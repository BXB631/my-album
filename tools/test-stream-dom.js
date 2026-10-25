// 2.0 前端流式加载的端到端测试
//
// 用 jsdom 当浏览器，配真实的 Express 服务和真实的照片文件，
// 完整跑一遍：summary → 占位 → 按天渲染 → 分块取数 → 缩略图排队 → 查看器翻页。
//
//   node tools/test-stream-dom.js
//
// jsdom 只装在 test-runtime 里（不进项目依赖）；没有装就跳过。

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'test-runtime', 'dom');
const PHOTOS = path.join(RUNTIME, 'photos');
const DATA = path.join(RUNTIME, 'data');
const CACHE = path.join(RUNTIME, 'cache');
const CACHE_PREVIEWS = path.join(CACHE, 'previews');
const JSDOM_PATH = path.join(ROOT, 'test-runtime', 'node_modules', 'jsdom');

// 张数给多一些，让扫描期有足够长的窗口来验证"边扫边分组"
const IMAGE_COUNT = 1200;
const DAY_COUNT = 40;
const PER_DAY = IMAGE_COUNT / DAY_COUNT;

// 额外放一对实况照片（JPG + 同名 MOV）：它只占一个格子，
// 所以总数 +1、第一天多一张，MOV 本身不应该出现在照片墙里。
// 再放一张 PNG（带透明通道）：用来验证原生格式走源文件、不生成转换预览。
const LIVE_PHOTO_COUNT = 1;
const PNG_COUNT = 1;
// 一张 TIFF（sharp 现生成）：浏览器解不了这个格式，是"必须转换"那一类。
// 选它而不是 HEIC：它没有 EXIF，日期完全由文件名决定，能精确排在实况照片后面当邻居；
// 而且不用依赖工作区 testmedia\ 里的素材，CI 上也能跑。
const TIFF_COUNT = 1;
// 一个真的 HEVC 视频（用捆绑的 ffmpeg 现生成，约 3 KB）：验证"HEVC 优先直出、失败再转"
const HEVC_VIDEO_COUNT = 1;
const EXPECTED_TOTAL =
  IMAGE_COUNT + LIVE_PHOTO_COUNT + PNG_COUNT + TIFF_COUNT + HEVC_VIDEO_COUNT;
const FIRST_DAY_COUNT =
  PER_DAY + LIVE_PHOTO_COUNT + PNG_COUNT + TIFF_COUNT + HEVC_VIDEO_COUNT;
const LIVE_PHOTO_NAME = 'IMG_2026-07-01_08-00-00_9000';
const PNG_NAME = 'IMG_2026-07-01_08-30-00_9001';
const TIFF_NAME = 'IMG_2026-07-01_08-45-00_9002';
const HEVC_VIDEO_NAME = 'IMG_2026-07-01_08-50-00_9003';

process.env.MY_ALBUM_DATA_DIR = DATA;
process.env.MY_ALBUM_CACHE_DIR = CACHE;
process.env.MY_ALBUM_DEFAULT_PHOTOS = PHOTOS;

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(JSDOM_PATH));
} catch (error) {
  console.log(
    `没有可用的 jsdom（pnpm -C test-runtime add jsdom --node-linker=hoisted），跳过前端端到端测试。\n原因：${error.message.split('\n')[0]}`
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

  await fsp.mkdir(RUNTIME, { recursive: true });

  // 先备一份真 HEVC 视频：实况照片的伴随 MOV 和那个独立视频都用它
  hevcSample = path.join(RUNTIME, 'hevc-sample.mp4');
  madeHevcSample = await makeHevcVideo(hevcSample);

  const buffer = await sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: { r: 120, g: 170, b: 210 },
    },
  })
    .jpeg({ quality: 70 })
    .toBuffer();

  const directory = path.join(PHOTOS, '2026', '202607');
  await fsp.mkdir(directory, { recursive: true });

  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    const day = String(Math.floor(index / PER_DAY) + 1).padStart(2, '0');
    const minute = String(index % 60).padStart(2, '0');
    const name = `IMG_2026-07-${day}_09-${minute}-00_${String(index).padStart(
      4,
      '0'
    )}.jpg`;

    await fsp.writeFile(path.join(directory, name), buffer);
  }

  // 一对实况照片：图片排在最前面（08:00，早于上面全部 09:xx），
  // 这样它一定落在首屏可视区里，不用滚动就能验证角标和悬停预览。
  await fsp.writeFile(
    path.join(directory, `${LIVE_PHOTO_NAME}.JPG`),
    buffer
  );

  // 伴随 MOV：有 ffmpeg 就用真 HEVC（这样"实况视频也能直出"才测得到），否则写个假文件
  if (madeHevcSample) {
    await fsp.copyFile(
      hevcSample,
      path.join(directory, `${LIVE_PHOTO_NAME}.MOV`)
    );
  } else {
    await fsp.writeFile(
      path.join(directory, `${LIVE_PHOTO_NAME}.MOV`),
      Buffer.from('not-a-real-mov'.repeat(64))
    );
  }

  // 一张带透明通道的 PNG（08:30，正好是实况照片的下一张）：
  // 用来看"翻到下一张原生格式时，给的是源文件还是转换预览"。
  const pngBuffer = await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 4,
      background: { r: 40, g: 200, b: 120, alpha: 0.35 },
    },
  })
    .png()
    .toBuffer();

  await fsp.writeFile(path.join(directory, `${PNG_NAME}.PNG`), pngBuffer);

  // 一张 TIFF（08:45，正好排在 PNG 后面）：浏览器解不了，必须转换那类
  await sharp({
    create: {
      width: 72,
      height: 54,
      channels: 3,
      background: { r: 190, g: 120, b: 70 },
    },
  })
    .tiff()
    .toFile(path.join(directory, `${TIFF_NAME}.TIF`));

  // 一个真的 HEVC 视频（08:50）：服务端 ffprobe 会认出 codec=hevc，
  // 前端的"HEVC 优先直出 / 失败再转"才有东西可判。生成失败（没有 ffmpeg）就跳过相关断言。
  if (madeHevcSample) {
    await fsp.copyFile(hevcSample, path.join(directory, `${HEVC_VIDEO_NAME}.MOV`));
  }
}

// 先给实况照片的伴随 MOV 也准备一份真 HEVC（生成一次，复制两处用）
let madeHevcSample = false;
let hevcSample = '';

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

// 用 ffmpeg 生成 1 秒的黑场 HEVC（带 hvc1 标签）：够小够快，但编码是真的
async function makeHevcVideo(target) {
  if (!FFMPEG_PATH || !fs.existsSync(FFMPEG_PATH)) {
    return false;
  }

  const logPath = path.join(RUNTIME, 'ffmpeg-hevc.log');
  const logFd = fs.openSync(logPath, 'w');

  try {
    await new Promise((resolve) => {
      const child = spawn(
        FFMPEG_PATH,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=64x48:d=1:r=10',
          '-c:v',
          'libx265',
          '-tag:v',
          'hvc1',
          '-pix_fmt',
          'yuv420p',
          '-an',
          target,
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', logFd] }
      );

      child.once('error', () => resolve());
      child.once('close', () => resolve());
    });
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {
      // 已经关掉了
    }
  }

  return fs.existsSync(target);
}

// HEVC 视频素材生成成功了吗（没有 ffmpeg 就跳过相关断言）
const HEVC_VIDEO_AVAILABLE = () =>
  madeHevcSample &&
  fs.existsSync(path.join(PHOTOS, '2026', '202607', `${HEVC_VIDEO_NAME}.MOV`));

// jsdom 没有真实的图片加载：这里手动把 src 上的图片"加载完成"，
// 让缩略图调度器的队列能像在浏览器里一样排空。
function startImageSimulator(window) {
  return setInterval(() => {
    // [8] 要精确控制"这张图到底是加载成功还是失败"，会先把它暂停（默认是跑的）
    if (window.__pauseImageSimulation) {
      return;
    }

    for (const image of window.document.querySelectorAll('img[src]')) {
      image.dispatchEvent(new window.Event('load'));
    }
  }, 15);
}

