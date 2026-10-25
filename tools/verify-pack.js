// 打包后的深度验证：用**打包好的载荷**（build\pack\staging）真跑一遍重活 ——
// HEIC 预览（sharp + HEIC 解码 worker + ICC 色彩修复）、视频封面（ffmpeg），
// 并确认缓存 / 索引确实落在安装目录里。
//
//   node tools/verify-pack.js [照片目录]     # 不给就默认用工作区的 testmedia\
//
// 这是 tools/pack.js 那套自检之外的"额外一道"：pack 的自检主要探接口，
// 这个会真的解码一张 HEIC、生成一张视频封面。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'build', 'pack', 'staging');
const photos = process.argv[2] || path.join(ROOT, '..', 'testmedia');
const port = 3311;

function get(pathname, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, timeout: 30000 },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            body: Buffer.concat(chunks),
            json: raw ? null : null,
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const child = spawn(path.join(STAGING, 'runtime', 'node.exe'), ['server.js'], {
    cwd: path.join(STAGING, 'app'),
    env: {
      ...process.env,
      PORT: String(port),
      MY_ALBUM_INSTALL_DIR: STAGING,
      MY_ALBUM_DEFAULT_PHOTOS: photos,
      MY_ALBUM_LOG_FILE: path.join(STAGING, 'cache', 'verify.log'),
    },
    stdio: 'ignore',
  });

  let failure = null;

  try {
    // 等扫描完成
    let summary = null;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await delay(1000);

      try {
        const res = await get('/api/library/summary');
        summary = JSON.parse(res.body.toString('utf8'));

        if (summary && summary.total > 0 && !summary.scanning) {
          break;
        }
      } catch {
        // 还没起来
      }
    }

    console.log(
      `扫描：total=${summary?.total} scanning=${summary?.scanning} ` +
        `（fromIndex=${summary?.fromIndex}）`
    );

    const items = JSON.parse(
      (await get('/api/library/items?offset=0&limit=400')).body.toString('utf8')
    ).items;

    const heic = items.find((item) => /\.(heic|heif)$/i.test(item.name));
    const video = items.find((item) => item.type === 'video');

    console.log(`样本：HEIC=${heic?.name} 视频=${video?.name}`);

    if (heic) {
      const startedAt = Date.now();
      const preview = await get(`/api/preview/${encodeURIComponent(heic.id)}`);
      const ms = Date.now() - startedAt;
      const head = preview.body.subarray(0, 2).toString('hex');

      console.log(
        `HEIC 预览：HTTP ${preview.status} ${preview.type} ` +
          `${(preview.body.length / 1048576).toFixed(2)} MB，JPEG 头=${head}，耗时 ${ms} ms`
      );

      if (preview.status !== 200 || head !== 'ffd8') {
        failure = 'HEIC 预览没有产出 JPEG';
      }
    }

    if (video) {
      const poster = await get(`/api/thumb/${encodeURIComponent(video.id)}`);

      console.log(
        `视频封面（ffmpeg）：HTTP ${poster.status} ${poster.type} ` +
          `${(poster.body.length / 1024).toFixed(0)} KB`
      );

      if (poster.status !== 200) {
        failure = '视频封面生成失败';
      }
    }

    const cacheInfo = JSON.parse((await get('/api/cache')).body.toString('utf8'));

    console.log(
      `缓存目录（应在安装目录下）：${cacheInfo.bytes} 字节 / ${cacheInfo.files} 个文件`
    );

    const onDisk = fs.existsSync(path.join(STAGING, 'cache', 'previews'));
    const dataOnDisk = fs.existsSync(path.join(STAGING, 'data'));

    console.log(`staging\\cache\\previews 存在=${onDisk}  staging\\data 存在=${dataOnDisk}`);

    if (!onDisk || !dataOnDisk) {
      failure = '缓存/索引没有落在安装目录里';
    }
  } catch (error) {
    failure = error.message;
  } finally {
    child.kill();
    await delay(500);

    // 验证会在载荷里留下缓存和索引，收工前清掉，免得它们被打进安装包
    for (const name of ['cache', 'data']) {
      fs.rmSync(path.join(STAGING, name), { recursive: true, force: true });
    }
  }

  console.log(failure ? `\n✗ ${failure}` : '\n✓ 打包载荷的重活全部通过');

  if (failure) {
    process.exitCode = 1;
  }
})();