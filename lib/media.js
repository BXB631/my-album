const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const exifr = require('exifr');
const MP4Box = require('mp4box');
const { convertHeic } = require('./heic-pool');
const { getPhotoRoot } = require('./settings');
const {
  parseYearMonth,
  parseYearMonthFromAbsolute,
} = require('./path-tags');
const { getCity } = require('./city-lookup');
const { DATA_DIR, CACHE_DIR } = require('./app-paths');

const LIBRARY_INDEX_PATH = path.join(DATA_DIR, 'library-index.json');
const LIBRARY_INDEX_VERSION = 3;
const THUMBS_DIR = path.join(CACHE_DIR, 'thumbnails');
const PREVIEWS_DIR = path.join(CACHE_DIR, 'previews');
const VIDEOS_DIR = path.join(CACHE_DIR, 'videos');
const THUMBNAIL_CACHE_VERSION = '3';
const THUMBNAIL_VERSION_FILE = path.join(
  THUMBS_DIR,
  '.thumbnail-version'
);

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
  '.bmp',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
]);

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

let libraryCache = null;
let libraryBuild = null;
let libraryBuildRoot = null;
let activeScan = null;
let indexLoadPromise = null;
let indexLoadRoot = null;
let thumbnailCacheReady = null;
const thumbnailJobs = new Map();
const previewJobs = new Map();
const videoThumbnailJobs = new Map();
const videoJobs = new Map();
const videoInfoCache = new Map();
const itemMetadataCache = new Map();
const ITEM_METADATA_CACHE_LIMIT = 4000;
const SCAN_CONCURRENCY = 8;

const FFMPEG_PATH = (() => {
  try {
    return path.join(
      path.dirname(
        require.resolve('@ffmpeg-installer/win32-x64/package.json')
      ),
      'ffmpeg.exe'
    );
  } catch {
    return null;
  }
})();

