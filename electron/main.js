const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
} = require('electron');

const PRODUCT_NAME = '我的相册';
const APP_ID = 'com.myalbum.desktop';
const PROJECT_DIR = path.join(__dirname, '..');

let mainWindow = null;
let httpServer = null;
let serverPort = null;

app.setName('MyAlbum');
app.setAppUserModelId(APP_ID);

// Keep the app's private data out of Program Files. The renderer never gets
// direct filesystem access; only the local Express service does.
const userDataDir = process.env.MY_ALBUM_USER_DATA
  ? path.resolve(process.env.MY_ALBUM_USER_DATA)
  : path.join(
      app.getPath('appData'),
      app.isPackaged ? 'MyAlbum' : 'MyAlbum-dev'
    );
app.setPath('userData', userDataDir);

const dataDir = process.env.MY_ALBUM_DATA_DIR
  ? path.resolve(process.env.MY_ALBUM_DATA_DIR)
  : app.isPackaged
    ? path.join(userDataDir, 'data')
    : path.join(PROJECT_DIR, 'data');
const cacheDir = process.env.MY_ALBUM_CACHE_DIR
  ? path.resolve(process.env.MY_ALBUM_CACHE_DIR)
  : app.isPackaged
    ? path.join(userDataDir, 'cache')
    : path.join(PROJECT_DIR, 'cache');
const defaultPhotosDir = process.env.MY_ALBUM_DEFAULT_PHOTOS
  ? path.resolve(process.env.MY_ALBUM_DEFAULT_PHOTOS)
  : app.isPackaged
    ? app.getPath('pictures')
    : path.join(PROJECT_DIR, 'photos');

process.env.MY_ALBUM_DATA_DIR = dataDir;
process.env.MY_ALBUM_CACHE_DIR = cacheDir;
process.env.MY_ALBUM_DEFAULT_PHOTOS = defaultPhotosDir;

const LOG_PATH = path.join(userDataDir, 'app.log');

function writeLog(message) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    );
  } catch {
    // Logging must never prevent the app from starting.
  }
}

function copyFileIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return false;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function importPortableDataOnce() {
  if (!app.isPackaged) {
    return;
  }

  const marker = path.join(userDataDir, '.portable-data-imported');
  const portableData = path.join(path.dirname(process.execPath), 'data');
  const portableCache = path.join(path.dirname(process.execPath), 'cache');

  if (fs.existsSync(marker) || !fs.existsSync(portableData)) {
    return;
  }

  try {
    copyFileIfMissing(
      path.join(portableData, 'settings.json'),
      path.join(dataDir, 'settings.json')
    );
    copyFileIfMissing(
      path.join(portableData, 'library-index.json'),
      path.join(dataDir, 'library-index.json')
    );

    if (fs.existsSync(portableCache) && !fs.existsSync(cacheDir)) {
      fs.cpSync(portableCache, cacheDir, { recursive: true });
    }

    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    writeLog('Imported portable data next to the executable.');
  } catch (error) {
    writeLog(`Portable data import failed: ${error.stack || error.message}`);
  }
}

function installFolderPicker() {
  globalThis.__myAlbumPickFolder = async ({ initialPath = '' } = {}) => {
    const parent =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const fallback = app.getPath('pictures');
    const defaultPath =
      initialPath && fs.existsSync(initialPath) ? initialPath : fallback;

    const result = await dialog.showOpenDialog(parent, {
      title: '选择照片文件夹',
      buttonLabel: '选择此文件夹',
      defaultPath,
      properties: ['openDirectory'],
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    return { canceled: false, path: result.filePaths[0] };
  };
}

function bindWindowSecurity(window, origin) {
  const isLocalUrl = (value) => {
    try {
      return new URL(value).origin === origin;
    } catch {
      return false;
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isLocalUrl(url)) {
      shell.openExternal(url).catch((error) => {
        writeLog(`Could not open external URL: ${error.message}`);
      });
    }

    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isLocalUrl(url)) {
      return;
    }

    event.preventDefault();

    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => {
        writeLog(`Could not open external URL: ${error.message}`);
      });
    }
  });
}

function bindShortcuts(window) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }

    const key = input.key.toLowerCase();
    const control = input.control || input.meta;

    if (key === 'f5' || (control && key === 'r')) {
      event.preventDefault();
      window.webContents.reload();
      return;
    }

    if (key === 'f11') {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
      return;
    }

    if (!app.isPackaged && control && input.shift && key === 'i') {
      event.preventDefault();
      window.webContents.toggleDevTools();
      return;
    }

    if (control && key === '0') {
      event.preventDefault();
      window.webContents.setZoomLevel(0);
    }
  });
}

function createWindow(origin) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(PROJECT_DIR, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  bindWindowSecurity(mainWindow, origin);
  bindShortcuts(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (event, code, description) => {
    writeLog(`Page failed to load (${code}): ${description}`);
  });

  mainWindow.loadURL(`${origin}/`).catch((error) => {
    writeLog(`loadURL failed: ${error.stack || error.message}`);
  });

  return mainWindow;
}

async function startApplication() {
  try {
    installFolderPicker();

    // A random loopback port prevents conflicts with other local apps.
    const result = await require('../server').startServer({ port: 0 });
    httpServer = result.server;
    serverPort = result.port;

    const origin = `http://127.0.0.1:${serverPort}`;
    writeLog(`Application started at ${origin}`);

    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(false);
      }
    );

    createWindow(origin);
  } catch (error) {
    writeLog(`Startup failed: ${error.stack || error.message}`);
    dialog.showErrorBox(
      '我的相册启动失败',
      `应用无法启动。\n\n${error.message || error}\n\n日志：${LOG_PATH}`
    );
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    importPortableDataOnce();
    startApplication();
  });

  app.on('activate', () => {
    if (serverPort) {
      createWindow(`http://127.0.0.1:${serverPort}`);
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
  });

  process.on('uncaughtException', (error) => {
    writeLog(`Uncaught exception: ${error.stack || error.message}`);
  });

  process.on('unhandledRejection', (error) => {
    writeLog(
      `Unhandled rejection: ${error?.stack || String(error)}`
    );
  });
}
