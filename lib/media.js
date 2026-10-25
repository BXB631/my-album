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
const LIBRARY_INDEX_VERSION = 4;
// v4 起索引里会带上实况照片关系；v2/v3 的老索引读进来时按文件名补一次配对。
const LIVE_PHOTO_INDEX_VERSION = 4;
const THUMBS_DIR = path.join(CACHE_DIR, 'thumbnails');
const PREVIEWS_DIR = path.join(CACHE_DIR, 'previews');
const VIDEOS_DIR = path.join(CACHE_DIR, 'videos');
// v4：HEIC 的缩略图原来丢了色彩配置（P3 当 sRGB 显示，颜色偏）。
// 版本号一变，prepareThumbnailCache() 会把旧缩略图删掉重新生成。
const THUMBNAIL_CACHE_VERSION = '4';
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

// 实况照片（Apple Live Photo）= 一张 HEIC/JPG + 一个同名的 MOV。
// 判定用的是 Lap 那套规则：先按"同文件夹同名"找候选，再用 Content Identifier 复核。
const LIVE_PHOTO_IMAGE_EXTENSIONS = new Set([
  '.heic',
  '.heif',
  '.hif',
  '.jpg',
  '.jpeg',
]);
const LIVE_PHOTO_VIDEO_EXTENSIONS = new Set(['.mov']);
// 只读图片头部这一小段：标识符（UUID）就在 XMP 里，实测在文件前 100KB 内。
const LIVE_PHOTO_HEADER_BYTES = 256 * 1024;
// MOV 的 udta/meta（标识符所在）写在文件尾部：ffmpeg 探不出来时可以只读尾巴。
const LIVE_PHOTO_TAIL_BYTES = 256 * 1024;
const CONTENT_IDENTIFIER_MARKER = 'com.apple.quicktime.content.identifier';
const CONTENT_IDENTIFIER_PATTERN =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

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

// 对外暴露的项目结构：和 1.11 的 /api/photos 保持一致，
// 剔除只在服务端使用的内部字段（标识符、缓存签名等）。
function toPublicItem(item) {
  if (!item) {
    return null;
  }

  const {
    cacheSignature,
    takenAtMs,
    needsTranscode,
    liveIdentifiers,
    contentIdentifiers,
    ...publicItem
  } = item;
  return publicItem;
}

function localDayKey(takenAtMs) {
  if (!Number.isFinite(takenAtMs)) {
    return 'unknown';
  }

  const date = new Date(takenAtMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
    // 实况照片的 MOV 里带着和图片一致的标识符，ffmpeg -i 会把它打出来，
    // 所以这里顺手取一下，不额外起进程。
    const identifierMatch = log.match(
      /com\.apple\.quicktime\.content\.identifier:\s*([0-9A-Za-z_-]{16,64})/
    );

    return {
      codec,
      duration: Number.isFinite(duration) ? duration : null,
      width: dimensionMatch ? Number(dimensionMatch[1]) : null,
      height: dimensionMatch ? Number(dimensionMatch[2]) : null,
      contentIdentifiers: identifierMatch
        ? [identifierMatch[1].toLowerCase()]
        : [],
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
      // MP4Box 这条路没解析标识符，实况照片复核会去读 MOV 尾巴补一次。
      contentIdentifiers: [],
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
      contentIdentifiers: [],
      needsTranscode: extension !== '.webm',
    };
  }
}

// ---------------------------------------------------------------------------
// 实况照片配对（对应 Lap 的 t_sqlite::pair_live_photos_in_folder）
//
// 规则：
//   1. 同一个文件夹里，"同名图片 + MOV"是候选对（iPhone 编号一台设备内唯一，
//      照片和视频不会撞号，所以同名可以作为主判据）；
//   2. MOV 侧还接受 IMG_1234_HEVC.MOV 这种加后缀的写法；
//   3. 两边的 Content Identifier（Apple 的 com.apple.quicktime.content.identifier）
//      都读得到时必须一致 —— 只有一个复制件/导出件丢了标识时才退回文件名判据；
//   4. 一个 MOV 只能配给一张照片（复制出来的实况照片会共用标识符）。
//
// 结果：图片那一项留在格子里并带上 liveVideo* 字段；MOV 那一项变成"伴随项"，
// 不进格子但留在 byId 里（查看器要用 /api/video/<id> 拿到它）。
// ---------------------------------------------------------------------------

function fileStemKey(name) {
  return path.parse(name).name.toLowerCase();
}

function videoStemKeys(name) {
  const stem = fileStemKey(name);
  const suffix = '_hevc';

  if (stem.endsWith(suffix) && stem.length > suffix.length) {
    return [stem, stem.slice(0, -suffix.length)];
  }

  return [stem];
}