function encodeId(relativePath) {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function createScanCanceledError() {
  const error = new Error('扫描已停止');
  error.code = 'SCAN_CANCELED';
  error.status = 499;
  return error;
}

function throwIfScanCanceled(scanState) {
  if (scanState?.canceled) {
    throw createScanCanceledError();
  }
}

function cancelCurrentScan() {
  if (!activeScan) {
    return false;
  }

  activeScan.canceled = true;
  return true;
}

function parseDateFromFilename(filename) {
  const match = filename.match(
    /(\d{4})[_-](\d{2})[_-](\d{2})[ _-](\d{2})[_-](\d{2})[_-](\d{2})/
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function asValidDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function collectFiles(directory, scanState) {
  let entries;

  throwIfScanCanceled(scanState);

  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'SCAN_CANCELED') {
      throw error;
    }

    console.warn(`跳过无法读取的文件夹：${directory}`, error.message);
    return [];
  }

  const files = [];

  for (const entry of entries) {
    throwIfScanCanceled(scanState);

    if (entry.name.startsWith('.')) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, scanState)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function readImageMetadata(absolutePath) {
  const result = {
    exif: {},
    width: null,
    height: null,
  };

  try {
    result.exif =
      (await exifr.parse(absolutePath, {
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'ModifyDate',
          'Make',
          'Model',
          'LensModel',
          'ExifImageWidth',
          'ExifImageHeight',
          'GPSLatitude',
          'GPSLongitude',
          'latitude',
          'longitude',
        ],
      })) || {};
  } catch {
    // 没有 EXIF 或文件格式不支持时，继续使用文件名和文件时间。
  }

  try {
    const metadata = await sharp(absolutePath).metadata();
    result.width = metadata.width || null;
    result.height = metadata.height || null;
  } catch {
    // 某些图片格式无法读取尺寸时，不影响它在时间轴里出现。
  }

  return result;
}

function getDeviceName(exif) {
  const make = typeof exif.Make === 'string' ? exif.Make.trim() : '';
  const model = typeof exif.Model === 'string' ? exif.Model.trim() : '';

  if (make && model && !model.toLowerCase().startsWith(make.toLowerCase())) {
    return `${make} ${model}`;
  }

  return model || make || null;
}

async function probeVideoWithFfmpeg(absolutePath) {
  if (!FFMPEG_PATH) {
    return null;
  }

  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'album-video-probe-')
  );
  const logPath = path.join(tempDir, 'probe.log');
  const logFd = fs.openSync(logPath, 'w');

  try {
    const child = spawn(
      FFMPEG_PATH,
      ['-hide_banner', '-i', absolutePath],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', logFd],
      }
    );

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('视频信息读取超时'));
      }, 10000);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // ffmpeg -i 没有输出文件时通常返回 1，但 stderr 里已经有完整信息。
    if (exitCode !== 0 && exitCode !== 1) {
      return null;
    }

    const log = await fsp.readFile(logPath, 'utf8');
    const durationMatch = log.match(
      /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
    );
    const videoLine = log
      .split(/\r?\n/)
      .find((line) => /Stream #.*Video:/.test(line));

    if (!videoLine) {
      return null;
    }

    const codecMatch = videoLine.match(/Video:\s*([^\s,(]+)/i);
    const dimensionMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/);
    const codec = codecMatch ? codecMatch[1].toLowerCase() : null;
    const duration = durationMatch
      ? Number(durationMatch[1]) * 3600 +
        Number(durationMatch[2]) * 60 +
        Number(durationMatch[3])
      : null;

    return {
      codec,
      duration: Number.isFinite(duration) ? duration : null,
      width: dimensionMatch ? Number(dimensionMatch[1]) : null,
      height: dimensionMatch ? Number(dimensionMatch[2]) : null,
      needsTranscode:
        !codec ||
        !/^(h264|avc1|vp8|vp9|av01|av1)$/i.test(codec),
    };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // 已经关闭时忽略。
    }

    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readVideoMetadata(absolutePath, signature, extension, fileSize) {
  if (videoInfoCache.has(signature)) {
    return videoInfoCache.get(signature);
  }

  const infoPromise = (async () => {
    const probed = await probeVideoWithFfmpeg(absolutePath);

    if (probed) {
      return probed;
    }

    let info = null;

    if (fileSize <= 300 * 1024 * 1024) {
      try {
        const buffer = await fsp.readFile(absolutePath);

        info = await new Promise((resolve) => {
          const file = MP4Box.createFile();
          let finished = false;
          let timer = null;

          const finish = (value) => {
            if (finished) {
              return;
            }

            finished = true;

            if (timer) {
              clearTimeout(timer);
            }

            resolve(value);
          };

          timer = setTimeout(() => finish(null), 5000);
          file.onReady = (parsedInfo) => finish(parsedInfo);
          file.onError = () => finish(null);

          const originalConsoleError = console.error;

          console.error = (...args) => {
            if (args.some((arg) => String(arg).includes('BoxParser'))) {
              return;
            }

            originalConsoleError(...args);
          };

          try {
            const arrayBuffer = buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength
            );
            arrayBuffer.fileStart = 0;
            file.appendBuffer(arrayBuffer);
            file.flush();
          } catch {
            finish(null);
          } finally {
            console.error = originalConsoleError;
          }
        });
      } catch {
        // 视频元数据读不到时，后面仍然可以尝试转码。
      }
    }

    const videoTrack = info?.tracks?.find((track) => track.type === 'video');
    const codec = videoTrack?.codec || null;
    const duration =
      videoTrack?.timescale && videoTrack?.duration
        ? videoTrack.duration / videoTrack.timescale
        : info?.timescale && info?.duration
          ? info.duration / info.timescale
          : null;
    const containerNeedsTranscode = ['.mov', '.avi', '.mkv'].includes(
      extension
    );
    const needsTranscode =
      /^(hvc1|hev1)/i.test(codec || '') ||
      containerNeedsTranscode ||
      (!codec && extension !== '.webm');

    return {
      codec,
      duration: Number.isFinite(duration) ? duration : null,
      width: videoTrack?.video?.width || null,
      height: videoTrack?.video?.height || null,
      needsTranscode,
    };
  })();

  videoInfoCache.set(signature, infoPromise);

  try {
    return await infoPromise;
  } catch {
    videoInfoCache.delete(signature);
    return {
      codec: null,
      duration: null,
      width: null,
      height: null,
      needsTranscode: extension !== '.webm',
    };
  }
}

