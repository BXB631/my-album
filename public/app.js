const gallery = document.querySelector('#gallery');
const summary = document.querySelector('#summary');
const refreshButton = document.querySelector('#refreshButton');
const toast = document.querySelector('#toast');
const sourceName = document.querySelector('#sourceName');
const sourcePath = document.querySelector('#sourcePath');
const sourceMeta = document.querySelector('#sourceMeta');
const footerSource = document.querySelector('#footerSource');
const chooseFolderButton = document.querySelector('#chooseFolderButton');
const topbarFolderButton = document.querySelector('#topbarFolderButton');
const folderList = document.querySelector('#folderList');
const folderSelect = document.querySelector('#folderSelect');
const sidebarCount = document.querySelector('#sidebarCount');
const scanBar = document.querySelector('#scanBar');
const scanText = document.querySelector('#scanText');
const scanFill = document.querySelector('#scanFill');
const scanCancelButton = document.querySelector('#scanCancelButton');
const clearCacheButton = document.querySelector('#clearCacheButton');
const directButton = document.querySelector('#directButton');
const cacheSize = document.querySelector('#cacheSize');
const openModeButtons = document.querySelectorAll('[data-open-mode]');
const cacheConfirm = document.querySelector('#cacheConfirm');
const cacheConfirmSize = document.querySelector('#cacheConfirmSize');
const cacheOptionButtons = [
  ...document.querySelectorAll('[data-cache-kind]'),
];
const cacheGroupSizes = {
  thumbnails: document.querySelector('#cacheThumbnailsSize'),
  media: document.querySelector('#cacheMediaSize'),
  all: document.querySelector('#cacheAllSize'),
};
const cacheCancelButton = document.querySelector('#cacheCancelButton');

const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewerClose');
const viewerPrev = document.querySelector('#viewerPrev');
const viewerNext = document.querySelector('#viewerNext');
const viewerCounter = document.querySelector('#viewerCounter');
const viewerStage = document.querySelector('#viewerStage');
const viewerMedia = document.querySelector('#viewerMedia');
const viewerSpinner = document.querySelector('#viewerSpinner');
const viewerSpinnerText = document.querySelector('#viewerSpinnerText');
const viewerFilename = document.querySelector('#viewerFilename');
const viewerDate = document.querySelector('#viewerDate');
const viewerZoom = document.querySelector('#viewerZoom');
const viewerDetailsButton = document.querySelector('#viewerDetailsButton');
const viewerHintDesktop = document.querySelector('#viewerHintDesktop');
const viewerHintTouch = document.querySelector('#viewerHintTouch');
const viewerOpenOriginal = document.querySelector('#viewerOpenOriginal');
const viewerLive = document.querySelector('#viewerLive');
const detailsBackdrop = document.querySelector('#detailsBackdrop');
const detailsPanel = document.querySelector('#viewerDetails');
const detailsClose = document.querySelector('#detailsClose');
const detailsContent = document.querySelector('#detailsContent');
const detailsSubtitle = document.querySelector('#detailsSubtitle');

const PHOTO_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3.25" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="8.4" cy="10" r="1.45" fill="currentColor"/>
    <path d="M4.8 16.2l4.1-4.05a1.35 1.35 0 0 1 1.9 0l2.2 2.18 1.55-1.53a1.35 1.35 0 0 1 1.9 0l2.75 2.72" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

const PLAY_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8 5.8c0-.9 1-1.45 1.76-.97l8.35 5.2a1.15 1.15 0 0 1 0 1.94l-8.35 5.2A1.15 1.15 0 0 1 8 16.2V5.8Z" fill="currentColor"/>
  </svg>
`;

const EMPTY_ICON = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3.25" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8 10.5h8M8 14h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
`;

const BROWSER_NATIVE_IMAGE_EXTENSIONS = new Set([
  'JPG',
  'JPEG',
  'PNG',
  'WEBP',
  'GIF',
  'BMP',
  'AVIF',
]);

// HEIF 家族（HEIC/HEIF/HIF）：Chromium 自己不带 HEIF/HEVC 解码器，但 Windows 上
// 装了「HEIF 图像扩展 + HEVC 视频扩展」之后 <img> 是能**直接显示原图**的。
// 所以这几类"先拿源文件试一次"，失败了再退回服务端转换（TIFF/RAW 这种浏览器肯定
// 显示不了的，试都不用试，仍然直接走转换预览）。
const TRIAL_SOURCE_IMAGE_EXTENSIONS = new Set(['HEIC', 'HEIF', 'HIF']);
// 本会话里"这台浏览器确实能直接显示 HEIC 原图"的结论（一个容器一个键，值 '1'）
const IMAGE_SOURCE_VERDICT_PREFIX = 'album-image-source-v1:';
// 每张图这次实际显示的是源文件还是转换图（详情面板要说实话，见 imageSourceLabelFor）
const imageDisplaySources = new Map();

const MUNICIPALITIES = new Set([
  '北京',
  '上海',
  '天津',
  '重庆',
  '香港',
  '澳门',
]);

function formatCityName(city) {
  return MUNICIPALITIES.has(city) ? `${city}市` : city;
}

const monthDayFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
});

const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', {
  weekday: 'long',
});

const viewerDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const detailDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const MIN_SCALE = 1;
const MAX_SCALE = 5;

let items = [];
let libraryData = null;
let activeFolder = 'all';
let streamState = null;
let folderNavRevision = -1;
let folderNavToken = null;
let folderNavRetry = null;
let isLoading = false;
let isChoosingFolder = false;
let cacheInfo = { bytes: 0, files: 0 };
let cacheInfoToken = 0;
let isClearingCache = false;
let openingMedia = false;
let openMode = 'viewer';

try {
  openMode =
    window.localStorage.getItem('album-open-mode') === 'external'
      ? 'external'
      : 'viewer';
} catch {
  // 隐私模式禁用 localStorage 时，使用默认值。
}
let cacheConfirmOpen = false;
let lastCacheFocus = null;
let toastTimer = null;
let currentIndex = -1;
// 2.0：查看器只持有当前这张 + 服务端给的左右邻居，
// 翻页不需要把整个图库加载进内存。
let viewerItem = null;
let viewerPrevItem = null;
let viewerNextItem = null;
let viewerPosition = { index: -1, total: 0 };
let lastFocusedElement = null;
let videoElement = null;
let scale = 1;
let panX = 0;
let panY = 0;
let gesture = null;
let suppressStageClick = false;
let viewerRenderToken = 0;
let detailsOpen = false;
let videoWasPlayingBeforeDetails = false;
let pendingPhotoId = new URLSearchParams(window.location.search).get('photo');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDay(date) {
  const now = new Date();
  const formatter =
    date.getFullYear() === now.getFullYear()
      ? monthDayFormatter
      : fullDateFormatter;

  return formatter.format(date);
}

function formatViewerDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : viewerDateFormatter.format(date);
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${pad(totalSeconds % 60)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 0) {
    return '—';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDetailDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : detailDateFormatter.format(date);
}

function syncCacheButton() {
  clearCacheButton.disabled = isLoading || isClearingCache;
  clearCacheButton.classList.toggle('is-busy', isClearingCache);
}

// 读缓存占用：一共三档（缩略图 / 打开的图片视频 / 全部），
// 按钮上显示"全部"，弹窗里三个选项各显示自己那一档。
function readCacheGroup(data, key) {
  const group = data?.[key];

  return {
    bytes: Number(group?.bytes) || 0,
    files: Number(group?.files) || 0,
  };
}

function updateCacheInfo(info) {
  cacheInfo = {
    bytes: Number(info?.bytes) || 0,
    files: Number(info?.files) || 0,
    thumbnails: readCacheGroup(info, 'thumbnails'),
    media: readCacheGroup(info, 'media'),
  };

  const size = formatBytes(cacheInfo.bytes);
  cacheSize.textContent = size;
  cacheConfirmSize.textContent =
    cacheInfo.bytes > 0
      ? `当前占用 ${size} · ${cacheInfo.files} 个缓存文件`
      : '当前没有缓存文件';

  for (const [key, element] of Object.entries(cacheGroupSizes)) {
    const group =
      key === 'all'
        ? { bytes: cacheInfo.bytes, files: cacheInfo.files }
        : cacheInfo[key];

    if (element) {
      element.textContent = group.bytes > 0 ? formatBytes(group.bytes) : '空';
    }
  }

  for (const button of cacheOptionButtons) {
    const key = button.dataset.cacheKind;
    const group =
      key === 'all'
        ? { bytes: cacheInfo.bytes }
        : cacheInfo[key];

    // 这一档本来就是空的：按钮置灰，省得白点一下
    button.disabled = isClearingCache || (group?.bytes || 0) <= 0;
  }

  syncCacheButton();
}

async function loadCacheInfo() {
  const token = ++cacheInfoToken;

  try {
    const response = await fetch('/api/cache', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    if (token !== cacheInfoToken) {
      return;
    }

    updateCacheInfo(data);
  } catch (error) {
    if (token !== cacheInfoToken) {
      return;
    }

    console.error(error);
    cacheSize.textContent = '—';
    cacheConfirmSize.textContent = '缓存占用读取失败';
  }
}

function openCacheConfirm() {
  if (isLoading || isClearingCache || cacheConfirmOpen) {
    return;
  }

  lastCacheFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  cacheConfirmOpen = true;
  cacheConfirm.hidden = false;
  document.body.classList.add('cache-confirm-open');
  updateCacheInfo(cacheInfo);

  loadCacheInfo();

  window.setTimeout(() => {
    const first = cacheOptionButtons.find((button) => !button.disabled);
    (first || cacheCancelButton).focus({ preventScroll: true });
  }, 30);
}

function closeCacheConfirm() {
  if (!cacheConfirmOpen) {
    return;
  }

  cacheConfirmOpen = false;
  cacheConfirm.hidden = true;
  document.body.classList.remove('cache-confirm-open');

  for (const button of cacheOptionButtons) {
    button.disabled = false;
    button.classList.remove('is-clearing');
  }

  cacheCancelButton.disabled = false;

  if (lastCacheFocus && document.contains(lastCacheFocus)) {
    lastCacheFocus.focus({ preventScroll: true });
  }

  lastCacheFocus = null;
}

const CACHE_KIND_LABELS = {
  thumbnails: '缩略图缓存',
  media: '打开的图片 / 视频缓存',
  all: '全部缓存',
};

async function clearCacheNow(kind = 'all') {
  if (isClearingCache) {
    return;
  }

  const previousBytes = cacheInfo.bytes;
  const button = cacheOptionButtons.find(
    (option) => option.dataset.cacheKind === kind
  );

  isClearingCache = true;
  cacheCancelButton.disabled = true;

  for (const option of cacheOptionButtons) {
    option.disabled = true;
  }

  if (button) {
    button.classList.add('is-clearing');
  }

  syncCacheButton();

  try {
    const response = await fetch('/api/cache/clear', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `清理缓存失败（${response.status}）`);
    }

    updateCacheInfo(data);

    const released = previousBytes - cacheInfo.bytes;
    const label = CACHE_KIND_LABELS[kind] || '缓存';

    showToast(
      released > 0
        ? `${label}已清理，释放 ${formatBytes(released)}`
        : `${label}本来就是空的`
    );

    // 弹窗留着：三档可以连着清，数字会跟着刷新
    await loadCacheInfo();
  } catch (error) {
    console.error(error);
    showToast(error.message || '清理缓存失败');
    await loadCacheInfo();
  } finally {
    isClearingCache = false;

    if (button) {
      button.classList.remove('is-clearing');
    }

    if (cacheConfirmOpen) {
      cacheCancelButton.disabled = false;
    }

    updateCacheInfo(cacheInfo);
  }
}