// 一个文件夹里的文件名列表 → 配对计划（纯字符串运算，不碰磁盘）。
// 内部先排序，所以结果只跟"文件夹里有哪些文件"有关，跟调用方给的顺序无关。
function planLivePhotoPairs(names) {
  const imagesByStem = new Map();
  const videosByStem = new Map();

  for (const name of [...names].sort()) {
    const extension = path.extname(name).toLowerCase();

    if (LIVE_PHOTO_IMAGE_EXTENSIONS.has(extension)) {
      const stem = fileStemKey(name);

      if (!imagesByStem.has(stem)) {
        imagesByStem.set(stem, name);
      }
    } else if (LIVE_PHOTO_VIDEO_EXTENSIONS.has(extension)) {
      const ownStem = fileStemKey(name);

      for (const stem of videoStemKeys(name)) {
        if (!videosByStem.has(stem)) {
          videosByStem.set(stem, []);
        }

        videosByStem.get(stem).push({ name, exact: stem === ownStem });
      }
    }
  }

  const imageCompanion = new Map();
  const companionImage = new Map();

  for (const [stem, imageName] of imagesByStem) {
    // 一个 MOV 只能配给一张照片；同名多个 MOV 时先要"名字正好对上"的那个
    // （IMG_6002.MOV 优先于 IMG_6002_HEVC.MOV），再按文件名排序取第一个。
    const candidates = (videosByStem.get(stem) || [])
      .filter((candidate) => !companionImage.has(candidate.name))
      .sort((a, b) => {
        if (a.exact !== b.exact) {
          return a.exact ? -1 : 1;
        }

        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

    if (!candidates.length) {
      continue;
    }

    imageCompanion.set(imageName, candidates[0].name);
    companionImage.set(candidates[0].name, imageName);
  }

  return { imageCompanion, companionImage };
}

// 只读头部这一段找 UUID：整张图读下来太贵（几万张），而标识符就在最前面。
async function readImageContentIdentifiers(absolutePath) {
  let handle;

  try {
    handle = await fsp.open(absolutePath, 'r');
  } catch {
    return [];
  }

  try {
    const buffer = Buffer.alloc(LIVE_PHOTO_HEADER_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      LIVE_PHOTO_HEADER_BYTES,
      0
    );
    const text = buffer.subarray(0, bytesRead).toString('latin1');
    const found = text.match(CONTENT_IDENTIFIER_PATTERN) || [];
    return [...new Set(found.map((value) => value.toLowerCase()))];
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}

// MOV 侧的兜底读取：QuickTime 的 keys/ilst 在文件尾部，
// 只读最后一段就能拿到标识符（正常路径上 ffmpeg -i 已经给了，这里用不上）。
// 返回的是"尾部出现过、且确实带了标识符键"的那组 UUID —— 只有一个时才采信。
async function readVideoContentIdentifiers(absolutePath) {
  let handle;

  try {
    handle = await fsp.open(absolutePath, 'r');
  } catch {
    return [];
  }

  try {
    const stat = await handle.stat();
    const size = Math.min(LIVE_PHOTO_TAIL_BYTES, stat.size);
    const offset = Math.max(0, stat.size - size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    const text = buffer.subarray(0, bytesRead).toString('latin1');

    if (!text.includes(CONTENT_IDENTIFIER_MARKER)) {
      return [];
    }

    const found = text.match(CONTENT_IDENTIFIER_PATTERN) || [];
    return [...new Set(found.map((value) => value.toLowerCase()))];
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}

// 给"图片"这一项写上实况照片字段；伴随视频的 id 由路径直接算出来，
// 所以扫描期就能知道有没有伴随项（不用等 MOV 那一项解析完）。
function applyLivePhotoFields(item, companionVideo) {
  const companionId = companionVideo
    ? companionVideo.id || encodeId(companionVideo.absolutePath)
    : null;

  item.livePhoto = Boolean(companionId);
  item.liveVideoId = companionId;
  item.liveVideoName = companionVideo ? companionVideo.name : null;
  item.liveVideoUrl = companionId ? `/api/video/${companionId}` : null;
  item.liveVideoDuration =
    companionVideo && Number.isFinite(companionVideo.duration)
      ? companionVideo.duration
      : null;
  item.liveVideoSize = companionVideo ? companionVideo.size || null : null;
  // 伴随 MOV 的编码也带上：前端据此判断"能不能直接播源文件"（HEVC 要看系统解码器）
  item.liveVideoCodec = companionVideo?.videoCodec || null;

  return item;
}

function clearLivePhotoFields(item) {
  item.livePhoto = false;
  item.liveVideoId = null;
  item.liveVideoName = null;
  item.liveVideoUrl = null;
  item.liveVideoDuration = null;
  item.liveVideoSize = null;
  return item;
}

// 伴随项：不进格子，但仍然可以被 /api/video/<id> 找到。
function markLivePhotoCompanion(item, image) {
  item.livePhotoCompanion = true;
  item.livePhotoCompanionOf = image ? image.id || encodeId(image.absolutePath) : null;
  return item;
}

function identifiersOverlap(imageIdentifiers, videoIdentifiers) {
  const images = Array.isArray(imageIdentifiers) ? imageIdentifiers : [];
  const videos = Array.isArray(videoIdentifiers) ? videoIdentifiers : [];

  if (!images.length || !videos.length) {
    // 有一边没有标识符：退回文件名判据（iPhone 的编号本来就够唯一）。
    return true;
  }

  return videos.some((identifier) => images.includes(identifier));
}

// 扫描结束后复核一轮：把"只有一边有标识、或者标识对不上"的错配拆开。
// 返回需要重新放回格子的项目（被拆开的伴随视频）。
async function linkLivePhotoCompanions(session) {
  const restored = [];
  const imagesById = new Map();

  for (const item of session.byId.values()) {
    if (item.type === 'image' && item.livePhoto) {
      imagesById.set(item.id, item);
    }
  }

  // 1) 图片声明的伴随项必须真的存在，且标识要能对上
  for (const image of imagesById.values()) {
    const companion = session.byId.get(image.liveVideoId);
    let videoIdentifiers = companion?.contentIdentifiers || [];

    // ffmpeg 没给出标识符时（比如没装 ffmpeg）从 MOV 尾巴补读一次，
    // 读到的结果留在项目上，后面的复核/索引就不用再读。
    if (
      companion &&
      !videoIdentifiers.length &&
      image.liveIdentifiers?.length
    ) {
      videoIdentifiers = await readVideoContentIdentifiers(
        companion.absolutePath
      );

      if (videoIdentifiers.length) {
        companion.contentIdentifiers = videoIdentifiers;
      }
    }

    const mismatch = !identifiersOverlap(
      image.liveIdentifiers,
      videoIdentifiers
    );

    if (!companion || companion.livePhotoCompanionOf !== image.id || mismatch) {
      if (companion) {
        companion.livePhotoCompanion = false;
        companion.livePhotoCompanionOf = null;
        restored.push(companion);
      }

      clearLivePhotoFields(image);
      continue;
    }

    // 视频的时长/大小回填到图片上（详情面板要显示）
    applyLivePhotoFields(image, companion);
  }

  // 2) 反方向：伴随项认领的照片不见了 / 已经不认它了 → 恢复成一个普通视频
  for (const item of session.byId.values()) {
    if (!item.livePhotoCompanion) {
      continue;
    }

    const image = session.byId.get(item.livePhotoCompanionOf);

    if (!image || !image.livePhoto || image.liveVideoId !== item.id) {
      item.livePhotoCompanion = false;
      item.livePhotoCompanionOf = null;

      if (!restored.includes(item)) {
        restored.push(item);
      }
    }
  }

  return restored;
}

// 老索引（v3 及以前）里实况照片还是两个独立条目：读进来时按文件名补一次配对，
// 并用标识符复核（只读图片头部和 MOV 尾部，不起 ffmpeg 进程）。
async function relinkLivePhotosInItems(items) {
  const groups = new Map();

  for (const item of items) {
    const key = item.folderPath || '';

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(item);
  }

  const visible = [];
  const companions = [];

  for (const group of groups.values()) {
    const byName = new Map(group.map((item) => [item.name, item]));
    const { imageCompanion, companionImage } = planLivePhotoPairs(
      group.map((item) => item.name)
    );

    // 先逐对复核：标识符对不上的直接否决，图片和 MOV 都保持独立条目。
    const paired = new Map();
    const rejected = new Set();

    for (const [imageName, videoName] of imageCompanion) {
      const image = byName.get(imageName) || null;
      const companion = byName.get(videoName) || null;
      const imageIdentifiers = image
        ? await readImageContentIdentifiers(image.absolutePath)
        : [];
      const videoIdentifiers = companion
        ? await readVideoContentIdentifiers(companion.absolutePath)
        : [];

      if (image && imageIdentifiers.length) {
        // 结果留在项目上：写进 v4 索引后下次打开就不用再读了。
        image.liveIdentifiers = imageIdentifiers;
      }

      if (companion && videoIdentifiers.length) {
        companion.contentIdentifiers = videoIdentifiers;
      }

      if (!identifiersOverlap(imageIdentifiers, videoIdentifiers)) {
        rejected.add(videoName);
        continue;
      }

      paired.set(imageName, videoName);
    }

    for (const item of group) {
      const companionName = paired.get(item.name);

      if (companionName) {
        applyLivePhotoFields(item, byName.get(companionName) || null);
        visible.push(item);
        continue;
      }

      const imageName = companionImage.get(item.name);

      // 被否决的 MOV 不能藏起来：它和图片一样都是独立项目。
      if (imageName && !rejected.has(item.name)) {
        markLivePhotoCompanion(item, byName.get(imageName) || null);
        companions.push(item);
        continue;
      }

      clearLivePhotoFields(item);
      visible.push(item);
    }
  }

  return { items: visible, companions };
}

async function buildItem(
  absolutePath,
  root,
  scanState,
  reusableItem = null,
  liveInfo = null
) {
  throwIfScanCanceled(scanState);

  const filename = path.basename(absolutePath);
  const extension = path.extname(filename).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);

  if (!isImage && !isVideo) {
    return null;
  }

  // liveInfo 只有两类：候选图片（配对视频路径）和候选伴随视频（图片路径）。
  const isLivePhotoImage = Boolean(liveInfo?.companionVideoPath);
  const isLivePhotoCompanion = Boolean(liveInfo?.companionImagePath);

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
    // 索引/上一轮扫描复用来的项目，实况照片关系要按这次的文件列表重算，
    // 否则 MOV 被删掉之后旧字段会一直挂着。
    if (isLivePhotoImage) {
      applyLivePhotoFields(reusableItem, { absolutePath: liveInfo.companionVideoPath, name: liveInfo.companionVideoName });
    } else if (isLivePhotoCompanion) {
      markLivePhotoCompanion(reusableItem, { absolutePath: liveInfo.companionImagePath });
    } else {
      clearLivePhotoFields(reusableItem);
      reusableItem.livePhotoCompanion = false;
      reusableItem.livePhotoCompanionOf = null;
    }

    return reusableItem;
  }

  let imageMetadata;
  let videoMetadata;
  let liveIdentifiers;
  const cachedMetadata = itemMetadataCache.get(signature);

  if (cachedMetadata) {
    imageMetadata = cachedMetadata.imageMetadata;
    videoMetadata = cachedMetadata.videoMetadata;
    liveIdentifiers = cachedMetadata.liveIdentifiers || [];
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

    // 只有"确实有同名 MOV 的图片"才去读标识符：几万张全读一遍不值得。
    liveIdentifiers = isLivePhotoImage
      ? await readImageContentIdentifiers(absolutePath)
      : [];
    throwIfScanCanceled(scanState);

    if (itemMetadataCache.size >= ITEM_METADATA_CACHE_LIMIT) {
      itemMetadataCache.clear();
    }

    itemMetadataCache.set(signature, {
      imageMetadata,
      videoMetadata,
      liveIdentifiers,
    });
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

  const item = {
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
    // --- 实况照片（Apple Live Photo）---
    // 图片那一项：livePhoto=true + liveVideo* 指向伴随的 MOV；
    // MOV 那一项：livePhotoCompanion=true，不进格子，只留在 byId 里给播放接口用。
    livePhoto: isLivePhotoImage,
    liveVideoId: null,
    liveVideoName: null,
    liveVideoUrl: null,
    liveVideoDuration: null,
    liveVideoSize: null,
    livePhotoCompanion: isLivePhotoCompanion || undefined,
    livePhotoCompanionOf: null,
    // 内部字段：标识符只用于复核配对，不发给前端（toPublicItem 会剔除）。
    liveIdentifiers: liveIdentifiers.length ? liveIdentifiers : undefined,
    contentIdentifiers:
      isVideo && videoMetadata.contentIdentifiers?.length
        ? videoMetadata.contentIdentifiers
        : undefined,
  };

  if (isLivePhotoImage) {
    applyLivePhotoFields(item, {
      absolutePath: liveInfo.companionVideoPath,
      name: liveInfo.companionVideoName,
    });
    item.liveIdentifiers = liveIdentifiers.length ? liveIdentifiers : undefined;
  } else if (isLivePhotoCompanion) {
    markLivePhotoCompanion(item, { absolutePath: liveInfo.companionImagePath });
  }

  return item;
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

// 2.0 的扫描不再"整树走完 → 批量解析 → 一次性返回"，
// 而是"边走目录边占位、并发解析、结果逐个填进格子"（参考 Lap 的流式加载）。
// 旧的 mapWithConcurrency(buildLibrary) 因此删除，扫描逻辑见下方 runStreamingScan。

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

// ---------------------------------------------------------------------------
// 2.0 流式图库会话
//
// 与 1.11 的差别（对应 Lap 的加载模式）：
//   1. 一个文件夹只有一个会话，会话里保存"格子"（slots）。
//   2. 扫描期：走目录时先占位（slots.push(null)），解析完一项就填一格，
//      所以 total 会增长、filled 也会增长，前端随时可以取到"部分结果"。
//   3. 完成后：按拍摄时间排序，并预计算"按天分组"（days）与视图（view），
//      前端按 offset/limit 取窗口数据，不需要一次拿到全部条目。
// ---------------------------------------------------------------------------

const MAX_STREAM_PAGE = 512;

let stream = null;
let streamStart = null;

// revision 是"图库内容变了吗"的唯一凭据，前端靠它判断要不要丢掉旧的格子/分组/侧栏目录。
// 它必须**跨会话单调递增**：每次刷新都会新建一个会话，如果 revision 从 1 重新数，
// 新会话扫完后的值可能和上一轮相同，前端就会以为"没变过"（侧栏目录因此不再刷新）。
let revisionCounter = 0;

function nextRevision() {
  revisionCounter += 1;
  return revisionCounter;
}

function createStreamSession(root) {
  return {
    root,
    revision: nextRevision(),
    phase: 'idle',
    order: 'scan',
    slots: [],
    byId: new Map(),
    discovered: 0,
    filled: 0,
    enriched: 0,
    view: { items: [], days: [], indexById: new Map() },
    views: new Map(),
    scanFoldersCache: null,
    scanViews: new Map(),
    folders: [],
    uncategorizedCount: 0,
    scannedAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    library: null,
    task: null,
    scanState: null,
    previous: null,
    fromIndex: false,
    signature: null,
  };
}

function buildDays(items) {
  const days = [];
  let current = null;
  const cityCounts = new Map();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = localDayKey(item.takenAtMs);

    if (!current || current.key !== key) {
      if (current) {
        current.city = pickMainCity(cityCounts);
      }

      cityCounts.clear();
      current = { key, count: 0, itemStart: index, city: null };
      days.push(current);
    }

    current.count += 1;

    if (item.city) {
      cityCounts.set(item.city, (cityCounts.get(item.city) || 0) + 1);
    }
  }

  if (current) {
    current.city = pickMainCity(cityCounts);
  }

  return days;
}

function pickMainCity(cityCounts) {
  let mainCity = null;
  let mainCount = 0;

  for (const [city, count] of cityCounts) {
    if (count > mainCount) {
      mainCity = city;
      mainCount = count;
    }
  }

  return mainCity;
}

function createView(items) {
  return {
    items,
    days: buildDays(items),
    indexById: new Map(items.map((item, index) => [item.id, index])),
  };
}

function matchesFolder(item, filter) {
  if (filter === 'unclassified') {
    return !item.year;
  }

  if (filter.startsWith('year-')) {
    return item.year === Number(filter.slice(5));
  }

  return item.monthKey === filter;
}

// 解析出请求对应的数据视图：
//   - 扫描中：只有"发现顺序"的实时视图，文件夹过滤不可用；
//   - 完成后：按天分组的日期顺序视图，文件夹过滤惰性建视图并缓存。
function resolveView(session, filter) {
  const key = typeof filter === 'string' && filter ? filter : 'all';

  if (session.phase !== 'ready') {
    // 关键：这里必须是"活的"格子数组（扫描期会不断增长、逐格填充），
    // 不能复用会话初始化时的空视图，否则扫描期 total 永远是 0。
    // 带过滤条件时（年/月入口）筛"已解析前缀"，这样扫描期点目录也能看到东西。
    return {
      key,
      ready: false,
      view: {
        items:
          key === 'all' ? session.slots : getScanFilteredItems(session, key),
        days: [],
        indexById: session.byId,
      },
    };
  }

  if (key === 'all') {
    return { key, view: session.view, ready: true };
  }

  if (!session.views.has(key)) {
    session.views.set(
      key,
      createView(session.view.items.filter((item) => matchesFolder(item, key)))
    );
  }

  return { key, view: session.views.get(key), ready: true };
}

function publishLibrary(session, library, { fromIndex = false } = {}) {
  const items = Array.isArray(library.items) ? library.items : [];

  session.slots = items;
  session.discovered = items.length;
  session.filled = items.length;
  session.enriched = items.length;
  session.byId =
    library.byId instanceof Map
      ? library.byId
      : new Map(items.map((item) => [item.id, item]));
  session.view = createView(items);
  session.views = new Map();
  session.folders = Array.isArray(library.folders) ? library.folders : [];
  session.uncategorizedCount = Number(library.uncategorizedCount) || 0;
  session.scannedAt = library.scannedAt || new Date().toISOString();
  session.library = {
    ...library,
    root: session.root,
    items,
    byId: session.byId,
  };
  session.signature = library.treeSignature || null;
  session.phase = 'ready';
  session.order = 'date';
  session.fromIndex = fromIndex;
  session.finishedAt = Date.now();
  session.revision = nextRevision();
}

async function runStreamingScan(session, previousLibrary) {
  const scanState = { canceled: false };
  session.scanState = scanState;
  activeScan = scanState;

  // 复用上一轮的解析结果时要把"伴随视频"也算进来，
  // 否则每次刷新都会重新 ffmpeg 探一遍所有实况照片的 MOV。
  const reusableSource =
    previousLibrary?.byId instanceof Map
      ? [...previousLibrary.byId.values()]
      : previousLibrary?.items || [];
  const reusableItems =
    previousLibrary?.root === session.root
      ? new Map(reusableSource.map((item) => [item.absolutePath, item]))
      : new Map();

  const pending = [];
  const signatureEntries = [];
  let waiters = [];
  let discoveryDone = false;

  const wake = () => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) {
      resolve();
    }
  };

  async function discover(directory) {
    throwIfScanCanceled(scanState);

    let stat;
    let entries;

    try {
      stat = await fsp.stat(directory);
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'SCAN_CANCELED') {
        throw error;
      }

      console.warn(`跳过无法读取的文件夹：${directory}`, error.message);
      return;
    }

    // 目录签名顺手在这里收集，扫描结束后不用再整树走一遍。
    signatureEntries.push(
      `${path.relative(session.root, directory) || '.'}|${stat.mtimeMs}`
    );

    // 按文件名排序再遍历：扫描期的顺序因此大致等于时间顺序，
    // "已经扫描到的部分"就能连续地按日期分组（后面的分段只往后追加，不会来回改）。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // 一个文件夹列完就先算一次"实况照片配对计划"（纯文件名运算，不读盘）。
    // 有了它，图片那一项一进格子就带着 LIVE 角标，伴随的 MOV 则完全不占格子，
    // 所以扫描期不会出现"MOV 先冒出来、扫完又消失"的跳动。
    const { imageCompanion, companionImage } = planLivePhotoPairs(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    );

    for (const entry of entries) {
      throwIfScanCanceled(scanState);

      if (entry.name.startsWith('.')) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await discover(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (
        !IMAGE_EXTENSIONS.has(extension) &&
        !VIDEO_EXTENSIONS.has(extension)
      ) {
        continue;
      }

      const companionVideoName = imageCompanion.get(entry.name);
      const companionImageName = companionImage.get(entry.name);

      // 伴随的 MOV：只解析出项目（byId 里留着，播放接口要用），不占格子。
      if (companionImageName) {
        pending.push({
          index: -1,
          absolutePath,
          companion: true,
          liveInfo: {
            companionImagePath: path.join(directory, companionImageName),
          },
        });
        wake();
        continue;
      }

      // 先占位：total 随发现增长，前端马上就有格子可铺。
      const index = session.slots.length;
      session.slots.push(null);
      session.discovered += 1;
      pending.push({
        index,
        absolutePath,
        liveInfo: companionVideoName
          ? {
              companionVideoPath: path.join(directory, companionVideoName),
              companionVideoName,
            }
          : null,
      });
      wake();
    }
  }

  async function worker() {
    while (true) {
      throwIfScanCanceled(scanState);

      const job = pending.shift();

      if (!job) {
        if (discoveryDone) {
          return;
        }

        await new Promise((resolve) => waiters.push(resolve));
        continue;
      }

      let item = null;

      try {
        item = await buildItem(
          job.absolutePath,
          session.root,
          scanState,
          reusableItems.get(job.absolutePath) || null,
          job.liveInfo
        );
      } catch (error) {
        if (error.code === 'SCAN_CANCELED') {
          throw error;
        }

        console.warn(
          `跳过无法读取的文件：${path.basename(job.absolutePath)}`,
          error.message
        );
      }

      if (item) {
        session.byId.set(item.id, item);

        if (job.companion) {
          // 伴随项不是格子：total / filled 都不该因为它变化。
          continue;
        }

        // 解析完一项就填一格：这就是"边扫边能看"的来源。
        session.slots[job.index] = item;
        session.filled += 1;
        session.enriched += 1;
      }
    }
  }

  const workers = Array.from({ length: SCAN_CONCURRENCY }, () => worker());

  try {
    await discover(session.root);
  } finally {
    discoveryDone = true;
    wake();
  }

  await Promise.all(workers);
  throwIfScanCanceled(scanState);

  // 收尾复核：标识符对不上的错配会被拆开，被拆的 MOV 重新放回格子。
  const items = session.slots.filter(Boolean);
  items.push(...(await linkLivePhotoCompanions(session)));
  items.sort((a, b) => a.takenAtMs - b.takenAtMs);
  const { folders, uncategorizedCount } = buildFolderTree(items);
  signatureEntries.sort();
  const treeSignature = signatureEntries.length
    ? crypto
        .createHash('sha1')
        .update(signatureEntries.join('\n'))
        .digest('hex')
    : null;

  const library = {
    root: session.root,
    treeSignature,
    items,
    byId: new Map(
      [...session.byId.values()].map((item) => [item.id, item])
    ),
    folders,
    uncategorizedCount,
    scannedAt: new Date().toISOString(),
  };

  publishLibrary(session, library, { fromIndex: false });
  libraryCache = library;
  await writeLibraryIndex(library);

  return library;
}

// 用户切换文件夹或刷新时，已经排队的请求不应该再重复启动扫描。
function startStream(options = {}) {
  if (streamStart) {
    return streamStart;
  }

  streamStart = startStreamInternal(options).finally(() => {
    streamStart = null;
  });

  return streamStart;
}

// 给路由层用的入口：refresh=1 时强制重扫（目录签名没变则直接复用索引）。
async function startLibraryStream({ force = false } = {}) {
  const session = await startStream({ force });

  return {
    root: session.root,
    phase: session.phase,
    revision: session.revision,
  };
}

async function startStreamInternal({ force = false } = {}) {
  const root = await getPhotoRoot();

  if (stream && stream.root !== root) {
    cancelCurrentScan();
    stream = null;
  }

  // 没有强制刷新时，扫描中 / 已完成 / 已取消的会话都可以直接复用。
  if (stream && !force && stream.phase !== 'error') {
    return stream;
  }

  if (stream && stream.phase === 'scanning') {
    cancelCurrentScan();
    await stream.task?.catch(() => {});
    stream = null;
  }

  const session = createStreamSession(root);
  stream = session;

  // 1) 内存里已经有同一文件夹的完整结果
  if (!force && libraryCache && libraryCache.root === root) {
    publishLibrary(session, libraryCache, { fromIndex: false });
    return session;
  }

  // 2) 读索引，秒开
  if (!force) {
    const indexed = await loadLibraryIndex(root);

    if (indexed) {
      publishLibrary(session, indexed, { fromIndex: true });
      libraryCache = session.library;

      if (Number(indexed.indexVersion) < LIBRARY_INDEX_VERSION) {
        session.library.indexVersion = LIBRARY_INDEX_VERSION;
        await writeLibraryIndex(session.library);
      }

      return session;
    }
  }

  // 3) 强制刷新时先比目录签名：没变化就直接复用旧结果
  const previous =
    libraryCache?.root === root
      ? libraryCache
      : await loadLibraryIndex(root).catch(() => null);

  if (previous?.treeSignature) {
    const signature = await buildDirectorySignature(root).catch(() => null);

    if (signature && signature === previous.treeSignature) {
      publishLibrary(session, previous, { fromIndex: true });
      libraryCache = session.library;
      return session;
    }
  }

  if (previous) {
    session.previous = previous;
  }

  // 4) 冷扫描：边发现边解析
  session.phase = 'scanning';
  session.startedAt = Date.now();
  session.revision = nextRevision();
  session.task = runStreamingScan(session, previous || null).catch((error) => {
    if (error?.code === 'SCAN_CANCELED') {
      // 取消时保留已经填好的格子，前端还能继续看已扫描的部分。
      session.phase = 'canceled';
      session.finishedAt = Date.now();
      return null;
    }

    session.phase = 'error';
    session.error = error?.message || String(error);
    session.finishedAt = Date.now();
    return null;
  }).finally(() => {
    if (activeScan === session.scanState) {
      activeScan = null;
    }
  });

  return session;
}

async function getStreamSummary(
  filter = 'all',
  { foldersToken = null } = {}
) {
  const session = stream || (await startStream({}));
  const { key, view, ready } = resolveView(session, filter);

  // 年/月目录也是"边扫边长"：扫描期就用已经解析出来的条目建树，
  // 否则用户选了一个几万张的大相册时要等整轮扫完才看到时间目录。
  const tree = ready
    ? { folders: session.folders, uncategorizedCount: session.uncategorizedCount }
    : getScanFolders(session);
  const nextFoldersToken = scanFoldersToken(
    tree.folders,
    tree.uncategorizedCount
  );
  const foldersChanged =
    ready || nextFoldersToken !== foldersToken;

  // 概览里的照片/视频数量：一次线性统计，扫描期相当于"已读到的部分"。
  let imageCount = 0;
  let videoCount = 0;

  for (const item of view.items) {
    if (!item) {
      continue;
    }

    if (item.type === 'image') {
      imageCount += 1;
    } else {
      videoCount += 1;
    }
  }

  return {
    root: session.root,
    revision: session.revision,
    phase: session.phase,
    scanning: session.phase === 'scanning',
    grouped: ready,
    order: ready ? 'date' : 'scan',
    filter: key,
    filterSupported: true,
    total: view.items.length,
    filled: ready ? view.items.length : session.filled,
    imageCount,
    videoCount,
    discovered: session.discovered,
    enriched: session.enriched,
    days: ready ? view.days.length : 0,
    // 扫描期不做按日期分组：前端据此知道"这段是占位块，不是日期分组"
    partialDays: false,
    // 目录树是"整个图库"的属性，不随当前过滤变化；内容没变就不重复传。
    folders: foldersChanged ? tree.folders : undefined,
    foldersToken: nextFoldersToken,
    uncategorizedCount: tree.uncategorizedCount,
    libraryTotal: ready ? session.view.items.length : session.slots.length,
    scannedAt: session.scannedAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    fromIndex: session.fromIndex,
    error: session.error,
  };
}

// 第一个还没解析出来的格子。扫描期"已解析前缀"就是 [0, firstEmpty)。
function firstEmptySlot(slots) {
  let index = 0;

  while (index < slots.length && slots[index]) {
    index += 1;
  }

  return index;
}

// 扫描期不做"按日期分组"（照片先按发现顺序铺占位格，扫完再分成一天一组）：
// 边扫边分组意味着每轮都要重算分段、前端还要跟着改已经铺好的块，
// 实测确认过它会让加载/滚动"有点发涩"，所以这块功能整体去掉了。

// 扫描期的年/月目录：只用"已经解析出来"的条目建树，边扫边长。
// 用户选一个几万张的大相册时，时间目录几秒内就该出来，而不是等整轮扫完。
// 按 (已解析数, 已发现数) 缓存，一轮只算一次。
function getScanFolders(session) {
  const cached = session.scanFoldersCache;

  if (
    cached &&
    cached.filled === session.filled &&
    cached.discovered === session.discovered
  ) {
    return cached;
  }

  const { folders, uncategorizedCount } = buildFolderTree(
    session.slots.filter(Boolean)
  );

  session.scanFoldersCache = {
    filled: session.filled,
    discovered: session.discovered,
    folders,
    uncategorizedCount,
  };

  return session.scanFoldersCache;
}

function scanFoldersToken(folders, uncategorizedCount = 0) {
  const hash = crypto.createHash('sha1');

  // 注意把"未分类"的张数也算进指纹：只有未分类在变的目录树同样要通知前端，
  // 否则侧栏会停在上一轮的"还没有识别到年份目录"上。
  hash.update(`unclassified:${uncategorizedCount};`);

  for (const year of folders || []) {
    hash.update(`${year.key}:${year.count};`);

    for (const month of year.months || []) {
      hash.update(`${month.key}:${month.count};`);
    }
  }

  return hash.digest('hex').slice(0, 16);
}

// 扫描期的过滤视图：年/月入口在扫描期也必须能用。
// 只筛"已经解析完的前缀" [0, firstEmpty)：这样过滤后的下标是**只往后追加**的，
// 不会因为中间某一格后解析出来而让前面所有照片挪位（挪位会让前端窗口数据错位）。
function getScanFilteredItems(session, key) {
  const stamp = `${session.filled}:${session.discovered}`;
  const cached = session.scanViews.get(key);

  if (cached && cached.stamp === stamp) {
    return cached.items;
  }

  const prefix = session.slots.slice(0, firstEmptySlot(session.slots));
  const items = prefix.filter((item) => item && matchesFolder(item, key));

  session.scanViews.set(key, { stamp, items });

  return items;
}

// 扫描期不做按日期分组：days 一律返回空表，前端就用纯占位块铺格子。
async function getStreamDays(filter = 'all') {
  const session = stream || (await startStream({}));

  if (session.phase !== 'ready') {
    return {
      revision: session.revision,
      phase: session.phase,
      filter: filter && filter !== 'all' ? filter : 'all',
      total:
        filter && filter !== 'all'
          ? getScanFilteredItems(session, filter).length
          : session.slots.length,
      partial: true,
      days: [],
    };
  }

  const { key, view } = resolveView(session, filter);

  return {
    revision: session.revision,
    phase: session.phase,
    filter: key,
    total: view.items.length,
    partial: false,
    days: view.days.map((day) => ({
      key: day.key,
      count: day.count,
      itemStart: day.itemStart,
      city: day.city,
    })),
  };
}

async function getStreamItems({ offset = 0, limit = 200, filter = 'all' } = {}) {
  const session = stream || (await startStream({}));
  const { key, view, ready } = resolveView(session, filter);
  const list = view.items;
  const start = Math.max(
    0,
    Math.min(Math.floor(Number(offset) || 0), list.length)
  );
  const size = Math.max(
    0,
    Math.min(Math.floor(Number(limit) || 0), MAX_STREAM_PAGE)
  );

  return {
    revision: session.revision,
    phase: session.phase,
    order: ready ? 'date' : 'scan',
    filter: key,
    total: list.length,
    filled: ready ? list.length : session.filled,
    offset: start,
    limit: size,
    items: list.slice(start, start + size).map(toPublicItem),
  };
}

// 打开查看器时的上一个 / 下一个，由服务端在全量顺序里算，
// 这样前端不需要为了翻页而把整个图库都拿下来。
async function getStreamNeighbors(id, filter = 'all') {
  const session = stream || (await startStream({}));

  if (session.phase !== 'ready') {
    return null;
  }

  const { key, view } = resolveView(session, filter);
  const index = view.indexById.get(id);

  if (typeof index !== 'number') {
    return null;
  }

  return {
    revision: session.revision,
    filter: key,
    index,
    total: view.items.length,
    previous: index > 0 ? toPublicItem(view.items[index - 1]) : null,
    next:
      index + 1 < view.items.length
        ? toPublicItem(view.items[index + 1])
        : null,
  };
}

async function getStreamItemsByIds(ids = []) {
  const session = stream || (await startStream({}));
  const list = Array.isArray(ids) ? ids : String(ids).split(',');

  return list
    .map((id) => session.byId.get(String(id).trim()))
    .map(toPublicItem);
}

// 缩略图 / 预览 / 播放请求只需要一项，不应该等整轮扫描。
async function getItemById(id) {
  if (typeof id !== 'string' || !id) {
    return null;
  }

  const session = stream || (await startStream({}));
  return session.byId.get(id) || null;
}

async function writeLibraryIndex(library) {
  // 索引里要带上伴随视频（带 livePhotoCompanion 标记），
  // 这样从索引秒开时 /api/video/<id> 依然拿得到实况照片的视频。
  const companions =
    library.byId instanceof Map
      ? [...library.byId.values()].filter((item) => item.livePhotoCompanion)
      : [];

  const payload = {
    version: LIBRARY_INDEX_VERSION,
    root: library.root,
    treeSignature: library.treeSignature,
    scannedAt: library.scannedAt,
    folders: library.folders,
    uncategorizedCount: library.uncategorizedCount,
    items: companions.length
      ? [...library.items, ...companions]
      : library.items,
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
    ![2, 3, LIBRARY_INDEX_VERSION].includes(indexVersion) ||
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

  const allItems = parsed.items;

  if (
    !allItems.every(
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

  // v3 及以前索引里实况照片是"图片 + MOV"两个独立条目：读进来时补一次配对，
  // 这样老用户不用为了这个功能重新扫一遍几万张照片。
  const needsRelink =
    indexVersion < LIVE_PHOTO_INDEX_VERSION ||
    allItems.some(
      (item) => item.livePhoto === undefined && item.livePhotoCompanion === undefined
    );
  const { items, companions } = needsRelink
    ? await relinkLivePhotosInItems(allItems)
    : {
        items: allItems.filter((item) => !item.livePhotoCompanion),
        companions: allItems.filter((item) => item.livePhotoCompanion),
      };

  // 老索引的年/月张数把伴随视频也算进去了，配完对之后要按"格子里的项目"重算。
  const tree = needsRelink
    ? buildFolderTree(items)
    : {
        folders: parsed.folders,
        uncategorizedCount: Number(parsed.uncategorizedCount) || 0,
      };

  return {
    root,
    indexVersion,
    treeSignature,
    items,
    byId: new Map(
      [...items, ...companions].map((item) => [item.id, item])
    ),
    folders: tree.folders,
    uncategorizedCount: tree.uncategorizedCount,
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

// 兼容旧调用（/api/photos、地图页）：等会话真正就绪后返回完整图库。
// 2.0 的新前端不会再走这里，而是用 summary / days / items 分页取数。
async function getLibrary(force = false) {
  const session = await startStream({ force });

  if (session.phase === 'ready' && session.library) {
    return session.library;
  }

  if (session.task) {
    // 扫描还没结束：旧的 /api/photos 语义就是"等全部完成"。
    await session.task;
  }

  if (session.phase === 'ready' && session.library) {
    return session.library;
  }

  if (session.phase === 'canceled') {
    throw createScanCanceledError();
  }

  throw new Error(session.error || '扫描照片文件夹失败');
}

function clearLibraryCache() {
  libraryCache = null;
  cancelCurrentScan();
  libraryBuild = null;
  libraryBuildRoot = null;
  // 丢掉流式会话：下一次请求会按新的照片文件夹重新建会话。
  stream = null;
  streamStart = null;
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
  const groups = {};

  for (const [key, directories] of Object.entries(CACHE_GROUPS)) {
    let bytes = 0;
    let files = 0;

    for (const directory of directories) {
      const info = await measureDirectory(directory);
      bytes += info.bytes;
      files += info.files;
    }

    groups[key] = { bytes, files };
  }

  const all = await measureDirectory(CACHE_DIR);

  return {
    // 兼容旧的单值字段：bytes / files 一直是"全部缓存"
    bytes: all.bytes,
    files: all.files,
    all,
    ...groups,
  };
}

// 缓存分成三档，对应界面上三个按钮：
//   thumbnails —— 照片墙/视频封面用的小图，删了下次浏览会重新生成（大相册会重算一轮）
//   media      —— 打开过的图片预览大图和视频转码结果，删了下次打开重新生成
//   all        —— 整个 cache 目录（还包括 PotPlayer 播放列表这种零碎文件）
const CACHE_GROUPS = {
  thumbnails: [THUMBS_DIR],
  media: [PREVIEWS_DIR, VIDEOS_DIR],
};

const CACHE_CLEAR_KINDS = new Set(['thumbnails', 'media', 'all']);

// 清理串行执行：连着点两个按钮时各自返回自己的结果，不会互相打断。
let cacheClearQueue = Promise.resolve();

function clearCache(kind = 'all') {
  if (!CACHE_CLEAR_KINDS.has(kind)) {
    const error = new Error('不认识的缓存类型');
    error.status = 400;
    return Promise.reject(error);
  }

  const task = cacheClearQueue.then(() => clearCacheKind(kind));
  cacheClearQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function clearCacheKind(kind) {
  const directories = kind === 'all' ? [CACHE_DIR] : CACHE_GROUPS[kind];

  for (const directory of directories) {
    await fsp.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 120,
    });
  }

  // 缩略图目录里还放着"缓存版本标记"，删掉之后要重新走一次准备流程。
  if (kind === 'all' || kind === 'thumbnails') {
    thumbnailCacheReady = null;
  }

  await fsp.mkdir(CACHE_DIR, { recursive: true });
  return getCacheInfo();
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
    // v2：HEIC 的预览原来丢了色彩配置（P3 当 sRGB 显示，颜色偏），
    // 换后缀让老预览不再被命中（旧的会变成孤儿文件，用"清理缓存"能清掉）。
    suffix: 'preview-v2',
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
  // 2.0 流式接口
  getItemById,
  startLibraryStream,
  getStreamSummary,
  getStreamDays,
  getStreamItems,
  getStreamNeighbors,
  getStreamItemsByIds,
  toPublicItem,
};