async function buildItem(absolutePath, root, scanState, reusableItem = null) {
  throwIfScanCanceled(scanState);

  const filename = path.basename(absolutePath);
  const extension = path.extname(filename).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);

  if (!isImage && !isVideo) {
    return null;
  }

  const stat = await fsp.stat(absolutePath);
  throwIfScanCanceled(scanState);

  const relativePath = path
    .relative(root, absolutePath)
    .split(path.sep)
    .join('/');
  const relativeDirectory = path.posix.dirname(relativePath);
  const folderPath = relativeDirectory === '.' ? '' : relativeDirectory;
  const tags =
    parseYearMonth(relativePath) ||
    parseYearMonthFromAbsolute(absolutePath);
  const type = isImage ? 'image' : 'video';
  const filenameDate = parseDateFromFilename(filename);
  const signature = `${absolutePath}|${stat.size}|${stat.mtimeMs}`;

  if (
    reusableItem &&
    reusableItem.cacheSignature === signature &&
    reusableItem.absolutePath === absolutePath
  ) {
    return reusableItem;
  }

  let imageMetadata;
  let videoMetadata;
  const cachedMetadata = itemMetadataCache.get(signature);

  if (cachedMetadata) {
    imageMetadata = cachedMetadata.imageMetadata;
    videoMetadata = cachedMetadata.videoMetadata;
  } else {
    imageMetadata = isImage
      ? await readImageMetadata(absolutePath)
      : { exif: {}, width: null, height: null };
    throwIfScanCanceled(scanState);

    videoMetadata = isVideo
      ? await readVideoMetadata(absolutePath, signature, extension, stat.size)
      : {
          codec: null,
          duration: null,
          width: null,
          height: null,
          needsTranscode: false,
        };
    throwIfScanCanceled(scanState);

    if (itemMetadataCache.size >= ITEM_METADATA_CACHE_LIMIT) {
      itemMetadataCache.clear();
    }

    itemMetadataCache.set(signature, { imageMetadata, videoMetadata });
  }

  const exifDate = asValidDate(
    imageMetadata.exif.DateTimeOriginal ||
      imageMetadata.exif.CreateDate ||
      imageMetadata.exif.ModifyDate
  );
  const takenAt = exifDate || filenameDate || stat.mtime;
  const rawLatitude = imageMetadata.exif.latitude;
  const rawLongitude = imageMetadata.exif.longitude;
  const latitude = typeof rawLatitude === 'number' ? rawLatitude : NaN;
  const longitude = typeof rawLongitude === 'number' ? rawLongitude : NaN;
  const city =
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? getCity(latitude, longitude)
      : null;
  const id = encodeId(absolutePath);
  const year = tags ? tags.year : null;
  const month = tags ? tags.month : null;

  return {
    id,
    name: filename,
    relativePath,
    folderPath,
    absolutePath,
    year,
    month,
    monthKey: tags ? tags.monthKey : null,
    yearLabel: year ? `${year} 年` : null,
    monthLabel: month ? `${month} 月` : null,
    type,
    mime: MIME_TYPES[extension] || 'application/octet-stream',
    extension: extension.slice(1).toUpperCase(),
    size: stat.size,
    width:
      imageMetadata.width ||
      imageMetadata.exif.ExifImageWidth ||
      videoMetadata.width ||
      null,
    height:
      imageMetadata.height ||
      imageMetadata.exif.ExifImageHeight ||
      videoMetadata.height ||
      null,
    duration: videoMetadata.duration,
    videoCodec: videoMetadata.codec,
    takenAt: takenAt.toISOString(),
    takenAtMs: takenAt.getTime(),
    modifiedAt: stat.mtime.toISOString(),
    dateSource: exifDate ? 'exif' : filenameDate ? 'filename' : 'file',
    device: isImage ? getDeviceName(imageMetadata.exif) : null,
    lens:
      isImage && imageMetadata.exif.LensModel
        ? imageMetadata.exif.LensModel
        : null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    city,
    thumbUrl: `/api/thumb/${id}?v=3`,
    previewUrl: isImage ? `/api/preview/${id}` : null,
    videoUrl: isVideo ? `/api/video/${id}` : null,
    fileUrl: `/api/file/${id}`,
    cacheSignature: signature,
    needsTranscode: videoMetadata.needsTranscode,
  };
}

