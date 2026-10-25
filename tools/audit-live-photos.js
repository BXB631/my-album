// 实况照片配对体检：不改任何东西，只报告"哪些图片和 MOV 会被判成一对、凭什么"。
//
//   node tools/audit-live-photos.js <相册根目录> [--verify 40]
//
// 判据（和 lib/media.js 里的实现一致）：
//   1. 同一个文件夹里、同名的 HEIC/JPG + MOV 是候选对；
//   2. 视频里的 com.apple.quicktime.content.identifier 和图片里的 UUID 一致 → 确认；
//   3. 两边都有标识但不一样 → 不配对（避免同名巧合）。
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');

const IMAGE_EXT = new Set(['.heic', '.heif', '.hif', '.jpg', '.jpeg']);
const VIDEO_EXT = new Set(['.mov']);
const HEADER_BYTES = 256 * 1024;
const UUID_RE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

const FFMPEG = (() => {
  try {
    return path.join(
      path.dirname(require.resolve('@ffmpeg-installer/win32-x64/package.json')),
      'ffmpeg.exe'
    );
  } catch {
    return null;
  }
})();

function stemOf(name) {
  return path.parse(name).name.toLowerCase();
}

function videoStems(name) {
  const stem = stemOf(name);
  const keys = [stem];
  if (stem.endsWith('_hevc') && stem.length > 5) keys.push(stem.slice(0, -5));
  return keys;
}

async function imageIdentifiers(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('latin1');
    return [...new Set(text.match(UUID_RE) || [])].map((id) => id.toLowerCase());
  } finally {
    await handle.close();
  }
}

// 注意：ffmpeg 的输出必须落到文件，不能用管道接（沙箱里 spawn 管道会 EPERM）。
async function videoIdentifier(file) {
  if (!FFMPEG) return null;

  const directory = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'audit-live-'));
  const logPath = path.join(directory, 'probe.log');
  const logFd = fs.openSync(logPath, 'w');

  try {
    await new Promise((resolve) => {
      const child = spawn(FFMPEG, ['-hide_banner', '-i', file], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', logFd],
      });
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    });

    const output = await fsp.readFile(logPath, 'latin1');
    const match = output.match(
      /com\.apple\.quicktime\.content\.identifier:\s*([0-9A-Za-z_-]{16,64})/
    );
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // 已经关掉了
    }
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function walk(directory, onDirectory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  await onDirectory(directory, files);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      await walk(path.join(directory, entry.name), onDirectory);
    }
  }
}

async function main() {
  const root = process.argv[2];
  if (!root) {
    console.error('用法：node tools/audit-live-photos.js <相册根目录> [--verify 40]');
    process.exitCode = 1;
    return;
  }
  const verifyAt = process.argv.indexOf('--verify');
  const verifyLimit = verifyAt >= 0 ? Number(process.argv[verifyAt + 1]) || 20 : 20;

  const pairs = [];
  let directories = 0;

  await walk(root, async (directory, files) => {
    directories += 1;
    files.sort();
    const images = new Map();
    const videos = new Map();
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      if (IMAGE_EXT.has(ext)) {
        const stem = stemOf(name);
        if (!images.has(stem)) images.set(stem, name);
      } else if (VIDEO_EXT.has(ext)) {
        for (const stem of videoStems(name)) {
          if (!videos.has(stem)) videos.set(stem, name);
        }
      }
    }
    const used = new Set();
    for (const [stem, image] of images) {
      const video = videos.get(stem);
      if (!video || used.has(video)) continue;
      used.add(video);
      pairs.push({ directory, image, video });
    }
  });

  console.log(`目录数 ${directories}，按文件名认定的候选对 ${pairs.length} 对`);
  console.log('');

  const stats = { match: 0, imageNoId: 0, videoNoId: 0, bothNoId: 0, mismatch: 0 };
  const mismatches = [];

  for (const pair of pairs.slice(0, verifyLimit)) {
    const [imageIds, videoId] = await Promise.all([
      imageIdentifiers(path.join(pair.directory, pair.image)),
      videoIdentifier(path.join(pair.directory, pair.video)),
    ]);

    let verdict;
    if (!videoId && !imageIds.length) verdict = 'bothNoId';
    else if (!videoId) verdict = 'videoNoId';
    else if (!imageIds.length) verdict = 'imageNoId';
    else if (imageIds.includes(videoId)) verdict = 'match';
    else verdict = 'mismatch';

    stats[verdict] += 1;
    if (verdict === 'mismatch') mismatches.push({ ...pair, videoId, imageIds });
    console.log(
      `${verdict.padEnd(10)} ${pair.image} + ${pair.video}  video=${videoId || '-'} image=${imageIds.length ? imageIds.join(',') : '-'}`
    );
  }

  console.log('');
  console.log(`抽查 ${Math.min(verifyLimit, pairs.length)} 对：`, stats);
  if (mismatches.length) {
    console.log('标识不一致（这些不会配对）：');
    for (const item of mismatches) {
      console.log(`  ${path.join(item.directory, item.image)}`);
    }
  }
}

main();