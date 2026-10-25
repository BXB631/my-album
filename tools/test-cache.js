// 2.0 缓存清理测试：三档（缩略图 / 打开的图片视频 / 全部）各清各的
//
//   node tools/test-cache.js
//
// 验证的是"清理分档"这件事本身：
//   1. /api/cache 分别报出三档的占用（缩略图、打开的图片视频、全部）；
//   2. 清缩略图只删 thumbnails/，预览图和视频缓存原样保留；
//   3. 清"打开的图片/视频"只删 previews/ + videos/，缩略图原样保留；
//   4. 清全部把整个 cache 清空（连播放列表这种零碎文件也一起）；
//   5. 清完之后缩略图能重新生成（缓存版本标记要跟着重置）；
//   6. 不认识的 kind 返回 400，且什么都不删。
//
// 照片、数据和缓存都放在 test-runtime/cache 下，不碰真实图库和真实缓存。

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'cache');
const PHOTOS = path.join(RUNTIME, 'photos');
const DATA = path.join(RUNTIME, 'data');
const CACHE = path.join(RUNTIME, 'cache');

// app-paths 在 require 时读环境变量，必须先设置再加载服务端代码。
process.env.MY_ALBUM_DATA_DIR = DATA;
process.env.MY_ALBUM_CACHE_DIR = CACHE;
process.env.MY_ALBUM_DEFAULT_PHOTOS = PHOTOS;

const failures = [];

function check(condition, message, detail) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }

  failures.push(message);
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, urlPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const clientRequest = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.length,
            }
          : {},
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );

    clientRequest.on('error', reject);

    if (payload) {
      clientRequest.write(payload);
    }

    clientRequest.end();
  });
}

async function getJson(port, urlPath) {
  const response = await request(port, urlPath);
  let parsed = null;

  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    parsed = null;
  }

  return { status: response.status, data: parsed };
}

async function postJson(port, urlPath, body) {
  const response = await request(port, urlPath, { method: 'POST', body });
  let parsed = null;

  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    parsed = null;
  }

  return { status: response.status, data: parsed };
}

async function makePhoto() {
  const sharp = require('sharp');
  const buffer = await sharp({
    create: {
      width: 96,
      height: 72,
      channels: 3,
      background: { r: 90, g: 140, b: 190 },
    },
  })
    .jpeg({ quality: 72 })
    .toBuffer();

  const directory = path.join(PHOTOS, '2026', '202607');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, 'IMG_0001.jpg'), buffer);
}

function countFiles(directory) {
  try {
    return fs.readdirSync(directory).length;
  } catch {
    return 0;
  }
}

async function waitForReady(port) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { data } = await getJson(port, '/api/library/summary');

    if (data && ['ready', 'canceled', 'error'].includes(data.phase)) {
      return data;
    }

    await delay(50);
  }

  return null;
}

