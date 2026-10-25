// 2.0 流式加载冒烟测试
//
// 验证「边扫描边能看」这条核心行为，而不是只看最终结果：
//   node tools/test-stream.js            # 冷扫描：必须观察到中间态
//   node tools/test-stream.js --index     # 索引快开：必须立刻 ready
//   node tools/test-stream.js --cancel    # 扫描中取消：保留已扫描的部分
//
// 生成的照片、数据和缓存都放在 test-runtime/stream 下，不会碰用户的 %APPDATA%。
// 注意目录名不能以点开头：express 的 res.sendFile 默认拒绝路径里含点段的文件。

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'stream');
const PHOTOS = path.join(RUNTIME, 'photos');
const DATA = path.join(RUNTIME, 'data');
const CACHE = path.join(RUNTIME, 'cache');

const MODE = process.argv.includes('--index')
  ? 'index'
  : process.argv.includes('--cancel')
    ? 'cancel'
    : 'scan';
const IMAGE_COUNT = Number(process.env.TEST_IMAGE_COUNT) || 3000;
const DAY_COUNT = 6;

// app-paths 在 require 时读取环境变量，必须先设置再加载服务端代码。
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(port, urlPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request(
      { host: '127.0.0.1', port, path: urlPath, method },
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

async function makePhotos() {
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

  const directory = path.join(PHOTOS, '2026', '202607');
  await fsp.mkdir(directory, { recursive: true });

  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    const day = String((index % DAY_COUNT) + 5).padStart(2, '0');
    const minute = String(index % 60).padStart(2, '0');
    const second = String(Math.floor(index / 60) % 60).padStart(2, '0');
    const name = `IMG_2026-07-${day}_10-${minute}-${second}_${String(
      index
    ).padStart(4, '0')}.jpg`;

    await fsp.writeFile(path.join(directory, name), buffer);
  }
}

async function sampleUntilSettled(port, { limit = 400, interval = 60 } = {}) {
  const samples = [];

  for (let attempt = 0; attempt < limit; attempt += 1) {
    const { data } = await getJson(port, '/api/library/summary');
    samples.push(data);

    if (!data || ['ready', 'canceled', 'error'].includes(data.phase)) {
      break;
    }

    await delay(interval);
  }

  return samples;
}

async function runScanMode(port) {
  console.log('\n[1] 冷扫描：summary 必须立刻可用，并出现中间态');

  const scanStartedAt = Date.now();

  // 扫描期**不做**按日期分组（这是刻意的性能取舍）：照片先按发现顺序铺占位块，
  // 扫描完成后才分成一天一组。刚启动那一瞬间还没走完第一层目录，先等发现开始。
  let scanSummary = await getJson(port, '/api/library/summary');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((scanSummary.data?.total || 0) > 0) {
      break;
    }

    await delay(20);
    scanSummary = await getJson(port, '/api/library/summary');
  }

  const daysDuringScan = await getJson(port, '/api/library/days');
  const scanDays = daysDuringScan.data?.days || [];

  check(
    daysDuringScan.status === 200 && daysDuringScan.data?.partial === true,
    '扫描期 days 接口仍然是"部分结果"语义',
    `status=${daysDuringScan.status} partial=${daysDuringScan.data?.partial}`
  );
  check(
    scanDays.length === 0,
    '扫描期 days 返回空表（不做按日期分组）',
    `分段=${scanDays.length}`
  );

  const inline = await getJson(port, '/api/library/summary');
  check(
    inline.data?.partialDays === false && inline.data?.scanDays === undefined,
    'summary 里没有扫描期分段（partialDays=false）',
    `partialDays=${inline.data?.partialDays} scanDays=${inline.data?.scanDays}`
  );
  check(
    inline.data?.days === 0,
    'summary 里扫描期的 days 计数是 0',
    `days=${inline.data?.days}`
  );

  const startedAt = Date.now();
  const samples = await sampleUntilSettled(port);
  const scanMs = Date.now() - startedAt;
  const totalScanMs = Date.now() - scanStartedAt;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const intermediate = samples.find(
    (sample) =>
      sample &&
      sample.phase === 'scanning' &&
      sample.filled > 0 &&
      sample.filled < sample.total
  );

  check(Boolean(first), '首次 summary 有返回');
  check(
    typeof first?.total === 'number' && typeof first?.filled === 'number',
    '首次 summary 就带 total / filled 字段',
    `total=${first?.total} filled=${first?.filled}`
  );
  check(
    samples.some((sample) => sample.total > 0),
    '开始发现文件后 total 立刻大于 0（不用等扫描完）',
    samples[1] ? `第 2 次采样 total=${samples[1].total}` : ''
  );
  check(
    samples.every((sample) => sample.filled <= sample.total),
    '任何时刻 filled 都不超过 total（占位先于数据）'
  );
  check(
    samples.every(
      (sample, index) => index === 0 || sample.total >= samples[index - 1].total
    ),
    'total 只会增长，不会回退'
  );
  check(
    Boolean(intermediate),
    '扫描过程中出现了"已填 N / 共 M"的中间态（边扫边能看）',
    intermediate
      ? `filled=${intermediate.filled}/${intermediate.total}`
      : `${samples.length} 次采样都没抓到`
  );
  check(
    last?.phase === 'ready',
    '扫描最终进入 ready',
    `phase=${last?.phase} error=${last?.error || ''}`
  );
  check(
    last?.total === IMAGE_COUNT,
    `总数等于生成的张数（${IMAGE_COUNT}）`,
    `total=${last?.total}`
  );
  check(
    last?.filled === last?.total,
    'ready 后所有格子都已填充',
    `filled=${last?.filled} total=${last?.total}`
  );

  console.log(
    `  · 采样序列：${samples
      .slice(0, 12)
      .map((sample) => `${sample.filled}/${sample.total}${sample.phase === 'ready' ? '✓' : ''}`)
      .join(' → ')}${samples.length > 12 ? ' …' : ''}`
  );

  // 扫描期不做按日期分组：整轮采样里都不该看到任何分段
  const samplesWithSegments = samples.filter(
    (sample) => Array.isArray(sample?.scanDays) && sample.scanDays.length
  ).length;
  check(
    samplesWithSegments === 0,
    '整个扫描过程中都没有出现过扫描期分段（这条路径已经去掉）',
    `${samplesWithSegments} / ${samples.length} 个采样点带分段`
  );

  console.log(
    `  · 计时：${IMAGE_COUNT} 张冷扫描 ${scanMs} ms（从第一次请求算起 ${totalScanMs} ms），采样 ${samples.length} 次（每次间隔 60 ms）`
  );

  return last;
}