function syncOpenModeButtons() {
  for (const button of openModeButtons) {
    const isActive = button.dataset.openMode === openMode;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
}

syncOpenModeButtons();

function setOpenMode(mode) {
  openMode = mode === 'viewer' ? 'viewer' : 'external';
  syncOpenModeButtons();

  try {
    window.localStorage.setItem('album-open-mode', openMode);
  } catch {
    // 隐私模式禁用 localStorage 时，只对当前页面生效。
  }

  showToast(
    openMode === 'viewer'
      ? '点击图片 / 视频都在相册内打开'
      : '点击图片用系统照片、视频用 PotPlayer 打开'
  );
}

async function openOriginal(item) {
  if (openingMedia) {
    return;
  }

  openingMedia = true;

  try {
    const response = await fetch(
      `/api/open/${encodeURIComponent(item.id)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `打开原文件失败（${response.status}）`);
    }

    showToast(
      data.app === 'potplayer'
        ? '已用 PotPlayer 打开原视频'
        : item.type === 'video'
          ? '已用系统默认播放器打开原视频'
          : '已用系统照片工具打开原图'
    );
  } catch (error) {
    console.error(error);
    showToast(error.message || '打开原文件失败');
  } finally {
    openingMedia = false;
  }
}

function handleCardOpen(item) {
  if (!item) {
    return;
  }

  // 相册模式：图片和视频都在应用内打开（视频走"直出 / 转码"那条播放链）。
  // 只有系统模式才交出去：图片 → 系统照片，视频 → PotPlayer。
  if (openMode === 'viewer') {
    openViewer(item.id);
    return;
  }

  openOriginal(item);
}

function formatCodec(codec) {
  if (!codec) {
    return '未记录';
  }

  if (/^(hvc1|hev1)/i.test(codec)) {
    return 'HEVC（H.265）';
  }

  if (/^(avc1|avc3)/i.test(codec)) {
    return 'H.264';
  }

  if (/^vp0?9/i.test(codec)) {
    return 'VP9';
  }

  if (/^av01/i.test(codec)) {
    return 'AV1';
  }

  return codec;
}

function formatDateSource(source) {
  if (source === 'exif') {
    return '照片 EXIF';
  }

  if (source === 'filename') {
    return '文件名';
  }

  return '文件修改时间';
}

function isViewerOpen() {
  return viewer.classList.contains('is-open');
}

function getCurrentItem() {
  return viewerItem || items[currentIndex] || null;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');

  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 2400);
}

function updateSource(source) {
  if (!source) {
    return;
  }

  const name = source.name || '照片文件夹';
  sourceName.textContent = name;
  sourcePath.textContent = source.path || '';
  sourcePath.title = source.path || '';
  sourceMeta.textContent = !source.exists
    ? '文件夹不存在，请重新选择'
    : source.isDefault
      ? '默认演示文件夹 · 只在本机读取'
      : '已选择的本地文件夹 · 不会上传';
  footerSource.textContent = `本地读取 · ${name}`;
  chooseFolderButton.textContent = source.isDefault
    ? '选择照片文件夹'
    : '更换文件夹';
}

function getFolderLabel(filter) {
  if (filter === 'all') {
    return '全部照片';
  }

  if (filter === 'unclassified') {
    return '未分类';
  }

  if (!libraryData) {
    return '';
  }

  if (filter.startsWith('year-')) {
    const year = Number(filter.slice(5));
    return `${year} 年`;
  }

  for (const year of libraryData.folders || []) {
    for (const month of year.months) {
      if (month.key === filter) {
        return `${year.year} 年 ${month.month} 月`;
      }
    }
  }

  return '';
}

function isFolderAvailable(filter) {
  if (filter === 'all') {
    return true;
  }

  if (!libraryData) {
    return false;
  }

  if (filter === 'unclassified') {
    return libraryData.uncategorizedCount > 0;
  }

  if (filter.startsWith('year-')) {
    const year = Number(filter.slice(5));
    return (libraryData.folders || []).some((entry) => entry.year === year);
  }

  return (libraryData.folders || []).some((year) =>
    year.months.some((month) => month.key === filter)
  );
}

function createFolderButton({ key, label, count, className }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'folder-item';
  button.dataset.folder = key;
  button.setAttribute('aria-pressed', key === activeFolder ? 'true' : 'false');

  if (className) {
    button.classList.add(className);
  }

  const labelElement = document.createElement('span');
  labelElement.className = 'folder-label';
  labelElement.textContent = label;

  const countElement = document.createElement('span');
  countElement.className = 'folder-count';
  countElement.textContent = String(count);

  button.append(labelElement, countElement);
  button.addEventListener('click', () => {
    setActiveFolder(key, { scroll: true });
  });

  return button;
}

function addFolderOption(key, label, count) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = `${label}（${count}）`;
  folderSelect.append(option);
}

function renderFolderNavigation(data) {
  folderList.replaceChildren();
  folderSelect.replaceChildren();

  folderList.append(
    createFolderButton({
      key: 'all',
      label: '全部照片',
      count: data.total,
      className: 'is-all',
    })
  );
  addFolderOption('all', '全部照片', data.total);

  for (const year of data.folders || []) {
    folderList.append(
      createFolderButton({
        key: year.key,
        label: year.label,
        count: year.count,
        className: 'is-year',
      })
    );
    addFolderOption(year.key, year.label, year.count);

    for (const month of year.months) {
      folderList.append(
        createFolderButton({
          key: month.key,
          label: month.label,
          count: month.count,
          className: 'is-month',
        })
      );
      addFolderOption(
        month.key,
        `${year.year} 年 ${month.month} 月`,
        month.count
      );
    }
  }

  if (data.uncategorizedCount > 0) {
    folderList.append(
      createFolderButton({
        key: 'unclassified',
        label: '未分类',
        count: data.uncategorizedCount,
        className: 'is-uncategorized',
      })
    );
    addFolderOption('unclassified', '未分类', data.uncategorizedCount);
  }

  if (!data.folders?.length && !data.uncategorizedCount) {
    const hint = document.createElement('p');
    hint.className = 'folder-empty';
    hint.textContent = '还没有识别到年份目录';
    folderList.append(hint);
  }

  sidebarCount.textContent = `${data.total} 项`;
  updateFolderSelection();
}

function updateFolderSelection() {
  for (const button of folderList.querySelectorAll('.folder-item')) {
    const isActive = button.dataset.folder === activeFolder;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }

  folderSelect.value = activeFolder;
}

function updateSummary() {
  if (!streamState) {
    return;
  }

  const sourceName = streamState.source?.name || '这个文件夹';

  if (streamState.phase === 'error') {
    summary.textContent = '读取相册失败';
    return;
  }

  if (streamState.scanning) {
    summary.textContent = `正在扫描 · 已发现 ${streamState.total} 项 · 已读取 ${streamState.filled} 项`;
    return;
  }

  if (!streamState.total) {
    summary.textContent = `${sourceName} 里还没有照片或视频`;
    return;
  }

  const parts = [`${streamState.total} 个项目`];

  if (streamState.imageCount) {
    parts.push(`${streamState.imageCount} 张照片`);
  }

  if (streamState.videoCount) {
    parts.push(`${streamState.videoCount} 个视频`);
  }

  if (activeFolder !== 'all') {
    parts.push(getFolderLabel(activeFolder));
  }

  summary.textContent = parts.join(' · ');
}

function setActiveFolder(filter, { scroll = false } = {}) {
  if (!isFolderAvailable(filter)) {
    filter = 'all';
  }

  if (filter === activeFolder) {
    updateFolderSelection();
    return;
  }

  if (isViewerOpen()) {
    closeViewer();
  }

  activeFolder = filter;
  updateFolderSelection();
  updateSummary();

  // 过滤在服务端做：前端只换窗口数据，不用把整个图库拿下来再筛。
  stream.setFilter(filter).catch(() => {
    showToast('切换目录失败，请稍后重试');
  });

  if (scroll) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------------------
// 实况照片（Apple Live Photo）：图片 + 同名 MOV 合成一项
//   · 卡片左下角一个 LIVE 角标，鼠标停下 350ms 后在原地静音播放
//   · 查看器里点"实况"（或按 L）在静止图上叠加播放，放完自动回到静止图
// 判定字段由服务端给出：item.livePhoto / item.liveVideoUrl。
// ---------------------------------------------------------------------------
const LIVE_HOVER_DELAY = 350;

function isLivePhoto(item) {
  return Boolean(item && item.type === 'image' && item.livePhoto && item.liveVideoUrl);
}

// 实况照片的伴随 MOV 也是视频，而且 iPhone 上同样是 HEVC：能直出就直出，解不了才转码。
// 伴随项没有独立的 codec 字段时（拿不到）按"未知编码"处理，一律走转码。
function liveVideoPlan(item) {
  const companionId = item?.liveVideoId;
  const extension = String(item?.liveVideoName || '')
    .split('.')
    .pop()
    .toUpperCase();

  return videoPlaybackPlan({
    id: companionId,
    type: 'video',
    name: item?.liveVideoName || 'live-photo.mov',
    extension,
    videoCodec: item?.liveVideoCodec || null,
    fileUrl: `/api/file/${companionId}`,
    videoUrl: item?.liveVideoUrl,
  });
}

function canHoverPreview() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}

function createLiveBadge(label = '实况') {
  const badge = document.createElement('span');
  badge.className = 'live-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = `<span class="live-dot"></span>${label}`;
  return badge;
}

// 悬停预览：延迟创建 <video>（避免鼠标扫过一排卡片就疯狂起播），
// 停播时把节点整个移除并清掉 src，不让它继续占着解码器。
function attachLivePreview(card, item) {
  let video = null;
  let timer = null;
  // 直出尝试的兜底定时器：报错不用它，卡住才用它
  let directTimer = null;

  const clearDirectTimer = () => {
    if (directTimer) {
      window.clearTimeout(directTimer);
      directTimer = null;
    }
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    clearDirectTimer();

    if (!video) {
      return;
    }

    video.pause();
    video.removeAttribute('src');
    video.remove();
    video = null;
    card.classList.remove('is-live-playing');
  };

  card.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'touch' || video || timer) {
      return;
    }

    if (!canHoverPreview() || isViewerOpen()) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;

      if (!card.isConnected || isViewerOpen()) {
        return;
      }

      const plan = liveVideoPlan(item);
      const startedWithDirect = plan.mode === 'direct';
      // 报错和超时可能先后都来，只换一次（否则会并排留下两个预览节点）
      let swappedToTranscode = false;

      // 直出这条路试不动时（报错，或者卡住既没报错也没画面）：
      // 记住这个伴随视频，然后静默换成转码那一份（静止图全程还在，不露黑）
      const fallbackToTranscode = () => {
        if (!startedWithDirect || !video || swappedToTranscode) {
          return;
        }

        swappedToTranscode = true;
        clearDirectTimer();
        rememberDirectVideoFailure({ id: item.liveVideoId });
        video.remove();
        video = null;
        card.classList.remove('is-live-playing');

        const fallback = document.createElement('video');
        fallback.className = 'card-live-video';
        fallback.muted = true;
        fallback.defaultMuted = true;
        fallback.playsInline = true;
        fallback.preload = 'auto';
        fallback.setAttribute('aria-hidden', 'true');
        fallback.addEventListener('canplay', () => {
          if (video === fallback) {
            card.classList.add('is-live-playing');
          }
        });
        fallback.addEventListener('error', stop, { once: true });
        fallback.src = item.liveVideoUrl;
        video = fallback;
        card.append(fallback);

        const retry = fallback.play();

        if (retry && typeof retry.catch === 'function') {
          retry.catch(() => stop());
        }
      };

      video = document.createElement('video');
      video.className = 'card-live-video';
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('canplay', () => {
        clearDirectTimer();

        if (video) {
          card.classList.add('is-live-playing');
        }
      });
      video.addEventListener('error', () => {
        if (!startedWithDirect) {
          stop();
          return;
        }

        fallbackToTranscode();
      });
      video.src = plan.url;
      card.append(video);

      if (startedWithDirect) {
        // 悬停这条路没有别的兜底：卡住就得自己收（比查看器更短的等待）
        directTimer = window.setTimeout(() => {
          directTimer = null;
          fallbackToTranscode();
        }, HOVER_DIRECT_TIMEOUT_MS);
      }

      const playPromise = video.play();

      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => stop());
      }
    }, LIVE_HOVER_DELAY);
  });

  card.addEventListener('pointerleave', stop);
  card.addEventListener('pointercancel', stop);
  // 键盘聚焦卡片时不要突然出声，点击打开查看器时也要先收掉预览
  card.addEventListener('focus', stop);
  card.addEventListener('click', stop);

  // 元素被挪回元素池 / 换项目时，photo-stream 会调用这个钩子收尾
  card.__teardown = stop;
  return stop;
}

function createImageCard(item, options = {}) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'media-card is-image';
  card.title = item.name;
  card.setAttribute('aria-label', `照片：${item.name}`);

  const shimmer = document.createElement('span');
  shimmer.className = 'thumb-shimmer';
  shimmer.setAttribute('aria-hidden', 'true');

  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';

  image.addEventListener(
    'load',
    () => {
      card.classList.add('is-loaded');
    },
    { once: true }
  );

  image.addEventListener(
    'error',
    () => {
      card.classList.add('has-error');
    },
    { once: true }
  );

  // 2.0：缩略图交给流式调度器按优先级排队后再赋值，
  // 卡片本身不再一创建就抢带宽。
  if (!options.deferThumbnail) {
    image.loading = 'lazy';
    image.src = item.thumbUrl;
  }

  const fallback = document.createElement('span');
  fallback.className = 'image-fallback';
  fallback.innerHTML = PHOTO_ICON;

  card.append(shimmer, image, fallback);

  if (isLivePhoto(item)) {
    card.classList.add('is-live');
    card.setAttribute(
      'aria-label',
      `实况照片：${item.name}（带 ${item.liveVideoName || '同名视频'}）`
    );
    card.append(createLiveBadge());
    attachLivePreview(card, item);
  }

  card.addEventListener('click', () => {
    handleCardOpen(item);
  });

  return card;
}

function createVideoCard(item, options = {}) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'media-card is-video';
  card.title = item.name;
  card.setAttribute('aria-label', `视频：${item.name}`);

  const videoLabel = item.duration
    ? `视频 · ${formatDuration(item.duration)}`
    : '视频';

  const shimmer = document.createElement('span');
  shimmer.className = 'thumb-shimmer';
  shimmer.setAttribute('aria-hidden', 'true');

  const poster = document.createElement('img');
  poster.className = 'video-poster';
  poster.alt = '';
  poster.decoding = 'async';

  poster.addEventListener(
    'load',
    () => {
      card.classList.add('has-poster');
    },
    { once: true }
  );

  poster.addEventListener(
    'error',
    () => {
      card.classList.add('poster-error');
    },
    { once: true }
  );

  if (!options.deferThumbnail) {
    poster.loading = 'lazy';
    poster.src = item.thumbUrl;
  }

  const placeholder = document.createElement('span');
  placeholder.className = 'video-placeholder';
  placeholder.innerHTML = `
    <span class="play-button" aria-hidden="true">${PLAY_ICON}</span>
    <span class="video-label">${videoLabel}</span>
  `;

  card.append(shimmer, poster, placeholder);

  card.addEventListener('click', () => {
    handleCardOpen(item);
  });

  return card;
}

function createMediaCard(item, options = {}) {
  const card =
    item.type === 'video'
      ? createVideoCard(item, options)
      : createImageCard(item, options);

  // 记一个"渲染指纹"：扫描期建出来的卡片里存的是当时的条目快照，
  // 而实况照片的伴随视频信息（id/时长/编码）是扫描收尾或索引里才补上的。
  // photo-stream 会拿这个指纹比对，发现条目变了就把这张卡片重建一次，
  // 否则那张卡片会一直按"没有伴随视频"的旧快照行事（悬停预览就会白白去转码）。
  card.__itemKey = itemRenderKey(item);
  return card;
}

// 只放"会影响这张卡片长什么样 / 怎么播"的字段
function itemRenderKey(item) {
  if (!item) {
    return '';
  }

  return [
    item.id,
    item.type,
    item.livePhoto ? 'live' : '-',
    item.liveVideoId || '-',
    item.liveVideoCodec || '-',
    item.liveVideoDuration === null || item.liveVideoDuration === undefined
      ? '-'
      : Math.round(item.liveVideoDuration),
    item.duration === null || item.duration === undefined
      ? '-'
      : Math.round(item.duration),
  ].join('|');
}

// 2.0：分组信息来自服务端（/api/library/days），前端只负责把表头画出来。
// 服务端顺手给了当天的主要城市，所以不用等该天的照片全部加载。
function buildDayHeader(day) {
  const date = new Date(`${day.key}T00:00:00`);
  const valid = !Number.isNaN(date.getTime());

  const header = document.createElement('div');
  header.className = 'day-header';

  const title = document.createElement('div');
  title.className = 'day-title';

  const dateElement = document.createElement('span');
  dateElement.className = 'day-date';
  dateElement.textContent = valid ? formatDay(date) : day.key;

  const weekday = document.createElement('span');
  weekday.className = 'day-weekday';
  weekday.textContent = valid ? weekdayFormatter.format(date) : '';

  title.append(dateElement, weekday);

  if (day.city) {
    const location = document.createElement('span');
    location.className = 'day-location';
    location.textContent = `· ${formatCityName(day.city)}`;
    title.append(location);
  }

  const count = document.createElement('span');
  count.className = 'day-count';
  count.textContent = `${day.count} 个项目`;

  header.append(title, count);
  return header;
}

// ---------------------------------------------------------------------------
// 2.0 照片墙：交给 photo-stream.js 驱动
//   summary → 铺占位格 → 只渲染可视块 → 按块取数 → 缩略图按优先级排队
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function loadedItemsInViewOrder() {
  const state = stream.getState();
  const list = [];

  for (const item of state.items) {
    if (item) {
      list.push(item);
    }
  }

  return list;
}

// 侧栏目录现在是不是空的（空 = 只有"全部照片"，没有年/月，也没有"未分类"）
function folderNavIsEmpty() {
  return (
    !libraryData ||
    (!(libraryData.folders || []).length && !libraryData.uncategorizedCount)
  );
}

function renderFolderNavFrom(data, revision) {
  folderNavRevision = revision;
  libraryData = {
    total: data.total,
    folders: data.folders || [],
    uncategorizedCount: data.uncategorizedCount || 0,
  };

  if (!isFolderAvailable(activeFolder)) {
    activeFolder = 'all';
  }

  renderFolderNavigation(libraryData);
}

// 目录请求失败时允许下一轮重试：否则侧栏会一直停在空状态，
// 看起来就是"时间目录检测不出来"（它其实只是那一次请求没成功）。
function scheduleFolderNavRetry() {
  if (folderNavRetry) {
    return;
  }

  folderNavRetry = window.setTimeout(() => {
    folderNavRetry = null;

    if (streamState?.grouped && folderNavIsEmpty()) {
      folderNavRevision = -1;
      syncFolderNavigation(streamState);
    }
  }, 1500);
}

function syncFolderNavigation(info) {
  // 服务端把年/月目录跟着 summary 一起带回来了（扫描期也有，会边扫边长）：
  // 直接渲染，不用再单发一个请求；内容没变时字段缺省，保持现状即可。
  if (Array.isArray(info.folders) && info.foldersToken !== folderNavToken) {
    folderNavToken = info.foldersToken || null;
    renderFolderNavFrom(
      {
        total: info.libraryTotal || info.total,
        folders: info.folders,
        uncategorizedCount: info.uncategorizedCount || 0,
      },
      info.revision
    );
    return;
  }

  if (info.foldersToken && info.foldersToken === folderNavToken) {
    // 目录没变（扫描期每轮的正常路径）：什么都不用做
    if (info.grouped && info.libraryTotal) {
      libraryData = { ...libraryData, total: info.libraryTotal };
      sidebarCount.textContent = `${info.libraryTotal} 项`;
    }
    return;
  }

  if (!info.grouped) {
    // 老服务端（扫描期不带目录）才会走到这里：先清空，等扫描完成再取。
    folderNavRevision = -1;
    libraryData = { total: info.total, folders: [], uncategorizedCount: 0 };
    renderFolderNavigation(libraryData);
    return;
  }

  // revision 相同 + 侧栏已经有内容 = 真的不用再取。
  // 但只要侧栏现在是空的，就必须重新取一次：空状态很可能就是扫描期留下的，
  // 而"revision 没变"并不等于"目录已经补回来了"。
  if (info.revision === folderNavRevision && !folderNavIsEmpty()) {
    return;
  }

  folderNavRevision = info.revision;

  fetchJson('/api/library/summary?folder=all')
    .then((data) => {
      renderFolderNavFrom(data, info.revision);
    })
    .catch(() => {
      // 拿不到目录时保留现有导航，不影响照片浏览；但要把"已同步"标记撤掉，
      // 免得一次失败就让侧栏永远空着。
      folderNavRevision = -1;
      scheduleFolderNavRetry();
    });
}

function applyStreamState(info) {
  streamState = info;
  items = loadedItemsInViewOrder();

  if (info.source) {
    updateSource(info.source);
  }

  if (info.phase === 'error') {
    summary.textContent = '读取相册失败';
    setScanning(false);
    return;
  }

  if (info.phase === 'canceled') {
    summary.textContent = `已停止加载 · 已扫描 ${info.filled} 个项目`;
    setOverlay('resume', `已停止加载，已保留 ${info.filled} 个项目`);
    return;
  }

  if (info.scanning) {
    setOverlay('cancel', `正在扫描照片文件夹… ${info.filled} / ${info.total}`);
  } else {
    setScanning(false);
  }

  gallery.dataset.state = info.phase === 'ready' ? 'ready' : 'loading';
  gallery.setAttribute('aria-busy', info.scanning ? 'true' : 'false');

  updateSummary();
  syncFolderNavigation(info);
}

const stream = window.createPhotoStream({
  gallery,
  renderCard: (item, options) => createMediaCard(item, options),
  // 条目指纹：扫描期建的卡片如果和最新条目对不上（比如实况照片刚补上伴随视频信息），
  // photo-stream 会把那一格重建一次
  itemKey: itemRenderKey,
  renderDayHeader: buildDayHeader,
  fetchJson,
  renderEmptyState: () => buildEmptyCard(),
  renderErrorState: () => buildErrorCard(),
  onBeforeFirstLoad: () => {
    gallery.dataset.state = 'loading';
    gallery.setAttribute('aria-busy', 'true');
  },
  onStateChange: applyStreamState,
});

function createStateCard({ icon, title, description, buttonLabel, onAction }) {
  const card = document.createElement('div');
  card.className = 'state-card';

  const iconElement = document.createElement('div');
  iconElement.className = 'state-icon';
  iconElement.innerHTML = icon;

  const heading = document.createElement('h2');
  heading.textContent = title;

  const paragraph = document.createElement('p');
  paragraph.innerHTML = description;

  card.append(iconElement, heading, paragraph);

  if (buttonLabel && onAction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'state-button';
    button.textContent = buttonLabel;
    button.addEventListener('click', onAction);
    card.append(button);
  }

  return card;
}

// 2.0：空态/错误态由照片墙在可视区里渲染，这里只负责造卡片。
function buildEmptyCard() {
  const hasAnyItems = (streamState?.total || 0) > 0;

  return hasAnyItems
    ? createStateCard({
        icon: EMPTY_ICON,
        title: '这个目录里还没有照片',
        description: `“${getFolderLabel(activeFolder)}”里还没有图片或视频。<br>可以切换到其他年月，或查看全部照片。`,
        buttonLabel: '查看全部照片',
        onAction: () => setActiveFolder('all', { scroll: true }),
      })
    : createStateCard({
        icon: EMPTY_ICON,
        title: '这个文件夹里还没有照片',
        description:
          '换一个包含照片的文件夹试试。<br>支持 JPG、PNG、HEIC、MOV 等常见格式。',
        buttonLabel: '选择照片文件夹',
        onAction: chooseFolder,
      });
}

function buildErrorCard() {
  return createStateCard({
    icon: '<span aria-hidden="true">!</span>',
    title: '相册读取失败',
    description:
      '请确认照片文件夹仍然存在，<br>或者重新选择一个文件夹。',
    buttonLabel: '重新选择文件夹',
    onAction: chooseFolder,
  });
}

function showSpinner(message = '正在加载…') {
  viewerSpinnerText.textContent = message;
  viewerSpinner.hidden = false;
}

function hideSpinner() {
  viewerSpinner.hidden = true;
}

function stopVideo() {
  if (!videoElement) {
    return;
  }

  try {
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
  } catch {
    // 视频已经移除时，不需要再做处理。
  }

  videoElement = null;
}

// --- 实况照片的查看器播放 -------------------------------------------------
// 静止图留在原地当"海报"，视频叠在同一个盒子里播（object-fit: contain）；
// 播完 / 报错 / 切图都会把视频节点移除，回到静止图。
let liveVideoElement = null;
// 实况视频"直出尝试"的兜底定时器（报错不用它，卡住才用它）。
// 放在外面是为了切图/关闭查看器时能一起收掉，否则 5 秒后它会把暂停的视频又拉起来。
let liveDirectTimer = null;

function stopLiveVideo() {
  viewerMedia.classList.remove('is-live-playing');

  if (liveDirectTimer) {
    window.clearTimeout(liveDirectTimer);
    liveDirectTimer = null;
  }

  if (!liveVideoElement) {
    return;
  }

  const video = liveVideoElement;
  liveVideoElement = null;

  try {
    video.pause();
    video.removeAttribute('src');
    video.remove();
  } catch {
    // 已经移除时忽略
  }
}

function playLivePhoto() {
  const item = getCurrentItem();

  if (!isLivePhoto(item) || !viewerMedia.querySelector('img')) {
    return;
  }

  if (liveVideoElement) {
    stopLiveVideo();
    return;
  }

  const plan = liveVideoPlan(item);

  const video = document.createElement('video');
  video.className = 'viewer-live-video';
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', `${item.name} 的实况视频`);

  const finish = () => {
    if (liveVideoElement === video) {
      hideSpinner();
    }
  };

  const clearDirectTimer = () => {
    if (liveDirectTimer) {
      window.clearTimeout(liveDirectTimer);
      liveDirectTimer = null;
    }
  };

  video.addEventListener('canplay', () => {
    clearDirectTimer();
    finish();
    viewerMedia.classList.add('is-live-playing');
  });
  video.addEventListener('ended', stopLiveVideo);
  video.addEventListener('error', () => {
    clearDirectTimer();

    // 直出失败：记住它，然后换成转码那一份再试一次（静止图还在，看不到黑屏）
    if (plan.mode !== 'direct') {
      stopLiveVideo();
      showToast('这个实况视频暂时无法播放');
      return;
    }

    rememberDirectVideoFailure({ id: item.liveVideoId });
    stopLiveVideo();
    showSpinner('这个实况视频的原始编码浏览器解不了，正在准备转码版本…');
    // 再走一遍：这次记住过失败了，计划直接就是转码那一份
    playLivePhoto();
  });

  showSpinner(
    plan.mode === 'direct' ? '正在打开实况视频…' : '正在准备实况视频…'
  );
  liveVideoElement = video;
  viewerMedia.append(video);
  video.src = plan.url;

  if (plan.mode === 'direct') {
    // 既没报错也没画面（卡住）也要兜住：直出失败就记住并换转码
    liveDirectTimer = window.setTimeout(() => {
      liveDirectTimer = null;
      rememberDirectVideoFailure({ id: item.liveVideoId });
      stopLiveVideo();
      showSpinner('这个实况视频的原始编码浏览器解不了，正在准备转码版本…');
      playLivePhoto();
    }, DIRECT_ATTEMPT_TIMEOUT_MS);
  }

  const playPromise = video.play();

  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      stopLiveVideo();
      hideSpinner();
    });
  }
}

function applyTransform() {
  viewerMedia.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`;
  viewerMedia.classList.toggle('is-zoomed', scale > 1.01);
  viewerZoom.hidden = scale <= 1.01;
  viewerZoom.textContent = `${Math.round(scale * 100)}%`;
}

function getStageContentCenter() {
  const rect = viewerStage.getBoundingClientRect();
  const style = window.getComputedStyle(viewerStage);
  const left = Number.parseFloat(style.paddingLeft) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const top = Number.parseFloat(style.paddingTop) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;

  return {
    x: rect.left + left + (rect.width - left - right) / 2,
    y: rect.top + top + (rect.height - top - bottom) / 2,
  };
}

function clampPan() {
  if (scale <= 1.01 || !viewerMedia.offsetWidth) {
    panX = 0;
    panY = 0;
    return;
  }

  const style = window.getComputedStyle(viewerStage);
  const horizontalPadding =
    (Number.parseFloat(style.paddingLeft) || 0) +
    (Number.parseFloat(style.paddingRight) || 0);
  const verticalPadding =
    (Number.parseFloat(style.paddingTop) || 0) +
    (Number.parseFloat(style.paddingBottom) || 0);
  const availableWidth = Math.max(1, viewerStage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(1, viewerStage.clientHeight - verticalPadding);
  const maxX = Math.max(0, (viewerMedia.offsetWidth * scale - availableWidth) / 2);
  const maxY = Math.max(0, (viewerMedia.offsetHeight * scale - availableHeight) / 2);

  panX = Math.min(maxX, Math.max(-maxX, panX));
  panY = Math.min(maxY, Math.max(-maxY, panY));
}

function resetZoom({ animate = false } = {}) {
  scale = 1;
  panX = 0;
  panY = 0;

  if (animate) {
    viewerMedia.classList.add('is-resetting');
    applyTransform();
    window.setTimeout(() => {
      viewerMedia.classList.remove('is-resetting');
    }, 240);
  } else {
    viewerMedia.classList.remove('is-resetting');
    applyTransform();
  }
}

function zoomAt(nextScale, clientX, clientY) {
  const item = getCurrentItem();

  if (!isViewerOpen() || !item || item.type !== 'image') {
    return;
  }

  const clampedScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));

  if (Math.abs(clampedScale - scale) < 0.001) {
    return;
  }

  const center = getStageContentCenter();
  const pointerX = clientX - center.x;
  const pointerY = clientY - center.y;
  const ratio = clampedScale / scale;

  if (clampedScale <= 1.001) {
    panX = 0;
    panY = 0;
  } else {
    panX = pointerX - (pointerX - panX) * ratio;
    panY = pointerY - (pointerY - panY) * ratio;
  }

  scale = clampedScale;
  clampPan();
  applyTransform();
}

// 查看器里这张图到底用哪个地址显示：
//   浏览器原生支持的格式（JPG/PNG/WebP/GIF/BMP/AVIF）→ 直接给源文件本体，
//   这样看到的就是原图，服务端也不会为它生成任何 JPEG；
//   HEIC/HEIF → **先给源文件试一次**（装了系统解码器的浏览器能直接显示原图，
//   而且色彩由浏览器按原图自带的配置做管理，比我们转出来的裸 JPEG 准）；
//   其它（TIFF/RAW…）→ 用转换出来的预览图。
// 浏览和预加载都必须走这里，否则又会在 cache\previews 里默默攒 JPEG。
function needsConvertedPreview(item) {
  return (
    Boolean(item) &&
    item.type === 'image' &&
    !BROWSER_NATIVE_IMAGE_EXTENSIONS.has(item.extension)
  );
}

function isHeifImage(item) {
  return (
    Boolean(item) &&
    item.type === 'image' &&
    TRIAL_SOURCE_IMAGE_EXTENSIONS.has(String(item.extension || '').toUpperCase())
  );
}

function imageSourceVerdictKey(extension) {
  return `${IMAGE_SOURCE_VERDICT_PREFIX}${String(extension || '').toUpperCase()}`;
}

// 这个会话里已经证实"本浏览器的 <img> 能直接显示 HEIC 原图"
function imageSourceProven(item) {
  try {
    return (
      window.sessionStorage.getItem(imageSourceVerdictKey(item.extension)) === '1'
    );
  } catch {
    return false;
  }
}

function rememberImageSourceWorks(item) {
  try {
    window.sessionStorage.setItem(imageSourceVerdictKey(item.extension), '1');
  } catch {
    // 隐私模式写不了：那就每次都试一次源文件，代价只是一次本地请求
  }
}

// 清掉"这个浏览器能直出 HEIC"的会话结论（顶栏"直出"关掉再打开时用 = 重新试一遍）
function clearImageSourceVerdicts() {
  try {
    const keys = [];

    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);

      if (key && key.startsWith(IMAGE_SOURCE_VERDICT_PREFIX)) {
        keys.push(key);
      }
    }

    for (const key of keys) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // 隐私模式清不了：不影响功能
  }
}

