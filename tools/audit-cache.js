// 缓存体检：把 cache\previews 和 cache\thumbnails 里的文件名反查回源照片。
//
//   node tools/audit-cache.js "D:\Pictures"
//   pnpm audit:cache "D:\Pictures"
//
// 用途：搞清"缓存里这个文件到底是哪张图产生的、为什么会多出来"。
// 缓存文件名 = sha1(`绝对路径|大小|修改时间` + 用途后缀)，所以能精确反查：
//   thumbnails 用 thumb-v3 后缀，previews 用 preview-v1 后缀。
//
// 只读，什么都不改。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PHOTOS = process.argv[2] || process.env.MY_ALBUM_DEFAULT_PHOTOS || '';
const CACHE =
  process.env.MY_ALBUM_CACHE_DIR || path.join(__dirname, '..', 'cache');

if (!PHOTOS || !fs.existsSync(PHOTOS)) {
  console.error('用法：node tools/audit-cache.js <相册根目录>');
  process.exit(1);
}

const SUFFIXES = [
  { directory: 'thumbnails', suffix: 'thumb-v3', label: '缩略图（照片墙小图）' },
  { directory: 'previews', suffix: 'preview-v1', label: '预览大图（打开图片时生成）' },
];

function cacheKey(signature, suffix) {
  return crypto
    .createHash('sha1')
    .update(`${signature}|${suffix}`)
    .digest('hex');
}

function walk(directory, files) {
  let entries;

  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
}

const files = [];
walk(PHOTOS, files);

console.log(`相册：${PHOTOS}`);
console.log(`文件数：${files.length}`);
console.log(`缓存：${CACHE}\n`);

for (const { directory, suffix, label } of SUFFIXES) {
  const target = path.join(CACHE, directory);
  let names = [];

  try {
    names = fs.readdirSync(target);
  } catch {
    console.log(`${label}：目录不存在（说明一次都没生成过）`);
    continue;
  }

  const index = new Map();

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }

    index.set(cacheKey(`${file}|${stat.size}|${stat.mtimeMs}`, suffix), file);
  }

  const byExt = new Map();
  const unmatched = [];
  let bytes = 0;

  for (const name of names) {
    const full = path.join(target, name);

    try {
      bytes += fs.statSync(full).size;
    } catch {
      // 刚好被删掉了
    }

    const source = index.get(name.replace(/\.(?:jpg|mp4)$/i, ''));

    if (!source) {
      unmatched.push(name);
      continue;
    }

    const ext = path.extname(source).toLowerCase() || '(无扩展名)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }

  console.log(
    `${label}：${names.length} 个文件 · ${(bytes / 1048576).toFixed(1)} MB`
  );
  console.log(
    `  能反查到源文件的扩展名：${byExt.size ? [...byExt].map(([k, v]) => `${k}=${v}`).join('  ') : '（无）'}`
  );
  console.log(
    `  反查不到源文件的：${unmatched.length} 个（源文件已改/已删，或来自别的相册）`
  );

  if (byExt.size) {
    console.log('  例子：');
    let shown = 0;
    for (const name of names) {
      const source = index.get(name.replace(/\.(?:jpg|mp4)$/i, ''));
      if (!source) continue;
      console.log(`    ${path.relative(PHOTOS, source)}`);
      shown += 1;
      if (shown >= 5) break;
    }
  }

  console.log('');
}

console.log('提示：浏览器原生支持的格式（JPG/PNG/WebP/GIF/BMP/AVIF）在查看器里走的是源文件，');
console.log('正常浏览不会生成预览大图；如果 previews 里出现了它们的名字，说明有代码路径又在请求预览。');