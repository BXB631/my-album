const path = require('node:path');
const express = require('express');
const {
  getLibrary,
  clearLibraryCache,
  cancelCurrentScan,
  getCacheInfo,
  clearCache,
  getThumbnail,
  getPreview,
  getVideoPlayback,
  getItemById,
  startLibraryStream,
  getStreamSummary,
  getStreamDays,
  getStreamItems,
  getStreamNeighbors,
  getStreamItemsByIds,
  toPublicItem,
} = require('./lib/media');
const { getSourceInfo, setPhotoRoot } = require('./lib/settings');
const { pickFolder } = require('./lib/folder-picker');
const { openOriginal } = require('./lib/launcher');

const app = express();
let folderPickerBusy = false;

// 启动器用它判断"浏览器到底有没有把页面加载出来"（无边框窗口失败时能自动回退成普通窗口）。
// 任何"像前端在启动"的请求都会刷新这个时间戳：首页、前端启动时要的那几个接口。
let lastPageRequestAt = 0;

app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    (req.path === '/' ||
      req.path === '/index.html' ||
      req.path === '/api/source' ||
      req.path.startsWith('/api/library/'))
  ) {
    lastPageRequestAt = Date.now();
  }

  next();
});

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: require('./package.json').version,
    pid: process.pid,
    lastPageAt: lastPageRequestAt,
  });
});

function toPublicLibrary(library, source) {
  const items = library.items.map(toPublicItem);
  const imageCount = items.filter((item) => item.type === 'image').length;
  const videoCount = items.length - imageCount;

  return {
    total: items.length,
    imageCount,
    videoCount,
    root: library.root,
    source,
    folders: library.folders,
    uncategorizedCount: library.uncategorizedCount,
    scannedAt: library.scannedAt,
    items,
  };
}

app.get('/api/source', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getSourceInfo());
  } catch (error) {
    next(error);
  }
});

app.post('/api/folder/select', async (req, res, next) => {
  if (folderPickerBusy) {
    res.status(409).json({ error: '文件夹选择窗口已经打开了' });
    return;
  }

  folderPickerBusy = true;

  try {
    const currentSource = await getSourceInfo();
    const result = await pickFolder({
      initialPath: currentSource.exists ? currentSource.path : '',
    });

    if (result.canceled) {
      res.json({ canceled: true, source: currentSource });
      return;
    }

    const source = await setPhotoRoot(result.path);
    clearLibraryCache();
    res.json({ canceled: false, source });
  } catch (error) {
    next(error);
  } finally {
    folderPickerBusy = false;
  }
});

app.put('/api/source', async (req, res, next) => {
  try {
    const source = await setPhotoRoot(req.body?.path);
    clearLibraryCache();
    res.json({ source });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan/cancel', (req, res) => {
  res.json({ canceled: cancelCurrentScan() });
});

app.get('/api/cache', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getCacheInfo());
  } catch (error) {
    next(error);
  }
});

app.post('/api/cache/clear', async (req, res, next) => {
  try {
    // kind: thumbnails（缩略图）| media（打开过的图片/视频）| all（全部，默认）
    const kind =
      typeof req.body?.kind === 'string' && req.body.kind ? req.body.kind : 'all';
    const cache = await clearCache(kind);
    res.json(cache);
  } catch (error) {
    next(error);
  }
});

// 2.0 流式图库接口：先要 summary（总格子数 / 扫描进度），
// 再按窗口取 items 或 days，不再一次性把整个图库塞进一个 JSON。
function readFolderQuery(req) {
  const value = req.query.folder;
  return typeof value === 'string' && value ? value : 'all';
}

app.get('/api/library/summary', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');

    // refresh=1：用户点"刷新"，强制重扫；目录签名没变时服务端会直接复用。
    if (req.query.refresh === '1') {
      await startLibraryStream({ force: true });
    }

    // foldersToken：前端带上自己已经拿到的那份指纹，
    // 内容没变时服务端就不重复传目录树。
    const summary = await getStreamSummary(readFolderQuery(req), {
      foldersToken:
        typeof req.query.foldersToken === 'string'
          ? req.query.foldersToken
          : null,
    });
    summary.source = await getSourceInfo();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get('/api/library/days', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getStreamDays(readFolderQuery(req)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/library/items', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(
      await getStreamItems({
        offset: Number(req.query.offset) || 0,
        limit: Number(req.query.limit) || 200,
        filter: readFolderQuery(req),
      })
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/library/neighbors/:id', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getStreamNeighbors(
      req.params.id,
      readFolderQuery(req)
    );

    if (!result) {
      res.status(404).json({ error: '这个项目还没有准备好' });
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/library/items-by-ids', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getStreamItemsByIds(req.query.ids || '') });
  } catch (error) {
    next(error);
  }
});

app.get('/api/photos', async (req, res, next) => {
  try {
    const library = await getLibrary(req.query.refresh === '1');
    const source = await getSourceInfo();

    res.set('Cache-Control', 'no-store');
    res.json(toPublicLibrary(library, source));
  } catch (error) {
    next(error);
  }
});

