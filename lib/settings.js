const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { DATA_DIR, DEFAULT_PHOTOS_DIR } = require('./app-paths');

const SETTINGS_DIR = DATA_DIR;
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

let settingsCache = null;
let settingsLoad = null;

async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    console.warn('读取设置失败，使用默认照片文件夹。', error.message);
    return {};
  }
}

async function getSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  if (!settingsLoad) {
    settingsLoad = readSettings()
      .then((settings) => {
        settingsCache = settings;
        return settings;
      })
      .finally(() => {
        settingsLoad = null;
      });
  }

  return settingsLoad;
}

async function getPhotoRoot() {
  const settings = await getSettings();
  const configured =
    typeof settings.photoRoot === 'string' ? settings.photoRoot.trim() : '';

  return configured ? path.resolve(configured) : DEFAULT_PHOTOS_DIR;
}

async function getSourceInfo() {
  const settings = await getSettings();
  const root = await getPhotoRoot();
  let exists = false;
  let isDirectory = false;

  try {
    const stat = await fsp.stat(root);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    // 文件夹被移动或删除时，前端会提示重新选择。
  }

  return {
    path: root,
    name: path.basename(root) || root,
    isDefault: !settings.photoRoot,
    exists,
    isDirectory,
  };
}

async function setPhotoRoot(folder) {
  if (typeof folder !== 'string' || !folder.trim()) {
    const error = new Error('请选择一个照片文件夹');
    error.status = 400;
    throw error;
  }

  const absolutePath = path.resolve(folder.trim());
  let stat;

  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    const error = new Error('这个文件夹不存在，请重新选择');
    error.status = 400;
    throw error;
  }

  if (!stat.isDirectory()) {
    const error = new Error('请选择文件夹，不要选择单个文件');
    error.status = 400;
    throw error;
  }

  const nextSettings = {
    ...(await getSettings()),
    photoRoot: absolutePath,
    updatedAt: new Date().toISOString(),
  };

  await fsp.mkdir(SETTINGS_DIR, { recursive: true });

  const tempPath = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(
    tempPath,
    `${JSON.stringify(nextSettings, null, 2)}\n`,
    'utf8'
  );
  await fsp.rename(tempPath, SETTINGS_PATH);
  settingsCache = nextSettings;

  return getSourceInfo();
}

module.exports = {
  DEFAULT_PHOTOS_DIR,
  getPhotoRoot,
  getSourceInfo,
  setPhotoRoot,
};
