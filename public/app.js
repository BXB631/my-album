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
const scanOverlay = document.querySelector('#scanOverlay');
const scanText = document.querySelector('#scanText');
const scanCancelButton = document.querySelector('#scanCancelButton');
const clearCacheButton = document.querySelector('#clearCacheButton');
const cacheSize = document.querySelector('#cacheSize');
const openModeButtons = document.querySelectorAll('[data-open-mode]');
const cacheConfirm = document.querySelector('#cacheConfirm');
const cacheConfirmSize = document.querySelector('#cacheConfirmSize');
const cacheConfirmButton = document.querySelector('#cacheConfirmButton');
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
let allItems = [];
let libraryData = null;
let activeFolder = 'all';
let galleryGroups = [];
let renderedGroupCount = 0;
let gallerySentinel = null;
let galleryObserver = null;
const INITIAL_GALLERY_GROUPS = 3;
const GALLERY_GROUP_BATCH = 3;
let isLoading = false;
let isChoosingFolder = false;
let scanController = null;
let scanWasCanceled = false;
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

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
}

function updateCacheInfo(info) {
  cacheInfo = {
    bytes: Number(info?.bytes) || 0,
    files: Number(info?.files) || 0,
  };

  const size = formatBytes(cacheInfo.bytes);
  cacheSize.textContent = size;
  cacheConfirmSize.textContent =
    cacheInfo.bytes > 0
      ? `当前占用 ${size} · ${cacheInfo.files} 个缓存文件`
      : '当前没有缓存文件';
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
  cacheConfirmButton.disabled = false;
  cacheCancelButton.disabled = false;
  cacheConfirmButton.textContent = '清除缓存';
  cacheConfirmSize.textContent =
    cacheInfo.bytes > 0
      ? `当前占用 ${formatBytes(cacheInfo.bytes)} · ${cacheInfo.files} 个缓存文件`
      : '当前没有缓存文件';

  loadCacheInfo();

  window.setTimeout(() => {
    cacheConfirmButton.focus({ preventScroll: true });
  }, 30);
}

function closeCacheConfirm() {
  if (!cacheConfirmOpen) {
    return;
  }

  cacheConfirmOpen = false;
  cacheConfirm.hidden = true;
  document.body.classList.remove('cache-confirm-open');
  cacheConfirmButton.textContent = '清除缓存';
  cacheConfirmButton.disabled = false;
  cacheCancelButton.disabled = false;

  if (lastCacheFocus && document.contains(lastCacheFocus)) {
    lastCacheFocus.focus({ preventScroll: true });
  }

  lastCacheFocus = null;
}

