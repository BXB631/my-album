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
} = require('./lib/media');
const { getSourceInfo, setPhotoRoot } = require('./lib/settings');
const { pickFolder } = require('./lib/folder-picker');
const { openOriginal } = require('./lib/launcher');

const app = express();
let folderPickerBusy = false;

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function toPublicLibrary(library, source) {
  const imageCount = library.items.filter((item) => item.type === 'image').length;
  const videoCount = library.items.length - imageCount;

  return {
    total: library.items.length,
    imageCount,
    videoCount,
    root: library.root,
    source,
    folders: library.folders,
    uncategorizedCount: library.uncategorizedCount,
    scannedAt: library.scannedAt,
    items: library.items.map((item) => {
      const { cacheSignature, takenAtMs, needsTranscode, ...publicItem } = item;
      return publicItem;
    }),
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
    const cache = await clearCache();
    res.json(cache);
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
    const library = await getLibrary();
    const item = library.byId.get(req.params.id);

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
    const library = await getLibrary();
    const item = library.byId.get(req.params.id);

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
    const library = await getLibrary();
    const item = library.byId.get(req.params.id);

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
    const library = await getLibrary();
    const item = library.byId.get(req.params.id);

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
    const library = await getLibrary();
    const item = library.byId.get(req.params.id);

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

app.use((error, req, res, next) => {
  if (error.code !== 'SCAN_CANCELED') {
    console.error(error);
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  if (req.path.startsWith('/api/')) {
    const status = Number(error.status) || 500;
    const message =
      status >= 500 ? '服务器读取照片时出错了' : error.message;

    res.status(status).json({ error: message });
    return;
  }

  res.status(500).send('服务器出错了');
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

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;

  startServer({ port })
    .then(({ port: actualPort }) => {
      console.log('');
      console.log('  我的相册服务已启动');
      console.log(`  桌面版会直接打开应用窗口；开发调试地址：http://localhost:${actualPort}`);
      console.log('  停止服务器：按 Ctrl + C');
      console.log('');
    })
    .catch((error) => {
      console.error('启动相册失败：', error);
      process.exitCode = 1;
    });
}

module.exports = { app, startServer };