// 这一次显示是"拿源文件在试"吗（HEIC/HEIF 且本会话还没证实过、而且"直出"是开着的）。
// 只用来决定提示文案 —— 试失败不记负面结论：一张坏图不该让整个会话放弃试原图，
// 而试错一次的代价只是"一次本地请求"。
function isImageSourceTrial(item) {
  return directFirst && isHeifImage(item) && !imageSourceProven(item);
}

function viewerImageUrl(item) {
  if (!item || item.type !== 'image') {
    return null;
  }

  if (isHeifImage(item)) {
    // 关掉"直出"就老老实实转换；开着就源文件优先（本会话证实过能显示，或还在试）
    if (!directFirst) {
      return item.previewUrl || item.fileUrl || null;
    }

    return item.fileUrl || item.previewUrl || null;
  }

  if (needsConvertedPreview(item)) {
    return item.previewUrl || item.fileUrl;
  }

  return item.fileUrl || item.previewUrl || null;
}

// 详情面板的"显示来源"：优先说**这次实际显示的**是什么，没显示过就按"会给哪个地址"预测。
function imageSourceLabelFor(item) {
  const shown = imageDisplaySources.get(item?.id);
  const fromSource =
    shown === 'source' ||
    (shown !== 'preview' && Boolean(item?.fileUrl) && viewerImageUrl(item) === item.fileUrl);

  return fromSource
    ? '源文件（未经转换）'
    : '转换预览（浏览器解不了这个格式）';
}