app.post('/api/open/:id', async (req, res, next) => {
  try {
    const item = await getItemById(req.params.id);

    if (!item) {
      res.status(404).json({ error: '没有找到这个文件' });
      return;
    }

    const result = await openOriginal(item);
    res.json({ opened: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/thumb/:id', async (req, res, next) => {
  try {
    const item = await getItemById(req.params.id);

    if (!item) {
      res.status(404).json({ error: '没有找到这个项目的缩略图' });
      return;
    }

    const thumbnailPath = await getThumbnail(item);
    res.sendFile(thumbnailPath, {
      maxAge: '30d',
      immutable: true,
      headers: {
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/preview/:id', async (req, res, next) => {
  try {
    const item = await getItemById(req.params.id);

    if (!item || item.type !== 'image') {
      res.status(404).json({ error: '没有找到这个项目的预览图' });
      return;
    }

    const previewPath = await getPreview(item);
    res.sendFile(previewPath, {
      maxAge: '30d',
      immutable: true,
      headers: {
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/video/:id', async (req, res, next) => {
  try {
    const item = await getItemById(req.params.id);

    if (!item || item.type !== 'video') {
      res.status(404).json({ error: '没有找到这个视频' });
      return;
    }

    const videoPath = await getVideoPlayback(item);
    res.sendFile(videoPath, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/file/:id', async (req, res, next) => {
  try {
    const item = await getItemById(req.params.id);

    if (!item) {
      res.status(404).json({ error: '没有找到这个文件' });
      return;
    }

    res.sendFile(item.absolutePath);
  } catch (error) {
    next(error);
  }
});

app.use(
  '/vendor/leaflet',
  express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), {
    maxAge: '7d',
    immutable: true,
  })
);

app.use(
  '/vendor/leaflet-markercluster',
  express.static(
    path.join(__dirname, 'node_modules', 'leaflet.markercluster', 'dist'),
    {
      maxAge: '7d',
      immutable: true,
    }
  )
);

app.use(express.static(path.join(__dirname, 'public')));

// 网页版把 assets 也挂出来，供页面图标使用。
app.use(
  '/assets',
  express.static(path.join(__dirname, 'assets'), { maxAge: '7d' })
);

app.use((error, req, res, next) => {
  // 4xx 是调用方的问题（比如清理缓存传了不认识的类型），不用把整段堆栈打到控制台；
// 5xx 才是服务端自己的错，必须留下现场。
const status = Number(error.status) || 500;

  if (error.code !== 'SCAN_CANCELED' && status >= 500) {
    console.error(error);
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  if (req.path.startsWith('/api/')) {
    // 这是本机自己用的服务，错误原因直接告诉界面 —— 不然用户只能看到
    // "服务器读取照片时出错了" 这种没头没尾的话，排查全靠翻日志。
    const message =
      status >= 500
        ? `服务器读取照片时出错了：${error.message || '未知原因'}`
        : error.message;

    res.status(status).json({ error: message });
    return;
  }

  res.status(status >= 500 ? 500 : status).send(
    status >= 500 ? '服务器出错了' : error.message
  );
});

function startServer({ port = 3000, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      resolve({
        app,
        server,
        port: typeof address === 'object' && address ? address.port : port,
      });
    });

    server.once('error', reject);
  });
}

// 打开系统默认浏览器（只有显式要求时才做，避免测试时弹出窗口）。
function openBrowser(url) {
  const { spawn } = require('node:child_process');

  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }

    return true;
  } catch {
    return false;
  }
}

if (require.main === module) {
  // 安装版没有控制台窗口：日志落到文件（启动器会设 MY_ALBUM_LOG_FILE）
  require('./lib/log-file').startFileLog(process.env.MY_ALBUM_LOG_FILE);

  const {
    CACHE_DIR,
    DATA_DIR,
    INSTALL_DIR,
    PATH_NOTES,
  } = require('./lib/app-paths');
  const port = Number(process.env.PORT) || 3000;

  for (const note of PATH_NOTES) {
    console.warn(`  ⚠ ${note}`);
  }

  startServer({ port })
    .then(({ port: actualPort }) => {
      const url = `http://localhost:${actualPort}`;
      console.log('');
      console.log('  我的相册已启动');
      console.log(`  在浏览器里打开：${url}`);
      console.log(`  缓存目录：${CACHE_DIR}`);
      console.log(`  索引目录：${DATA_DIR}`);

      if (INSTALL_DIR) {
        console.log(`  安装目录：${INSTALL_DIR}`);
      }

      console.log('  停止服务：按 Ctrl + C');
      console.log('');

      if (process.env.MY_ALBUM_OPEN_BROWSER === '1' && !openBrowser(url)) {
        console.log(`  自动打开浏览器失败，请手动访问：${url}`);
      }
    })
    .catch((error) => {
      console.error('启动相册失败：', error);
      process.exitCode = 1;
    });
}

module.exports = { app, startServer };
