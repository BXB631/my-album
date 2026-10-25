// 2.0 照片墙流式加载（参考 Lap 的加载模式）
//
// 和 1.11 的区别：
//   1.11：GET /api/photos 拿回整份图库 JSON → 渲染前 3 天 → 滚动时再追加 3 天。
//   2.0 ：summary 先到（总格子数 / 扫描进度）→ 立刻铺占位格 →
//          只渲染可视块的 DOM → 只请求可视块的数据 → 缩略图按优先级排队取。
//
// 四层渐进：
//   [数据] 分块（chunk）按需拉取，滚到哪取到哪
//   [DOM]  只渲染可视区附近的块，上下用撑高的占位块保持滚动条长度
//   [图片] 可视区内的缩略图按"离视口中心近"的优先级、4 并发 4 张一批地取
//   [扫描] 扫描期列表继续增长，前端跟着铺格子（不用等扫完）

(function () {
  'use strict';

  const GAP = 8;
  const NARROW_WIDTH = 720;
  const MIN_CELL_WIDE = 145;
  const MIN_CELL_NARROW = 104;
  const ROW_BUFFER = 3;
  // 表头高度只是个初值：第一次渲染后会用实测值校准（见 calibrate）。
  const DAY_HEADER_HEIGHT = 62;
  const DAY_BLOCK_GAP = 30;
  const SCAN_ROWS_PER_BLOCK = 6;
  const CHUNK_MIN = 64;
  const CHUNK_MAX = 256;
  const THUMB_CONCURRENCY = 4;
  const THUMB_BATCH = 4;
  const THUMB_PREFETCH_ROWS = 1;
  // 格子元素池的上限（大约一屏半）：超过就按放入顺序淘汰
  const NODE_POOL_LIMIT = 400;
  const SCAN_POLL_INTERVAL = 400;

  // ---------------------------------------------------------------------
  // 纯几何：不碰 DOM，方便单测（见 tools/test-stream-geometry.js）
  // ---------------------------------------------------------------------

  function computeMetrics(width, viewportWidth) {
    const narrow = viewportWidth < NARROW_WIDTH;
    const minCell = narrow ? MIN_CELL_NARROW : MIN_CELL_WIDE;
    const columns = Math.max(1, Math.floor((width + GAP) / (minCell + GAP)));
    const cell = (width - GAP * (columns - 1)) / columns;
    const rowHeight = cell + GAP;

    return { columns, cell, rowHeight };
  }

  // blocks 是渲染与定位的最小单位：
  //   扫描期 = 若干行的占位块；完成后 = 一天（表头 + 该天的行）
  //
  // 注意：扫描期**不做**按日期分组（扫完才分成一天一组）。
  // 边扫边分组需要每轮重算分段、还要改已经铺好的块，实测会让加载"有点发涩"，
  // 所以这里扫描期一律走"固定大小占位块"这条最短路径。
  //
  // 高度模型（必须和 CSS 完全对齐，否则滚动条会漂移）：
  //   grid 的自然高度 = rows × 行高 − gap      （最后一行没有行间距）
  //   扫描块 = grid 自然高度 + gap（块的 padding-bottom 补回行间距）
  //   日期块 = 表头 + grid 自然高度 + 天间距（块的 padding-bottom）
  function buildBlocks({
    days,
    total,
    columns,
    rowHeight,
    headerHeight = DAY_HEADER_HEIGHT,
    blockGap = DAY_BLOCK_GAP,
  }) {
    const blocks = [];
    const itemsPerScanBlock = Math.max(1, SCAN_ROWS_PER_BLOCK * columns);

    // 还没有分组信息（扫描期，或 days 还没到）时就是整段占位块
    if (!days.length) {
      for (let start = 0; start < total; start += itemsPerScanBlock) {
        const itemCount = Math.min(itemsPerScanBlock, total - start);
        const rows = Math.ceil(itemCount / columns);

        blocks.push({
          kind: 'scan',
          itemStart: start,
          itemCount,
          rows,
          height: rows * rowHeight,
        });
      }

      return blocks;
    }

    for (const day of days) {
      const rows = Math.ceil(day.count / columns);

      blocks.push({
        kind: 'day',
        key: day.key,
        city: day.city,
        count: day.count,
        itemStart: day.itemStart,
        itemCount: day.count,
        rows,
        height: headerHeight + rows * rowHeight - GAP + blockGap,
      });
    }

    return blocks;
  }

  function blockTops(blocks) {
    const tops = new Array(blocks.length + 1);
    tops[0] = 0;

    for (let index = 0; index < blocks.length; index += 1) {
      tops[index + 1] = tops[index] + blocks[index].height;
    }

    return tops;
  }

  // 找出与 [from, to) 相交的块区间。
  // 窗口落在内容之外时（例如重扫期间内容变短）贴到最近的块，
  // 保证任何滚动位置都至少有一个块可渲染，不会出现整屏空白。
  function findWindow(tops, blocks, from, to) {
    if (!blocks.length) {
      return { start: 0, end: 0 };
    }

    let low = 0;
    let high = blocks.length;

    while (low < high) {
      const mid = (low + high) >> 1;

      if (tops[mid + 1] > from) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    const start = Math.min(low, blocks.length - 1);
    let end = start;

    while (end < blocks.length && tops[end] < to) {
      end += 1;
    }

    return { start, end: Math.max(end, start + 1) };
  }

  // 把 [start,end) 对齐到固定大小的数据块，避免滚动时反复请求同一段
  function chunkRange(start, end, chunkSize) {
    const first = Math.floor(start / chunkSize);
    const last = Math.floor((Math.max(end, start + 1) - 1) / chunkSize);

    return { first, last };
  }

  const geometry = {
    computeMetrics,
    buildBlocks,
    blockTops,
    findWindow,
    chunkRange,
    constants: {
      GAP,
      NARROW_WIDTH,
      MIN_CELL_WIDE,
      MIN_CELL_NARROW,
      ROW_BUFFER,
      DAY_HEADER_HEIGHT,
      DAY_BLOCK_GAP,
      SCAN_ROWS_PER_BLOCK,
    },
  };

  // ---------------------------------------------------------------------
  // 控制器
  // ---------------------------------------------------------------------

  function createPhotoStream(config) {
    const gallery = config.gallery;
    const renderCard = config.renderCard;
    // 条目指纹（可选）：卡片上记的指纹和最新条目不一致时，那一格重建
    const itemKey = config.itemKey || ((item) => (item ? item.id : ''));
    const renderDayHeader = config.renderDayHeader;
    const fetchJson = config.fetchJson;
    const onStateChange = config.onStateChange || function () {};
    const onBeforeFirstLoad = config.onBeforeFirstLoad || function () {};
    const renderEmptyState =
      config.renderEmptyState ||
      function () {
        return document.createTextNode('');
      };
    const renderErrorState =
      config.renderErrorState ||
      function () {
        return document.createTextNode('');
      };

    // 占位 / 内容 / 占位：中间只放可视块，上下用高度撑住滚动条
    const topSpacer = document.createElement('div');
    topSpacer.className = 'stream-spacer';
    const middle = document.createElement('div');
    middle.className = 'stream-window';

    // 已经渲染出来的块：blockIndex -> { el, kind, itemStart, itemCount }
    // 复用这些 DOM 是流畅性的关键：滚动换块时只增删进出窗口的块，
    // 不再整窗口重建（重建会让所有图片重新解码，肉眼看到的就是"疯狂闪烁"）。
    const renderedBlocks = new Map();
    // 离开视口 / 被裁掉的格子元素先放这里：同一个格子再用到时原样搬回去，
    // <img> 节点身份不变，浏览器就不会重新请求和解码（扫描期不闪、不卡的关键）。
    const nodePool = new Map();
    const bottomSpacer = document.createElement('div');
    bottomSpacer.className = 'stream-spacer';

    let pollTimer = null;
    let renderFrame = null;
    let generation = 0;
    let destroyed = false;

    const state = {
      filter: 'all',
      revision: -1,
      phase: 'idle',
      grouped: false,
      total: 0,
      filled: 0,
      imageCount: 0,
      videoCount: 0,
      scanning: false,
      items: [],
      days: [],
      folders: null,
      foldersToken: null,
      uncategorizedCount: 0,
      libraryTotal: 0,
      layoutKey: '',
      uiKey: '',
      blocks: [],
      tops: [0],
      chunks: new Map(),
      thumbDone: new Set(),
      loaded: new Map(),
      chunkSize: CHUNK_MIN,
      metrics: { columns: 1, cell: 0, rowHeight: 0 },
      measuredWidth: -1,
      headerHeight: DAY_HEADER_HEIGHT,
      blockGap: DAY_BLOCK_GAP,
      window: { start: 0, end: 0 },
      renderedKey: '',
      fromIndex: false,
      error: null,
      source: null,
    };

    const thumbQueue = new Map();
    let thumbActive = 0;

    // 画廊在文档里的纵向位置。滚动时每帧都读 getBoundingClientRect 会强制重排
    // （因为同一帧里还要写占位块高度，读写交替 = 布局抖动），所以缓存起来：
    // 只有窗口尺寸变化、状态变化或超过 1 秒才重新测一次。
    let galleryDocumentTop = 0;
    let galleryTopMeasuredAt = 0;

    function invalidateGalleryTop() {
      galleryTopMeasuredAt = 0;
    }

    function getGalleryDocumentTop() {
      const now = Date.now();

      if (now - galleryTopMeasuredAt > 1000) {
        galleryDocumentTop =
          gallery.getBoundingClientRect().top + window.scrollY;
        galleryTopMeasuredAt = now;
      }

      return galleryDocumentTop;
    }

    // -----------------------------------------------------------------
    // 取数
    // -----------------------------------------------------------------

    function query(path, extra) {
      const params = new URLSearchParams();

      params.set('folder', state.filter);

      if (extra) {
        for (const [key, value] of Object.entries(extra)) {
          if (value !== undefined && value !== null && value !== '') {
            params.set(key, String(value));
          }
        }
      }

      return fetchJson(`${path}?${params.toString()}`);
    }

    function mergeItems(offset, items) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        if (item) {
          state.items[offset + index] = item;
          state.loaded.set(item.id, item);
        }
      }
    }

    async function loadChunk(chunkIndex) {
      const key = `${state.revision}:${state.filter}:${chunkIndex}`;

      if (state.chunks.get(key)) {
        return;
      }

      state.chunks.set(key, 'loading');

      const offset = chunkIndex * state.chunkSize;

      if (offset >= state.total) {
        state.chunks.set(key, 'ready');
        return;
      }

      const limit = Math.min(state.chunkSize, state.total - offset);
      const revision = state.revision;

      try {
        const data = await query('/api/library/items', {
          offset,
          limit,
        });

        // 期间可能已经刷新 / 换文件夹，过期结果直接丢
        if (destroyed || Number(data?.revision) !== revision) {
          return;
        }

        mergeItems(offset, data?.items || []);
        state.chunks.set(key, 'ready');
        scheduleRender();
      } catch {
        state.chunks.set(key, 'failed');
      }
    }

    function ensureChunks(start, end) {
      const { first, last } = chunkRange(start, end, state.chunkSize);

      for (let index = first; index <= last; index += 1) {
        if (index * state.chunkSize < state.total) {
          loadChunk(index);
        }
      }
    }

    function resetData() {
      state.items = [];
      state.days = [];
      state.folders = null;
      state.foldersToken = null;
      state.uncategorizedCount = 0;
      state.libraryTotal = 0;
      state.layoutKey = '';
      state.uiKey = '';
      state.blocks = [];
      state.tops = [0];
      state.chunks = new Map();
      state.thumbDone = new Set();
      state.renderedKey = '';
      renderedBlocks.clear();
      clearNodePool();
      middle.replaceChildren();
      cancelThumbWork();
    }

    function clearNodePool() {
      for (const node of nodePool.values()) {
        node.__teardown?.();
        node.remove();
      }

      nodePool.clear();
    }

    // -----------------------------------------------------------------
    // 缩略图调度：按"离视口中心近"排序，4 并发、每批 4 张；滚走的排队任务直接丢
    // -----------------------------------------------------------------

    function cancelThumbWork() {
      for (const task of thumbQueue.values()) {
        task.cancelled = true;
      }

      thumbQueue.clear();
    }

    function enqueueThumb(index, card, priority) {
      const item = state.items[index];

      if (!item) {
        return;
      }

      const image = card.querySelector('img');

      if (!image) {
        return;
      }

      if (state.thumbDone.has(item.id)) {
        // 已经加载过：直接给地址，浏览器缓存命中，不再排队
        if (!image.getAttribute('src')) {
          image.src = item.thumbUrl;
        }
        return;
      }

      const existing = thumbQueue.get(item.id);

      if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return;
      }

      thumbQueue.set(item.id, {
        id: item.id,
        image,
        url: item.thumbUrl,
        priority,
        cancelled: false,
        running: false,
      });
    }

    function pumpThumbs() {
      if (destroyed) {
        return;
      }

      while (thumbActive < THUMB_CONCURRENCY) {
        const batch = [...thumbQueue.values()]
          .filter((task) => !task.cancelled && !task.running)
          .sort((a, b) => a.priority - b.priority)
          .slice(0, THUMB_BATCH);

        if (!batch.length) {
          return;
        }

        thumbActive += 1;

        for (const task of batch) {
          task.running = true;
        }

        Promise.all(
          batch.map(
            (task) =>
              new Promise((resolve) => {
                const { image } = task;

                if (!image.isConnected) {
                  resolve();
                  return;
                }

                const finish = () => {
                  state.thumbDone.add(task.id);
                  resolve();
                };

                image.addEventListener('load', finish, { once: true });
                image.addEventListener('error', finish, { once: true });
                image.src = task.url;
              })
          )
        ).finally(() => {
          thumbActive -= 1;

          for (const task of batch) {
            if (thumbQueue.get(task.id) === task) {
              thumbQueue.delete(task.id);
            }
          }

          pumpThumbs();
        });
      }
    }

    function scheduleThumbs(itemStart, itemEnd) {
      cancelThumbWork();

      const center = (itemStart + itemEnd) / 2;
      const perRow = Math.max(1, state.metrics.columns);
      const prefetch = THUMB_PREFETCH_ROWS * perRow;
      const from = itemStart - prefetch;
      const to = itemEnd + prefetch;

      for (const card of middle.querySelectorAll('[data-stream-index]')) {
        const index = Number(card.dataset.streamIndex);

        if (index < from || index > to) {
          continue;
        }

        enqueueThumb(index, card, Math.abs(index - center) / perRow);
      }

      pumpThumbs();
    }

    // -----------------------------------------------------------------
    // 布局与渲染
    // -----------------------------------------------------------------

    // 只有宽度真的变了才重算布局。
    // 页面滚动条出现/消失会让可用宽度变化几像素，如果每次都重建布局并回滚位置，
    // 滚动时就会出现"一进一出"的来回跳动。
    function measure() {
      const width = gallery.clientWidth || window.innerWidth;

      if (Math.abs(width - state.measuredWidth) < 1) {
        return false;
      }

      state.measuredWidth = width;
      state.metrics = computeMetrics(width, window.innerWidth);

      const visibleItems = Math.ceil(
        (window.innerHeight / Math.max(1, state.metrics.rowHeight)) *
          state.metrics.columns
      );

      state.chunkSize = Math.max(
        CHUNK_MIN,
        Math.min(CHUNK_MAX, visibleItems)
      );

      return true;
    }

    function rebuildLayout() {
      state.blocks = buildBlocks({
        days: state.days,
        total: state.total,
        columns: state.metrics.columns,
        rowHeight: state.metrics.rowHeight,
        headerHeight: state.headerHeight,
        blockGap: state.blockGap,
      });
      state.tops = blockTops(state.blocks);
    }

    // 首帧之后用真实渲染结果校准：
    // 卡片高度（决定行高）和日期表头高度都按实测值来，避免累积误差。
    function calibrate() {
      let changed = false;
      const card = middle.querySelector('.media-card');

      if (card) {
        const height = card.getBoundingClientRect().height;

        if (height > 1) {
          const measured = height + GAP;

          if (Math.abs(measured - state.metrics.rowHeight) > 0.5) {
            state.metrics = {
              ...state.metrics,
              cell: height,
              rowHeight: measured,
            };
            changed = true;
          }
        }
      }

      const header = middle.querySelector('.day-header');

      if (header) {
        const rect = header.getBoundingClientRect();
        const style = window.getComputedStyle(header);
        const measured =
          rect.height + (Number.parseFloat(style.marginBottom) || 0);

        if (measured > 1 && Math.abs(measured - state.headerHeight) > 0.5) {
          state.headerHeight = measured;
          changed = true;
        }
      }

      return changed;
    }

    function createPlaceholder() {
      const placeholder = document.createElement('div');
      placeholder.className = 'media-card stream-placeholder';
      placeholder.innerHTML = '<span class="thumb-shimmer"></span>';
      return placeholder;
    }

    function nodeForIndex(index) {
      const item = state.items[index];
      const pooled = nodePool.get(index);

      if (pooled) {
        nodePool.delete(index);

        // 卡片自己挂的收尾钩子（实况照片的悬停预览视频等）：
        // 节点要么被换掉、要么被搬去别的项目，先把这些临时资源收掉。
        pooled.__teardown?.();

        const pooledIsPlaceholder = pooled.classList.contains(
          'stream-placeholder'
        );
        // 池子里的卡片可能存的是"扫描期的条目快照"（比如实况照片那时还没有伴随视频信息），
        // 指纹对不上就不能复用，否则那张卡片会一直按旧快照行事（悬停预览会白白转码）。
        const staleCard =
          !pooledIsPlaceholder && item && pooled.__itemKey !== itemKey(item);

        // 同一个格子的元素直接搬回来复用：<img> 还是原来那个节点，
        // 浏览器不会重新请求/重新解码，所以扫描期和来回滚动都不会闪。
        if (!staleCard && Boolean(item) === pooledIsPlaceholder) {
          return pooled;
        }

        pooled.remove();
      }

      if (!item) {
        return createPlaceholder();
      }

      const card = renderCard(item, { deferThumbnail: true });
      card.dataset.streamIndex = String(index);
      return card;
    }

    function stashNode(node, index) {
      if (!node || nodePool.get(index) === node) {
        return;
      }

      node.__teardown?.();
      nodePool.set(index, node);

      while (nodePool.size > NODE_POOL_LIMIT) {
        const oldest = nodePool.keys().next().value;
        const dropped = nodePool.get(oldest);
        nodePool.delete(oldest);
        dropped.remove();
      }
    }

    // 块离开视口时把格子先放回池子（而不是销毁），滚回来还能接着用
    function stashBlockNodes(entry) {
      const grid = entry.el.querySelector('.stream-grid');

      if (!grid) {
        return;
      }

      const children = [...grid.children];

      for (let offset = 0; offset < children.length; offset += 1) {
        stashNode(children[offset], entry.itemStart + offset);
      }
    }

    // 列数会变（改窗口大小、侧栏出现/消失、最大化、DevTools 停靠……），
    // 但已经渲染出来的块**不会**因为列数变化就重建 —— 重建会让整块图片重新解码、肉眼看到闪烁。
    // 所以"当前列数"必须显式写回每一个还在屏幕上的网格：
    // 漏了这一步，宽度变过之后格子会一直停在旧列数上（一行 8 张变成一行 5 张大格子）。
    function applyGridColumns(grid) {
      const columns = state.metrics.columns;

      if (grid.__columns === columns) {
        return;
      }

      grid.__columns = columns;
      grid.style.gap = `${GAP}px`;
      grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    }

    function renderBlock(block) {
      const section = document.createElement('section');
      section.className = 'stream-block';

      if (block.kind === 'day') {
        section.classList.add('is-day');
        section.append(
          renderDayHeader({
            key: block.key,
            city: block.city,
            count: block.count,
          })
        );
      } else {
        section.classList.add('is-scan');
      }

      const grid = document.createElement('div');
      grid.className = 'media-grid stream-grid';
      applyGridColumns(grid);

      const fragment = document.createDocumentFragment();

      for (let offset = 0; offset < block.itemCount; offset += 1) {
        fragment.append(nodeForIndex(block.itemStart + offset));
      }

      grid.append(fragment);
      section.append(grid);

      return section;
    }

    function currentWindow() {
      const relative = window.scrollY - getGalleryDocumentTop();
      const buffer = ROW_BUFFER * state.metrics.rowHeight;

      return findWindow(
        state.tops,
        state.blocks,
        relative - buffer,
        relative + window.innerHeight + buffer
      );
    }

    function clearRenderedBlocks() {
      renderedBlocks.clear();
      clearNodePool();
      middle.replaceChildren();
    }

    // 升序遍历，所以插入时只要找"后面第一个已经存在的块"当锚点
    // （块按 itemStart 认身份：中间插入/删除块时，后面的块不会因此被重建）
    function insertBlockInOrder(el, block) {
      let candidate = null;

      for (const entry of renderedBlocks.values()) {
        if (
          entry.itemStart > block.itemStart &&
          (!candidate || entry.itemStart < candidate.itemStart)
        ) {
          candidate = entry;
        }
      }

      if (candidate) {
        middle.insertBefore(el, candidate.el);
        return;
      }

      middle.append(el);
    }

    // 只补差异：同一个 itemStart 的块一律原地改
    // （换表头 / 加减格子 / 占位↔卡片互换），绝不重建整块 ——
    // 重建会让块里的图片重新解码，肉眼看到的就是闪烁，也拖慢加载。
    function patchBlock(entry, block) {
      if (entry.itemStart !== block.itemStart) {
        const replacement = renderBlock(block);
        entry.el.replaceWith(replacement);
        entry.el = replacement;
      } else {
        const section = entry.el;
        const sameHeader =
          entry.kind === block.kind &&
          entry.key === block.key &&
          entry.count === block.count;

        if (block.kind === 'day') {
          section.classList.add('is-day');
          section.classList.remove('is-scan');

          if (!sameHeader) {
            const header = renderDayHeader({
              key: block.key,
              city: block.city,
              count: block.count,
            });
            const existing = section.querySelector('.day-header');

            if (existing) {
              existing.replaceWith(header);
            } else {
              section.prepend(header);
            }
          }
        } else if (entry.kind === 'day') {
          section.classList.remove('is-day');
          section.classList.add('is-scan');
          section.querySelector('.day-header')?.remove();
        }

        const grid = section.querySelector('.stream-grid');

        if (grid) {
          // 列数变了也要跟上来（同一个块是原地打补丁的，不会重建）
          applyGridColumns(grid);

          // 多了砍尾巴、少了补格子：扫描期尾巴一直在变，这里不能整块重建。
          // 砍下来的格子先进池子，同一格稍后要用（分组细化会把它们搬去别的块）。
          while (grid.children.length > block.itemCount) {
            const node = grid.lastElementChild;
            stashNode(node, block.itemStart + grid.children.length - 1);
            node.remove();
          }

          for (
            let offset = grid.children.length;
            offset < block.itemCount;
            offset += 1
          ) {
            grid.append(nodeForIndex(block.itemStart + offset));
          }

          for (let offset = 0; offset < block.itemCount; offset += 1) {
            const node = grid.children[offset];

            if (!node) {
              continue;
            }

            const index = block.itemStart + offset;
            const item = state.items[index];
            const isPlaceholder = node.classList.contains(
              'stream-placeholder'
            );

            if (item && isPlaceholder) {
              node.replaceWith(nodeForIndex(index));
            } else if (!item && !isPlaceholder) {
              // 卡片退回占位（重排/刷新）：卡片先进池子，别直接销毁
              stashNode(node, index);
              node.replaceWith(createPlaceholder());
            } else if (
              item &&
              (node.dataset.streamIndex !== String(index) ||
                node.__itemKey !== itemKey(item))
            ) {
              // 换条目、或者同一个条目的关键信息变了（实况照片补上伴随视频信息、
              // 视频拿到时长/编码）：这一格重建一次，别让卡片一直用旧快照
              node.replaceWith(nodeForIndex(index));
            }
          }
        }
      }

      entry.kind = block.kind;
      entry.itemStart = block.itemStart;
      entry.itemCount = block.itemCount;
      entry.key = block.key;
      entry.count = block.count;
    }

    function syncRenderedBlocks(windowRange) {
      const wanted = new Map();

      for (let index = windowRange.start; index < windowRange.end; index += 1) {
        const block = state.blocks[index];

        if (block) {
          wanted.set(block.itemStart, block);
        }
      }

      for (const [key, entry] of [...renderedBlocks]) {
        if (!wanted.has(key)) {
          stashBlockNodes(entry);
          entry.el.remove();
          renderedBlocks.delete(key);
        }
      }

      for (const [key, block] of wanted) {
        const entry = renderedBlocks.get(key);

        if (entry) {
          patchBlock(entry, block);
          continue;
        }

        const el = renderBlock(block);
        insertBlockInOrder(el, block);
        renderedBlocks.set(key, {
          el,
          kind: block.kind,
          itemStart: block.itemStart,
          itemCount: block.itemCount,
          key: block.key,
          count: block.count,
        });
      }
    }

    function renderNow() {
      if (destroyed) {
        return;
      }

      const stateKey = [
        state.revision,
        state.filter,
        state.metrics.columns,
        state.error || '',
        state.phase,
      ].join(':');

      if (state.error) {
        if (state.renderedKey !== `error:${stateKey}`) {
          state.renderedKey = `error:${stateKey}`;
          topSpacer.style.height = '0px';
          bottomSpacer.style.height = '0px';
          clearRenderedBlocks();
          middle.append(renderErrorState(state.error));
        }
        return;
      }

      if (state.phase === 'ready' && !state.total) {
        if (state.renderedKey !== `empty:${stateKey}`) {
          state.renderedKey = `empty:${stateKey}`;
          topSpacer.style.height = '0px';
          bottomSpacer.style.height = '0px';
          clearRenderedBlocks();
          middle.append(renderEmptyState());
        }
        return;
      }

      if (!state.total || !state.blocks.length) {
        topSpacer.style.height = '0px';
        bottomSpacer.style.height = '0px';
        clearRenderedBlocks();
        state.window = { start: 0, end: 0 };
        state.renderedKey = '';
        return;
      }

      const windowRange = currentWindow();
      const firstBlock = state.blocks[windowRange.start];
      const lastBlock = state.blocks[windowRange.end - 1];
      const itemStart = firstBlock ? firstBlock.itemStart : 0;
      const itemEnd = lastBlock
        ? lastBlock.itemStart + lastBlock.itemCount
        : itemStart;

      ensureChunks(itemStart, itemEnd);

      state.window = windowRange;

      topSpacer.style.height = `${state.tops[windowRange.start]}px`;
      bottomSpacer.style.height = `${
        state.tops[state.blocks.length] - state.tops[windowRange.end]
      }px`;

      syncRenderedBlocks(windowRange);
      scheduleThumbs(itemStart, itemEnd);

      // 实测校准：首帧的预估高度和真实高度会差一点，
      // 用真实值重建一次布局，滚动条长度就和内容一致了。
      if (calibrate()) {
        rebuildLayout();
        scheduleRender();
      }
    }

    function scheduleRender() {
      if (renderFrame || destroyed) {
        return;
      }

      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        renderNow();
      });
    }

    // -----------------------------------------------------------------
    // 状态同步
    // -----------------------------------------------------------------

    function publish() {
      onStateChange({
        phase: state.phase,
        scanning: state.scanning,
        grouped: state.grouped,
        total: state.total,
        filled: state.filled,
        imageCount: state.imageCount,
        videoCount: state.videoCount,
        filter: state.filter,
        days: state.days.length,
        // 扫描期不做按日期分组（扫完才分成一天一组）
        partialDays: false,
        revision: state.revision,
        fromIndex: state.fromIndex,
        error: state.error,
        source: state.source,
        folders: state.folders,
        foldersToken: state.foldersToken,
        uncategorizedCount: state.uncategorizedCount,
        libraryTotal: state.libraryTotal,
      });
    }

    function anchorIdAtTop() {
      const block = state.blocks[state.window.start];

      if (!block) {
        return null;
      }

      for (
        let index = block.itemStart;
        index < block.itemStart + block.itemCount;
        index += 1
      ) {
        const item = state.items[index];

        if (item) {
          return item.id;
        }
      }

      return null;
    }

    // 扫描完成时顺序会从"发现顺序"变成"拍摄时间顺序"，
    // 用邻居接口把视口顶部那张照片找回来，尽量不跳位置。
    async function reanchor(anchorId) {
      if (!anchorId) {
        return;
      }

      try {
        const data = await query(
          `/api/library/neighbors/${encodeURIComponent(anchorId)}`
        );

        if (!data || typeof data.index !== 'number') {
          return;
        }

        const blockIndex = state.blocks.findIndex(
          (block) =>
            block.itemStart <= data.index &&
            data.index < block.itemStart + block.itemCount
        );

        if (blockIndex < 0) {
          return;
        }

        const block = state.blocks[blockIndex];
        const row = Math.floor(
          (data.index - block.itemStart) / Math.max(1, state.metrics.columns)
        );
        const offsetInBlock =
          (block.kind === 'day' ? state.headerHeight : 0) +
          row * state.metrics.rowHeight;

        window.scrollTo({
          top: Math.max(
            0,
            getGalleryDocumentTop() + state.tops[blockIndex] + offsetInBlock
          ),
        });
        scheduleRender();
      } catch {
        // 找不回来就保持原地，不值得打断用户
      }
    }

    // 精确的按天分组只在"扫描完成"之后取一次（扫描期不做日期分组）。
    // 扫描期 state.days 一直是空的，于是块布局走"固定占位块"那条最短路径。
    async function syncDays(data) {
      if (!data.grouped || state.days.length) {
        return false;
      }

      const daysData = await query('/api/library/days');
      state.days = daysData?.days || [];
      return true;
    }

    async function loadSummary() {
      const localGeneration = generation;
      const data = await query('/api/library/summary', {
        foldersToken: state.foldersToken,
      });

      if (destroyed || localGeneration !== generation || !data) {
        return null;
      }

      const previousRevision = state.revision;
      const nextRevision = Number(data.revision) || 0;
      const revisionChanged = nextRevision !== previousRevision;
      const wasGrouped = state.grouped;
      const anchor = !wasGrouped && data.grouped ? anchorIdAtTop() : null;

      state.phase = data.phase;
      state.scanning = Boolean(data.scanning);
      state.grouped = Boolean(data.grouped);
      state.revision = nextRevision;
      state.total = Number(data.total) || 0;
      state.filled = Number(data.filled) || 0;
      state.imageCount = Number(data.imageCount) || 0;
      state.videoCount = Number(data.videoCount) || 0;
      state.fromIndex = Boolean(data.fromIndex);
      state.error = data.error || null;
      state.source = data.source || state.source;

      // 年/月目录：扫描期服务端也会带（边扫边长），内容没变时字段缺省 = 保持现状
      if (Array.isArray(data.folders)) {
        state.folders = data.folders;
      }

      if (typeof data.foldersToken === 'string') {
        state.foldersToken = data.foldersToken;
      }

      if (data.uncategorizedCount !== undefined) {
        state.uncategorizedCount = Number(data.uncategorizedCount) || 0;
      }

      state.libraryTotal = Number(data.libraryTotal) || state.libraryTotal;

      if (revisionChanged) {
        // 顺序/内容变了（扫描完成会重排成按拍摄时间）：格子索引不再对得上，
        // 按天分组也要重新取（扫描期本来就是空的，这里主要是扫描完成那一次）。
        state.items = [];
        state.chunks = new Map();
        state.days = [];
        state.renderedKey = '';
        clearNodePool();
      }

      if (state.items.length > state.total) {
        state.items.length = state.total;
      }

      await syncDays(data);

      if (destroyed || localGeneration !== generation) {
        return null;
      }

      // 宽度只在这里量一次：它可能改变列数/行高，所以要在算 layoutKey 之前。
      measure();

      // 两把尺子分开：
      //   uiKey    —— 进度条、概览这些"文字"要不要更新（filled 每变一次都要更新）
      //   layoutKey—— 块结构要不要重建（数据/分组/宽度没变就完全不碰 DOM）
      const uiKey = [
        state.revision,
        state.total,
        state.filled,
        state.days.length,
        state.foldersToken || '',
        state.phase,
        state.error || '',
        state.grouped,
      ].join(':');
      const layoutKey = [
        state.revision,
        state.total,
        state.days.length,
        state.phase,
        state.error || '',
        state.grouped,
        state.metrics.columns,
        state.metrics.rowHeight,
      ].join(':');

      if (layoutKey !== state.layoutKey) {
        state.layoutKey = layoutKey;
        rebuildLayout();
        // 扫描进度条出现/消失会把内容区往下推，画廊位置要重新测一次
        invalidateGalleryTop();
        renderNow();
      }

      if (uiKey !== state.uiKey) {
        state.uiKey = uiKey;
        publish();
      }

      if (anchor) {
        await reanchor(anchor);
      }

      return data;
    }

    function stopPolling() {
      if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    function poll() {
      stopPolling();

      if (destroyed) {
        return;
      }

      pollTimer = window.setTimeout(async () => {
        try {
          const data = await loadSummary();

          if (data && data.scanning) {
            poll();
          }
        } catch {
          poll();
        }
      }, SCAN_POLL_INTERVAL);
    }

    // -----------------------------------------------------------------
    // 事件
    // -----------------------------------------------------------------

    function onScroll() {
      scheduleRender();
    }

    function onResize() {
      invalidateGalleryTop();

      // 宽度没变（例如只是滚动条出现、窗口高度变化）就什么都别做，
      // 否则会在滚动过程中不断重建布局并回滚位置，看起来就是"跳跃"。
      if (!measure()) {
        return;
      }

      const anchor = anchorIdAtTop();
      rebuildLayout();
      scheduleRender();

      if (anchor) {
        reanchor(anchor);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    // 窗口尺寸没变、但画廊自己的宽度变了的情况：侧栏出现/消失、页面滚动条出现/消失、
    // DevTools 停靠……这些不一定会有 window 的 resize 事件，可一旦宽度变了列数就得重算。
    // 只看"宽度"：高度每次铺块都在变，跟着跑会把 galleryDocumentTop 缓存一直作废。
    const galleryWidthObserver =
      typeof window.ResizeObserver === 'function'
        ? new window.ResizeObserver((entries) => {
            const rect = entries[entries.length - 1]?.contentRect;
            const width = rect ? rect.width : gallery.clientWidth;

            if (!(width > 0) || Math.abs(width - state.measuredWidth) < 1) {
              return;
            }

            onResize();
          })
        : null;

    galleryWidthObserver?.observe(gallery);

    gallery.replaceChildren(topSpacer, middle, bottomSpacer);
    gallery.dataset.state = 'loading';

    async function start({ force = false } = {}) {
      generation += 1;
      stopPolling();
      resetData();
      state.revision = -1;
      state.phase = 'loading';
      state.grouped = false;
      state.total = 0;
      state.filled = 0;
      gallery.dataset.state = 'loading';
      onBeforeFirstLoad();

      if (force) {
        // 让服务端重新扫描（目录签名没变时它自己会直接复用索引）
        await query('/api/library/summary', { refresh: 1 }).catch(() => null);
      }

      const data = await loadSummary();

      if (data && data.scanning) {
        poll();
      }

      return state.phase;
    }

    async function setFilter(filter) {
      if (filter === state.filter) {
        return;
      }

      state.filter = filter;
      await start();
    }

    function resize() {
      onResize();
    }

    return {
      start,
      refresh() {
        return start({ force: true });
      },
      setFilter,
      resize,
      getLoadedItem(id) {
        return state.loaded.get(id) || null;
      },
      rememberItems(list) {
        for (const item of list || []) {
          if (item && item.id) {
            state.loaded.set(item.id, item);
          }
        }
      },
      getState() {
        return state;
      },
      destroy() {
        destroyed = true;
        stopPolling();
        cancelThumbWork();
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        galleryWidthObserver?.disconnect();
        gallery.replaceChildren();
      },
    };
  }

  createPhotoStream.geometry = geometry;
  window.createPhotoStream = createPhotoStream;
})();