async function main() {
  console.log(
    `2.0 前端端到端测试 · ${IMAGE_COUNT} 张 / ${DAY_COUNT} 天 + ${LIVE_PHOTO_COUNT} 实况 + ${PNG_COUNT} PNG + ${TIFF_COUNT} TIFF + ${HEVC_VIDEO_COUNT} HEVC 视频`
  );

  await fsp.rm(RUNTIME, { recursive: true, force: true });
  await makePhotos();
  console.log(`已生成测试照片：${PHOTOS}`);

  const { startServer } = require('../server.js');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}/`;

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  // jsdom 没有真正的媒体栈，<video>.play()/pause() 会走 "Not implemented" 报错。
  // 这类噪音过滤掉，页面里的真实错误照旧打出来。
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (!/Not implemented/.test(error.message)) {
      console.error(error.message);
    }
  });
  virtualConsole.on('error', (...args) => console.error(...args));
  virtualConsole.on('warn', (...args) => console.warn(...args));

  const dom = new JSDOM(html, {
    url: base,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const calls = [];
  const callTimings = [];

  // 让 jsdom 里的 fetch 走真实的本地服务；同时记录调用顺序和耗时。
  window.fetch = (input, options) => {
    const url = typeof input === 'string' ? input : input.url;
    const startedAt = Date.now();

    calls.push(url);

    // 清理缓存要看请求体里的 kind（三档缓存就是这么分的）
    if (url.startsWith('/api/cache/clear') && options?.body) {
      try {
        window.__lastCacheClearBody = JSON.parse(String(options.body));
      } catch {
        window.__lastCacheClearBody = null;
      }
    }

    return fetch(new URL(url, base).toString(), options).then(
      (response) => {
        callTimings.push({ url, start: startedAt, ms: Date.now() - startedAt });
        return response;
      },
      (error) => {
        callTimings.push({
          url,
          start: startedAt,
          ms: Date.now() - startedAt,
          failed: true,
        });
        throw error;
      }
    );
  };

  // jsdom 不做样式布局，给关键元素一份可控的几何数据，
  // 这样窗口计算、滚动换块这些逻辑才真的被走到。
  // 注意：#gallery 的 rect.top 在真实浏览器里是"视口相对"的，会随滚动变负，
  // 这里必须照样模拟，否则"相对滚动位置"永远算成 0。
  const GALLERY_WIDTH = 1200;
  const GALLERY_DOCUMENT_TOP = 0;
  const CELL = (GALLERY_WIDTH - 8 * 6) / 7;
  // 列数是从"画廊实测宽度"算出来的，所以这个宽度必须能改：
  // [7.5] 要验证改宽度之后，已经渲染出来的块会不会跟着换列数。
  let galleryWidth = GALLERY_WIDTH;
  const setGalleryWidth = (width) => {
    galleryWidth = width;
  };
  window.Element.prototype.getBoundingClientRect = function getRect() {
    if (this.id === 'gallery') {
      const top = GALLERY_DOCUMENT_TOP - window.scrollY;
      return {
        top,
        left: 0,
        width: galleryWidth,
        height: window.innerHeight,
        bottom: top + window.innerHeight,
        right: galleryWidth,
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
        return this.id === 'gallery' ? galleryWidth : 0;
      },
    });
  }

  let scrollY = 0;
  let scrollSimulated = true;

  try {
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
  } catch {
    scrollSimulated = false;
  }

  window.scrollTo = (options) => {
    if (typeof options === 'object' && typeof options.top === 'number') {
      scrollY = options.top;
    }
  };

  // jsdom 的 matchMedia 一律返回 matches:false，这里让"鼠标悬停"这条媒体查询为真，
  // 否则实况照片的悬停预览在测试里永远不会启动。
  window.matchMedia = (query) => ({
    matches: /hover/.test(query),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });

  const imageSimulator = startImageSimulator(window);

  // app.js 预加载邻居用的是 `new Image()`。app.js 是在 eval 里跑的，
  // 它顶层的 const/let 从外面看不见，但 `Image` 是按名字从全局对象上取的，
  // 所以把 window.Image 包一层就能精确抓到"它决定预热了哪个地址"。
  const preloadedImageSrcs = [];
  const OriginalImage = window.Image;

  window.Image = function TrackedImage(...args) {
    const image = new OriginalImage(...args);
    let currentSrc = '';

    Object.defineProperty(image, 'src', {
      configurable: true,
      get() {
        return currentSrc;
      },
      set(value) {
        currentSrc = String(value);
        preloadedImageSrcs.push(currentSrc);
      },
    });

    return image;
  };

  window.__preloadedImageSrcs = preloadedImageSrcs;

  // 扫描期的"隐性成本"计数器：请求数、真正新建的 DOM 元素、图片 src 被赋值次数。
  // 卡片被重建一次，就会重新赋一次 src（浏览器重新解码）——这是"越扫越卡"的直接来源。
  const churn = { createdElements: 0, createdCards: 0, srcAssigns: 0, srcUnique: new Set() };
  const seenNodes = new WeakSet();

  function observeCreated(node) {
    if (!node || node.nodeType !== 1) {
      return;
    }

    const elements = [node, ...node.querySelectorAll('*')];

    for (const element of elements) {
      if (seenNodes.has(element)) {
        continue;
      }

      seenNodes.add(element);
      churn.createdElements += 1;

      if (element.dataset && element.dataset.streamIndex !== undefined) {
        churn.createdCards += 1;
      }
    }
  }

  const srcDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLImageElement.prototype,
    'src'
  );

  // 记录每一次 img.src 赋值：既能断言"没有多余请求"，也能查"给的是源文件还是预览图"。
  const imageSrcLog = [];

  if (srcDescriptor?.set) {
    Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
      configurable: true,
      get: srcDescriptor.get,
      set(value) {
        churn.srcAssigns += 1;
        churn.srcUnique.add(String(value));
        imageSrcLog.push(String(value));
        srcDescriptor.set.call(this, value);
      },
    });
  }

  window.__imageSrcLog = imageSrcLog;

  // <video> 的 src 赋值也记一份：jsdom 的媒体元素会立刻报错（它没法真的解码），
  // 所以要按"先后给过哪些地址"来看，而不能只看最后剩哪个。
  const videoSrcLog = [];
  const mediaSrcDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLMediaElement.prototype,
    'src'
  );

  if (mediaSrcDescriptor?.set) {
    Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get: mediaSrcDescriptor.get,
      set(value) {
        videoSrcLog.push(String(value));
        mediaSrcDescriptor.set.call(this, value);
      },
    });
  }

  window.__videoSrcLog = videoSrcLog;

  const createdObserver = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        observeCreated(node);
      }
    }
  });

  function countCalls(prefix) {
    return calls.filter((url) => url.startsWith(prefix)).length;
  }

  try {
    const bootAt = Date.now();
    window.eval(
      fs.readFileSync(path.join(ROOT, 'public', 'photo-stream.js'), 'utf8')
    );
    window.eval(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));

    const document = window.document;
    const gallery = document.querySelector('#gallery');
    createdObserver.observe(document.body, { childList: true, subtree: true });

    // "扫描完成"的时刻必须由状态变化本身记录：
    // 如果等测试里的其它等待（比如等扫描期表头）跑完再读时间，计时就被等待顺序算歪了。
    let readyAt = null;
    const stateObserver = new window.MutationObserver(() => {
      if (readyAt === null && gallery.dataset.state === 'ready') {
        readyAt = Date.now() - bootAt;
      }
    });
    stateObserver.observe(gallery, {
      attributes: true,
      attributeFilter: ['data-state'],
    });

    const requestsAtBoot = {
      summary: countCalls('/api/library/summary'),
      days: countCalls('/api/library/days'),
      items: countCalls('/api/library/items'),
    };

    // 首屏指标：第一张真实照片出现时，扫描还在进行中（这就是"边扫边能看"）
    const firstCardAppeared = await waitFor(
      () => document.querySelector('[data-stream-index]'),
      10000
    );
    const firstCardMs = Date.now() - bootAt;
    const stateAtFirstCard = gallery.dataset.state;

    // 趁扫描还在进行记录进度条状态：扫描结束后它会自动隐藏
    const scanBarElement = document.querySelector('#scanBar');
    const scanBarVisibleDuringScan = Boolean(
      scanBarElement && !scanBarElement.hidden
    );
    const scanTextDuringScan =
      document.querySelector('#scanText')?.textContent || '';

    // 扫描期**不做**按日期分组：趁扫描还在（第一张卡片刚出现时）确认块里没有日期表头，
    // 照片是直接铺在固定占位块里的。
    const scanPhaseStateAtCheck = gallery.dataset.state;
    const headersDuringScan = document.querySelectorAll(
      '.stream-block .day-header'
    ).length;
    const scanBlocksDuringScan = document.querySelectorAll(
      '.stream-block.is-scan'
    ).length;

    const scanFinished = await waitFor(
      () => gallery.dataset.state === 'ready',
      20000
    );
    const readyMs = readyAt === null ? Date.now() - bootAt : readyAt;

    // 扫描期（从启动到 ready）客户端到底花了多少代价
    const scanRequests = {
      summary: countCalls('/api/library/summary') - requestsAtBoot.summary,
      days: countCalls('/api/library/days') - requestsAtBoot.days,
      items: countCalls('/api/library/items') - requestsAtBoot.items,
    };

    console.log(
      `  · 计时：首张照片出现 ${firstCardMs} ms（此时 gallery 状态=${stateAtFirstCard}），扫描完成 ${readyMs} ms（共 ${IMAGE_COUNT} 张）`
    );
    // 服务端自己认定的扫描耗时（区分"扫描慢"还是"前端处理慢"）
    const settled = await fetch(new URL('/api/library/summary', base).toString())
      .then((response) => response.json())
      .catch(() => null);
    const serverScanMs =
      settled?.finishedAt && settled?.startedAt
        ? settled.finishedAt - settled.startedAt
        : null;

    console.log(
      `  · 扫描期客户端代价：请求 summary ${scanRequests.summary} / days ${scanRequests.days} / items ${scanRequests.items}；` +
        `真正新建 DOM 元素 ${churn.createdElements} 个（其中卡片 ${churn.createdCards}）；` +
        `img.src 赋值 ${churn.srcAssigns} 次（去重 ${churn.srcUnique.size}）；` +
        `服务端扫描 ${serverScanMs} ms`
    );

    // 轮询节奏诊断：请求本身多久、两轮之间空了多少时间（空白 = 前端自己的同步工作）
    const summaryCalls = callTimings.filter((call) =>
      call.url.startsWith('/api/library/summary')
    );
    const slowest = [...callTimings]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((call) => `${call.url.split('?')[0]} ${call.ms}ms`)
      .join(' · ');
    const gaps = [];

    for (let index = 1; index < summaryCalls.length; index += 1) {
      gaps.push(
        summaryCalls[index].start -
          (summaryCalls[index - 1].start + summaryCalls[index - 1].ms)
      );
    }

    console.log(
      `  · 轮询节奏：最慢的请求 ${slowest}；两轮之间的空隙 ${gaps.join('/')} ms`
    );
    check(firstCardAppeared && scanFinished, '照片墙完成首次渲染与扫描');
    check(
      stateAtFirstCard === 'loading',
      '第一张照片出现时扫描还没结束（确实没有等全量）',
      `状态=${stateAtFirstCard}`
    );
    check(
      firstCardMs < readyMs,
      '首屏时间早于扫描完成时间',
      `${firstCardMs} ms vs ${readyMs} ms`
    );

    // 加载提示必须在顶部细条里，而不是全屏遮罩挡住照片
    const scanBar = document.querySelector('#scanBar');
    check(
      !document.querySelector('#scanOverlay'),
      '全屏加载遮罩已经移除'
    );
    check(Boolean(scanBar), '顶部扫描进度条存在');
    check(
      Boolean(scanBar && scanBar.closest('.library-content')),
      '扫描进度条在内容区顶部，不是覆盖全屏的浮层'
    );
    check(
      scanBarVisibleDuringScan,
      '扫描期间进度条是可见的'
    );
    check(
      /\/\s*\d+/.test(scanTextDuringScan),
      '进度条文字带着"已读 / 总数"',
      scanTextDuringScan
    );

    // 扫描期不做按日期分组（去掉这个功能是为了省掉每轮重算分段 + 重排已铺好的块）
    check(
      scanPhaseStateAtCheck === 'loading' &&
        headersDuringScan === 0 &&
        scanBlocksDuringScan > 0,
      '扫描期没有日期表头，只有占位块',
      `状态=${scanPhaseStateAtCheck} 表头=${headersDuringScan} 占位块=${scanBlocksDuringScan}`
    );

    console.log('\n[1] 先要总数，再取窗口数据（Lap 的加载顺序）');
    // 扫描完成后才切成"一天一个日期块"
    const ready = await waitFor(() => document.querySelector('.day-header'));
    check(ready, '扫描完成后渲染出日期分组');

    // 启动时还会拉一次缓存占用（/api/cache），这里只看"图库"相关的顺序。
    const libraryCalls = calls.filter((url) => url.startsWith('/api/library/'));
    const summaryIndex = libraryCalls.findIndex((url) =>
      url.startsWith('/api/library/summary')
    );
    const firstItemsIndex = libraryCalls.findIndex((url) =>
      url.startsWith('/api/library/items')
    );
    const daysIndex = libraryCalls.findIndex((url) =>
      url.startsWith('/api/library/days')
    );

    check(
      summaryIndex === 0,
      '图库相关请求里，第一个就是 summary（先知道总数）',
      `实际第一个是 ${libraryCalls[0]}`
    );
    check(
      summaryIndex >= 0 && firstItemsIndex > summaryIndex,
      'items 一定发生在 summary 之后',
      `summary@${summaryIndex} items@${firstItemsIndex}`
    );
    check(
      daysIndex >= 0 &&
        libraryCalls.findIndex(
          (url, index) =>
            index > daysIndex && url.startsWith('/api/library/items')
        ) > daysIndex,
      '切到按天分组后，days 先于那一轮的 items',
      `days@${daysIndex} items@${firstItemsIndex}`
    );
    check(
      calls.every((url) => !url.startsWith('/api/photos')),
      '前端不再调用整库接口 /api/photos'
    );

    console.log('\n[2] 占位与分块：只要可视区，不要全量');
    const renderedBlocks = document.querySelectorAll('.stream-block').length;
    const renderedCards = document.querySelectorAll('.media-card').length;
    const dayHeaders = document.querySelectorAll('.day-header').length;

    check(
      dayHeaders > 0 && dayHeaders < DAY_COUNT,
      '只渲染了可视区附近的几天',
      `渲染 ${dayHeaders} / 共 ${DAY_COUNT} 天`
    );
    check(
      renderedCards < IMAGE_COUNT,
      '渲染的卡片数远小于总张数',
      `渲染 ${renderedCards} / 共 ${IMAGE_COUNT}`
    );
    check(
      document.querySelectorAll('.stream-spacer').length === 2,
      '上下各有一个撑高滚动条的占位块'
    );
    check(
      Number(gallery.querySelector('.stream-spacer')?.style.height.replace('px', '')) >= 0,
      '顶部占位块高度可用'
    );

    const tops = [...document.querySelectorAll('.stream-spacer')].map((element) =>
      Number.parseFloat(element.style.height) || 0
    );
    check(
      tops[1] > 0,
      '底部占位块撑起了剩余内容（滚动条长度正确）',
      `bottom=${tops[1]}`
    );

    const firstDayText = document.querySelector('.day-header')?.textContent || '';
    check(firstDayText.includes('个项目'), '日表头显示了当天张数', firstDayText);
    // 扫描完成时必须换成"精确分组"：扫描期的近似分段在重排后不能继续留在前端
    // （曾经就是这样：分段表不跟着 revision 清掉，完成后表头张数还是发现顺序的旧值）
    check(
      firstDayText.includes(String(FIRST_DAY_COUNT)),
      '扫描完成后换成了精确分组（每天的张数是准的）',
      `${firstDayText}（应为 ${FIRST_DAY_COUNT}）`
    );

    console.log('\n[3] 缩略图按优先级排队取');
    const thumbAssigned = await waitFor(
      () => [...document.querySelectorAll('.stream-block img')].every((image) => image.getAttribute('src')),
      6000
    );
    const withSrc = [...document.querySelectorAll('.stream-block img')].filter(
      (image) => image.getAttribute('src')
    ).length;
    check(thumbAssigned, '可视区内的缩略图都被排上队并取到了', `${withSrc} 张有 src`);
    check(
      [...document.querySelectorAll('.stream-block img')].every((image) =>
        String(image.getAttribute('src')).startsWith('/api/thumb/')
      ),
      '缩略图地址走的是 /api/thumb/:id'
    );

    console.log('\n[4] 侧栏目录与概览');
    const folderNavReady = await waitFor(
      () => document.querySelectorAll('#folderList .folder-item').length > 1,
      5000
    );
    const folderButtons = document.querySelectorAll('#folderList .folder-item').length;
    check(
      folderNavReady,
      '侧栏列出了年/月目录',
      `${folderButtons} 个入口`
    );
    const summaryText = document.querySelector('#summary').textContent;
    check(
      summaryText.includes(`${EXPECTED_TOTAL} 个项目`),
      '概览文字显示总数',
      summaryText
    );

    console.log('\n[4.5] 实况照片：合并成一张卡片 + 悬停播放');
    // 切成按天分组之后，格子会先以占位形式铺出来、再填数据，
    // 所以这里必须等"真实卡片"出现，不能直接断言。
    const liveCardAppeared = await waitFor(
      () => document.querySelector('.media-card.is-live'),
      10000
    );
    const liveCard = document.querySelector('.media-card.is-live');
    check(
      liveCardAppeared && Boolean(liveCard),
      '实况照片的卡片带 is-live 标记',
      `可视区卡片 ${document.querySelectorAll('.stream-block .media-card').length} 个`
    );
    check(
      liveCard?.querySelector('.live-badge')?.textContent.includes('实况') === true,
      '实况卡片上有 LIVE 角标',
      liveCard?.querySelector('.live-badge')?.textContent || '没有角标'
    );
    check(
      liveCard?.title === `${LIVE_PHOTO_NAME}.JPG`,
      '实况卡片显示的是图片那一项',
      liveCard?.title
    );
    check(
      ![...document.querySelectorAll('.media-card')].some(
        (card) => card.title === `${LIVE_PHOTO_NAME}.MOV`
      ),
      '实况照片的同名 MOV 没有单独占一个格子（合成展示了）'
    );
    check(
      [...document.querySelectorAll('.media-card')].some(
        (card) => card.title === `${HEVC_VIDEO_NAME}.MOV`
      ) || !HEVC_VIDEO_AVAILABLE(),
      '没有同名图片的独立 MOV 仍然是普通视频（该显示就显示）',
      HEVC_VIDEO_AVAILABLE() ? '没找到那张视频卡片' : '没有生成 HEVC 视频素材'
    );
    check(
      document.querySelectorAll('.media-card.is-live').length === LIVE_PHOTO_COUNT,
      `照片墙里只有 ${LIVE_PHOTO_COUNT} 张实况照片`,
      `实际 ${document.querySelectorAll('.media-card.is-live').length}`
    );

    // 悬停：延迟一小会儿后在原地叠一个静音视频；移开鼠标就撤掉
    liveCard.dispatchEvent(new window.Event('pointerenter'));
    const hoverStarted = await waitFor(
      () => liveCard.querySelector('video.card-live-video'),
      3000
    );
    check(hoverStarted, '鼠标停住后实况视频开始预览');
    check(
      liveCard.classList.contains('is-live-playing') === false ||
        Boolean(liveCard.querySelector('.card-live-video')),
      '预览视频是叠在卡片里的（不改卡片尺寸）'
    );
    check(
      liveCard.querySelector('video.card-live-video')?.muted === true,
      '悬停预览是静音的'
    );

    liveCard.dispatchEvent(new window.Event('pointerleave'));
    const hoverStopped = await waitFor(
      () => !liveCard.querySelector('video.card-live-video'),
      2000
    );
    check(hoverStopped, '鼠标移开后预览视频被移除（不会一直占解码器）');

    console.log('\n[5] 打开查看器：邻居由服务端给');
    // 只点真实卡片（占位格没有点击行为）
    const cardReady = await waitFor(
      () => document.querySelector('.stream-block [data-stream-index]'),
      5000
    );
    check(cardReady, '可视区里已经出现真实卡片');

    document
      .querySelector('.stream-block [data-stream-index]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const viewerOpened = await waitFor(() =>
      document.querySelector('#viewer')?.classList.contains('is-open')
    );
    check(viewerOpened, '查看器打开');
    check(
      (document.querySelector('#viewerFilename')?.textContent || '').length > 0,
      '查看器显示文件名',
      document.querySelector('#viewerFilename')?.textContent
    );

    const counterReady = await waitFor(() =>
      /\d+ \/ \d+/.test(document.querySelector('#viewerCounter')?.textContent || '')
    );
    check(counterReady, '计数器显示"第几张 / 共几张"', document.querySelector('#viewerCounter')?.textContent);
    check(
      (document.querySelector('#viewerCounter')?.textContent || '').includes(`/ ${EXPECTED_TOTAL}`),
      '总数来自服务端邻居接口',
      document.querySelector('#viewerCounter')?.textContent
    );
    check(
      document.querySelector('#viewerPrev')?.disabled === false ||
        document.querySelector('#viewerNext')?.disabled === false,
      '前后翻页按钮至少有一个可用'
    );

    const detailRequest = calls.filter((url) =>
      url.startsWith('/api/library/neighbors/')
    ).length;
    check(detailRequest > 0, '翻页信息来自 /api/library/neighbors');

    // 查看器翻页：邻居是异步取回来的，点得太快时那一下会"原地不动"，
// 所以这里点一下等一会儿，最多试几次，直到文件名真的变成目标。
    async function stepViewerTo(name, direction = 1, { attempts = 8 } = {}) {
      const readName = () =>
        document.querySelector('#viewerFilename')?.textContent || '';

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (readName() === name) {
          return true;
        }

        const button = document.querySelector(
          direction > 0 ? '#viewerNext' : '#viewerPrev'
        );

        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await delay(80);
      }

      return readName() === name;
    }

    console.log('\n[5.4] 源文件直出：原生格式不生成转换预览');
    // 预加载用的是 `new Image()`，测试在 setup 里包了一层记录它设了哪个 src
    const readPreloadedUrls = () => [...window.__preloadedImageSrcs];

    const openedSrc =
      document.querySelector('#viewerMedia img')?.getAttribute('src') || '';
    check(
      openedSrc.startsWith('/api/file/'),
      '查看器里给的是源文件地址（/api/file/:id），不是转换预览',
      openedSrc
    );

    const preloadedOnOpen = readPreloadedUrls();
    check(
      preloadedOnOpen.length > 0 &&
        preloadedOnOpen.every((url) => url.startsWith('/api/file/')),
      '预加载邻居预热的是源文件地址',
      preloadedOnOpen.join(', ')
    );

    // 拿这份源文件和服务端返回的字节比一遍：确认看到的确实是原文件本体
    const sourceResponse = await fetch(new URL(openedSrc, base).toString());
    const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
    const livePhotoFile = await fsp.readFile(
      path.join(PHOTOS, '2026', '202607', `${LIVE_PHOTO_NAME}.JPG`)
    );
    check(
      sourceResponse.status === 200 && sourceBytes.equals(livePhotoFile),
      '服务端返回的字节 = 磁盘上的原文件（一点没动过）',
      `${sourceBytes.length}B vs ${livePhotoFile.length}B`
    );

    // 翻到下一张：08:30 的那张 PNG，同样必须是源文件
    const pngOpened = await stepViewerTo(`${PNG_NAME}.PNG`, 1);
    check(pngOpened, '翻页到下一张 PNG', document.querySelector('#viewerFilename')?.textContent);

    const pngSrc =
      document.querySelector('#viewerMedia img')?.getAttribute('src') || '';
    check(
      pngSrc.startsWith('/api/file/'),
      'PNG 给的也是源文件地址',
      pngSrc
    );

    const pngResponse = await fetch(new URL(pngSrc, base).toString());
    const pngBytes = Buffer.from(await pngResponse.arrayBuffer());
    const pngFile = await fsp.readFile(
      path.join(PHOTOS, '2026', '202607', `${PNG_NAME}.PNG`)
    );
    check(
      pngResponse.status === 200 &&
        pngBytes.equals(pngFile) &&
        /image\/png/.test(pngResponse.headers.get('content-type') || ''),
      'PNG 返回的就是原文件字节（含透明通道，没有转成 JPG）',
      `${pngBytes.length}B ${pngResponse.headers.get('content-type')}`
    );

    // 整轮浏览下来：一次预览请求都不该有，cache\previews 里也不该多出东西
    const previewRequests = calls.filter((url) =>
      url.startsWith('/api/preview/')
    );
    check(
      previewRequests.length === 0,
      '浏览 / 翻页过程中一次都没有请求 /api/preview',
      previewRequests.slice(0, 3).join(', ')
    );

    const previewSrcAssigns = window.__imageSrcLog.filter((src) =>
      src.startsWith('/api/preview/')
    );
    check(
      previewSrcAssigns.length === 0,
      '预加载和查看器都没有把 /api/preview 塞进 <img>（以前预加载邻居就会）',
      previewSrcAssigns.slice(0, 3).join(', ')
    );
    // 目录压根不存在也算 0 —— 那就说明一次预览都没生成过（更彻底）
    const previewFiles = fs.existsSync(CACHE_PREVIEWS)
      ? fs.readdirSync(CACHE_PREVIEWS)
      : [];
    check(
      previewFiles.length === 0,
      'cache\\previews 里没有多出 JPEG（目录都没被建出来）',
      previewFiles.join(', ')
    );

    // 回到实况照片那张，后面的断言还指着它
    await stepViewerTo(`${LIVE_PHOTO_NAME}.JPG`, -1);

    console.log('\n[5.45] 必须转换的格式（TIFF）：只在真正打开时才转');
    // (a) 纯函数判定：TIFF 走转换预览，PNG 走源文件
    const probe = window.eval(`
      (function () {
        const converted = {
          id: 'probe-tiff',
          type: 'image',
          extension: 'TIF',
          name: '探针.TIF',
          size: 2 * 1024 * 1024,
          previewUrl: '/api/preview/probe-tiff',
          fileUrl: '/api/file/probe-tiff',
          thumbUrl: '/api/thumb/probe-tiff',
        };
        const png = {
          id: 'probe-png',
          type: 'image',
          extension: 'PNG',
          name: '探针.PNG',
          size: 1024 * 1024,
          previewUrl: '/api/preview/probe-png',
          fileUrl: '/api/file/probe-png',
          thumbUrl: '/api/thumb/probe-png',
        };
        return {
          convertedDisplay: viewerImageUrl(converted),
          pngDisplay: viewerImageUrl(png),
          convertedNeedsConvert: needsConvertedPreview(converted),
          pngNeedsConvert: needsConvertedPreview(png),
        };
      })()
    `);

    check(
      probe.convertedNeedsConvert === true && probe.pngNeedsConvert === false,
      'TIFF 被判为"需要转换"、PNG 不是',
      JSON.stringify(probe)
    );
    check(
      probe.convertedDisplay === '/api/preview/probe-tiff' &&
        probe.pngDisplay === '/api/file/probe-png',
      '打开时 TIFF 用转换预览、PNG 用源文件',
      JSON.stringify(probe)
    );

    // (b) 真数据：先走到 PNG 上，它的下一张就是那张 TIFF
    const reachedPng = await stepViewerTo(`${PNG_NAME}.PNG`, 1);

    check(
      reachedPng &&
        (document.querySelector('#viewerFilename')?.textContent || '') ===
          `${PNG_NAME}.PNG`,
      '当前停在 PNG 上（下一张就是必须转换的 TIFF）',
      document.querySelector('#viewerFilename')?.textContent
    );

    const preloadedOnPng = readPreloadedUrls();
    check(
      preloadedOnPng.every((url) => !url.includes('/api/preview/')),
      '邻居里有 TIFF，但没有被预热（翻页不会顺手把邻居也转一遍）',
      preloadedOnPng.join(', ')
    );
    check(
      preloadedOnPng.some((url) => url.startsWith('/api/file/')),
      '同一时刻原生格式的邻居照样预热（源文件）',
      preloadedOnPng.join(', ')
    );

    // (c) 真正打开 TIFF 这一张：这时才走转换预览
    const tiffOpened = await stepViewerTo(`${TIFF_NAME}.TIF`, 1);
    check(tiffOpened, '翻开那张 TIFF', document.querySelector('#viewerFilename')?.textContent);

    const tiffSrc =
      document.querySelector('#viewerMedia img')?.getAttribute('src') || '';
    check(
      tiffSrc.startsWith('/api/preview/'),
      '打开 TIFF 时才请求转换预览（这时候才转）',
      tiffSrc
    );
    check(
      (document.querySelector('#viewerSpinnerText')?.textContent || '').includes(
        '转换'
      ) || document.querySelector('#viewerSpinner')?.hidden === true,
      '转换期间提示写明了是在转换',
      document.querySelector('#viewerSpinnerText')?.textContent
    );

    // (d) 服务端确实是在"打开这一张"时才生成了预览文件
    const previewBefore = fs.existsSync(CACHE_PREVIEWS)
      ? fs.readdirSync(CACHE_PREVIEWS).length
      : 0;
    await fetch(new URL(tiffSrc, base).toString());
    const previewAfter = fs.existsSync(CACHE_PREVIEWS)
      ? fs.readdirSync(CACHE_PREVIEWS).length
      : 0;
    check(
      previewBefore === 0 && previewAfter === 1,
      '打开之前 previews 是空的，打开之后才多出这一张的预览',
      `${previewBefore} → ${previewAfter}`
    );

    // 回到实况照片那张，后面 [5.5] 还要用它
    await stepViewerTo(`${PNG_NAME}.PNG`, -1);
    await stepViewerTo(`${LIVE_PHOTO_NAME}.JPG`, -1);

    console.log('\n[5.5] 查看器：实况按钮 + 叠放播放 + 详情');
    // 上一段打开的是可视区里的第一张卡片，也就是那张实况照片
    check(
      !document.querySelector('#viewerLive')?.hidden,
      '打开实况照片时"实况"按钮是可见的',
      document.querySelector('#viewerFilename')?.textContent
    );

    document
      .querySelector('#viewerLive')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const liveViewerStarted = await waitFor(
      () => document.querySelector('#viewerMedia video.viewer-live-video'),
      3000
    );
    check(liveViewerStarted, '点"实况"后视频叠在静止图上播放');
    check(
      document.querySelector('#viewerMedia img')?.isConnected === true,
      '静止图仍然留着当海报（播完要回到它）'
    );

    document
      .querySelector('#viewerMedia video.viewer-live-video')
      ?.dispatchEvent(new window.Event('ended'));
    const liveViewerStopped = await waitFor(
      () => !document.querySelector('#viewerMedia video.viewer-live-video'),
      2000
    );
    check(liveViewerStopped, '播完之后视频被移除，回到静止图');

    document
      .querySelector('#viewerDetailsButton')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const detailsShown = await waitFor(
      () => !document.querySelector('#viewerDetails')?.hidden,
      2000
    );
    const detailsText = document.querySelector('#detailsContent')?.textContent || '';
    check(detailsShown, '详情面板可以打开');
    check(
      detailsText.includes('实况'),
      '详情面板标出了"实况照片"和伴随视频',
      detailsText.slice(0, 120)
    );
    check(
      (document.querySelector('#detailsSubtitle')?.textContent || '').includes('实况'),
      '详情标题写的是实况照片',
      document.querySelector('#detailsSubtitle')?.textContent
    );
    document
      .querySelector('#detailsClose')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('#viewerDetails')?.hidden, 2000);
    // 查看器继续开着（和改动前一样），下面的滚动断言接着跑

    console.log('\n[5.6] 清理缓存弹窗：三档各清各的');
    // 先关掉查看器，避免它挡着（也顺手验证 Esc 关闭仍然可用）
    document
      .querySelector('#viewerClose')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(
      () => !document.querySelector('#viewer')?.classList.contains('is-open'),
      2000
    );

    // jsdom 不会真的去请求图片，所以这里手动生成一份缩略图 + 预览图，
    // 否则缓存本来就是空的，三档占用全显示"空"，断言就没意义了。
    const samplePage = await fetch(
      new URL('/api/library/items?offset=0&limit=1', base).toString()
    ).then((response) => response.json());
    const sampleItem = samplePage?.items?.[0];
    await fetch(new URL(`/api/thumb/${sampleItem.id}`, base).toString());
    await fetch(new URL(`/api/preview/${sampleItem.id}`, base).toString());

    document
      .querySelector('#clearCacheButton')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const cacheDialogOpen = await waitFor(
      () => !document.querySelector('#cacheConfirm')?.hidden,
      2000
    );
    check(cacheDialogOpen, '点"清理缓存"打开弹窗');

    const cacheOptions = [
      ...document.querySelectorAll('[data-cache-kind]'),
    ];
    check(
      cacheOptions.length === 3,
      '弹窗里有三个选项：缩略图 / 打开的图片视频 / 全部',
      `实际 ${cacheOptions.length} 个`
    );
    check(
      cacheOptions.map((option) => option.dataset.cacheKind).join(',') ===
        'thumbnails,media,all',
      '三个选项的顺序和类型正确',
      cacheOptions.map((option) => option.dataset.cacheKind).join(',')
    );

    // 等占用真的读回来（初始值是"—"，读到空缓存时是"空"）
    const sizesReady = await waitFor(
      () =>
        ['#cacheThumbnailsSize', '#cacheMediaSize', '#cacheAllSize'].every(
          (selector) => {
            const text = document.querySelector(selector)?.textContent || '';
            return text !== '—' && text !== '空' && text.length > 0;
          }
        ),
      5000
    );
    const sizesText = [
      document.querySelector('#cacheThumbnailsSize')?.textContent,
      document.querySelector('#cacheMediaSize')?.textContent,
      document.querySelector('#cacheAllSize')?.textContent,
    ].join(' / ');
    check(sizesReady, '三个选项各自显示了占用', sizesText);
    check(
      /KB|MB|B/.test(document.querySelector('#cacheAllSize')?.textContent || ''),
      '“全部缓存”显示的是真实占用',
      document.querySelector('#cacheAllSize')?.textContent
    );

    // 点"缩略图"那一档：请求体里必须带上 kind=thumbnails
    const clearCallsBefore = calls.filter((url) =>
      url.startsWith('/api/cache/clear')
    ).length;
    document
      .querySelector('#cacheClearThumbnails')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const clearRequestSeen = await waitFor(
      () =>
        calls.filter((url) => url.startsWith('/api/cache/clear')).length >
        clearCallsBefore,
      4000
    );
    check(clearRequestSeen, '点第一档会发清理请求');

    const clearBody = window.__lastCacheClearBody;
    check(
      clearBody?.kind === 'thumbnails',
      '请求体里带的是 kind=thumbnails（只清这一档）',
      JSON.stringify(clearBody)
    );

    // 清完（请求回来了）之后弹窗还留着，而且缩略图那一档变成"空"
    const clearedInPlace = await waitFor(
      () =>
        document.querySelector('#cacheCancelButton')?.disabled === false &&
        document.querySelector('#cacheThumbnailsSize')?.textContent === '空',
      4000
    );
    check(
      clearedInPlace && document.querySelector('#cacheConfirm')?.hidden === false,
      '清完一档弹窗还留着，数字刷新成"空"，可以接着清别的',
      `缩略图=${document.querySelector('#cacheThumbnailsSize')?.textContent} 全部=${document.querySelector('#cacheAllSize')?.textContent}`
    );
    check(
      document.querySelector('#cacheClearThumbnails')?.disabled === true,
      '已经空掉的那一档按钮会被置灰'
    );

    document
      .querySelector('#cacheCancelButton')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const cacheDialogClosed = await waitFor(
      () => document.querySelector('#cacheConfirm')?.hidden,
      2000
    );
    check(cacheDialogClosed, '点取消关掉弹窗');

    console.log('\n[5.7] 视频：HEVC 优先直出、失败再转（预判 / 记忆 / 隐藏）');
    // 把 canPlayType 变成可控的：它正是前端"预判能不能解 HEVC"用的那一步
    const probeAnswers = { answer: '', calls: [] };
    const originalCanPlayType = window.HTMLMediaElement.prototype.canPlayType;

    window.HTMLMediaElement.prototype.canPlayType = function canPlayType(type) {
      probeAnswers.calls.push(String(type));
      return probeAnswers.answer;
    };

    // (a) 真数据：打开查看器，走到那个真 HEVC 视频。
    // 预判设成"这台机器能解 HEVC"，所以应该直出源文件。
    // 前面 [4.5] 的悬停预览已经用真 canPlayType（jsdom 返回空串）问过一次并缓存了，
    // 这里清掉会话缓存，让它按"能解"重新问一遍。
    probeAnswers.answer = 'probably';
    window.sessionStorage.clear();

    if (HEVC_VIDEO_AVAILABLE()) {
      // [5.6] 里把查看器关掉了，这里重新打开（第一张卡片 = 实况照片）
      document
        .querySelector('.stream-block [data-stream-index]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      const viewerReopened = await waitFor(
        () => document.querySelector('#viewer')?.classList.contains('is-open'),
        3000
      );
      check(viewerReopened, '重新打开查看器（视频这一段要用）');

      const reachedHevc = await stepViewerTo(`${HEVC_VIDEO_NAME}.MOV`, 1, {
        attempts: 10,
      });

      check(
        reachedHevc,
        '翻到那个真 HEVC 视频',
        document.querySelector('#viewerFilename')?.textContent
      );

      const directVideo = document.querySelector('#viewerMedia video');
      check(
        Boolean(directVideo) && directVideo.dataset.source === 'direct',
        '首次打开：走直出（源文件）',
        `${directVideo?.dataset.source} src=${directVideo?.getAttribute('src')}`
      );
      check(
        (directVideo?.getAttribute('src') || '').startsWith('/api/file/'),
        '直出给的是 /api/file/:id（源文件）',
        directVideo?.getAttribute('src')
      );
      check(
        document.querySelector('#viewerSpinner')?.hidden === false ||
          document.querySelector('#viewerSpinnerText')?.textContent === '',
        '播放器加载完成前一直有转圈提示盖着（不露黑屏）',
        document.querySelector('#viewerSpinnerText')?.textContent
      );

      // 假设这台机器其实解不了：浏览器报错 → 静默换成转码地址
      directVideo.dispatchEvent(new window.Event('error'));
      await delay(120);

      const fallbackVideo = document.querySelector('#viewerMedia video');
      const mediaChildren = document.querySelectorAll('#viewerMedia video').length;
      check(
        Boolean(fallbackVideo) && fallbackVideo.dataset.source === 'transcode',
        '直出失败后自动换成转码版本',
        `${fallbackVideo?.dataset.source} src=${fallbackVideo?.getAttribute('src')}`
      );
      check(
        (fallbackVideo?.getAttribute('src') || '').startsWith('/api/video/'),
        '换过去的是 /api/video/:id（转码那一份）',
        fallbackVideo?.getAttribute('src')
      );
      check(
        mediaChildren <= 1 && directVideo.isConnected === false,
        '失败的那个 <video> 已经撤掉（不会两个播放器并排）',
        `${mediaChildren} 个，原节点还在 DOM 里=${directVideo.isConnected}`
      );
      check(
        (document.querySelector('#viewerSpinnerText')?.textContent || '').includes(
          '转码'
        ),
        '换转码期间提示写明了原因',
        document.querySelector('#viewerSpinnerText')?.textContent
      );

      // 记住这次失败：localStorage 里有它，而且下次打开直接走转码、不再试
      const remembered = window.localStorage.getItem(
        'album-direct-video-failures-v1'
      );
      const rememberedIds = JSON.parse(remembered || '[]');
      check(
        rememberedIds.length === 1,
        '失败按文件记进 localStorage（下次不再试）',
        remembered
      );

      const secondPlan = window.eval(`
        (function () {
          const raw = window.localStorage.getItem('album-direct-video-failures-v1');
          return raw;
        })()
      `);
      check(Boolean(secondPlan), 'localStorage 里确实写进去了', secondPlan);

      // 离开再回来：应该直接是转码版本，一次直出都不试
      await stepViewerTo(`${TIFF_NAME}.TIF`, -1);
      const reachedHevcAgain = await stepViewerTo(`${HEVC_VIDEO_NAME}.MOV`, 1);
      const reopened = document.querySelector('#viewerMedia video');
      check(
        reachedHevcAgain && reopened?.dataset.source === 'transcode',
        '再看同一个视频：直接走转码（记住失败了）',
        `${reopened?.dataset.source}`
      );

      // 详情面板要说清这次播的是什么
      reopened.dispatchEvent(new window.Event('canplay'));
      await delay(60);
      document
        .querySelector('#viewerDetailsButton')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(() => !document.querySelector('#viewerDetails')?.hidden, 2000);
      const videoDetails = document.querySelector('#detailsContent')?.textContent || '';
      check(
        videoDetails.includes('播放方式') && videoDetails.includes('转码'),
        '详情面板写出了这次是转码副本',
        videoDetails.slice(0, 160)
      );
      document
        .querySelector('#detailsClose')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(() => document.querySelector('#viewerDetails')?.hidden, 2000);
    } else {
      console.log('  · 没有 ffmpeg（或生成失败），跳过真实 HEVC 视频的直出/回退断言');
    }

    // (b) 判定矩阵：用 MP4 容器的新键（上面那个真视频走的是 MOV 的键，互不干扰）
    // 上面那段 e2e 可能已经预判过一次（MOV 容器），所以这里用相对计数
    const probeBaseline = probeAnswers.calls.length;
    probeAnswers.answer = '';
    const planHelpers = window.eval(`
      (function () {
        window.__planOf = (id, codec, extension) => videoPlaybackPlan({
          id,
          type: 'video',
          name: id + '.' + extension,
          extension,
          videoCodec: codec,
          fileUrl: '/api/file/' + id,
          videoUrl: '/api/video/' + id,
        });
        return true;
      })()
    `);
    const planOf = (id, codec, extension) =>
      window.eval(`window.__planOf(${JSON.stringify(id)}, ${JSON.stringify(codec)}, ${JSON.stringify(extension)})`);

    check(Boolean(planHelpers), '拿到了判定函数的探针入口');

    const nativePlan = planOf('m1', 'h264', 'MP4');
    const unknownPlan = planOf('m2', 'mpeg4', 'MP4');
    const nothingPlan = planOf('m3', null, 'MP4');
    const callsAfterNative = probeAnswers.calls.length;

    check(
      nativePlan.mode === 'direct' && nativePlan.url === '/api/file/m1',
      'H.264 直接给源文件（浏览器自带解码器）',
      JSON.stringify(nativePlan)
    );
    check(
      unknownPlan.mode === 'transcode' &&
        unknownPlan.reason === 'unsupported-codec' &&
        nothingPlan.mode === 'transcode',
      'MPEG-4 / 编码未知的视频直接走转码（不做无谓尝试）',
      `${JSON.stringify(unknownPlan)} / ${JSON.stringify(nothingPlan)}`
    );
    check(
      unknownPlan.url === '/api/video/m2' && nativePlan.url === '/api/file/m1',
      '转码走 videoUrl、直出走 fileUrl',
      `${unknownPlan.url} / ${nativePlan.url}`
    );
    check(
      callsAfterNative === probeBaseline,
      'h264 不用问、mpeg4/未知不值得问 → 矩阵里一次预判都没发生',
      `${probeBaseline} → ${callsAfterNative}（${probeAnswers.calls.join(' | ')}）`
    );

    const hevcUnsurePlan = planOf('m4', 'hevc', 'MP4');
    const callsAfterNo = probeAnswers.calls.length;
    probeAnswers.answer = 'probably';
    const hevcUnsurePlanAgain = planOf('m5', 'hevc', 'MP4');
    const callsAfterNoCached = probeAnswers.calls.length;

    check(
      hevcUnsurePlan.mode === 'direct' &&
        hevcUnsurePlan.reason === 'probe-unsure' &&
        hevcUnsurePlan.url === '/api/file/m4' &&
        callsAfterNo === probeBaseline + 1,
      '预判答不上来（空串）→ 也先试源文件（"不确定"不等于"解不了"）',
      `${JSON.stringify(hevcUnsurePlan)} 预判次数=${probeBaseline} → ${callsAfterNo}`
    );
    check(
      hevcUnsurePlanAgain.mode === 'direct' &&
        hevcUnsurePlanAgain.reason === 'probe-unsure' &&
        callsAfterNoCached === callsAfterNo,
      '同一个"编码 + 容器"只问一次（答不上来也记住结论，不反复问）',
      `${JSON.stringify(hevcUnsurePlanAgain)} 预判次数=${callsAfterNoCached}`
    );
    check(
      window.sessionStorage.getItem('album-video-probe-v1:hevc|MP4') === '?',
      '答不上来的结论存成 "?"（不再写成老的 "0"）',
      window.sessionStorage.getItem('album-video-probe-v1:hevc|MP4')
    );

    // 老版本把"答不上来"写成了 '0'（当成"解不了"），升级上来的会话里如果还留着 '0'，
    // 也必须当"不确定"处理，否则老用户永远等不到它去试。
    // 用一个不跟真素材冲突的键（真素材是 hevc|MOV / hevc|MP4），免得影响后面的断言。
    window.sessionStorage.setItem('album-video-probe-v1:hevc|M4V', '0');
    const legacyPlan = planOf('m8', 'hevc', 'M4V');
    const callsAfterLegacy = probeAnswers.calls.length;

    check(
      legacyPlan.mode === 'direct' &&
        legacyPlan.reason === 'probe-unsure' &&
        callsAfterLegacy === callsAfterNoCached,
      '老版本留下的 "0" 一律当"不确定"→ 照样先试一次（不被旧结论挡死）',
      `${JSON.stringify(legacyPlan)} 预判次数=${callsAfterNoCached} → ${callsAfterLegacy}`
    );

    const hvc1Plan = planOf('m6', 'hvc1', 'MP4');
    const hvc1Again = planOf('m7', 'hvc1', 'MP4');
    const callsAfterHvc1 = probeAnswers.calls.length;

    check(
      hvc1Plan.mode === 'direct' && hvc1Plan.url === '/api/file/m6',
      '预判说能解 HEVC（hvc1 写法）→ 直出源文件',
      JSON.stringify(hvc1Plan)
    );
    check(
      hvc1Again.mode === 'direct' && callsAfterHvc1 === probeBaseline + 2,
      '换成 hevc 的另一种写法也一样，且第二次不再预判',
      `${JSON.stringify(hvc1Again)} 预判次数=${probeBaseline} → ${callsAfterHvc1}`
    );

    // (c) 实况照片的伴随 MOV 也走同一套：能直出就直出，失败静默换成转码
    if (HEVC_VIDEO_AVAILABLE()) {
      // 悬停预览只在查看器关着的时候才起播
      document
        .querySelector('#viewerClose')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(
        () => !document.querySelector('#viewer')?.classList.contains('is-open'),
        2000
      );

      probeAnswers.answer = 'probably';
      const liveCard = document.querySelector('.media-card.is-live');
      const liveItems = await fetch(
        new URL('/api/library/items?offset=0&limit=512', base).toString()
      ).then((response) => response.json());
      const liveItem = liveItems.items.find((entry) => entry.livePhoto);
      const videoLogMark = window.__videoSrcLog.length;
      liveCard.dispatchEvent(new window.Event('pointerenter'));

      const hoverStarted = await waitFor(
        () => liveCard.querySelector('video.card-live-video'),
        3000
      );
      const hoverSrcs = window.__videoSrcLog.slice(videoLogMark);
      const firstHoverSrc = hoverSrcs[0] || '';

      check(
        hoverStarted && firstHoverSrc.startsWith('/api/file/'),
        '实况照片的悬停预览先试源文件（伴随 MOV 直出）',
        hoverSrcs.map((url) => url.slice(0, 12)).join(' → ')
      );

      // jsdom 不会自己给媒体元素报错，这里手动模拟"这台机器其实解不了"
      liveCard
        .querySelector('video.card-live-video')
        ?.dispatchEvent(new window.Event('error'));
      await delay(120);

      const hoverFallbackSrc =
        liveCard.querySelector('video.card-live-video')?.getAttribute('src') || '';
      check(
        hoverFallbackSrc.startsWith('/api/video/'),
        '直出报错后悬停预览静默换成转码版本',
        window.__videoSrcLog.slice(videoLogMark).map((url) => url.slice(0, 12)).join(' → ')
      );
      check(
        liveCard.querySelectorAll('video.card-live-video').length === 1,
        '悬停预览也不会留下两个 <video>',
        `${liveCard.querySelectorAll('video').length} 个`
      );
      check(
        JSON.parse(
          window.localStorage.getItem('album-direct-video-failures-v1') || '[]'
        ).includes(liveItem.liveVideoId),
        '伴随 MOV 的直出失败也被记住了（下次直接转码）'
      );

      liveCard.dispatchEvent(new window.Event('pointerleave'));
      await waitFor(() => !liveCard.querySelector('video.card-live-video'), 2000);
    }

    console.log('\n[5.8] 预判答不上来（空串）也要真试一次源文件');
    // Chromium 对 `video/quicktime; codecs="hevc"` 这种问法经常回空串（它答不上来），
    // 旧逻辑把空串当"解不了"→ 永远转码。现在空串 = 不确定 → 先真试一次，
    // 失败/超时再静默换转码（并记住）。这一段就是那个行为的端到端回归。
    if (HEVC_VIDEO_AVAILABLE()) {
      probeAnswers.answer = ''; // jsdom 的默认答案就是空串：答不上来
      window.sessionStorage.clear(); // 丢掉之前缓存的预判结论

      // 关掉再打开"直出" = 清掉两类记忆（用户能做的那个重置手势）
      const directButton = document.querySelector('#directButton');
      directButton.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      );
      directButton.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true })
      );

      check(
        JSON.parse(
          window.localStorage.getItem('album-direct-video-failures-v1') || '[]'
        ).length === 0,
        '先把"直出失败"的记忆清空（假装从没试过）'
      );

      document
        .querySelector('.stream-block [data-stream-index]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(
        () => document.querySelector('#viewer')?.classList.contains('is-open'),
        3000
      );

      const reachedUnsure = await stepViewerTo(`${HEVC_VIDEO_NAME}.MOV`, 1, {
        attempts: 10,
      });
      const unsureVideo = document.querySelector('#viewerMedia video');

      check(
        reachedUnsure &&
          unsureVideo?.dataset.source === 'direct' &&
          (unsureVideo?.getAttribute('src') || '').startsWith('/api/file/'),
        '预判答不上来也先给源文件（/api/file/:id），不再直接转码',
        `source=${unsureVideo?.dataset.source} src=${unsureVideo?.getAttribute('src')}`
      );
      check(
        window.sessionStorage.getItem('album-video-probe-v1:hevc|MOV') === '?',
        '结论在会话里记成 "?"（Application 面板里能直接看到"答不上来"）',
        window.sessionStorage.getItem('album-video-probe-v1:hevc|MOV')
      );
      check(
        (document.querySelector('#viewerSpinnerText')?.textContent || '').includes(
          '试播'
        ),
        '转圈提示写明了"正在试播源文件"（不是一上来就说在转码）',
        document.querySelector('#viewerSpinnerText')?.textContent
      );

      // 真解不了：报错 → 静默换转码 + 记住这个文件
      unsureVideo?.dispatchEvent(new window.Event('error'));
      await delay(120);

      const swappedVideo = document.querySelector('#viewerMedia video');
      check(
        swappedVideo?.dataset.source === 'transcode' &&
          (swappedVideo?.getAttribute('src') || '').startsWith('/api/video/'),
        '试不动就静默换成转码版本（不让用户看点不了的黑屏）',
        `source=${swappedVideo?.dataset.source} src=${swappedVideo?.getAttribute('src')}`
      );
      check(
        JSON.parse(
          window.localStorage.getItem('album-direct-video-failures-v1') || '[]'
        ).length === 1,
        '这次失败被记住（同一个文件下次直接转码）'
      );

      document
        .querySelector('#viewerClose')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(
        () => !document.querySelector('#viewer')?.classList.contains('is-open'),
        2000
      );
    }

    window.HTMLMediaElement.prototype.canPlayType = originalCanPlayType;

    console.log('\n[6] 滚动：换块 + 取新的一段数据');
    if (!scrollSimulated) {
      console.log('  · jsdom 不允许改写 scrollY，跳过滚动断言');
    } else {
      const before = calls.filter((url) => url.startsWith('/api/library/items')).length;

      // (a) 小幅滚动（真实滚轮的场景）：窗口内的块必须原样复用。
      // 复用 DOM 才不会闪 —— 重建会让所有图片重新解码，肉眼看到的就是闪烁。
      const cardsBefore = [...document.querySelectorAll('.stream-block .media-card')];
      for (const card of cardsBefore) {
        card.dataset.reuseProbe = '1';
      }

      scrollY += 500;
      window.dispatchEvent(new window.Event('scroll'));
      await delay(250);

      const survived = cardsBefore.filter(
        (card) => card.isConnected && card.dataset.reuseProbe === '1'
      ).length;
      const survivedRatio = cardsBefore.length ? survived / cardsBefore.length : 1;

      console.log(
        `  · 复用：小幅滚动后仍保留 ${survived}/${cardsBefore.length} 个卡片节点（整窗重建时会是 0）`
      );

      check(
        survivedRatio > 0.3,
        '小幅滚动复用已有卡片 DOM（不是整窗口重建，所以不闪）',
        `保留 ${survived}/${cardsBefore.length}`
      );

      // (b) 大幅跳转：换到另一天，并取新的一段数据
      const firstKeyBefore =
        document.querySelector('.stream-block .day-header')?.textContent || '';

      scrollY = 8000;
      window.dispatchEvent(new window.Event('scroll'));

      const scrolled = await waitFor(() => {
        const keyNow =
          document.querySelector('.stream-block .day-header')?.textContent || '';
        return keyNow && keyNow !== firstKeyBefore;
      }, 4000);

      const after = calls.filter((url) => url.startsWith('/api/library/items')).length;

      if (!scrolled || after === before) {
        // 失败时把可见的布局状态打出来，方便区分"没重算"还是"算错了"
        const spacers = [...document.querySelectorAll('.stream-spacer')].map(
          (element) => element.style.height
        );
        console.log(
          `  · 诊断：scrollY=${scrollY} 渲染块=${document.querySelectorAll('.stream-block').length} 占位块=${spacers.join(' / ')}`
        );
      }

      check(scrolled, '滚动后渲染的是另一天的内容', `之前 ${firstKeyBefore}`);
      check(after > before, '滚动触发了新的分块数据请求', `${before} → ${after}`);

      const offsets = calls
        .filter((url) => url.startsWith('/api/library/items'))
        .map((url) => Number(new URL(url, base).searchParams.get('offset') || 0));
      check(
        offsets.some((offset) => offset > 0),
        '确实请求了后面的数据段（offset > 0）',
        `offsets=${offsets.slice(0, 8).join(',')}`
      );
    }
  console.log('\n[7] 点视频卡片：相册模式在应用内播，不交给 PotPlayer');
    // 以前这里是硬编码的"视频一律用外部播放器打开"，所以相册模式点视频也会弹 PotPlayer。
    // 现在相册模式一律进应用内查看器（视频走"直出 / 转码"那条链），只有系统模式才交出去。
    scrollY = 0;
    window.dispatchEvent(new window.Event('scroll'));

    const videoCardShown = await waitFor(
      () => document.querySelector('.media-card.is-video'),
      4000
    );
    const videoCard = document.querySelector('.media-card.is-video');
    check(videoCardShown && Boolean(videoCard), '视频卡片出现在照片墙上');

    if (videoCard) {
      const openCallsBefore = calls.filter((url) =>
        url.startsWith('/api/open/')
      ).length;

      videoCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

      const viewerOpened = await waitFor(
        () => document.querySelector('#viewer')?.classList.contains('is-open'),
        3000
      );
      await delay(150);

      const inAppVideo = document.querySelector('#viewerMedia video');
      check(
        viewerOpened && Boolean(inAppVideo),
        '相册模式：点视频卡片进的是应用内查看器，里面有 <video>',
        `viewer=${viewerOpened} video=${Boolean(inAppVideo)}`
      );
      check(
        (inAppVideo?.getAttribute('src') || '').startsWith('/api/'),
        '应用内播放器用的是 /api/file 或 /api/video 的地址',
        inAppVideo?.getAttribute('src')
      );

      const openCallsNow = calls.filter((url) =>
        url.startsWith('/api/open/')
      ).length;
      check(
        openCallsNow === openCallsBefore,
        '相册模式点视频一次都没有请求 /api/open（不启动 PotPlayer）',
        `${openCallsBefore} → ${openCallsNow}`
      );

      document
        .querySelector('#viewerClose')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(
        () => !document.querySelector('#viewer')?.classList.contains('is-open'),
        2000
      );
    }

    console.log('\n[7.5] 改宽度：已经渲染出来的块要跟着换列数');
    // 块是原地打补丁复用的（重建会让整块图片重新解码），所以列数必须显式写回旧网格。
    // 漏了这一步的症状：宽度变过之后，格子一直停在旧列数上（一行 8 张变成一行 5 张大格子）。
    const columnsOf = (grid) => {
      const match = /repeat\((\d+)/.exec(grid?.style.gridTemplateColumns || '');
      return match ? Number(match[1]) : 0;
    };
    const renderedGrids = () => [...document.querySelectorAll('.stream-grid')];

    const wideGrids = renderedGrids();
    for (const grid of wideGrids) {
      grid.dataset.columnsProbe = '1';
    }

    const wideColumns = wideGrids.map(columnsOf);
    check(
      wideGrids.length > 0 && wideColumns.every((count) => count === 7),
      '宽度 1200px 时是 7 列',
      wideColumns.join(',')
    );

    setGalleryWidth(900); // 5 列
    window.dispatchEvent(new window.Event('resize'));
    await delay(220);

    const narrowColumns = renderedGrids().map(columnsOf);
    check(
      narrowColumns.length > 0 && narrowColumns.every((count) => count === 5),
      '变窄之后，屏幕上每一块都跟着换成 5 列',
      narrowColumns.join(',')
    );

    setGalleryWidth(GALLERY_WIDTH); // 回到 7 列
    window.dispatchEvent(new window.Event('resize'));
    await delay(220);

    const backGrids = renderedGrids();
    const backColumns = backGrids.map(columnsOf);
    check(
      backGrids.length > 0 && backColumns.every((count) => count === 7),
      '变宽回来后又都换回 7 列（不会停在旧列数上）',
      backColumns.join(',')
    );

    const survivedGrids = backGrids.filter(
      (grid) => grid.dataset.columnsProbe === '1'
    ).length;
    console.log(
      `  · 复用：宽度来回变之后，${survivedGrids}/${wideGrids.length} 个网格还是原来那些节点（原地改列数，没整块重建）`
    );
    check(
      survivedGrids > 0,
      '换列数是原地打补丁，没有把块整个重建掉',
      `${survivedGrids}/${wideGrids.length}`
    );
  console.log('\n[8] HEIC/HEIF：先试原图（装了 HEIF+HEVC 扩展就能直出），失败才转换');
    // 本机生成不出真的 HEIC 素材，所以先打开一张**真 PNG**，再在前端把它的扩展名改成
    // HEIC（只改前端的判定输入；服务端照旧把那个文件当 PNG：/api/file 给真字节、
    // /api/preview 也能转出真预览）。这样不用新增测试素材就能覆盖客户端逻辑。
    const heicProbeItems = await fetch(
      new URL('/api/library/items?offset=0&limit=512', base).toString()
    ).then((response) => response.json());
    const fakeHeic = heicProbeItems.items.find(
      (item) => item.name === `${PNG_NAME}.PNG`
    );

    check(Boolean(fakeHeic), '找到那张 PNG 素材（拿来假装 HEIC）', fakeHeic?.name);

    if (fakeHeic) {
      window.sessionStorage.removeItem('album-image-source-v1:HEIC');

      // 先按真 PNG 打开一次，拿到那个条目对象，再把它的扩展名改成 HEIC
      window.__pauseImageSimulation = true; // 下面要自己控制"加载成功/失败"
      window.eval(`openViewer(${JSON.stringify(fakeHeic.id)})`);
      await waitFor(() => document.querySelector('#viewerMedia img'), 2000);

      const heicPlan = window.eval(`
        (function () {
          const item = getCurrentItem();
          item.extension = 'HEIC';           // 只改前端判定用的扩展名
          window.__fakeHeicItem = item;
          return {
            url: viewerImageUrl(item),
            trial: isImageSourceTrial(item),
            label: imageSourceLabelFor(item),
          };
        })()
      `);

      check(
        heicPlan.url === `/api/file/${fakeHeic.id}` && heicPlan.trial === true,
        'HEIC 原来是"必须转换"，现在第一下给源文件（真的在试）',
        JSON.stringify(heicPlan)
      );

      // (a) 这台机器显示不了 HEIC：报错 → 退回 /api/preview 转换，且不写负面结论
      window.eval(`closeViewer(); openViewer(${JSON.stringify(fakeHeic.id)})`);
      await waitFor(() => document.querySelector('#viewerMedia img'), 2000);
      await delay(60);

      check(
        (document.querySelector('#viewerMedia img')?.getAttribute('src') || '') ===
          `/api/file/${fakeHeic.id}`,
        '查看器给的是 /api/file/:id（源文件，不是转换预览）',
        document.querySelector('#viewerMedia img')?.getAttribute('src')
      );
      check(
        (document.querySelector('#viewerSpinnerText')?.textContent || '').includes(
          '试原图'
        ),
        '转圈提示写明了"正在试原图"',
        document.querySelector('#viewerSpinnerText')?.textContent
      );

      document
        .querySelector('#viewerMedia img')
        ?.dispatchEvent(new window.Event('error'));
      await delay(60);

      check(
        (document.querySelector('#viewerMedia img')?.getAttribute('src') || '') ===
          `/api/preview/${fakeHeic.id}`,
        '试不动就退回 /api/preview/:id（转一次），不会白屏',
        document.querySelector('#viewerMedia img')?.getAttribute('src')
      );
      check(
        (document.querySelector('#viewerSpinnerText')?.textContent || '').includes(
          'HEIC'
        ),
        '退回时提示说清了"这台机器显示不了 HEIC 原图，正在转换"',
        document.querySelector('#viewerSpinnerText')?.textContent
      );
      check(
        window.eval('imageSourceLabelFor(window.__fakeHeicItem)') ===
          '转换预览（浏览器解不了这个格式）',
        '详情面板的"显示来源"跟着说真话：这次是转换预览'
      );
      check(
        window.sessionStorage.getItem('album-image-source-v1:HEIC') === null,
        '试失败**不写**负面结论（一张坏图不该让整个会话都放弃试原图）'
      );

      // (b) 这台机器能显示 HEIC：让原图加载成功 → 会话里记下结论，之后不再试
      window.eval('closeViewer()');
      window.eval(`openViewer(${JSON.stringify(fakeHeic.id)})`);
      await waitFor(
        () =>
          (document.querySelector('#viewerMedia img')?.getAttribute('src') || '') ===
          `/api/file/${fakeHeic.id}`,
        2000
      );

      window.__pauseImageSimulation = false; // 恢复模拟器：这张源文件"加载成功"

      const heicProved = await waitFor(
        () => window.sessionStorage.getItem('album-image-source-v1:HEIC') === '1',
        3000
      );
      check(
        heicProved,
        '原图加载成功 → 会话里记下"这台浏览器能直出 HEIC"（下次不用再试）',
        window.sessionStorage.getItem('album-image-source-v1:HEIC')
      );
      check(
        window.eval('imageSourceLabelFor(window.__fakeHeicItem)') ===
          '源文件（未经转换）',
        '详情面板说的是实际显示的：源文件'
      );

      // (c) 已经证实能直出之后再打开：不再是"试"，直接就是加载原图
      window.__pauseImageSimulation = true;
      window.eval('closeViewer()');
      window.eval(`openViewer(${JSON.stringify(fakeHeic.id)})`);
      await waitFor(() => document.querySelector('#viewerMedia img'), 2000);
      await delay(60);

      const provenSpinner =
        document.querySelector('#viewerSpinnerText')?.textContent || '';
      check(
        !provenSpinner.includes('试原图') && provenSpinner.includes('加载照片'),
        '已证实能直出之后，提示不再是"试原图"',
        provenSpinner
      );
      check(
        window.eval('isImageSourceTrial(window.__fakeHeicItem)') === false,
        '判定函数也认这个结论（后面所有 HEIC 都直接源文件）'
      );

      // (d) 顶栏"直出"总开关也管 HEIC（关掉 = 老老实实转换；打开 = 重新试）
      const heicToggle = document.querySelector('#directButton');

      heicToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      check(
        window.eval(`
          (function () {
            const item = window.__fakeHeicItem;
            return JSON.stringify({
              url: viewerImageUrl(item),
              trial: isImageSourceTrial(item),
              active: document.querySelector('#directButton').classList.contains('is-active'),
              title: document.querySelector('#directButton').title,
            });
          })()
        `).includes(`/api/preview/${fakeHeic.id}`),
        '关掉"直出"：HEIC 不再试原图，直接给转换预览'
      );

      const offTitle = window.eval(`document.querySelector('#directButton').title`);
      check(
        offTitle.includes('直出：关') && offTitle.includes('HEIC 原图'),
        '关掉之后按钮的悬停说明写明了状态和结论',
        offTitle.split('\n')[0]
      );

      heicToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      check(
        window.eval(`
          (function () {
            const item = window.__fakeHeicItem;
            return viewerImageUrl(item) === '/api/file/' + ${JSON.stringify(fakeHeic.id)} &&
              isImageSourceTrial(item) === true &&
              window.sessionStorage.getItem('album-image-source-v1:HEIC') === null;
          })()
        `) === true,
        '再打开"直出"：又变成"试原图"，而且刚清掉了之前的会话结论（= 重新试一遍）'
      );

      // (e) 收尾：扩展名改回 PNG、关掉查看器，别影响别的断言
      window.__pauseImageSimulation = false;
      window.eval('closeViewer()');
      window.sessionStorage.removeItem('album-image-source-v1:HEIC');
      check(
        window.eval(`
          (function () {
            window.__fakeHeicItem.extension = 'PNG';
            return viewerImageUrl(window.__fakeHeicItem);
          })()
        `) === `/api/file/${fakeHeic.id}`,
        '收尾：扩展名改回 PNG（状态干净）'
      );
    }
  } finally {
    clearInterval(imageSimulator);
    await new Promise((resolve) => server.close(resolve));
    window.close();
  }

  console.log('');

  if (failures.length) {
    console.error(`前端端到端测试失败 ${failures.length} 项：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('前端端到端测试全部通过 ✓');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});