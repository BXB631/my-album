// 2.0 实况照片（Apple Live Photo）合并测试
//
//   node tools/test-live-photo.js
//
// 用的是工作区里**真实的**测试素材：testmedia\ 下的 HEIC/JPG + 同名 MOV。
// 在这里验证的行为（对应 Lap 的 t_sqlite::pair_live_photos_in_folder）：
//   1. 同文件夹同名的"图片 + MOV"合并成一个格子，MOV 不再单独出现（扫描期也不出现）；
//   2. MOV 里的 Content Identifier 和图片里的不一致时**不合并**（防止同名巧合）；
//   3. IMG_1234_HEVC.MOV 这种加后缀的写法也能配对；同名多个 MOV 只吃一个，
//      多出来的仍然是普通视频；
//   4. 伴随视频仍然可以通过 /api/video/<id> 播放（会被转码成 H.264）；
//   5. 索引写的是 v4（带实况照片关系），v3 老索引能自动补配对并升级；
//   6. liveIdentifiers / contentIdentifier 这些内部字段不会发给前端。
//
// 所有生成物都在 test-runtime/live 下，不会碰用户的 %APPDATA%。

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, '..', 'testmedia');
const RUNTIME = path.join(ROOT, 'test-runtime', 'live');
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

// ---------------------------------------------------------------------------
// 素材准备
// ---------------------------------------------------------------------------

const NORMAL = '2026/202607';
const MISMATCH = '2026/202608';
const HEVC = '2026/202609';

// [源文件, 目标目录, 目标文件名]
const FIXTURES = [
  // 普通素材：静态照片、静态 PNG、独立视频
  ['2026_07_02_20_07_41_IMG_5006.HEIC', NORMAL, '2026_07_02_20_07_41_IMG_5006.HEIC'],
  ['2026_07_03_10_25_25_IMG_5007.PNG', NORMAL, '2026_07_03_10_25_25_IMG_5007.PNG'],
  ['2026_07_03_13_25_24_IMG_5008.HEIC', NORMAL, '2026_07_03_13_25_24_IMG_5008.HEIC'],
  ['2026_07_07_17_14_23_IMG_5054.MP4', NORMAL, '2026_07_07_17_14_23_IMG_5054.MP4'],
  // 三对真正的实况照片（图片里的标识符和 MOV 里的一致）
  ['2026_07_17_15_08_38_IMG_5832.HEIC', NORMAL, '2026_07_17_15_08_38_IMG_5832.HEIC'],
  ['2026_07_17_15_08_38_IMG_5832.MOV', NORMAL, '2026_07_17_15_08_38_IMG_5832.MOV'],
  ['2026_07_17_15_08_45_IMG_5833.HEIC', NORMAL, '2026_07_17_15_08_45_IMG_5833.HEIC'],
  ['2026_07_17_15_08_45_IMG_5833.MOV', NORMAL, '2026_07_17_15_08_45_IMG_5833.MOV'],
  ['2026_07_17_22_01_36_IMG_5881.HEIC', NORMAL, '2026_07_17_22_01_36_IMG_5881.HEIC'],
  ['2026_07_17_22_01_36_IMG_5881.MOV', NORMAL, '2026_07_17_22_01_36_IMG_5881.MOV'],
  // 同名但标识符对不上：不能被合并
  ['2026_07_02_20_07_41_IMG_5006.HEIC', MISMATCH, 'MISMATCH_0001.HEIC'],
  ['2026_07_17_15_08_38_IMG_5832.MOV', MISMATCH, 'MISMATCH_0001.MOV'],
  // _HEVC 变体：IMG_6001.HEIC + IMG_6001_HEVC.MOV 要配对
  ['2026_07_17_15_08_45_IMG_5833.HEIC', HEVC, 'IMG_6001.HEIC'],
  ['2026_07_17_15_08_45_IMG_5833.MOV', HEVC, 'IMG_6001_HEVC.MOV'],
  // 同名两个 MOV：IMG_6002.MOV 配对，IMG_6002_HEVC.MOV 仍是普通视频
  ['2026_07_17_15_08_45_IMG_5833.HEIC', HEVC, 'IMG_6002.HEIC'],
  ['2026_07_17_15_08_45_IMG_5833.MOV', HEVC, 'IMG_6002.MOV'],
  ['2026_07_17_15_08_45_IMG_5833.MOV', HEVC, 'IMG_6002_HEVC.MOV'],
];