// 预加载邻居：只预热"这次真的会显示的那份源文件"。
//
// 需要转换的格式（TIFF 等）**故意不预热**：预热就等于"翻页时顺手把邻居也转一遍"，
// 白花 CPU、白占盘 —— 用户要的是"真正打开那一张的时候才转"。
// HEIC/HEIF 例外：一旦这个会话证实了浏览器能直接显示原图，邻居预热的就是源文件本体，
// 不产生任何转换；还没证实时不预热（免得白读一遍 HEIC 最后还得转换）。
// 已经打开过的那些不受影响：/api/preview 的响应带 immutable 缓存，翻回来照样秒开。
//
// 太大的原图也不预热（几十 MB 的图预热一下比打开还贵），反正有转圈提示兜着。
const PRELOAD_MAX_BYTES = 8 * 1024 * 1024;
const preloadedNeighborImages = [];

function preloadNeighbors() {
  preloadedNeighborImages.length = 0;

  for (const item of [viewerPrevItem, viewerNextItem]) {
    const heifWillShowSource =
      directFirst && isHeifImage(item) && imageSourceProven(item);

    if (needsConvertedPreview(item) && !heifWillShowSource) {
      continue;
    }

    const url = viewerImageUrl(item);

    if (!url) {
      continue;
    }

    if (Number(item.size) > PRELOAD_MAX_BYTES) {
      continue;
    }

    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    // 留住引用，别让浏览器把刚预热的解码结果回收掉
    preloadedNeighborImages.push(image);
  }
}