async function runPagingChecks(port, summary) {
  console.log('\n[2] 分页取数：只要窗口，不要全量');

  const page = await getJson(port, '/api/library/items?offset=0&limit=50');
  const items = page.data?.items || [];
  check(page.status === 200, 'items 接口返回 200', `status=${page.status}`);
  check(items.length === 50, 'limit=50 返回 50 条', `实际 ${items.length}`);
  check(
    items.every((item) => item && item.id && item.thumbUrl),
    '每条都带 id 和 thumbUrl',
    `缺字段 ${items.filter((item) => !item?.id || !item?.thumbUrl).length} 条`
  );
  check(
    page.data?.total === IMAGE_COUNT,
    '同一响应里带回 total，前端不需要再问一次',
    `total=${page.data?.total}`
  );

  const tail = await getJson(
    port,
    `/api/library/items?offset=${IMAGE_COUNT - 5}&limit=10`
  );
  check(
    tail.data?.items?.length === 5,
    '越界时只返回剩下的条数',
    `实际 ${tail.data?.items?.length}`
  );

  console.log('\n[3] 按天分组：days 只给元数据，条目仍然分页');
  const days = await getJson(port, '/api/library/days');
  const dayList = days.data?.days || [];
  const dayTotal = dayList.reduce((sum, day) => sum + day.count, 0);
  check(dayList.length === DAY_COUNT, `识别出 ${DAY_COUNT} 天`, `实际 ${dayList.length}`);
  check(dayTotal === IMAGE_COUNT, '每天的张数加起来等于总数', `${dayTotal}`);
  check(
    dayList.every((day, index) =>
      index === 0 ? day.itemStart === 0 : day.itemStart > dayList[index - 1].itemStart
    ),
    'itemStart 单调递增，可以直接换算成 offset'
  );

  console.log('\n[4] 翻页邻居：查看器不需要全量列表');
  const target = items[10];
  const neighbors = await getJson(
    port,
    `/api/library/neighbors/${encodeURIComponent(target.id)}`
  );
  check(neighbors.status === 200, 'neighbors 返回 200', `status=${neighbors.status}`);
  check(neighbors.data?.index === 10, 'index 正确', `index=${neighbors.data?.index}`);
  check(
    neighbors.data?.previous?.id === items[9]?.id &&
      neighbors.data?.next?.id === items[11]?.id,
    'previous / next 与顺序一致'
  );
  check(
    neighbors.data?.total === IMAGE_COUNT,
    'neighbors 带回总数，翻页到边界可判断',
    `total=${neighbors.data?.total}`
  );

  console.log('\n[5] 文件夹过滤在服务端做');
  const filtered = await getJson(
    port,
    '/api/library/items?folder=year-2026&offset=0&limit=5'
  );
  check(
    filtered.data?.total === IMAGE_COUNT,
    'year-2026 视图条数正确',
    `total=${filtered.data?.total}`
  );

  const summaryYear = await getJson(port, '/api/library/summary?folder=year-2026');
  check(
    summaryYear.data?.filter === 'year-2026',
    'summary 回显当前过滤条件',
    `filter=${summaryYear.data?.filter}`
  );

  console.log('\n[6] 单项请求不等整轮扫描');
  const thumb = await request(port, `/api/thumb/${encodeURIComponent(target.id)}`);
  check(thumb.status === 200, '缩略图 200', `status=${thumb.status}`);
  check(
    String(thumb.headers['content-type'] || '').includes('image/jpeg'),
    '缩略图是 image/jpeg',
    String(thumb.headers['content-type'])
  );

  console.log('\n[7] 旧接口保持兼容');
  const legacy = await getJson(port, '/api/photos');
  check(legacy.status === 200, '/api/photos 返回 200', `status=${legacy.status}`);
  check(
    legacy.data?.total === IMAGE_COUNT && legacy.data?.items?.length === IMAGE_COUNT,
    '/api/photos 仍然给出完整图库',
    `total=${legacy.data?.total} items=${legacy.data?.items?.length}`
  );
  check(
    legacy.data?.items?.every((item) => item.takenAtMs === undefined),
    '对外的项目结构不变（不泄漏内部字段）'
  );
}