const LIVE_IMAGES = [
  '2026_07_17_15_08_38_IMG_5832.HEIC',
  '2026_07_17_15_08_45_IMG_5833.HEIC',
  '2026_07_17_22_01_36_IMG_5881.HEIC',
  'IMG_6001.HEIC',
  'IMG_6002.HEIC',
];

// 应该被藏起来的伴随视频（按文件名）
const COMPANION_NAMES = [
  '2026_07_17_15_08_38_IMG_5832.MOV',
  '2026_07_17_15_08_45_IMG_5833.MOV',
  '2026_07_17_22_01_36_IMG_5881.MOV',
  'IMG_6001_HEVC.MOV',
  'IMG_6002.MOV',
];

// 应该仍然作为普通视频出现的 MOV
const VISIBLE_VIDEO_NAMES = ['IMG_6002_HEVC.MOV', 'MISMATCH_0001.MOV'];

const VISIBLE_TOTAL = FIXTURES.length - COMPANION_NAMES.length; // 17 - 5 = 12

// 硬链接最快也不占空间；跨卷等情况下退回复制。
async function place(source, directory, name) {
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, name);

  await fsp.rm(target, { force: true });

  try {
    await fsp.link(path.join(MEDIA, source), target);
  } catch {
    await fsp.copyFile(path.join(MEDIA, source), target);
  }
}

async function makePhotos() {
  if (!fs.existsSync(MEDIA)) {
    throw new Error(`没有找到测试素材目录：${MEDIA}`);
  }

  await fsp.rm(RUNTIME, { recursive: true, force: true });

  for (const [source, directory, name] of FIXTURES) {
    await place(source, path.join(PHOTOS, directory), name);
  }
}

// 素材放在工作区的 testmedia\ 里（不在 2.0 仓库内，体积 35 MB）：
// CI 或别人 clone 下来时没有这些文件，这种情况直接跳过而不是报失败。
function missingMedia() {
  return FIXTURES.filter(
    ([source]) => !fs.existsSync(path.join(MEDIA, source))
  ).map(([source]) => source);
}

// ---------------------------------------------------------------------------

async function sampleUntilSettled(port, { limit = 600, interval = 40 } = {}) {
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

async function visibleItems(port) {
  const page = await getJson(port, '/api/library/items?offset=0&limit=512');
  return (page.data?.items || []).filter(Boolean);
}

function byName(items) {
  return new Map(items.map((item) => [item.name, item]));
}

function base64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

async function runScanChecks(port) {
  console.log('\n[1] 扫描期：伴随 MOV 从头到尾都不进格子');

  const seenNames = new Set();
  let sawLivePhotoDuringScan = false;
  let scanSummary = null;

  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { data } = await getJson(port, '/api/library/summary');
    scanSummary = data;

    if (data?.total > 0) {
      const items = await visibleItems(port);

      for (const item of items) {
        seenNames.add(item.name);

        if (item.livePhoto && item.liveVideoUrl) {
          sawLivePhotoDuringScan = true;
        }
      }
    }

    if (!data || ['ready', 'canceled', 'error'].includes(data.phase)) {
      break;
    }

    await delay(25);
  }

  const leaked = COMPANION_NAMES.filter((name) => seenNames.has(name));
  check(
    leaked.length === 0,
    '扫描过程中伴随视频一次都没有出现在格子里（不会"先冒出来再消失"）',
    leaked.length ? `漏出：${leaked.join(', ')}` : `共看到 ${seenNames.size} 个名字`
  );
  check(
    sawLivePhotoDuringScan,
    '扫描期图片就已经带上了 livePhoto / liveVideoUrl（角标不用等扫完）'
  );
  check(
    !scanSummary || scanSummary.total <= VISIBLE_TOTAL,
    '扫描期 total 也不过是有格子的项目数（伴随视频不占格）',
    `total=${scanSummary?.total} 上限=${VISIBLE_TOTAL}`
  );

  return scanSummary;
}