function showViewerError(message) {
  hideSpinner();
  const box = document.createElement('div');
  box.className = 'viewer-error';
  box.textContent = message;
  viewerMedia.replaceChildren(box);
}

function renderImageInViewer(item, renderToken) {
  // 需要转换的格式只在打开这一张时才转，所以这里把话说清楚；
  // HEIC/HEIF 是先拿源文件试（浏览器装了系统解码器就能直接显示原图）。
  // 提示按"这次到底会给哪个地址"来写，之前转过的会命中磁盘缓存 + 浏览器
  // immutable 缓存，通常一闪而过。
  const willShowSource = viewerImageUrl(item) === item.fileUrl;

  showSpinner(
    willShowSource
      ? isImageSourceTrial(item)
        ? '正在试原图…（浏览器解不了这个格式的话会自动转一次）'
        : '正在加载照片…'
      : '正在转换这张照片…（浏览器解不了这个格式，需要转一次）'
  );
  resetZoom();

  const image = document.createElement('img');
  image.className = 'viewer-image';
  image.alt = item.name;
  image.draggable = false;
  let usedFallback = false;
  // 这次给的是不是源文件本体（HEIC 试原图、原生格式都是；退回预览/缩略图就不是）
  let showingSource = willShowSource;
  // 原生格式先试源文件；HEIC/HEIF 同理（浏览器可能装了系统解码器，能直接显示）。
  // 万一这个"jpg"其实是别的格式（或 CMYK/超大图）、或者 HEIC 这台机器显示不了，
  // 才退到服务端转出来的预览图 —— 这是唯一会生成预览的路径。
  // 注意：已经在显示预览图时不重复退（否则会拿同一个地址再试一次）。
  let allowPreviewFallback =
    willShowSource &&
    (BROWSER_NATIVE_IMAGE_EXTENSIONS.has(item.extension) || isHeifImage(item));

  image.addEventListener('load', () => {
    if (renderToken !== viewerRenderToken) {
      return;
    }

    // 记下"这次显示的到底是什么"（详情面板要说实话），
    // 顺便把"本浏览器能直接显示 HEIC 原图"记进会话，后面所有 HEIC 都不用再试。
    imageDisplaySources.set(item.id, showingSource ? 'source' : 'preview');

    if (showingSource && isHeifImage(item)) {
      rememberImageSourceWorks(item);
    }

    hideSpinner();
    clampPan();
    applyTransform();
  });

  image.addEventListener('error', () => {
    if (renderToken !== viewerRenderToken) {
      return;
    }

    if (allowPreviewFallback && item.previewUrl) {
      allowPreviewFallback = false;
      showingSource = false;
      // 现在就记下"这次显示的是转换图"（详情面板不用等它加载完才说实话）
      imageDisplaySources.set(item.id, 'preview');
      showSpinner(
        isHeifImage(item)
          ? '这台机器显示不了 HEIC 原图，正在转换…（转一次之后就能看）'
          : '正在加载预览图…'
      );
      image.src = item.previewUrl;
      return;
    }

    if (!usedFallback && item.thumbUrl) {
      usedFallback = true;
      showingSource = false;
      showSpinner('正在加载缩略图…');
      image.src = item.thumbUrl;
      return;
    }

    showViewerError('这张图片暂时无法显示');
  });

  image.src = viewerImageUrl(item);
  viewerMedia.append(image);
  applyTransform();
}

// ---------------------------------------------------------------------------
// 视频播放方式：HEVC 优先直出，失败再转（三层：预判 / 记忆 / 隐藏）
//
//   1. 预判：给 <video> 设源之前先问浏览器能不能解这个编码（canPlayType 在 Chromium 里
//      就是去问平台解码器，装了 HEVC 扩展就返回 probably），说不行就直接走转码，一次都不试。
//   2. 记忆：按"编码 + 容器"记住预判结论（本会话；每次启动重问，用户中途装了解码器也能生效），
//      再按"文件"记住实际失败过的那些（localStorage，下次直接走转码，不再试）。
//   3. 隐藏：直出失败/超时时不露黑屏 —— 转圈提示一直盖着，静默换成转码地址重来。
//
// 服务端不用改：fileUrl 就是源文件，videoUrl 是需要时会转码的那一份。
// ---------------------------------------------------------------------------
const DIRECT_VIDEO_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av01', 'av1']);
// 这些编码浏览器自己不带解码器，全靠系统（HEVC 扩展 / 硬件解码），所以要预判
const PROBED_VIDEO_CODECS = new Set(['hevc', 'hvc1', 'hev1', 'h265']);
const DIRECT_VIDEO_FAILURES_KEY = 'album-direct-video-failures-v1';
// 预判结论直接存在 sessionStorage 里，一个"编码|容器"一个键：
// 每个标签页一份、刷新/重开页面就重新问（用户中途装 HEVC 扩展，下次打开就生效），
// 也方便排查"这台机器到底能不能解"（Application → Session Storage 里一眼就能看）。
const VIDEO_PROBE_KEY_PREFIX = 'album-video-probe-v1:';
const DIRECT_ATTEMPT_TIMEOUT_MS = 5000;
// 悬停预览是"顺手看一眼"的东西：等满 5 秒才换转码，比不预览还难受，所以给它更短的兜底
const HOVER_DIRECT_TIMEOUT_MS = 2500;
// "直出"总开关（图片 + 视频）：一个设置管两件事
//   开：图片（HEIC/HEIF）先试原图、视频（HEVC 等）先试播源文件，试不动自动转换/转码
//   关：图片一律转换、视频一律转码（回到"稳"的老行为）
// 老版本的键是 album-direct-video-first（那时只管视频），读的时候兼容一下。
const directSettingKey = 'album-direct-source-first';
const legacyDirectSettingKey = 'album-direct-video-first';

// 默认开：装了 HEVC/HEIF 解码器的机器就能省掉转换和转码
let directFirst = true;
let directVideoFailures = loadDirectVideoFailures();
const videoPlaybackModes = new Map();