async function clearCacheNow() {
  if (isClearingCache) {
    return;
  }

  const previousBytes = cacheInfo.bytes;
  isClearingCache = true;
  cacheConfirmButton.disabled = true;
  cacheCancelButton.disabled = true;
  cacheConfirmButton.textContent = '正在清理…';
  clearCacheButton.classList.add('is-busy');
  syncCacheButton();

  try {
    const response = await fetch('/api/cache/clear', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `清除缓存失败（${response.status}）`);
    }

    updateCacheInfo(data);
    closeCacheConfirm();
    await loadCacheInfo();

    const released = previousBytes - cacheInfo.bytes;

    showToast(
      released > 0
        ? `缓存已清除，释放 ${formatBytes(released)}`
        : '缓存已清除'
    );
  } catch (error) {
    console.error(error);
    showToast(error.message || '清除缓存失败');
  } finally {
    isClearingCache = false;
    clearCacheButton.classList.remove('is-busy');

    if (cacheConfirmOpen) {
      cacheConfirmButton.disabled = false;
      cacheCancelButton.disabled = false;
      cacheConfirmButton.textContent = '清除缓存';
    }

    syncCacheButton();
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
      ? '点击图片将在相册内浏览'
      : '点击图片将用系统照片打开原图'
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
  if (item.type === 'video') {
    openOriginal(item);
    return;
  }

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
  return items[currentIndex] || null;
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

function filterItems(filter) {
  if (filter === 'all') {
    return allItems;
  }

  if (filter === 'unclassified') {
    return allItems.filter((item) => !item.year);
  }

  if (filter.startsWith('year-')) {
    const year = Number(filter.slice(5));
    return allItems.filter((item) => item.year === year);
  }

  return allItems.filter((item) => item.monthKey === filter);
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
  if (!libraryData) {
    return;
  }

  if (!allItems.length) {
    summary.textContent = `${libraryData.source?.name || '这个文件夹'} 里还没有照片或视频`;
    return;
  }

  const parts = [`${items.length} 个项目`];
  const imageCount = items.filter((item) => item.type === 'image').length;
  const videoCount = items.length - imageCount;

  if (imageCount) {
    parts.push(`${imageCount} 张照片`);
  }

  if (videoCount) {
    parts.push(`${videoCount} 个视频`);
  }

  if (activeFolder !== 'all') {
    parts.push(getFolderLabel(activeFolder));
  } else if (items.length !== allItems.length) {
    parts.push(`共 ${allItems.length} 个`);
  }

  summary.textContent = parts.join(' · ');
}

function setActiveFolder(filter, { scroll = false } = {}) {
  if (!isFolderAvailable(filter)) {
    filter = 'all';
  }

  if (filter === activeFolder && items.length) {
    updateFolderSelection();
    return;
  }

  if (isViewerOpen()) {
    closeViewer();
  }

  activeFolder = filter;
  items = filterItems(filter);
  updateFolderSelection();
  updateSummary();
  renderGalleryItems();

  if (scroll) {
    const header = document.querySelector('.library-layout');
    if (header) {
      const top = header.getBoundingClientRect().top + window.scrollY - 74;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }
}

function renderSkeleton() {
  const grid = document.createElement('div');
  grid.className = 'media-grid skeleton-grid';
  grid.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < 8; index += 1) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    grid.append(card);
  }

  gallery.replaceChildren(grid);
  gallery.dataset.state = 'loading';
}

function createImageCard(item) {
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
  image.loading = 'lazy';
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

  image.src = item.thumbUrl;

  const fallback = document.createElement('span');
  fallback.className = 'image-fallback';
  fallback.innerHTML = PHOTO_ICON;

  card.append(shimmer, image, fallback);

  card.addEventListener('click', () => {
    handleCardOpen(item);
  });

  return card;
}

function createVideoCard(item) {
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
  poster.loading = 'lazy';
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

  poster.src = item.thumbUrl;

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

function createMediaCard(item) {
  return item.type === 'video'
    ? createVideoCard(item)
    : createImageCard(item);
}

function groupItemsByDay(sourceItems) {
  const groups = new Map();

  for (const item of sourceItems) {
    const date = new Date(item.takenAt);

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const key = dayKey(date);

    if (!groups.has(key)) {
      groups.set(key, { date, items: [] });
    }

    groups.get(key).items.push(item);
  }

  return [...groups.values()];
}

function createDayGroup(group, index) {
  const section = document.createElement('section');
  section.className = 'day-group';
  section.style.animationDelay = `${Math.min(index * 55, 280)}ms`;

  const header = document.createElement('div');
  header.className = 'day-header';

  const title = document.createElement('div');
  title.className = 'day-title';

  const date = document.createElement('span');
  date.className = 'day-date';
  date.textContent = formatDay(group.date);

  const weekday = document.createElement('span');
  weekday.className = 'day-weekday';
  weekday.textContent = weekdayFormatter.format(group.date);

  title.append(date, weekday);

  const cityCounts = new Map();

  for (const item of group.items) {
    if (item.city) {
      cityCounts.set(item.city, (cityCounts.get(item.city) || 0) + 1);
    }
  }

  let mainCity = null;
  let mainCityCount = 0;

  for (const [city, cityCount] of cityCounts) {
    if (cityCount > mainCityCount) {
      mainCity = city;
      mainCityCount = cityCount;
    }
  }

  if (mainCity) {
    const location = document.createElement('span');
    location.className = 'day-location';
    location.textContent = `· ${formatCityName(mainCity)}`;
    title.append(location);
  }

  const count = document.createElement('span');
  count.className = 'day-count';
  count.textContent = `${group.items.length} 个项目`;

  header.append(title, count);

  const grid = document.createElement('div');
  grid.className = 'media-grid';

  for (const item of group.items) {
    grid.append(createMediaCard(item));
  }

  section.append(header, grid);
  return section;
}

function renderLibrary(data) {
  libraryData = data;
  allItems = Array.isArray(data.items) ? data.items : [];
  updateSource(data.source);

  if (!isFolderAvailable(activeFolder)) {
    activeFolder = 'all';
  }

  renderFolderNavigation(data);
  items = filterItems(activeFolder);
  updateSummary();
  renderGalleryItems();
}

function resetGalleryPaging() {
  if (galleryObserver) {
    galleryObserver.disconnect();
    galleryObserver = null;
  }

  gallerySentinel = null;
  galleryGroups = [];
  renderedGroupCount = 0;
}

function updateGallerySentinel() {
  if (!gallerySentinel) {
    return;
  }

  const remaining = galleryGroups.length - renderedGroupCount;
  const button = gallerySentinel.querySelector('button');

  if (remaining <= 0) {
    gallerySentinel.remove();
    gallerySentinel = null;

    if (galleryObserver) {
      galleryObserver.disconnect();
      galleryObserver = null;
    }

    return;
  }

  if (button) {
    button.textContent = `加载更多（还剩 ${remaining} 天）`;
  }
}

function appendGalleryGroups(count = GALLERY_GROUP_BATCH) {
  if (!galleryGroups.length || renderedGroupCount >= galleryGroups.length) {
    return;
  }

  const nextEnd = Math.min(
    galleryGroups.length,
    renderedGroupCount + count
  );

  if (nextEnd <= renderedGroupCount) {
    return;
  }

  const fragment = document.createDocumentFragment();

  for (let index = renderedGroupCount; index < nextEnd; index += 1) {
    fragment.append(createDayGroup(galleryGroups[index], index));
  }

  renderedGroupCount = nextEnd;

  if (gallerySentinel?.isConnected) {
    gallery.insertBefore(fragment, gallerySentinel);
  } else {
    gallery.append(fragment);
  }

  updateGallerySentinel();
}

function observeGallerySentinel() {
  if (!gallerySentinel || !('IntersectionObserver' in window)) {
    return;
  }

  galleryObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        appendGalleryGroups();
      }
    },
    { rootMargin: '1200px 0px' }
  );

  galleryObserver.observe(gallerySentinel);
}