async function runReadyChecks(port, scanSummary) {
  console.log('\n[2] 扫完：3 对 + _HEVC 变体合并成 1 个格子，多出来的 MOV 仍是视频');

  check(
    scanSummary?.phase === 'ready',
    '扫描进入 ready',
    `phase=${scanSummary?.phase} error=${scanSummary?.error || ''}`
  );
  check(
    scanSummary?.total === VISIBLE_TOTAL,
    `格子总数 = 文件数 - 伴随视频数 = ${VISIBLE_TOTAL}`,
    `total=${scanSummary?.total}`
  );

  const items = await visibleItems(port);
  const index = byName(items);
  const names = items.map((item) => item.name);

  check(items.length === VISIBLE_TOTAL, `items 分页返回 ${VISIBLE_TOTAL} 条`, `实际 ${items.length}`);

  for (const name of COMPANION_NAMES) {
    check(!names.includes(name), `伴随视频不出现在列表里：${name}`);
  }

  for (const name of VISIBLE_VIDEO_NAMES) {
    check(names.includes(name), `该保留的视频仍然是独立项目：${name}`);
  }

  const imageCount = items.filter((item) => item.type === 'image').length;
  const videoCount = items.filter((item) => item.type === 'video').length;

  check(
    scanSummary?.imageCount === imageCount && scanSummary?.videoCount === videoCount,
    'summary 的照片/视频计数和列表一致（伴随视频不计入视频数）',
    `summary=${scanSummary?.imageCount}/${scanSummary?.videoCount} 实际=${imageCount}/${videoCount}`
  );
  check(
    videoCount === VISIBLE_VIDEO_NAMES.length + 1,
    `视频数 = 独立视频(${VISIBLE_VIDEO_NAMES.length}) + IMG_5054.MP4`,
    `videoCount=${videoCount}`
  );

  for (const name of LIVE_IMAGES) {
    const item = index.get(name);
    const folder = item ? item.folderPath : '';

    check(Boolean(item), `找到实况照片：${name}`);
    check(
      Boolean(item?.livePhoto) && Boolean(item?.liveVideoId),
      `${name} 标记为实况照片并带上伴随视频 id`,
      `livePhoto=${item?.livePhoto} liveVideoId=${Boolean(item?.liveVideoId)}`
    );

    const expectedId = base64Url(
      path.join(PHOTOS, folder, item ? item.liveVideoName : '')
    );
    check(
      item?.liveVideoId === expectedId,
      `${name} 的 liveVideoId 就是同名 MOV 的编码路径`,
      `${item?.liveVideoId} ≠ ${expectedId}`
    );
    check(
      item?.liveVideoUrl === `/api/video/${item?.liveVideoId}`,
      `${name} 的 liveVideoUrl 可直接播放`
    );
    check(
      item?.liveVideoId !== undefined &&
        !names.some((other) => index.get(other)?.id === item?.liveVideoId),
      `${name} 的伴随视频确实不在格子里`
    );
  }

  check(
    index.get('2026_07_02_20_07_41_IMG_5006.HEIC')?.livePhoto === false,
    '普通 HEIC 没有被误判成实况照片'
  );
  check(
    index.get('2026_07_03_10_25_25_IMG_5007.PNG')?.livePhoto === false,
    '静态 PNG 没有被误判成实况照片'
  );

  // 内部字段不能外泄
  const leakedFields = items.filter(
    (item) =>
      item.liveIdentifiers !== undefined ||
      item.contentIdentifiers !== undefined ||
      item.cacheSignature !== undefined
  );
  check(
    leakedFields.length === 0,
    'liveIdentifiers / contentIdentifiers / cacheSignature 没发给前端',
    leakedFields.length ? `${leakedFields.length} 条带内部字段` : ''
  );

  return { items, index };
}

async function runMismatchChecks(index) {
  console.log('\n[3] 标识符对不上：同名也不合并（防止同名巧合）');

  const image = index.get('MISMATCH_0001.HEIC');
  const video = index.get('MISMATCH_0001.MOV');

  check(
    image?.livePhoto === false && !image?.liveVideoId,
    '同名但标识符不一致的图片没有被合并',
    `livePhoto=${image?.livePhoto}`
  );
  check(
    video?.type === 'video' && !video?.livePhotoCompanion,
    '对不上的 MOV 仍然是普通视频（重新回到了格子里）'
  );
  check(
    image?.liveIdentifiers === undefined,
    '被拆开的图片不带内部标识符字段'
  );
}