// 预判结论只有两档，**没有"肯定不行"这一档**：
//   'yes'    canPlayType 明确说 probably/maybe → 直接给源文件
//   'unsure' 答不上来（空串）。Chromium 对 `video/quicktime; codecs="hevc"` 这种问法
//            经常就回空串 —— 它的意思是"我不保证"，不是"肯定播不了"，所以照样先试一次。
// 存的时候：能 = '1'，不确定 = '?'；老版本写的 '0' 一律当"不确定"
// （那时候的 bug 正是把"答不上来"当成了"解不了"，于是永远不试）。
const VIDEO_PROBE_YES = 'yes';
const VIDEO_PROBE_UNSURE = 'unsure';

function readVideoProbe(key) {
  try {
    const raw = window.sessionStorage.getItem(`${VIDEO_PROBE_KEY_PREFIX}${key}`);

    if (raw === null) {
      return null;
    }

    return raw === '1' ? VIDEO_PROBE_YES : VIDEO_PROBE_UNSURE;
  } catch {
    return null;
  }
}

function writeVideoProbe(key, verdict) {
  try {
    window.sessionStorage.setItem(
      `${VIDEO_PROBE_KEY_PREFIX}${key}`,
      verdict === VIDEO_PROBE_YES ? '1' : '?'
    );
  } catch {
    // 隐私模式下写不了，就每次都重新问（代价是一次 canPlayType，几乎为零）
  }
}

function loadDirectVideoFailures() {
  try {
    const raw = window.localStorage.getItem(DIRECT_VIDEO_FAILURES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveDirectVideoFailures() {
  try {
    // 只留最近 500 条，够用又不会把 localStorage 撑爆
    const values = [...directVideoFailures].slice(-500);
    directVideoFailures = new Set(values);
    window.localStorage.setItem(
      DIRECT_VIDEO_FAILURES_KEY,
      JSON.stringify(values)
    );
  } catch {
    // 隐私模式下写不了，就只对本会话生效
  }
}

function loadDirectSetting() {
  try {
    const raw =
      window.localStorage.getItem(directSettingKey) ??
      window.localStorage.getItem(legacyDirectSettingKey);

    directFirst = raw === null ? true : raw === '1';
  } catch {
    directFirst = true;
  }

  return directFirst;
}

function setDirectFirst(enabled) {
  directFirst = Boolean(enabled);

  try {
    window.localStorage.setItem(directSettingKey, directFirst ? '1' : '0');
  } catch {
    // 隐私模式：只对当前页面生效
  }

  syncDirectButton();
}

function videoCodecOf(item) {
  return String(item?.videoCodec || '').trim().toLowerCase();
}

// 第一层：预判这台机器能不能解这个编码（结果按"编码+容器"缓存到本次会话）
function probeVideoCodec(item) {
  const codec = videoCodecOf(item);

  if (!codec) {
    return VIDEO_PROBE_UNSURE;
  }

  const extension = String(item.extension || '').toUpperCase();
  const key = `${codec}|${extension}`;
  const cached = readVideoProbe(key);

  if (cached !== null) {
    return cached;
  }

  const container = extension === 'MOV' ? 'video/quicktime' : 'video/mp4';
  let verdict = VIDEO_PROBE_UNSURE;

  try {
    const probe = document.createElement('video');
    const answer = probe.canPlayType(`${container}; codecs="${codec}"`);

    // probably / maybe 才算"说了能解"；空串是"答不上来"，也算不确定
    if (answer === 'probably' || answer === 'maybe') {
      verdict = VIDEO_PROBE_YES;
    }
  } catch {
    verdict = VIDEO_PROBE_UNSURE;
  }

  writeVideoProbe(key, verdict);
  return verdict;
}

// 综合第一、二层：这个视频这次该怎么播
function videoPlaybackPlan(item) {
  const url = item?.fileUrl || null;
  const transcodeUrl = item?.videoUrl || item?.fileUrl || null;
  const codec = videoCodecOf(item);

  if (!directFirst) {
    return { mode: 'transcode', url: transcodeUrl, reason: 'setting' };
  }

  if (directVideoFailures.has(item?.id)) {
    return { mode: 'transcode', url: transcodeUrl, reason: 'remembered' };
  }

  if (DIRECT_VIDEO_CODECS.has(codec)) {
    // 浏览器本来就带解码器：服务端也不会转码，直接源文件
    return { mode: 'direct', url, reason: 'native-codec' };
  }

  if (PROBED_VIDEO_CODECS.has(codec)) {
    // 预判只是"快速路径"：说能解就直接给源文件；**答不上来也照样先试一次**
    // （Chromium 对 quicktime + 裸 hevc 这种问法经常答不上来，而它其实能播）。
    // 试不动的话由第三层兜住：报错/超时就静默换转码，并把这个文件记下来。
    return {
      mode: 'direct',
      url,
      reason:
        probeVideoCodec(item) === VIDEO_PROBE_YES ? 'probe-ok' : 'probe-unsure',
    };
  }

  // 明确不值得试的（mpeg4 / prores / 编码未知）：直接转码
  return { mode: 'transcode', url: transcodeUrl, reason: 'unsupported-codec' };
}

function clearDirectVideoFailures() {
  directVideoFailures = new Set();
  saveDirectVideoFailures();
}

function rememberDirectVideoFailure(item) {
  if (!item?.id || directVideoFailures.has(item.id)) {
    return;
  }

  directVideoFailures.add(item.id);
  saveDirectVideoFailures();
}

// 详情面板用的人话：这次播的是源文件还是转码副本
function videoModeLabel(item) {
  const mode = videoPlaybackModes.get(item.id) || videoPlaybackPlan(item).mode;

  return mode === 'direct'
    ? '源文件直出（未经转码）'
    : '转码副本（H.264）';
}

// 悬停说明里写清"这台机器到底行不行"：视频看预判结论、图片看有没有试出来能直出
function directVerdictLines() {
  const videoProbe =
    readVideoProbe('hevc|MOV') ?? readVideoProbe('hevc|MP4') ?? null;
  const heicProven = imageSourceProven({ type: 'image', extension: 'HEIC' });

  return [
    videoProbe === null
      ? '· 视频（HEVC）：还没试过'
      : videoProbe === VIDEO_PROBE_YES
        ? '· 视频（HEVC）：预判说能解 → 直接播源文件'
        : '· 视频（HEVC）：预判答不上来（仍会真试一次，试不动才转码）',
    heicProven
      ? '· HEIC 原图：这个浏览器能直出'
      : '· HEIC 原图：还没试出来（打开一张 HEIC 就知道；显示不了会自动转换）',
  ];
}

function syncDirectButton() {
  if (!directButton) {
    return;
  }

  directButton.classList.toggle('is-active', directFirst);
  directButton.setAttribute('aria-pressed', directFirst ? 'true' : 'false');
  directButton.title = [
    directFirst
      ? '直出：开 —— 图片和视频都先试原图，试不动自动转换 / 转码'
      : '直出：关 —— 图片一律转换、视频一律转码',
    ...directVerdictLines(),
    directFirst
      ? '点一下 = 关掉直出，并重置"试过"的记忆'
      : '点一下 = 打开直出（图片和视频都重新试一遍）',
  ].join('\n');
}

function renderVideoInViewer(item, renderToken) {
  const plan = videoPlaybackPlan(item);

  showSpinner(
    plan.mode === 'direct'
      ? plan.reason === 'probe-unsure'
        ? '正在试播源文件…（这台机器解不解得了还不确定，不行会自动换转码版本）'
        : '正在打开视频…'
      : '正在准备视频，首次播放可能需要十几秒…'
  );
  resetZoom();

  playVideoSource(item, plan, renderToken, {
    allowFallback: plan.mode === 'direct',
  });
}

// 第三层：出错/超时都走这里，悄悄换成转码地址，中途一直有转圈提示盖着，不露黑屏。
function playVideoSource(item, plan, renderToken, { allowFallback }) {
  const video = document.createElement('video');
  video.className = 'viewer-video';
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.dataset.source = plan.mode;
  video.setAttribute('aria-label', item.name);

  let settled = false;
  let fallbackTimer = null;

  const finishLoading = () => {
    if (settled) {
      return;
    }

    settled = true;

    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    if (renderToken === viewerRenderToken) {
      videoPlaybackModes.set(item.id, plan.mode);
      hideSpinner();
    }
  };

  const fallbackToTranscode = () => {
    if (settled || renderToken !== viewerRenderToken) {
      return;
    }

    settled = true;

    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    stopVideo();
    // 失败的那个 <video> 还留在 DOM 里（stopVideo 只清 src），先撤干净再放新的
    viewerMedia.replaceChildren();
    showSpinner('这个视频的原始编码浏览器解不了，正在准备转码版本…');
    playVideoSource(
      item,
      { mode: 'transcode', url: item.videoUrl || item.fileUrl, reason: 'fallback' },
      renderToken,
      { allowFallback: false }
    );
  };

  video.addEventListener('loadeddata', finishLoading, { once: true });
  video.addEventListener('canplay', finishLoading, { once: true });
  video.addEventListener('error', () => {
    if (renderToken !== viewerRenderToken) {
      return;
    }

    if (allowFallback) {
      // 第二层：这个文件直出不行，记住，下次直接转码
      rememberDirectVideoFailure(item);
      fallbackToTranscode();
      return;
    }

    stopVideo();
    showViewerError('这个视频暂时无法在应用内播放');
  });

  if (allowFallback) {
    // 既不报错也不出画面（比如卡在那儿）也要兜住
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null;
      rememberDirectVideoFailure(item);
      fallbackToTranscode();
    }, DIRECT_ATTEMPT_TIMEOUT_MS);
  }

  video.src = plan.url;
  viewerMedia.append(video);
  videoElement = video;

  const playPromise = video.play();

  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      // 应用阻止自动播放时，保留控制条，让用户手动点播放。
    });
  }
}

function renderViewerItem() {
  const item = getCurrentItem();

  if (!item) {
    return;
  }

  if (detailsOpen) {
    closeDetails({ restoreFocus: false, resumeVideo: false });
  }

  const renderToken = ++viewerRenderToken;

  stopVideo();
  stopLiveVideo();
  viewerMedia.replaceChildren();
  viewerMedia.classList.remove('is-dragging');
  viewerZoom.hidden = true;

  updateViewerNavigation();
  viewerFilename.textContent = item.name;
  viewerOpenOriginal.textContent =
    item.type === 'video' ? 'PotPlayer' : '原图';
  viewerOpenOriginal.title =
    item.type === 'video'
      ? '用 PotPlayer 打开原视频'
      : '用系统照片打开原图';

  // 实况照片多一个"实况"按钮：在静止图上叠放同名 MOV。
  const live = isLivePhoto(item);
  viewerLive.hidden = !live;

  if (live) {
    const duration = item.liveVideoDuration
      ? ` · ${formatDuration(item.liveVideoDuration)}`
      : '';
    viewerLive.title = `播放实况视频：${item.liveVideoName || ''}${duration}（L）`;
  }

  const dateText = formatViewerDate(item.takenAt);
  viewerDate.textContent = live
    ? `${dateText} · 实况照片${item.liveVideoDuration ? ` · ${formatDuration(item.liveVideoDuration)}` : ''}`
    : item.type === 'video' && item.duration
      ? `${dateText} · ${formatDuration(item.duration)}`
      : dateText;

  if (item.type === 'video') {
    viewerHintDesktop.textContent = '← → 切换 · Esc 关闭';
    viewerHintTouch.textContent = '左右滑动切换';
    renderVideoInViewer(item, renderToken);
  } else {
    viewerHintDesktop.textContent = live
      ? '滚轮缩放 · L 播放实况 · ← → 切换 · Esc 关闭'
      : '滚轮缩放 · 双击放大 · ← → 切换 · Esc 关闭';
    viewerHintTouch.textContent = live
      ? '双击放大 · 点"实况"播放 · 左右滑动切换'
      : '双击放大 · 左右滑动切换';
    renderImageInViewer(item, renderToken);
  }

  preloadNeighbors();
}