function renderGalleryItems() {
  resetGalleryPaging();
  gallery.replaceChildren();

  if (!items.length) {
    renderEmptyState();
    return;
  }

  galleryGroups = groupItemsByDay(items);
  renderedGroupCount = 0;

  gallerySentinel = document.createElement('div');
  gallerySentinel.className = 'gallery-sentinel';

  const moreButton = document.createElement('button');
  moreButton.type = 'button';
  moreButton.textContent = '加载更多照片';
  moreButton.addEventListener('click', () => {
    appendGalleryGroups();
  });
  gallerySentinel.append(moreButton);
  gallery.append(gallerySentinel);

  appendGalleryGroups(INITIAL_GALLERY_GROUPS);
  observeGallerySentinel();

  gallery.dataset.state = 'ready';
  gallery.setAttribute('aria-busy', 'false');
}

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

function renderEmptyState() {
  resetGalleryPaging();
  const hasAnyItems = allItems.length > 0;
  const card = hasAnyItems
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

  gallery.replaceChildren(card);
  gallery.dataset.state = 'ready';
  gallery.setAttribute('aria-busy', 'false');
}

function renderErrorState() {
  resetGalleryPaging();
  const card = createStateCard({
    icon: '<span aria-hidden="true">!</span>',
    title: '相册读取失败',
    description:
      '请确认照片文件夹仍然存在，<br>或者重新选择一个文件夹。',
    buttonLabel: '重新选择文件夹',
    onAction: chooseFolder,
  });

  gallery.replaceChildren(card);
  gallery.dataset.state = 'error';
  gallery.setAttribute('aria-busy', 'false');
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

function preloadNeighbors() {
  for (const offset of [-1, 1]) {
    const item = items[currentIndex + offset];

    if (item && item.type === 'image' && item.previewUrl) {
      const image = new Image();
      image.src = item.previewUrl;
    }
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
  showSpinner('正在加载照片…');
  resetZoom();

  const image = document.createElement('img');
  image.className = 'viewer-image';
  image.alt = item.name;
  image.draggable = false;
  let usedFallback = false;
  let allowPreviewFallback = BROWSER_NATIVE_IMAGE_EXTENSIONS.has(
    item.extension
  );

  image.addEventListener('load', () => {
    if (renderToken !== viewerRenderToken) {
      return;
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
      showSpinner('正在加载预览图…');
      image.src = item.previewUrl;
      return;
    }

    if (!usedFallback && item.thumbUrl) {
      usedFallback = true;
      showSpinner('正在加载缩略图…');
      image.src = item.thumbUrl;
      return;
    }

    showViewerError('这张图片暂时无法显示');
  });

  image.src = BROWSER_NATIVE_IMAGE_EXTENSIONS.has(item.extension)
    ? item.fileUrl
    : (item.previewUrl || item.fileUrl);
  viewerMedia.append(image);
  applyTransform();
}

function renderVideoInViewer(item, renderToken) {
  showSpinner('正在准备视频，首次播放可能需要十几秒…');
  resetZoom();

  const video = document.createElement('video');
  video.className = 'viewer-video';
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', item.name);

  const finishLoading = () => {
    if (renderToken === viewerRenderToken) {
      hideSpinner();
    }
  };

  video.addEventListener('loadeddata', finishLoading, { once: true });
  video.addEventListener('canplay', finishLoading, { once: true });
  video.addEventListener('error', () => {
    if (renderToken !== viewerRenderToken) {
      return;
    }

    stopVideo();
    showViewerError('这个视频暂时无法在应用内播放');
  });

  video.src = item.videoUrl || item.fileUrl;
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
  viewerMedia.replaceChildren();
  viewerMedia.classList.remove('is-dragging');
  viewerZoom.hidden = true;

  viewerCounter.textContent = `${currentIndex + 1} / ${items.length}`;
  viewerFilename.textContent = item.name;
  viewerOpenOriginal.textContent =
    item.type === 'video' ? 'PotPlayer' : '原图';
  viewerOpenOriginal.title =
    item.type === 'video'
      ? '用 PotPlayer 打开原视频'
      : '用系统照片打开原图';

  const dateText = formatViewerDate(item.takenAt);
  viewerDate.textContent =
    item.type === 'video' && item.duration
      ? `${dateText} · ${formatDuration(item.duration)}`
      : dateText;

  viewerPrev.disabled = currentIndex === 0;
  viewerNext.disabled = currentIndex === items.length - 1;
  viewerPrev.hidden = items.length < 2;
  viewerNext.hidden = items.length < 2;

  if (item.type === 'video') {
    viewerHintDesktop.textContent = '← → 切换 · Esc 关闭';
    viewerHintTouch.textContent = '左右滑动切换';
    renderVideoInViewer(item, renderToken);
  } else {
    viewerHintDesktop.textContent = '滚轮缩放 · 双击放大 · ← → 切换 · Esc 关闭';
    viewerHintTouch.textContent = '双击放大 · 左右滑动切换';
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
  const sections = [
    createDetailSection('文件', [
      ['文件名', item.name],
      ['格式', `${item.extension} · ${item.mime}`],
      ['大小', formatBytes(item.size)],
      ['分辨率', item.width && item.height ? `${item.width} × ${item.height}` : '未读取到'],
      ...(isVideo
        ? [
            ['时长', item.duration ? formatDuration(item.duration) : '未读取到'],
            ['视频编码', formatCodec(item.videoCodec)],
          ]
        : []),
    ]),
    createDetailSection('时间', [
      ['拍摄时间', formatDetailDate(item.takenAt)],
      ['修改时间', formatDetailDate(item.modifiedAt)],
      ['时间来源', formatDateSource(item.dateSource)],
    ]),
  ];

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

  detailsSubtitle.textContent = `${isVideo ? '视频' : '照片'} · ${item.extension}`;
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

function openViewer(itemId) {
  const index = items.findIndex((item) => item.id === itemId);

  if (index < 0) {
    return;
  }

  lastFocusedElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const shouldFocusClose =
    lastFocusedElement?.matches?.(':focus-visible') || false;
  currentIndex = index;

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
}

function closeViewer() {
  if (!isViewerOpen()) {
    return;
  }

  closeDetails({ restoreFocus: false, resumeVideo: false });
  stopVideo();
  viewerRenderToken += 1;
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('viewer-open');
  viewerMedia.replaceChildren();
  viewerSpinner.hidden = true;
  currentIndex = -1;
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

  const nextIndex = currentIndex + direction;

  if (nextIndex < 0 || nextIndex >= items.length) {
    return;
  }

  currentIndex = nextIndex;
  renderViewerItem();
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

function setScanning(isScanning, message = '正在扫描照片文件夹…') {
  scanText.textContent = message;
  scanOverlay.hidden = !isScanning;

  if (isScanning) {
    scanCancelButton.disabled = false;
    scanCancelButton.textContent = '停止加载';
  }
}

function stopScanning() {
  scanWasCanceled = true;
  scanCancelButton.disabled = true;
  scanCancelButton.textContent = '正在停止…';

  if (scanController) {
    scanController.abort();
  }

  scanOverlay.hidden = true;

  fetch('/api/scan/cancel', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  }).catch(() => {
    // 前端已经停止等待，取消接口失败不影响界面恢复。
  });
}

function renderStoppedState() {
  const card = createStateCard({
    icon: '<span aria-hidden="true">■</span>',
    title: '已停止加载',
    description:
      '扫描已经停止，当前文件夹没有加载完成。<br>可以继续加载，或者换一个文件夹。',
    buttonLabel: '继续加载',
    onAction: () => loadLibrary({ force: true }),
  });

  gallery.replaceChildren(card);
  gallery.dataset.state = 'ready';
  gallery.setAttribute('aria-busy', 'false');
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

async function loadLibrary({ force = false } = {}) {
  if (isLoading) {
    return;
  }

  isLoading = true;
  let loadSucceeded = false;
  const hadContent = gallery.dataset.state === 'ready';
  scanWasCanceled = false;
  scanController = new AbortController();

  refreshButton.disabled = true;
  refreshButton.classList.add('is-spinning');
  gallery.setAttribute('aria-busy', 'true');
  syncCacheButton();

  if (hadContent) {
    // 刷新时保留旧图库，用户可以继续浏览和打开图片。
    gallery.classList.add('is-refreshing');
  } else {
    setScanning(
      true,
      force ? '正在刷新照片文件夹…' : '正在扫描照片文件夹…'
    );
    renderSkeleton();
  }

  try {
    const response = await fetch(
      force ? '/api/photos?refresh=1' : '/api/photos',
      {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: scanController.signal,
      }
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    renderLibrary(data);
    loadSucceeded = true;

    if (pendingPhotoId) {
      const requestedItem = allItems.find(
        (item) => item.id === pendingPhotoId
      );
      pendingPhotoId = null;
      window.history.replaceState({}, '', window.location.pathname);

      if (requestedItem) {
        if (!items.includes(requestedItem)) {
          activeFolder = 'all';
          items = filterItems('all');
          updateFolderSelection();
          renderGalleryItems();
          updateSummary();
        }

        openViewer(requestedItem.id);
      } else {
        showToast('没有找到这张照片');
      }
    }

    if (force) {
      showToast('已重新扫描照片文件夹');
    }
  } catch (error) {
    const wasAborted =
      error.name === 'AbortError' || scanWasCanceled;

    if (wasAborted) {
      if (!hadContent) {
        summary.textContent = '已停止加载';
        renderStoppedState();
      }

      showToast('已停止加载');
    } else {
      console.error(error);

      if (hadContent) {
        showToast(error.message || '刷新失败，请稍后重试');
      } else {
        summary.textContent = '读取相册失败';
        renderErrorState();
      }
    }
  } finally {
    isLoading = false;
    scanController = null;
    scanWasCanceled = false;
    gallery.classList.remove('is-refreshing');
    gallery.setAttribute('aria-busy', 'false');
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-spinning');
    setScanning(false);
    syncCacheButton();
  }

  return loadSucceeded;
}

refreshButton.addEventListener('click', () => {
  loadLibrary({ force: true });
});

chooseFolderButton.addEventListener('click', chooseFolder);
topbarFolderButton.addEventListener('click', chooseFolder);
scanCancelButton.addEventListener('click', stopScanning);
clearCacheButton.addEventListener('click', openCacheConfirm);
for (const button of openModeButtons) {
  button.addEventListener('click', () => {
    setOpenMode(button.dataset.openMode);
  });
}
cacheConfirmButton.addEventListener('click', clearCacheNow);
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