async function runHevcChecks(index) {
  console.log('\n[4] _HEVC 变体与"同名多个 MOV"');

  const variant = index.get('IMG_6001.HEIC');
  check(
    variant?.livePhoto === true && variant?.liveVideoName === 'IMG_6001_HEVC.MOV',
    'IMG_6001.HEIC 和 IMG_6001_HEVC.MOV 配成了一对',
    `liveVideoName=${variant?.liveVideoName}`
  );

  const plain = index.get('IMG_6002.HEIC');
  check(
    plain?.livePhoto === true && plain?.liveVideoName === 'IMG_6002.MOV',
    '同名有多个 MOV 时优先用"没有 _HEVC 后缀"的那个',
    `liveVideoName=${plain?.liveVideoName}`
  );
  check(
    index.get('IMG_6002_HEVC.MOV')?.type === 'video' &&
      !index.get('IMG_6002_HEVC.MOV')?.livePhotoCompanion,
    '多出来的 IMG_6002_HEVC.MOV 仍然作为普通视频显示'
  );
}

async function runPlaybackChecks(port, index) {
  console.log('\n[5] 伴随视频依然能播（走原来的视频转码管线）');

  const item = index.get('2026_07_17_15_08_38_IMG_5832.HEIC');
  const startedAt = Date.now();
  const response = await request(port, `/api/video/${item.liveVideoId}`);
  const elapsed = Date.now() - startedAt;

  check(
    response.status === 200,
    '实况照片的伴随视频拿到了 200',
    `status=${response.status}`
  );
  check(
    /video\//.test(response.headers['content-type'] || ''),
    `返回的是视频（${response.headers['content-type']}）`
  );
  check(
    response.body.length > 100 * 1024,
    '返回的视频体积正常（不是空文件）',
    `${Math.round(response.body.length / 1024)} KB`
  );
  console.log(`  · 计时：首次请求伴随视频（含 HEVC → H.264 转码）${elapsed} ms`);

  const second = await request(port, `/api/video/${item.liveVideoId}`);
  check(
    second.status === 200 && second.body.length === response.body.length,
    '第二次请求命中转码缓存，结果一致'
  );
}

async function runDaysChecks(port) {
  console.log('\n[6] 分组接口：实况照片只算一项');

  const { data } = await getJson(port, '/api/library/days');
  const days = data?.days || [];
  const coverage = days.reduce((sum, day) => sum + day.count, 0);

  check(
    data?.partial === false && days.length > 0,
    '扫描完成后 days 是完整结果',
    `partial=${data?.partial} 分段=${days.length}`
  );
  check(
    coverage === VISIBLE_TOTAL,
    `所有分段的张数加起来 = ${VISIBLE_TOTAL}（伴随视频不参与分组）`,
    `加起来=${coverage}`
  );
  check(
    days.every((day, order) => order === 0 || day.itemStart >= days[order - 1].itemStart + days[order - 1].count - 1),
    '分段起点连续、不重叠'
  );
}

