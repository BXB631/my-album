// 侧栏"时间目录"（年/月）的端到端测试
//
//   node tools/test-folder-nav.js
//
// 这里复刻用户真实的目录形态，而不是测试里常见的那种"照片直接放在根目录下的年份文件夹"：
//   选中的根目录**就是最里层的月份文件夹**，年份只出现在绝对路径里
//   （README 的"目录识别"就是按这条路径规则承诺的）。
// 于是它同时盯住三件事：
//   1. 路径识别（年/月/未分类）符合 README；
//   2. 侧栏真的渲染出年/月入口，而不是"还没有识别到年份目录"；
//   3. **点"刷新"之后侧栏还能回来** —— 曾经的 bug 是刷新后侧栏永久停在空状态。

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'foldernav');
const LIBRARY = path.join(RUNTIME, 'lib', 'iphone13相册', '2026', '202606');
const SCATTERED = path.join(RUNTIME, 'lib', '散图');
// 一个"扫得慢一点"的大相册：用来看扫描期的时间目录
const BIG_LIBRARY = path.join(RUNTIME, 'big', 'iphone13总');
const BIG_YEARS = [
  { year: '2019', month: '201901', count: 700 },
  { year: '2026', month: '202606', count: 700 },
];
const DATA = path.join(RUNTIME, 'data');
const CACHE = path.join(RUNTIME, 'cache');
const JSDOM_PATH = path.join(ROOT, 'test-runtime', 'node_modules', 'jsdom');

const PHOTO_COUNT = 6;
const SCATTERED_COUNT = 3;

process.env.MY_ALBUM_DATA_DIR = DATA;
process.env.MY_ALBUM_CACHE_DIR = CACHE;
process.env.MY_ALBUM_DEFAULT_PHOTOS = LIBRARY;

let JSDOM;
try {
  ({ JSDOM } = require(JSDOM_PATH));
} catch (error) {
  console.log(
    `没有可用的 jsdom（pnpm -C test-runtime add jsdom --node-linker=hoisted），跳过侧栏目录测试。\n原因：${error.message.split('\n')[0]}`
  );
  process.exit(0);
}

const failures = [];

function check(condition, message, detail) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return true;
  }

  failures.push(message);
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 8000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await delay(interval);
  }

  return false;
}

async function makePhotos() {
  const sharp = require('sharp');
  const buffer = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 30, g: 90, b: 140 },
    },
  })
    .jpeg()
    .toBuffer();

  await fsp.mkdir(LIBRARY, { recursive: true });
  await fsp.mkdir(SCATTERED, { recursive: true });

  for (let index = 0; index < PHOTO_COUNT; index += 1) {
    await fsp.writeFile(
      path.join(
        LIBRARY,
        `2026_06_0${index + 1}_10_00_00_IMG_${5000 + index}.jpg`
      ),
      buffer
    );
  }

  for (let index = 0; index < SCATTERED_COUNT; index += 1) {
    await fsp.writeFile(
      path.join(SCATTERED, `ps_${index}.jpg`),
      buffer
    );
  }

  // 大相册：两个年份，扫描需要几秒，用来验证"扫描期时间目录先出来"
  for (const entry of BIG_YEARS) {
    const directory = path.join(BIG_LIBRARY, entry.year, entry.month);
    await fsp.mkdir(directory, { recursive: true });

    for (let index = 0; index < entry.count; index += 1) {
      await fsp.writeFile(
        path.join(
          directory,
          `${entry.year}_${entry.month.slice(4)}_01_10_${String(
            index % 60
          ).padStart(2, '0')}_${String(index).padStart(4, '0')}.jpg`
        ),
        buffer
      );
    }
  }
}