function buildFolderTree(items) {
  const years = new Map();
  let uncategorizedCount = 0;

  for (const item of items) {
    if (!item.year) {
      uncategorizedCount += 1;
      continue;
    }

    if (!years.has(item.year)) {
      years.set(item.year, {
        year: item.year,
        key: `year-${item.year}`,
        label: `${item.year} 年`,
        count: 0,
        months: new Map(),
      });
    }

    const year = years.get(item.year);
    year.count += 1;

    if (item.month && item.monthKey) {
      if (!year.months.has(item.monthKey)) {
        year.months.set(item.monthKey, {
          month: item.month,
          key: item.monthKey,
          label: `${item.month} 月`,
          count: 0,
        });
      }

      year.months.get(item.monthKey).count += 1;
    }
  }

  const folders = [...years.values()]
    .sort((a, b) => a.year - b.year)
    .map((year) => ({
      ...year,
      months: [...year.months.values()].sort(
        (a, b) => a.month - b.month
      ),
    }));

  return { folders, uncategorizedCount };
}

async function mapWithConcurrency(items, limit, worker, scanState) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      throwIfScanCanceled(scanState);

      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => run())
  );

  return results;
}

async function buildDirectorySignature(root) {
  const entries = [];

  async function walk(directory) {
    let stat;
    let directoryEntries;

    try {
      stat = await fsp.stat(directory);
      directoryEntries = await fsp.readdir(directory, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    const relative = path.relative(root, directory) || '.';
    entries.push(`${relative}|${stat.mtimeMs}`);

    for (const entry of directoryEntries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(directory, entry.name));
      }
    }
  }

  await walk(root);

  if (!entries.length) {
    return null;
  }

  entries.sort();
  return crypto
    .createHash('sha1')
    .update(entries.join('\n'))
    .digest('hex');
}

async function buildLibrary(root, scanState, previousLibrary = null) {
  let rootStat;

  try {
    rootStat = await fsp.stat(root);
  } catch {
    const error = new Error('照片文件夹不存在，请重新选择');
    error.status = 400;
    throw error;
  }

  if (!rootStat.isDirectory()) {
    const error = new Error('选择的路径不是文件夹，请重新选择');
    error.status = 400;
    throw error;
  }

  const treeSignature = await buildDirectorySignature(root);
  const reusableItems =
    previousLibrary?.root === root
      ? new Map(
          previousLibrary.items.map((item) => [item.absolutePath, item])
        )
      : new Map();
  const files = await collectFiles(root, scanState);
  const results = await mapWithConcurrency(
    files,
    SCAN_CONCURRENCY,
    async (file) => {
      try {
        return await buildItem(
          file,
          root,
          scanState,
          reusableItems.get(file)
        );
      } catch (error) {
        if (error.code === 'SCAN_CANCELED') {
          throw error;
        }

        console.warn(
          `跳过无法读取的文件：${path.basename(file)}`,
          error.message
        );
        return null;
      }
    },
    scanState
  );

  throwIfScanCanceled(scanState);

  const items = results.filter(Boolean);
  items.sort((a, b) => a.takenAtMs - b.takenAtMs);
  const { folders, uncategorizedCount } = buildFolderTree(items);

  return {
    root,
    treeSignature,
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    folders,
    uncategorizedCount,
    scannedAt: new Date().toISOString(),
  };
}