async function runIndexChecks(port) {
  console.log('\n[7] 索引：写成 v4，重开秒回，v3 老索引能自动补配对');

  const indexPath = path.join(DATA, 'library-index.json');
  check(fs.existsSync(indexPath), 'library-index.json 已写入');

  const raw = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  const storedCompanions = raw.items.filter((item) => item.livePhotoCompanion);
  const storedLive = raw.items.filter((item) => item.livePhoto);

  check(raw.version === 4, '索引版本是 4', `version=${raw.version}`);
  check(
    raw.items.length === FIXTURES.length,
    `索引里保留了全部 ${FIXTURES.length} 个文件（含伴随视频）`,
    `items=${raw.items.length}`
  );
  check(
    storedCompanions.length === COMPANION_NAMES.length,
    `索引里 ${COMPANION_NAMES.length} 个伴随视频带 livePhotoCompanion 标记`,
    `实际 ${storedCompanions.length}`
  );
  check(
    storedLive.length === LIVE_IMAGES.length,
    `索引里 ${LIVE_IMAGES.length} 张实况照片带 livePhoto 标记`,
    `实际 ${storedLive.length}`
  );
  check(
    storedLive.every((item) => item.liveVideoDuration > 0),
    '索引里的实况照片带着伴随视频的时长（详情面板要用）'
  );

  const media = require('../lib/media');

  // (a) 直接重开会话：应该走索引秒开，配对关系保持不变
  media.clearLibraryCache();
  const fromIndex = await getJson(port, '/api/library/summary');
  const indexItems = await visibleItems(port);

  check(
    fromIndex.data?.phase === 'ready' && fromIndex.data?.fromIndex === true,
    '重新打开走的是索引（没有重新扫描）',
    `phase=${fromIndex.data?.phase} fromIndex=${fromIndex.data?.fromIndex}`
  );
  check(
    indexItems.length === VISIBLE_TOTAL,
    `从索引打开后格子数仍然是 ${VISIBLE_TOTAL}`,
    `实际 ${indexItems.length}`
  );
  check(
    indexItems.filter((item) => item.livePhoto).length === LIVE_IMAGES.length,
    '从索引打开后实况照片关系还在',
    `livePhoto=${indexItems.filter((item) => item.livePhoto).length}`
  );
  check(
    indexItems.every((item) => !COMPANION_NAMES.includes(item.name)),
    '从索引打开后伴随视频同样不进格子'
  );

  // (b) 伪造一份 v3 索引（实况照片还是两个独立条目）：应该自动补配对并升级成 v4
  const legacy = JSON.parse(JSON.stringify(raw));
  legacy.version = 3;
  legacy.items = legacy.items.map((item) => {
    const plain = { ...item };
    delete plain.livePhoto;
    delete plain.liveVideoId;
    delete plain.liveVideoName;
    delete plain.liveVideoUrl;
    delete plain.liveVideoDuration;
    delete plain.liveVideoSize;
    delete plain.livePhotoCompanion;
    delete plain.livePhotoCompanionOf;
    delete plain.liveIdentifiers;
    delete plain.contentIdentifiers;
    return plain;
  });
  // v3 会把伴随视频也当普通项目写进去
  await fsp.writeFile(indexPath, `${JSON.stringify(legacy)}\n`, 'utf8');

  media.clearLibraryCache();
  const upgraded = await getJson(port, '/api/library/summary');
  const upgradedItems = await visibleItems(port);

  check(
    upgraded.data?.phase === 'ready',
    'v3 老索引也能直接打开（不用重扫几万张）',
    `phase=${upgraded.data?.phase}`
  );
  check(
    upgradedItems.length === VISIBLE_TOTAL,
    `v3 索引读进来后自动合并成 ${VISIBLE_TOTAL} 个格子`,
    `实际 ${upgradedItems.length}`
  );
  check(
    upgradedItems.filter((item) => item.livePhoto).length === LIVE_IMAGES.length,
    'v3 索引补配对后实况照片数量正确',
    `livePhoto=${upgradedItems.filter((item) => item.livePhoto).length}`
  );
  check(
    upgradedItems.every((item) => !COMPANION_NAMES.includes(item.name)),
    'v3 索引补配对后伴随视频不再进格子'
  );

  const rewritten = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  check(
    rewritten.version === 4,
    'v3 索引被就地升级成 v4（下次打开不用再补）',
    `version=${rewritten.version}`
  );
}

async function main() {
  console.log('2.0 实况照片合并测试（素材来自 testmedia）');

  const missing = missingMedia();

  if (!fs.existsSync(MEDIA) || missing.length) {
    console.log(
      `没有找到实况照片测试素材（${MEDIA}），跳过实况照片测试。`
    );

    if (missing.length) {
      console.log(`缺少文件：${missing.join(', ')}`);
    }

    return;
  }

  try {
    await makePhotos();
    console.log(`已准备 ${FIXTURES.length} 个测试文件：${PHOTOS}`);
  } catch (error) {
    console.error(`素材准备失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const startedAt = Date.now();

  try {
    const scanSummary = await runScanChecks(port);
    const readyMs = Date.now() - startedAt;
    const { index } = await runReadyChecks(port, scanSummary);

    await runMismatchChecks(index);
    await runHevcChecks(index);
    await runPlaybackChecks(port, index);
    await runDaysChecks(port);
    await runIndexChecks(port);

    console.log(`\n  · 计时：从第一次请求到 ready 共 ${readyMs} ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('');

  if (failures.length) {
    console.error(`实况照片测试失败 ${failures.length} 项：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('实况照片测试全部通过。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});