async function runIndexMode(port) {
  console.log('\n[index] 有索引时必须"秒开"，不再重新扫描');
  const started = Date.now();
  const { data } = await getJson(port, '/api/library/summary');
  const elapsed = Date.now() - started;

  check(data?.phase === 'ready', '首次 summary 直接 ready', `phase=${data?.phase}`);
  check(data?.fromIndex === true, '标记为来自索引', `fromIndex=${data?.fromIndex}`);
  check(
    data?.total === IMAGE_COUNT && data?.filled === IMAGE_COUNT,
    '索引里就是完整结果',
    `total=${data?.total} filled=${data?.filled}`
  );
  check(elapsed < 3000, '打开耗时在 3 秒内', `${elapsed}ms`);
  console.log(`  · 计时：有索引时首个 summary ${elapsed} ms（不重新扫描）`);

  const page = await getJson(port, '/api/library/items?offset=100&limit=10');
  check(page.data?.items?.length === 10, '索引打开后照样能分页取数');
}

async function runCancelMode(port) {
  console.log('\n[cancel] 扫描中取消：保留已经扫描的部分');

  let summary = null;

  // 等到"确实扫了一部分"再取消，这样能验证部分结果被保留；
  // 阈值取小一点，避免小图库在取消请求到达前就扫完了。
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { data } = await getJson(port, '/api/library/summary');
    summary = data;

    if (data?.phase !== 'scanning' || data?.filled >= 100) {
      break;
    }

    await delay(5);
  }

  check(
    summary?.phase === 'scanning',
    '取消前确实在扫描中',
    `phase=${summary?.phase} filled=${summary?.filled}/${summary?.total}`
  );

  const cancelResponse = await request(port, '/api/scan/cancel', {
    method: 'POST',
  });
  const cancelStarted = Date.now();
  check(
    cancelResponse.status === 200,
    '取消接口返回 200',
    `status=${cancelResponse.status}`
  );

  const samples = await sampleUntilSettled(port, { interval: 20 });
  const cancelMs = Date.now() - cancelStarted;
  const last = samples[samples.length - 1];
  console.log(`  · 计时：发出取消到进入 canceled 共 ${cancelMs} ms`);
  check(last?.phase === 'canceled', '进入 canceled 状态', `phase=${last?.phase}`);
  check(
    last?.filled > 0,
    '已经扫描到的条目仍然保留',
    `filled=${last?.filled}`
  );
  check(
    last?.filled < last?.total,
    '确实没有扫完，保留的是部分结果',
    `filled=${last?.filled} total=${last?.total}`
  );

  const page = await getJson(port, '/api/library/items?offset=0&limit=20');
  const items = (page.data?.items || []).filter(Boolean);
  check(items.length > 0, '取消后仍能取到已扫描的部分', `可读 ${items.length} 条`);

  const legacy = await getJson(port, '/api/photos');
  check(
    legacy.status === 499,
    '/api/photos 在取消后按旧语义报错',
    `status=${legacy.status}`
  );
}

async function main() {
  console.log(`2.0 流式加载冒烟测试 · 模式=${MODE} · 张数=${IMAGE_COUNT}`);

  if (MODE === 'scan') {
    await fsp.rm(RUNTIME, { recursive: true, force: true });
    await makePhotos();
    console.log(`已生成 ${IMAGE_COUNT} 张测试照片：${PHOTOS}`);
  } else if (MODE === 'cancel') {
    await fsp.rm(DATA, { recursive: true, force: true });
    await fsp.rm(CACHE, { recursive: true, force: true });
  } else if (!fs.existsSync(path.join(DATA, 'library-index.json'))) {
    console.error(
      '索引模式需要先跑一次冷扫描（node tools/test-stream.js），当前 test-runtime 里没有索引。'
    );
    process.exitCode = 1;
    return;
  }

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    if (MODE === 'scan') {
      const summary = await runScanMode(port);
      await runPagingChecks(port, summary);
    } else if (MODE === 'index') {
      await runIndexMode(port);
    } else {
      await runCancelMode(port);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const indexPath = path.join(DATA, 'library-index.json');

  if (MODE === 'scan') {
    console.log('\n[8] 索引落盘');
    check(fs.existsSync(indexPath), 'library-index.json 已写入');
  }

  console.log('');

  if (failures.length) {
    console.error(`流式测试失败 ${failures.length} 项：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('流式测试全部通过 ✓');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});