async function main() {
  console.log('2.0 缓存清理测试（三档）');

  await fsp.rm(RUNTIME, { recursive: true, force: true });
  await makePhoto();

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    const summary = await waitForReady(port);
    check(summary?.phase === 'ready', '服务起来了并扫完了 1 张照片', `phase=${summary?.phase}`);

    const page = await getJson(port, '/api/library/items?offset=0&limit=1');
    const item = page.data?.items?.[0];
    check(Boolean(item), '取到了那张照片');

    // --- 造出三档缓存 ---------------------------------------------------
    console.log('\n[1] 三档占用分别报出来');

    const thumbResponse = await request(port, `/api/thumb/${item.id}`);
    check(thumbResponse.status === 200, '生成了一张缩略图', `status=${thumbResponse.status}`);

    const previewResponse = await request(port, `/api/preview/${item.id}`);
    check(previewResponse.status === 200, '生成了一张预览图', `status=${previewResponse.status}`);

    // 视频转码缓存和播放列表没法在测试里真跑（要 ffmpeg + PotPlayer），
    // 直接放两个占位文件，验证"清哪一档"的边界。
    await fsp.mkdir(path.join(CACHE, 'videos'), { recursive: true });
    await fsp.mkdir(path.join(CACHE, 'playlists'), { recursive: true });
    const fakeVideo = Buffer.alloc(64 * 1024, 7);
    await fsp.writeFile(path.join(CACHE, 'videos', 'fake-transcode.mp4'), fakeVideo);
    await fsp.writeFile(path.join(CACHE, 'playlists', 'fake.m3u'), '#EXTM3U\n');

    const info = await getJson(port, '/api/cache');
    const data = info.data;

    check(info.status === 200, '/api/cache 返回 200');
    check(
      data?.thumbnails?.bytes > 0 && data?.thumbnails?.files >= 1,
      '缩略图这一档有占用',
      `thumbnails=${data?.thumbnails?.bytes}B/${data?.thumbnails?.files}`
    );
    check(
      data?.media?.bytes > fakeVideo.length,
      '“打开的图片/视频”这一档 = 预览图 + 视频转码',
      `media=${data?.media?.bytes}B`
    );
    check(
      data?.all?.bytes >= data.media.bytes + data.thumbnails.bytes,
      '“全部”不小于前两档之和（还包含播放列表等）',
      `all=${data?.all?.bytes} 前两档=${data.media.bytes + data.thumbnails.bytes}`
    );
    check(
      data?.bytes === data?.all?.bytes && data?.files === data?.all?.files,
      '兼容字段 bytes/files 仍然等于全部缓存',
      `bytes=${data?.bytes} all=${data?.all?.bytes}`
    );

    // --- 只清缩略图 ----------------------------------------------------
    console.log('\n[2] 只清缩略图：预览图/视频缓存不能动');

    const clearedThumbs = await postJson(port, '/api/cache/clear', {
      kind: 'thumbnails',
    });
    await delay(50);

    check(clearedThumbs.status === 200, '清缩略图返回 200', `status=${clearedThumbs.status}`);
    check(
      countFiles(path.join(CACHE, 'thumbnails')) === 0,
      'thumbnails/ 里的文件被清空',
      `还剩 ${countFiles(path.join(CACHE, 'thumbnails'))} 个`
    );
    check(
      fs.existsSync(path.join(CACHE, 'videos', 'fake-transcode.mp4')),
      '视频转码缓存没有被误删'
    );
    check(
      fs.existsSync(path.join(CACHE, 'playlists', 'fake.m3u')),
      '播放列表没有被误删'
    );
    check(
      (clearedThumbs.data?.thumbnails?.bytes || 0) === 0,
      '返回里的缩略图占用变成 0',
      `thumbnails=${clearedThumbs.data?.thumbnails?.bytes}`
    );

    const previewFiles = countFiles(path.join(CACHE, 'previews'));
    check(previewFiles > 0, '预览图还在', `previews/ ${previewFiles} 个`);

    // --- 缩略图能重新生成 ----------------------------------------------
    console.log('\n[3] 清完之后缩略图还能重新生成');

    const regenerated = await request(port, `/api/thumb/${item.id}`);
    check(
      regenerated.status === 200 && regenerated.body.length > 0,
      '再次请求缩略图仍然 200（重新生成）',
      `status=${regenerated.status}`
    );
    check(
      countFiles(path.join(CACHE, 'thumbnails')) >= 1,
      'thumbnails/ 里重新出现了文件（版本标记跟着重置了）',
      `现在 ${countFiles(path.join(CACHE, 'thumbnails'))} 个`
    );

    const afterRegenerate = await getJson(port, '/api/cache');
    check(
      afterRegenerate.data?.thumbnails?.bytes > 0,
      '占用统计也跟着涨回来',
      `thumbnails=${afterRegenerate.data?.thumbnails?.bytes}B`
    );

    // --- 只清"打开的图片/视频" -----------------------------------------
    console.log('\n[4] 只清“打开的图片/视频”：缩略图要留着');

    const thumbsBefore = countFiles(path.join(CACHE, 'thumbnails'));
    const clearedMedia = await postJson(port, '/api/cache/clear', {
      kind: 'media',
    });
    await delay(50);

    check(clearedMedia.status === 200, '清“打开的图片/视频”返回 200');
    check(
      countFiles(path.join(CACHE, 'previews')) === 0,
      'previews/ 被清空',
      `还剩 ${countFiles(path.join(CACHE, 'previews'))} 个`
    );
    check(
      countFiles(path.join(CACHE, 'videos')) === 0,
      'videos/ 被清空',
      `还剩 ${countFiles(path.join(CACHE, 'videos'))} 个`
    );
    check(
      countFiles(path.join(CACHE, 'thumbnails')) === thumbsBefore,
      '缩略图一个都没少',
      `之前 ${thumbsBefore} 个，现在 ${countFiles(path.join(CACHE, 'thumbnails'))} 个`
    );
    check(
      fs.existsSync(path.join(CACHE, 'playlists', 'fake.m3u')),
      '播放列表仍在（它不属于这一档）'
    );
    check(
      (clearedMedia.data?.media?.bytes || 0) === 0,
      '返回里的这一档占用变成 0',
      `media=${clearedMedia.data?.media?.bytes}`
    );

    // --- 清全部 --------------------------------------------------------
    console.log('\n[5] 清全部：连零碎文件一起清掉');

    const clearedAll = await postJson(port, '/api/cache/clear', { kind: 'all' });
    await delay(50);

    check(clearedAll.status === 200, '清全部返回 200');
    check(
      fs.existsSync(CACHE) && countFiles(CACHE) === 0,
      'cache 目录还在但已经空了',
      `${CACHE} 下还有 ${countFiles(CACHE)} 项`
    );
    check(
      (clearedAll.data?.bytes || 0) === 0 && (clearedAll.data?.files || 0) === 0,
      '占用统计归零',
      `bytes=${clearedAll.data?.bytes} files=${clearedAll.data?.files}`
    );
    check(
      !fs.existsSync(path.join(CACHE, 'playlists', 'fake.m3u')),
      '播放列表也被清掉（全部就是全部）'
    );

    // --- 不带 kind 的旧调用 --------------------------------------------
    console.log('\n[6] 兼容与边界');

    const legacy = await postJson(port, '/api/cache/clear', null);
    check(legacy.status === 200, '不带 kind 的调用仍然可用（等于全部）', `status=${legacy.status}`);

    const bogus = await postJson(port, '/api/cache/clear', { kind: 'everything' });
    check(
      bogus.status === 400,
      '不认识的 kind 返回 400',
      `status=${bogus.status} body=${bogus.data?.error || ''}`
    );

    // 造点文件再确认 400 时什么都没删
    await fsp.mkdir(path.join(CACHE, 'videos'), { recursive: true });
    await fsp.writeFile(path.join(CACHE, 'videos', 'keep.mp4'), fakeVideo);
    await postJson(port, '/api/cache/clear', { kind: 'nope' });
    check(
      fs.existsSync(path.join(CACHE, 'videos', 'keep.mp4')),
      '400 的时候什么都没删',
      fs.existsSync(path.join(CACHE, 'videos', 'keep.mp4')) ? '' : '被删了'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('');

  if (failures.length) {
    console.error(`缓存清理测试失败 ${failures.length} 项：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('缓存清理测试全部通过。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});