// jsdom 里没有真实布局：喂一份可控几何数据，让窗口/分块逻辑能跑起来。
function stubLayout(window) {
  const GALLERY_WIDTH = 1200;
  const CELL = (GALLERY_WIDTH - 8 * 6) / 7;
  let scrollY = 0;

  window.Element.prototype.getBoundingClientRect = function getRect() {
    if (this.id === 'gallery') {
      const top = -scrollY;
      return {
        top,
        left: 0,
        width: GALLERY_WIDTH,
        height: window.innerHeight,
        bottom: top + window.innerHeight,
        right: GALLERY_WIDTH,
        x: 0,
        y: top,
      };
    }

    if (this.classList?.contains('media-card')) {
      return { top: 0, left: 0, width: CELL, height: CELL, bottom: CELL, right: CELL, x: 0, y: 0 };
    }

    if (this.classList?.contains('day-header')) {
      return { top: 0, left: 0, width: GALLERY_WIDTH, height: 49, bottom: 49, right: GALLERY_WIDTH, x: 0, y: 0 };
    }

    return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 };
  };

  if (!Object.getOwnPropertyDescriptor(window, 'clientWidth')) {
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.id === 'gallery' ? GALLERY_WIDTH : 0;
      },
    });
  }

  try {
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
  } catch {
    // jsdom 不让改就跳过
  }

  window.scrollTo = (options) => {
    if (typeof options === 'object' && typeof options.top === 'number') {
      scrollY = options.top;
    }
  };

  // jsdom 不加载图片：手动派发 load，让缩略图队列能排空
  return setInterval(() => {
    for (const image of window.document.querySelectorAll('img[src]')) {
      image.dispatchEvent(new window.Event('load'));
    }
  }, 15);
}

async function bootClient(port) {
  const base = `http://127.0.0.1:${port}/`;
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: base,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];

  window.fetch = (input, options) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    return fetch(new URL(url, base).toString(), options);
  };

  const simulator = stubLayout(window);
  window.eval(
    fs.readFileSync(path.join(ROOT, 'public', 'photo-stream.js'), 'utf8')
  );
  window.eval(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));

  return { window, calls, stop: () => { clearInterval(simulator); window.close(); } };
}

function folderItems(window) {
  return [...window.document.querySelectorAll('#folderList .folder-item')].map(
    (item) => item.textContent.replace(/\s+/g, ' ').trim()
  );
}

