// 冷扫描吞吐基准：看扫描本身以及"客户端轮询"对它的影响。
//
//   node tools/bench-scan.js                     # 默认 3000 张、3 轮
//   node tools/bench-scan.js --images=1200 --runs=2
//   node tools/bench-scan.js --client            # 每轮轮询也模拟前端的取数负载
//
// 每一轮都清掉 data/（索引）重新冷扫，并且用同一个照片目录，
// 所以不同轮次之间的差异只来自被比较的那段代码。
//
// 扫描期已经**不做**按日期分组（这块功能去掉了），所以这里只量：
//   1. 冷扫描本身要多久；
//   2. 每轮 summary 轮询的耗时（服务端每轮只算"目录树 + 计数"）；
//   3. 加上 --client 时，把前端会做的 items 取数也算进去。
//
// 客户端渲染侧的开销见 tools/test-stream-dom.js。

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'bench');
const PHOTOS = path.join(RUNTIME, 'photos');
const DATA = path.join(RUNTIME, 'data');
const CACHE = path.join(RUNTIME, 'cache');

function readArg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const IMAGE_COUNT = readArg('images', 3000);
const RUNS = readArg('runs', 3);
const DAY_COUNT = 6;
// 客户端轮询节奏：每 400ms 一次 summary（和 public/photo-stream.js 保持一致）
const POLL_INTERVAL = 400;

process.env.MY_ALBUM_DATA_DIR = DATA;
process.env.MY_ALBUM_CACHE_DIR = CACHE;
process.env.MY_ALBUM_DEFAULT_PHOTOS = PHOTOS;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
          })
        );
      }
    );

    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

async function getJson(port, urlPath) {
  const response = await request(port, urlPath);
  let data = null;

  try {
    data = JSON.parse(response.body.toString('utf8'));
  } catch {
    data = null;
  }

  return data;
}

async function ensurePhotos() {
  const directory = path.join(PHOTOS, '2026', '202607');
  const existing = fs.existsSync(directory)
    ? await fsp.readdir(directory)
    : [];

  if (existing.length === IMAGE_COUNT) {
    return false;
  }

  await fsp.rm(PHOTOS, { recursive: true, force: true });
  await fsp.mkdir(directory, { recursive: true });

  const sharp = require('sharp');
  const buffer = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 210, g: 160, b: 120 },
    },
  })
    .jpeg({ quality: 70 })
    .toBuffer();

  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    const day = String((index % DAY_COUNT) + 5).padStart(2, '0');
    const name = `IMG_2026-07-${day}_10-${String(index % 60).padStart(
      2,
      '0'
    )}-${String(Math.floor(index / 60) % 60).padStart(2, '0')}_${String(
      index
    ).padStart(4, '0')}.jpg`;

    await fsp.writeFile(path.join(directory, name), buffer);
  }

  return true;
}

// 客户端那一侧的负载可以单独打开，用来验证"轮询本身会不会拖慢扫描"。
const CLIENT_PROFILE = process.argv.includes('--client') ? 'full' : 'summary';

function startPoller(port, onSample) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) {
      return;
    }

    const startedAt = Date.now();

    try {
      const summary = await getJson(port, '/api/library/summary');

      if (CLIENT_PROFILE === 'full' && summary) {
        // 前端扫描期真实会做的事：summary 拿进度 + 取可视窗口那一段数据
        await getJson(port, '/api/library/items?offset=0&limit=64');
        await getJson(port, '/api/library/items?offset=64&limit=64');
      }

      onSample(summary, Date.now() - startedAt);
    } catch {
      // 服务端已经关掉了（基准结束），轮询直接停
      stopped = true;
      return;
    }

    if (stopped) {
      return;
    }

    timer = setTimeout(tick, POLL_INTERVAL);
  }

  timer = setTimeout(tick, POLL_INTERVAL);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function wipe(directory) {
  // 服务端在 phase=ready 之后还会异步把索引写盘，紧接着就 rm 会撞上 EPERM，重试几次。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }

      await delay(120);
    }
  }
}

async function coldScan(port) {
  // 清掉索引和内存里的会话 → 下一次 summary 必然是真正的冷扫
  const { clearLibraryCache } = require('../lib/media.js');
  clearLibraryCache();
  await delay(200);
  await wipe(DATA);
  await wipe(CACHE);

  const pollStats = { count: 0, totalMs: 0, maxMs: 0, bytes: 0 };
  const stopPoller = startPoller(port, (summary, elapsedMs) => {
    pollStats.count += 1;
    pollStats.totalMs += elapsedMs;
    pollStats.maxMs = Math.max(pollStats.maxMs, elapsedMs);
    pollStats.bytes += JSON.stringify(summary || {}).length;
  });

  const startedAt = Date.now();
  let summary = await getJson(port, '/api/library/summary?refresh=1');

  while (summary && !['ready', 'canceled', 'error'].includes(summary.phase)) {
    await delay(50);
    summary = await getJson(port, '/api/library/summary');
  }

  const elapsed = Date.now() - startedAt;
  stopPoller();

  return {
    elapsed,
    total: summary?.total ?? 0,
    pollStats,
  };
}

async function main() {
  console.log(
    `冷扫描基准 · ${IMAGE_COUNT} 张 · ${RUNS} 轮 · 轮询=${CLIENT_PROFILE}`
  );

  const regenerated = await ensurePhotos();

  if (regenerated) {
    console.log(`已生成测试照片：${PHOTOS}`);
  } else {
    console.log(`复用已有测试照片：${PHOTOS}`);
  }

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const results = [];

  try {
    // 先热身一轮，把模块加载、sharp 初始化这些一次性成本摊掉
    await coldScan(port);

    for (let run = 1; run <= RUNS; run += 1) {
      const result = await coldScan(port);
      results.push(result);
      console.log(
        `  第 ${run} 轮：冷扫描 ${result.elapsed} ms（${result.total} 张）· ` +
          `轮询 ${result.pollStats.count} 次，平均 ${(
            result.pollStats.totalMs / Math.max(1, result.pollStats.count)
          ).toFixed(1)} ms，最慢 ${result.pollStats.maxMs} ms`
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const times = results.map((result) => result.elapsed).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const best = times[0];
  console.log(`  中位数 ${median} ms · 最快 ${best} ms`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});