async function writeLibraryIndex(library) {
  const payload = {
    version: LIBRARY_INDEX_VERSION,
    root: library.root,
    treeSignature: library.treeSignature,
    scannedAt: library.scannedAt,
    folders: library.folders,
    uncategorizedCount: library.uncategorizedCount,
    items: library.items,
  };
  const tempPath = `${LIBRARY_INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(
      tempPath,
      `${JSON.stringify(payload)}\n`,
      'utf8'
    );
    await fsp.rename(tempPath, LIBRARY_INDEX_PATH);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    console.warn('保存图库索引失败：', error.message);
  }
}

async function readLibraryIndex(root) {
  let parsed;

  try {
    const raw = await fsp.readFile(LIBRARY_INDEX_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('读取图库索引失败，将重新扫描：', error.message);
    }

    return null;
  }

  const indexVersion = Number(parsed?.version);

  if (
    !parsed ||
    ![2, LIBRARY_INDEX_VERSION].includes(indexVersion) ||
    parsed.root !== root ||
    !Array.isArray(parsed.items) ||
    !Array.isArray(parsed.folders)
  ) {
    return null;
  }

  try {
    const rootStat = await fsp.stat(root);

    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const items = parsed.items;

  if (
    !items.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.absolutePath === 'string' &&
        typeof item.takenAt === 'string' &&
        Number.isFinite(item.takenAtMs)
    )
  ) {
    return null;
  }

  let treeSignature =
    typeof parsed.treeSignature === 'string'
      ? parsed.treeSignature
      : null;

  if (!treeSignature) {
    treeSignature = await buildDirectorySignature(root);
  }

  return {
    root,
    indexVersion,
    treeSignature,
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    folders: parsed.folders,
    uncategorizedCount: Number(parsed.uncategorizedCount) || 0,
    scannedAt: parsed.scannedAt || new Date().toISOString(),
  };
}

function loadLibraryIndex(root) {
  if (indexLoadPromise && indexLoadRoot === root) {
    return indexLoadPromise;
  }

  indexLoadRoot = root;
  indexLoadPromise = readLibraryIndex(root).finally(() => {
    if (indexLoadRoot === root) {
      indexLoadPromise = null;
      indexLoadRoot = null;
    }
  });

  return indexLoadPromise;
}

async function getLibrary(force = false) {
  const root = await getPhotoRoot();

  if (libraryCache && libraryCache.root !== root) {
    libraryCache = null;
  }

  // 同一个文件夹的扫描结果一直复用；
  // 只有用户主动刷新或切换文件夹时才重新扫描。
  if (!force && libraryCache && libraryCache.root === root) {
    return libraryCache;
  }

  if (activeScan?.canceled && libraryBuild) {
    // 上一次扫描已经被用户停止，下一次请求直接开始新的扫描。
    libraryBuild = null;
    libraryBuildRoot = null;
  }

  let previousLibrary = libraryCache;

  if (!force) {
    const indexedLibrary = await loadLibraryIndex(root);

    if (indexedLibrary) {
      libraryCache = indexedLibrary;

      if (indexedLibrary.indexVersion < LIBRARY_INDEX_VERSION) {
        indexedLibrary.indexVersion = LIBRARY_INDEX_VERSION;
        await writeLibraryIndex(indexedLibrary);
      }

      return indexedLibrary;
    }
  }

  if (libraryBuild) {
    if (libraryBuildRoot === root) {
      return libraryBuild;
    }

    // 切换文件夹时，先通知旧扫描停止，再开始新扫描。
    cancelCurrentScan();
    await libraryBuild.catch(() => {});
  }

  if (force && !previousLibrary) {
    previousLibrary = await loadLibraryIndex(root);
  }

  if (force && previousLibrary?.treeSignature) {
    const treeSignature = await buildDirectorySignature(root);

    if (treeSignature === previousLibrary.treeSignature) {
      libraryCache = previousLibrary;
      return previousLibrary;
    }
  }

  const scanState = { canceled: false };
  activeScan = scanState;
  libraryBuildRoot = root;
  const buildPromise = buildLibrary(root, scanState, previousLibrary)
    .then(async (library) => {
      if (activeScan === scanState) {
        libraryCache = library;
        await writeLibraryIndex(library);
      }

      return library;
    })
    .finally(() => {
      if (activeScan === scanState) {
        activeScan = null;
      }

      if (libraryBuild === buildPromise) {
        libraryBuild = null;
        libraryBuildRoot = null;
      }
    });

  libraryBuild = buildPromise;
  return libraryBuild;
}

function clearLibraryCache() {
  libraryCache = null;
  cancelCurrentScan();
  libraryBuild = null;
  libraryBuildRoot = null;
}

async function measureDirectory(directory) {
  let entries;

  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { bytes: 0, files: 0 };
    }

    throw error;
  }

  let bytes = 0;
  let files = 0;

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const child = await measureDirectory(entryPath);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(entryPath);
        bytes += stat.size;
        files += 1;
      } catch {
        // 文件刚好被删除时跳过。
      }
    }
  }

  return { bytes, files };
}

async function getCacheInfo() {
  return measureDirectory(CACHE_DIR);
}

let cacheClearPromise = null;

function clearCache() {
  if (cacheClearPromise) {
    return cacheClearPromise;
  }

  cacheClearPromise = (async () => {
    await fsp.rm(CACHE_DIR, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 120,
    });

    thumbnailCacheReady = null;
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    return getCacheInfo();
  })().finally(() => {
    cacheClearPromise = null;
  });

  return cacheClearPromise;
}

async function getImageSource(item, options = {}) {
  if (['.heic', '.heif'].includes(`.${item.extension.toLowerCase()}`)) {
    const original = await fsp.readFile(item.absolutePath);
    return convertHeic(original, options.heicQuality ?? 0.94);
  }

  return item.absolutePath;
}

async function getRenderedImage(item, options) {
  if (!item || item.type !== 'image') {
    throw new Error('这个项目没有可用的图片');
  }

  const {
    directory,
    jobs,
    suffix,
    size,
    fit,
    quality,
    chromaSubsampling,
  } = options;

  await fsp.mkdir(directory, { recursive: true });

  const cacheKey = crypto
    .createHash('sha1')
    .update(`${item.cacheSignature}|${suffix}`)
    .digest('hex');
  const cachePath = path.join(directory, `${cacheKey}.jpg`);

  try {
    await fsp.access(cachePath);
    return cachePath;
  } catch {
    // 缓存不存在，下面开始生成。
  }

  if (jobs.has(cacheKey)) {
    return jobs.get(cacheKey);
  }

  const job = (async () => {
    const source = await getImageSource(item, options);
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      const jpegOptions = { quality, progressive: true };

      if (chromaSubsampling) {
        jpegOptions.chromaSubsampling = chromaSubsampling;
      }

      await sharp(source, { failOn: 'none' })
        .rotate()
        .resize(size, size, {
          fit,
          position: 'centre',
          withoutEnlargement: true,
        })
        .flatten({ background: '#000000' })
        .jpeg(jpegOptions)
        .toFile(tempPath);

      await fsp.rename(tempPath, cachePath);
      return cachePath;
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  })().finally(() => {
    jobs.delete(cacheKey);
  });

  jobs.set(cacheKey, job);
  return job;
}

function prepareThumbnailCache() {
  if (!thumbnailCacheReady) {
    thumbnailCacheReady = (async () => {
      await fsp.mkdir(THUMBS_DIR, { recursive: true });

      let version = '';

      try {
        version = (
          await fsp.readFile(THUMBNAIL_VERSION_FILE, 'utf8')
        ).trim();
      } catch {
        // 还没有版本标记，说明是旧缓存。
      }

      if (version === THUMBNAIL_CACHE_VERSION) {
        return;
      }

      const entries = await fsp.readdir(THUMBS_DIR, {
        withFileTypes: true,
      });
      const oldFiles = entries
        .filter(
          (entry) =>
            entry.isFile() && /\.(?:jpe?g)$/i.test(entry.name)
        )
        .map((entry) => path.join(THUMBS_DIR, entry.name));

      // 旧缩略图按 50 个一批删除，避免一次打开太多文件句柄。
      for (let index = 0; index < oldFiles.length; index += 50) {
        await Promise.all(
          oldFiles
            .slice(index, index + 50)
            .map((file) => fsp.rm(file, { force: true }))
        );
      }

      await fsp.writeFile(
        THUMBNAIL_VERSION_FILE,
        THUMBNAIL_CACHE_VERSION,
        'utf8'
      );
    })().catch((error) => {
      console.warn('清理旧缩略图缓存失败：', error.message);
      thumbnailCacheReady = null;
    });
  }

  return thumbnailCacheReady;
}

async function getThumbnail(item) {
  if (!item) {
    throw new Error('这个项目没有可用的缩略图');
  }

  await prepareThumbnailCache();

  if (item.type === 'video') {
    return getVideoThumbnail(item);
  }

  return getRenderedImage(item, {
    directory: THUMBS_DIR,
    jobs: thumbnailJobs,
    suffix: 'thumb-v3',
    size: 320,
    fit: 'cover',
    quality: 65,
    heicQuality: 0.7,
  });
}

function getPreview(item) {
  return getRenderedImage(item, {
    directory: PREVIEWS_DIR,
    jobs: previewJobs,
    suffix: 'preview-v1',
    size: 2560,
    fit: 'inside',
    quality: 90,
    chromaSubsampling: '4:4:4',
    heicQuality: 0.92,
  });
}

function runFfmpeg(args, logPath) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_PATH) {
      reject(new Error('没有找到 FFmpeg'));
      return;
    }

    let logHandle;

    try {
      logHandle = fs.openSync(logPath, 'w');
    } catch (error) {
      reject(error);
      return;
    }

    let finished = false;

    const finish = async (code, spawnError) => {
      if (finished) {
        return;
      }

      finished = true;

      try {
        fs.closeSync(logHandle);
      } catch {
        // 文件已经关闭时忽略。
      }

      let detail = '';

      if (code !== 0 || spawnError) {
        try {
          detail = (await fsp.readFile(logPath, 'utf8'))
            .trim()
            .split('\n')
            .slice(-3)
            .join(' ');
        } catch {
          // 没有日志时使用通用错误信息。
        }
      }

      await fsp.rm(logPath, { force: true }).catch(() => {});

      if (code === 0 && !spawnError) {
        resolve();
        return;
      }

      reject(
        spawnError ||
          new Error(detail || `FFmpeg 退出码 ${code}`)
      );
    };

    let ffmpegProcess;

    try {
      ffmpegProcess = spawn(FFMPEG_PATH, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', logHandle],
      });
    } catch (error) {
      finish(-1, error);
      return;
    }

    ffmpegProcess.on('error', (error) => {
      finish(-1, error);
    });

    ffmpegProcess.on('close', (code) => {
      finish(code, null);
    });
  });
}

async function transcodeVideo(item, outputPath) {
  const stamp = `${process.pid}.${Date.now()}`;
  const tempPath = `${outputPath}.${stamp}.tmp.mp4`;
  const logPath = `${outputPath}.${stamp}.log`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    item.absolutePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    tempPath,
  ];

  try {
    await runFfmpeg(args, logPath);
    await fsp.rename(tempPath, outputPath);
    return outputPath;
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function getVideoThumbnail(item) {
  await fsp.mkdir(THUMBS_DIR, { recursive: true });

  const cacheKey = crypto
    .createHash('sha1')
    .update(`${item.cacheSignature}|video-poster-v3`)
    .digest('hex');
  const cachePath = path.join(THUMBS_DIR, `${cacheKey}.jpg`);

  try {
    await fsp.access(cachePath);
    return cachePath;
  } catch {
    // 还没有生成过视频封面。
  }

  if (videoThumbnailJobs.has(cacheKey)) {
    return videoThumbnailJobs.get(cacheKey);
  }

  const job = (async () => {
    const stamp = `${process.pid}.${Date.now()}`;
    const framePath = `${cachePath}.${stamp}.frame.jpg`;
    const tempPath = `${cachePath}.${stamp}.tmp.jpg`;
    const logPath = `${cachePath}.${stamp}.log`;
    const duration = Number(item.duration) || 2;
    const seek = Math.min(2, Math.max(0.1, duration * 0.1));
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seek.toFixed(2),
      '-i',
      item.absolutePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '2',
      framePath,
    ];

    try {
      await runFfmpeg(args, logPath);
      await sharp(framePath, { failOn: 'none' })
        .rotate()
        .resize(320, 320, {
          fit: 'cover',
          position: 'centre',
          withoutEnlargement: true,
        })
        .flatten({ background: '#000000' })
        .jpeg({ quality: 65, progressive: true })
        .toFile(tempPath);
      await fsp.rename(tempPath, cachePath);
      return cachePath;
    } finally {
      await fsp.rm(framePath, { force: true }).catch(() => {});
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  })().finally(() => {
    videoThumbnailJobs.delete(cacheKey);
  });

  videoThumbnailJobs.set(cacheKey, job);
  return job;
}

async function getVideoPlayback(item) {
  if (!item || item.type !== 'video') {
    throw new Error('这个项目不是视频');
  }

  if (!item.needsTranscode) {
    return item.absolutePath;
  }

  await fsp.mkdir(VIDEOS_DIR, { recursive: true });

  const cacheKey = crypto
    .createHash('sha1')
    .update(`${item.cacheSignature}|video-transcode-v1`)
    .digest('hex');
  const cachePath = path.join(VIDEOS_DIR, `${cacheKey}.mp4`);

  try {
    await fsp.access(cachePath);
    return cachePath;
  } catch {
    // 还没有转码过，下面开始生成。
  }

  if (videoJobs.has(cacheKey)) {
    return videoJobs.get(cacheKey);
  }

  const job = transcodeVideo(item, cachePath).finally(() => {
    videoJobs.delete(cacheKey);
  });

  videoJobs.set(cacheKey, job);
  return job;
}

module.exports = {
  getLibrary,
  clearLibraryCache,
  cancelCurrentScan,
  getCacheInfo,
  clearCache,
  getThumbnail,
  getPreview,
  getVideoPlayback,
};