function folderNavText(window) {
  return (window.document.querySelector('#folderList')?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ready(window) {
  return waitFor(
    () => window.document.querySelector('#gallery')?.dataset.state === 'ready',
    15000
  );
}

async function main() {
  console.log('侧栏时间目录测试 · 根目录就是最里层月份文件夹（年份只在绝对路径里）');

  await fsp.rm(RUNTIME, { recursive: true, force: true });
  await makePhotos();
  console.log(`已生成测试照片：${LIBRARY}（${PHOTO_COUNT} 张）`);
  console.log(`另有散图目录：${SCATTERED}（${SCATTERED_COUNT} 张）`);

  const { startServer } = require('../server.js');
  const { clearLibraryCache } = require('../lib/media.js');
  const { setPhotoRoot } = require('../lib/settings.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}/`;
  const getJson = (urlPath) =>
    fetch(new URL(urlPath, base).toString()).then((response) => response.json());

  let client = await bootClient(port);

  try {
    console.log('\n[1] 冷扫描 + 递归目录：年份只出现在绝对路径里也要认出来');
    const coldReady = await ready(client.window);
    check(coldReady, '扫描完成', client.window.document.querySelector('#gallery')?.dataset.state);

    const coldSummary = await getJson('/api/library/summary?folder=all');
    const coldYear = (coldSummary.folders || [])[0];
    check(
      coldYear?.key === 'year-2026' && coldYear?.months?.[0]?.key === '2026-06',
      '服务端识别出 2026 年 / 6 月（按绝对路径里的 202606）',
      JSON.stringify(
        (coldSummary.folders || []).map((year) => `${year.key}:${year.months.map((m) => m.key)}`)
      )
    );
    check(
      coldSummary.uncategorizedCount === 0,
      '这些照片不算"未分类"',
      `uncategorizedCount=${coldSummary.uncategorizedCount}`
    );

    console.log('\n[2] 侧栏真的把年/月列出来了');
    const coldNavReady = await waitFor(
      () => client.window.document.querySelectorAll('#folderList .folder-item').length > 1,
      6000
    );
    const coldNav = folderNavText(client.window);
    check(coldNavReady, '侧栏有年/月入口', `${folderItems(client.window).length} 个：${folderItems(client.window).join(' | ')}`);
    check(
      coldNav.includes('2026 年') && coldNav.includes('6 月'),
      '侧栏文字里有"2026 年"和"6 月"',
      coldNav
    );
    check(
      !client.window.document.querySelector('.folder-empty'),
      '不再显示"还没有识别到年份目录"'
    );

    console.log('\n[3] 年 / 月 过滤能过滤出东西（README 承诺的入口是可用的）');
    const yearView = await getJson('/api/library/summary?folder=year-2026');
    const monthView = await getJson('/api/library/summary?folder=2026-06');
    check(
      yearView.filter === 'year-2026' && yearView.total === PHOTO_COUNT,
      '按年过滤可用',
      `${yearView.filter} total=${yearView.total}`
    );
    check(
      monthView.filter === '2026-06' && monthView.total === PHOTO_COUNT,
      '按月过滤可用',
      `${monthView.filter} total=${monthView.total}`
    );

    console.log('\n[4] 重开页面（这次走索引）→ 点"刷新"：侧栏必须还在');
    // 这就是用户遇到的那条路径：平时是从索引直接打开的（ready 的 revision 是个小数字），
    // 刷新时服务端新建会话、revision 从 1 重新数，扫完可能正好和上一轮相同 ——
    // 前端就会以为"目录没变过"，于是一直停在扫描期渲染的空状态上。
    const revisionWarmBefore = (await getJson('/api/library/summary?folder=all')).revision;

    client.stop();
    client = await bootClient(port);

    const warmReady = await ready(client.window);
    check(warmReady, '走索引重开页面后 ready');

    const warmNavReady = await waitFor(
      () => client.window.document.querySelectorAll('#folderList .folder-item').length > 1,
      6000
    );
    check(warmNavReady, '走索引打开时侧栏就有年/月入口', folderItems(client.window).join(' | '));

    const revisionBefore = (await getJson('/api/library/summary?folder=all')).revision;
    const callsBefore = client.calls.length;

    client.window.document
      .querySelector('#refreshButton')
      .dispatchEvent(new client.window.MouseEvent('click', { bubbles: true }));

    // 刷新会先进入扫描期（侧栏被清成空状态），然后必须自己恢复
    const sawEmptyState = await waitFor(
      () =>
        client.calls.length > callsBefore &&
        client.window.document.querySelectorAll('#folderList .folder-item').length <= 1,
      8000
    );
    console.log(
      sawEmptyState
        ? '  · 刷新期间侧栏确实先清空了（所以"能恢复"才是关键）'
        : '  · 刷新太快，没抓到清空的中间态'
    );

    const refreshedReady = await ready(client.window);
    check(refreshedReady, '刷新后重新进入 ready');

    const afterRefresh = await getJson('/api/library/summary?folder=all');
    check(
      afterRefresh.revision > revisionBefore,
      'revision 跨会话单调递增（前端据此判断"内容变了"）',
      `${revisionBefore} → ${afterRefresh.revision}（走索引打开时是 ${revisionWarmBefore}）`
    );

    const navBack = await waitFor(
      () => client.window.document.querySelectorAll('#folderList .folder-item').length > 1,
      8000
    );
    const navTextAfterRefresh = folderNavText(client.window);
    check(navBack, '刷新后侧栏年/月入口回来了', `${folderItems(client.window).length} 个`);
    check(
      navTextAfterRefresh.includes('2026 年') && !client.window.document.querySelector('.folder-empty'),
      '刷新后侧栏内容正确，且不是空状态',
      navTextAfterRefresh
    );

    console.log('\n[5] 换成"没有年份的散图"文件夹：按 README 应该进"未分类"');
    await setPhotoRoot(SCATTERED);
    clearLibraryCache();

    client.window.document
      .querySelector('#refreshButton')
      .dispatchEvent(new client.window.MouseEvent('click', { bubbles: true }));

    const scatteredReady = await ready(client.window);
    check(scatteredReady, '散图文件夹扫描完成');

    const scatteredSummary = await getJson('/api/library/summary?folder=all');
    check(
      (scatteredSummary.folders || []).length === 0 &&
        scatteredSummary.uncategorizedCount === SCATTERED_COUNT,
      '没有年份的散图全部算"未分类"',
      `folders=${(scatteredSummary.folders || []).length} uncategorized=${scatteredSummary.uncategorizedCount}`
    );

    const scatteredNav = await waitFor(
      () => folderNavText(client.window).includes('未分类'),
      8000
    );
    check(scatteredNav, '侧栏出现"未分类"入口', folderNavText(client.window));

    const uncategorized = await getJson('/api/library/summary?folder=unclassified');
    check(
      uncategorized.total === SCATTERED_COUNT,
      '"未分类"过滤可用',
      `total=${uncategorized.total}`
    );

    console.log(
      '\n[6] 大相册：扫描还没结束，时间目录就该先出来（用户那 3 万多张的情况）'
    );
    await setPhotoRoot(BIG_LIBRARY);
    clearLibraryCache();
    client.stop();
    client = await bootClient(port);

    const navDuringScan = await waitFor(() => {
      const text = folderNavText(client.window);
      const loading =
        client.window.document.querySelector('#gallery')?.dataset.state ===
        'loading';

      return (
        loading &&
        /年/.test(text) &&
        !client.window.document.querySelector('.folder-empty')
      );
    }, 10000);

    const navTextDuringScan = folderNavText(client.window);
    const summaryDuringScan = await getJson('/api/library/summary?folder=all');
    check(
      navDuringScan,
      '扫描期侧栏就列出了年份（不用等整轮扫完）',
      `${navTextDuringScan}（那时 filled=${summaryDuringScan.filled}/${summaryDuringScan.total}）`
    );
    check(
      summaryDuringScan.phase === 'scanning' &&
        summaryDuringScan.filled > 0 &&
        summaryDuringScan.filled < summaryDuringScan.total,
      '做这个断言时扫描确实还在进行中',
      `phase=${summaryDuringScan.phase} filled=${summaryDuringScan.filled}/${summaryDuringScan.total}`
    );
    check(
      (summaryDuringScan.folders || []).some((year) => year.key === 'year-2019'),
      '扫描期的目录树里有 2019 年',
      JSON.stringify((summaryDuringScan.folders || []).map((year) => year.key))
    );
    check(
      summaryDuringScan.filterSupported === true,
      '扫描期就允许按目录过滤（filterSupported=true）',
      String(summaryDuringScan.filterSupported)
    );

    // 扫描期点一下"2019 年"：必须真的筛出东西，而不是点出一个空相册
    const yearButton = [...client.window.document.querySelectorAll('#folderList .folder-item')].find(
      (item) => item.textContent.includes('2019')
    );
    check(Boolean(yearButton), '侧栏里有 2019 年的入口');

    if (yearButton) {
      yearButton.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true }));

      await delay(500);
      const yearSummary = await getJson('/api/library/summary?folder=year-2019');
      const usedFilter = client.calls.some((url) => url.includes('folder=year-2019'));

      check(
        yearSummary.total > 0,
        '扫描期按年过滤能筛出已解析的照片',
        `total=${yearSummary.total} phase=${yearSummary.phase}`
      );
      check(usedFilter, '前端确实按 year-2019 去取窗口数据了');
      check(
        client.window.document.querySelector('#gallery')?.dataset.state !== 'error',
        '切换目录没有把画廊打成错误状态'
      );
    }
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('');

  if (failures.length) {
    console.error(`侧栏目录测试失败 ${failures.length} 项：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('侧栏目录测试全部通过 ✓');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});