function createDetailSection(title, rows) {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);

  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') {
      continue;
    }

    const row = document.createElement('div');
    row.className = 'detail-row';

    const labelElement = document.createElement('span');
    labelElement.className = 'detail-label';
    labelElement.textContent = label;

    const valueElement = document.createElement('span');
    valueElement.className = 'detail-value';
    valueElement.textContent = String(value);

    row.append(labelElement, valueElement);
    section.append(row);
  }

  return section.children.length > 1 ? section : null;
}

function renderDetails(item) {
  const isVideo = item.type === 'video';
  const isLive = isLivePhoto(item);
  // 用户最关心"我现在看到的是不是原图"：图片说清是源文件还是转换预览，
  // 视频说清是源文件还是转码副本（needsTranscode 会被 toPublicItem 剔掉，
  // 所以这里用"扩展名 + 是否原生支持"来给一句人话）。
  const imageSourceLabel = imageSourceLabelFor(item);
  const sections = [
    createDetailSection('文件', [
      ['文件名', item.name],
      ['格式', `${item.extension} · ${item.mime}`],
      ['大小', formatBytes(item.size)],
      ['分辨率', item.width && item.height ? `${item.width} × ${item.height}` : '未读取到'],
      ...(isVideo ? [] : [['显示来源', imageSourceLabel]]),
      ...(isLive
        ? [['类型', item.liveVideoDuration
            ? `实况照片 · 视频 ${formatDuration(item.liveVideoDuration)}`
            : '实况照片']]
        : []),
      ...(isVideo
        ? [
            ['时长', item.duration ? formatDuration(item.duration) : '未读取到'],
            ['视频编码', formatCodec(item.videoCodec)],
            ['播放方式', videoModeLabel(item)],
          ]
        : []),
    ]),
    isLive
      ? createDetailSection('实况', [
          ['伴随视频', item.liveVideoName || '同名 MOV'],
          ['视频大小', item.liveVideoSize ? formatBytes(item.liveVideoSize) : null],
          ['视频时长', item.liveVideoDuration ? formatDuration(item.liveVideoDuration) : null],
        ])
      : null,
    createDetailSection('时间', [
      ['拍摄时间', formatDetailDate(item.takenAt)],
      ['修改时间', formatDetailDate(item.modifiedAt)],
      ['时间来源', formatDateSource(item.dateSource)],
    ]),
  ].filter(Boolean);

  if (item.device || item.lens) {
    sections.push(
      createDetailSection('设备', [
        ['设备', item.device || '未记录'],
        ['镜头', item.lens || '未记录'],
      ])
    );
  }

  if (
    typeof item.latitude === 'number' &&
    typeof item.longitude === 'number'
  ) {
    sections.push(
      createDetailSection('位置', [
        ['城市', item.city ? formatCityName(item.city) : '未识别'],
        [
          '经纬度',
          `${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}`,
        ],
      ])
    );
  }

  detailsSubtitle.textContent = isLive
    ? `实况照片 · ${item.extension}`
    : `${isVideo ? '视频' : '照片'} · ${item.extension}`;
  detailsContent.replaceChildren(...sections.filter(Boolean));
}

function openDetails() {
  const item = getCurrentItem();

  if (!item || detailsOpen) {
    return;
  }

  renderDetails(item);
  detailsOpen = true;
  detailsPanel.hidden = false;
  detailsBackdrop.hidden = false;
  viewerDetailsButton.setAttribute('aria-expanded', 'true');

  if (videoElement && !videoElement.paused) {
    videoWasPlayingBeforeDetails = true;
    videoElement.pause();
  } else {
    videoWasPlayingBeforeDetails = false;
  }

  // 实况视频同理：打开详情时先停下，关闭详情不自动续播（用户按"实况"再来）。
  if (liveVideoElement && !liveVideoElement.paused) {
    liveVideoElement.pause();
  }

  const focusClose = viewerDetailsButton.matches(':focus-visible');

  window.setTimeout(() => {
    if (focusClose) {
      detailsClose.focus({ preventScroll: true });
    } else {
      detailsPanel.focus({ preventScroll: true });
    }
  }, 30);
}

function closeDetails({ restoreFocus = true, resumeVideo = true } = {}) {
  if (!detailsOpen) {
    return;
  }

  detailsOpen = false;
  detailsPanel.hidden = true;
  detailsBackdrop.hidden = true;
  viewerDetailsButton.setAttribute('aria-expanded', 'false');

  if (resumeVideo && videoWasPlayingBeforeDetails && videoElement) {
    videoElement.play().catch(() => {
      // 应用阻止恢复播放时保持暂停。
    });
  }

  videoWasPlayingBeforeDetails = false;

  if (restoreFocus) {
    viewerDetailsButton.focus({ preventScroll: true });
  }
}

// 查看器导航：优先用服务端算出的邻居（覆盖整个图库），
// 退化到"当前已加载的条目"里的相邻项。
function viewerStep(direction) {
  const neighbor = direction > 0 ? viewerNextItem : viewerPrevItem;

  if (neighbor) {
    return neighbor;
  }

  return items[currentIndex + direction] || null;
}

function updateViewerNavigation() {
  const index = viewerPosition.index >= 0 ? viewerPosition.index : currentIndex;
  const total = viewerPosition.total || items.length;

  viewerCounter.textContent = total > 0 ? `${Math.max(1, index + 1)} / ${total}` : '';

  const canGoPrevious =
    Boolean(viewerPrevItem) || (currentIndex > 0 && currentIndex < items.length);
  const canGoNext =
    Boolean(viewerNextItem) ||
    (currentIndex >= 0 && currentIndex < items.length - 1);

  viewerPrev.disabled = !canGoPrevious;
  viewerNext.disabled = !canGoNext;
  viewerPrev.hidden = !canGoPrevious && !canGoNext;
  viewerNext.hidden = !canGoPrevious && !canGoNext;
}

async function loadViewerNeighbors(itemId) {
  try {
    const data = await fetchJson(
      `/api/library/neighbors/${encodeURIComponent(
        itemId
      )}?folder=${encodeURIComponent(activeFolder)}`
    );

    if (!viewerItem || viewerItem.id !== itemId) {
      return;
    }

    viewerPrevItem = data?.previous || null;
    viewerNextItem = data?.next || null;
    viewerPosition = {
      index: typeof data?.index === 'number' ? data.index : -1,
      total: Number(data?.total) || 0,
    };

    updateViewerNavigation();
    preloadNeighbors();
  } catch {
    // 扫描还没完成时拿不到邻居，保持单张浏览即可。
  }
}

function openViewer(itemId) {
  const item =
    stream.getLoadedItem(itemId) ||
    items.find((entry) => entry.id === itemId) ||
    null;

  if (!item) {
    return;
  }

  lastFocusedElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const shouldFocusClose =
    lastFocusedElement?.matches?.(':focus-visible') || false;

  viewerItem = item;
  viewerPrevItem = null;
  viewerNextItem = null;
  viewerPosition = { index: -1, total: 0 };
  currentIndex = items.indexOf(item);

  viewer.classList.add('is-open');
  viewer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('viewer-open');
  renderViewerItem();

  window.setTimeout(() => {
    if (shouldFocusClose) {
      viewerClose.focus({ preventScroll: true });
    } else {
      viewer.focus({ preventScroll: true });
    }
  }, 40);

  loadViewerNeighbors(item.id);
}

function closeViewer() {
  if (!isViewerOpen()) {
    return;
  }

  closeDetails({ restoreFocus: false, resumeVideo: false });
  stopVideo();
  stopLiveVideo();
  viewerRenderToken += 1;
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('viewer-open');
  viewerMedia.replaceChildren();
  viewerSpinner.hidden = true;
  currentIndex = -1;
  viewerItem = null;
  viewerPrevItem = null;
  viewerNextItem = null;
  viewerPosition = { index: -1, total: 0 };
  gesture = null;

  if (lastFocusedElement && document.contains(lastFocusedElement)) {
    lastFocusedElement.focus({ preventScroll: true });
  }

  lastFocusedElement = null;
}

function navigateViewer(direction) {
  if (!isViewerOpen()) {
    return;
  }

  const target = viewerStep(direction);

  if (!target) {
    return;
  }

  viewerItem = target;
  viewerPrevItem = null;
  viewerNextItem = null;
  viewerPosition = {
    index: viewerPosition.index >= 0 ? viewerPosition.index + direction : -1,
    total: viewerPosition.total,
  };
  currentIndex = items.indexOf(target);

  renderViewerItem();
  loadViewerNeighbors(target.id);
}

