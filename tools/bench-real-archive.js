// 真实相册冷扫描体检：拿你自己的大相册跑一遍，看扫描耗时、实况照片合并了多少对。
//
//   node tools/bench-real-archive.js "E:\01\0101\iphone13总"
//   pnpm bench:real "E:\01\0101\iphone13总"
//
// 和 bench-scan 的区别：那个用生成的假图片量吞吐，这个直接扫真实相册。
// 数据写进 test-runtime/live-real，不碰 data\settings.json 里正在用的图库。
//
// 输出：侧栏目录出现时间、第一张照片时间、扫描完成时间、可见格子数、
//       实况照片对数（以及被隐藏的 MOV 数）、实况视频首播耗时。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'live-real');
const ARCHIVE = process.argv[2] || process.env.LIVE_REAL_ROOT || '';

if (!ARCHIVE) {
  console.error('用法：node tools/bench-real-archive.js <相册根目录>');
  process.exit(1);
}

process.env.MY_ALBUM_DATA_DIR = path.join(RUNTIME, 'data');
process.env.MY_ALBUM_CACHE_DIR = path.join(RUNTIME, 'cache');
process.env.MY_ALBUM_DEFAULT_PHOTOS = ARCHIVE;

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(ARCHIVE)) {
    console.error(`相册根目录不存在：${ARCHIVE}`);
    process.exit(1);
  }

  fs.rmSync(path.join(RUNTIME, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(RUNTIME, 'cache'), { recursive: true, force: true });

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const startedAt = Date.now();

  let firstTreeMs = null;
  let firstItemMs = null;
  let summary = null;
  let samples = 0;

  for (let attempt = 0; attempt < 4000; attempt += 1) {
    summary = await request(port, '/api/library/summary');
    samples += 1;

    if (
      firstTreeMs === null &&
      Array.isArray(summary.folders) &&
      summary.folders.length
    ) {
      firstTreeMs = Date.now() - startedAt;
    }

    if (firstItemMs === null && summary.total > 0) {
      firstItemMs = Date.now() - startedAt;
    }

    if (['ready', 'canceled', 'error'].includes(summary.phase)) {
      break;
    }

    await delay(400);
  }

  const readyMs = Date.now() - startedAt;
  const index = JSON.parse(
    fs.readFileSync(path.join(RUNTIME, 'data', 'library-index.json'), 'utf8')
  );
  const liveImages = index.items.filter((item) => item.livePhoto);
  const companions = index.items.filter((item) => item.livePhotoCompanion);
  const images = index.items.filter(
    (item) => !item.livePhotoCompanion && item.type === 'image'
  );
  const videos = index.items.filter(
    (item) => !item.livePhotoCompanion && item.type === 'video'
  );
  const durations = liveImages
    .map((item) => item.liveVideoDuration)
    .filter((value) => Number.isFinite(value));

  console.log('');
  console.log('=== 真实相册冷扫描体检 ===');
  console.log(`相册根目录     ${ARCHIVE}`);
  console.log(`轮询次数       ${samples}`);
  console.log(
    `侧栏目录出现   ${firstTreeMs === null ? '没有年份目录（全是未分类）' : `${firstTreeMs} ms`}`
  );
  console.log(`第一张照片     ${firstItemMs} ms`);
  console.log(`扫描完成       ${readyMs} ms（${summary.phase}）`);
  console.log(
    `索引文件       全部 ${index.items.length} 个文件 → 可见格子 ${
      index.items.length - companions.length
    } 个`
  );
  console.log(`格子构成       照片 ${images.length} / 视频 ${videos.length}`);
  console.log(
    `实况照片       ${liveImages.length} 对（合并掉了 ${companions.length} 个 MOV）`
  );
  console.log(
    `实况视频时长   平均 ${(
      durations.reduce((sum, value) => sum + value, 0) / (durations.length || 1)
    ).toFixed(2)} 秒（${durations.length} 个有数据）`
  );

  // 抽一个真实实况照片，量一下首播（HEVC → H.264 转码）要多久
  const one = liveImages.find((item) => item.liveVideoUrl);

  if (one) {
    const videoStarted = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}${one.liveVideoUrl}`);
    const buffer = await response.arrayBuffer();
    console.log(
      `实测播放       ${one.name} → ${response.status} ${response.headers.get(
        'content-type'
      )} ${Math.round(buffer.byteLength / 1024)} KB，${Date.now() - videoStarted} ms`
    );
  }

  console.log('');
  await new Promise((resolve) => server.close(resolve));
})();