function trapViewerFocus(event) {
  const scope = detailsOpen ? detailsPanel : viewer;
  const focusable = [
    ...scope.querySelectorAll(
      'button:not([disabled]):not([hidden]), video[controls]'
    ),
  ].filter((element) => element.getClientRects().length > 0);

  if (!focusable.length) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function blockStageClick() {
  suppressStageClick = true;
  window.setTimeout(() => {
    suppressStageClick = false;
  }, 420);
}

viewerClose.addEventListener('click', closeViewer);
viewerPrev.addEventListener('click', () => navigateViewer(-1));
viewerNext.addEventListener('click', () => navigateViewer(1));
viewerOpenOriginal.addEventListener('click', () => {
  const item = getCurrentItem();

  if (item) {
    openOriginal(item);
  }
});
viewerZoom.addEventListener('click', () => resetZoom({ animate: true }));
viewerLive.addEventListener('click', () => playLivePhoto());
viewerDetailsButton.addEventListener('click', () => {
  if (detailsOpen) {
    closeDetails();
  } else {
    openDetails();
  }
});
detailsClose.addEventListener('click', () => closeDetails());
detailsBackdrop.addEventListener('click', () => closeDetails());

viewerStage.addEventListener(
  'wheel',
  (event) => {
    const item = getCurrentItem();

    if (!isViewerOpen() || !item || item.type !== 'image') {
      return;
    }

    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    zoomAt(scale * factor, event.clientX, event.clientY);
  },
  { passive: false }
);

viewerStage.addEventListener('dblclick', (event) => {
  const item = getCurrentItem();

  if (
    !item ||
    item.type !== 'image' ||
    !event.target.closest('.viewer-image')
  ) {
    return;
  }

  event.preventDefault();

  if (scale > 1.01) {
    resetZoom({ animate: true });
    return;
  }

  zoomAt(2.5, event.clientX, event.clientY);
});

viewerStage.addEventListener('pointerdown', (event) => {
  const item = getCurrentItem();

  if (!item || item.type !== 'image' || event.button !== 0) {
    return;
  }

  const startedOnImage = event.target.closest?.('.viewer-image');

  if (!startedOnImage && event.target !== viewerStage) {
    return;
  }

  const mode =
    scale > 1.01
      ? 'pan'
      : event.pointerType === 'mouse'
        ? 'none'
        : 'swipe';

  if (mode === 'none') {
    return;
  }

  gesture = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    startX: event.clientX,
    startY: event.clientY,
    startPanX: panX,
    startPanY: panY,
    moved: false,
    mode,
  };

  if (viewerStage.setPointerCapture) {
    viewerStage.setPointerCapture(event.pointerId);
  }

  if (mode === 'pan') {
    viewerMedia.classList.add('is-dragging');
  }
});

viewerStage.addEventListener('pointermove', (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - gesture.startX;
  const deltaY = event.clientY - gesture.startY;

  if (Math.hypot(deltaX, deltaY) > 4) {
    gesture.moved = true;
  }

  if (gesture.mode === 'pan') {
    panX = gesture.startPanX + deltaX;
    panY = gesture.startPanY + deltaY;
    clampPan();
    applyTransform();
  }
});

function finishGesture(event) {
  if (!gesture || gesture.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - gesture.startX;
  const deltaY = event.clientY - gesture.startY;
  const currentGesture = gesture;
  const cancelled = event.type === 'pointercancel';

  gesture = null;

  if (viewerStage.hasPointerCapture?.(event.pointerId)) {
    viewerStage.releasePointerCapture(event.pointerId);
  }

  viewerMedia.classList.remove('is-dragging');

  if (currentGesture.mode === 'pan') {
    clampPan();
    applyTransform();
  }

  if (
    !cancelled &&
    currentGesture.mode === 'swipe' &&
    currentGesture.moved &&
    Math.abs(deltaX) > 55 &&
    Math.abs(deltaX) > Math.abs(deltaY) * 1.2
  ) {
    blockStageClick();
    navigateViewer(deltaX > 0 ? -1 : 1);
  } else if (currentGesture.moved) {
    blockStageClick();
  }
}

viewerStage.addEventListener('pointerup', finishGesture);
viewerStage.addEventListener('pointercancel', finishGesture);

viewerStage.addEventListener('click', (event) => {
  if (suppressStageClick) {
    suppressStageClick = false;
    return;
  }

  if (event.target === viewerStage) {
    closeViewer();
  }
});

document.addEventListener('keydown', (event) => {
  if (!isViewerOpen()) {
    return;
  }

  if (detailsOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDetails();
    } else if (event.key === 'Tab') {
      trapViewerFocus(event);
    }

    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeViewer();
    return;
  }

  if (videoElement && document.activeElement === videoElement) {
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navigateViewer(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigateViewer(1);
  } else if (event.key === '0') {
    event.preventDefault();
    resetZoom({ animate: true });
  } else if (event.key === 'l' || event.key === 'L') {
    event.preventDefault();
    playLivePhoto();
  } else if (event.key === 'Tab') {
    trapViewerFocus(event);
  }
});

window.addEventListener('resize', () => {
  if (!isViewerOpen()) {
    return;
  }

  clampPan();
  applyTransform();
});

// 扫描提示现在贴在内容区顶部（不再是全屏遮罩）：
// 扫描中可以"停止加载"，停止后可以"继续加载"。
let overlayMode = 'cancel';

function updateScanProgress() {
  const total = streamState?.total || 0;
  const filled = streamState?.filled || 0;
  const percent = total > 0 ? Math.min(100, Math.round((filled / total) * 100)) : 0;

  scanFill.style.width = `${percent}%`;
}

function setOverlay(mode, message) {
  overlayMode = mode;
  scanText.textContent = message;
  scanBar.hidden = false;
  scanCancelButton.disabled = false;
  scanCancelButton.textContent = mode === 'resume' ? '继续加载' : '停止加载';
  updateScanProgress();
}

function setScanning(isScanning, message = '正在扫描照片文件夹…') {
  if (isScanning) {
    setOverlay('cancel', message);
    return;
  }

  scanBar.hidden = true;
}

function stopScanning() {
  if (overlayMode === 'resume') {
    scanBar.hidden = true;
    loadLibrary({ force: true });
    return;
  }

  scanCancelButton.disabled = true;
  scanCancelButton.textContent = '正在停止…';

  // 2.0：取消由服务端处理，已经扫描到的部分会保留下来继续可看。
  fetch('/api/scan/cancel', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  })
    .then(() => {
      showToast('已停止加载');
    })
    .catch(() => {
      // 前端已经停止等待，取消接口失败不影响界面恢复。
      scanBar.hidden = true;
    });
}

function setChoosingFolder(isChoosing) {
  chooseFolderButton.disabled = isChoosing;
  topbarFolderButton.disabled = isChoosing;
  chooseFolderButton.classList.toggle('is-busy', isChoosing);

  if (isChoosing) {
    chooseFolderButton.textContent = '正在选择…';
    return;
  }

  chooseFolderButton.textContent = libraryData?.source?.isDefault
    ? '选择照片文件夹'
    : '更换文件夹';
}

async function chooseFolder() {
  if (isChoosingFolder || isLoading) {
    return;
  }

  isChoosingFolder = true;
  setChoosingFolder(true);
  showToast('请在系统窗口中选择照片文件夹');

  try {
    const response = await fetch('/api/folder/select', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `打开文件夹选择窗口失败（${response.status}）`);
    }

    if (data.canceled) {
      showToast('没有更换照片文件夹');
      return;
    }

    updateSource(data.source);
    activeFolder = 'all';
    gallery.dataset.state = 'loading';

    if (isViewerOpen()) {
      closeViewer();
    }

    const loaded = await loadLibrary({ force: true });

    if (loaded) {
      showToast('照片文件夹已更新');
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || '打开文件夹选择窗口失败');
  } finally {
    isChoosingFolder = false;
    setChoosingFolder(false);
  }
}

// 从 ?photo=<id> 进来时，目标照片可能还没进入可视窗口；
// 用按 id 取数的接口把它找出来，而不是把整个图库拉下来找。
async function resolvePendingPhoto(id) {
  try {
    const data = await fetchJson(
      `/api/library/items-by-ids?ids=${encodeURIComponent(id)}`
    );
    const item = data?.items?.[0];

    if (!item) {
      showToast('没有找到这张照片');
      return;
    }

    stream.rememberItems([item]);
    openViewer(item.id);
  } catch {
    showToast('没有找到这张照片');
  }
}

async function loadLibrary({ force = false } = {}) {
  if (isLoading) {
    return false;
  }

  isLoading = true;
  const hadContent = gallery.dataset.state === 'ready';

  // 每轮加载都重新核对一次侧栏目录：刷新/换文件夹后必须重新拿一遍，
  // 不能因为"revision 看起来没变"就跳过（见 syncFolderNavigation 里的说明）。
  folderNavRevision = -1;

  refreshButton.disabled = true;
  refreshButton.classList.add('is-spinning');
  syncCacheButton();

  if (force && !hadContent) {
    setOverlay('cancel', '正在刷新照片文件夹…');
  }

  try {
    await stream.start({ force });

    if (pendingPhotoId) {
      const id = pendingPhotoId;
      pendingPhotoId = null;
      window.history.replaceState({}, '', window.location.pathname);

      if (stream.getLoadedItem(id)) {
        openViewer(id);
      } else {
        await resolvePendingPhoto(id);
      }
    }

    if (force) {
      showToast('已重新扫描照片文件夹');
    }

    return true;
  } catch (error) {
    console.error(error);
    summary.textContent = '读取相册失败';
    showToast(error.message || '读取相册失败，请稍后重试');
    return false;
  } finally {
    isLoading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-spinning');
    syncCacheButton();
  }
}

refreshButton.addEventListener('click', () => {
  loadLibrary({ force: true });
});

chooseFolderButton.addEventListener('click', chooseFolder);
topbarFolderButton.addEventListener('click', chooseFolder);
scanCancelButton.addEventListener('click', stopScanning);
clearCacheButton.addEventListener('click', openCacheConfirm);
// "直出"总开关的初值要等上面的声明都执行完（let 有暂时死区）
loadDirectSetting();
syncDirectButton();
directButton?.addEventListener('click', () => {
  setDirectFirst(!directFirst);

  if (directFirst) {
    // 重新打开 = 重新试一遍：两类记忆都清掉
    //   · 视频：按文件记的"直出失败过"（localStorage）
    //   · 图片：本会话记的"这个浏览器能直出 HEIC"（sessionStorage）
    // 用户中途装了 HEVC / HEIF 解码器时，这个手势就能让它立刻生效。
    clearDirectVideoFailures();
    clearImageSourceVerdicts();
    showToast('直出已打开：图片和视频都先试原图（已重置试过的记忆）');
  } else {
    showToast('直出已关闭：图片一律转换、视频一律转码');
  }
});
for (const button of openModeButtons) {
  button.addEventListener('click', () => {
    setOpenMode(button.dataset.openMode);
  });
}
for (const button of cacheOptionButtons) {
  button.addEventListener('click', () => {
    clearCacheNow(button.dataset.cacheKind || 'all');
  });
}

cacheCancelButton.addEventListener('click', () => {
  if (!isClearingCache) {
    closeCacheConfirm();
  }
});

cacheConfirm.addEventListener('click', (event) => {
  if (event.target === cacheConfirm && !isClearingCache) {
    closeCacheConfirm();
  }
});

cacheConfirm.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !isClearingCache) {
    event.preventDefault();
    closeCacheConfirm();
    return;
  }

  if (event.key !== 'Tab') {
    return;
  }

  const focusable = [
    ...cacheConfirm.querySelectorAll(
      'button:not([disabled]):not([hidden])'
    ),
  ].filter((element) => element.getClientRects().length > 0);

  if (!focusable.length) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

folderSelect.addEventListener('change', () => {
  setActiveFolder(folderSelect.value, { scroll: true });
});

loadCacheInfo();
loadLibrary();
