const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 三种运行形态：
//   安装版：MyAlbum.exe 的启动器会传 MY_ALBUM_INSTALL_DIR = 安装目录。
//           按用户要求，缓存 / 索引 / 设置**全在安装目录里**（自包含；装到 D 盘缓存就跟着去 D 盘）。
//   免安装版：同样是"装在哪就写在哪"，只是没有安装流程（同一套代码路径）。
//   开发版：直接跑源码，data / cache / photos 在项目目录下（和以前一样）。
//
// 环境变量仍然最优先（测试、临时指定目录都用它），其次是安装目录，最后才是项目目录。
const PROJECT_DIR = path.join(__dirname, '..');

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function installDirFromEnv() {
  const value = trimmed(process.env.MY_ALBUM_INSTALL_DIR);

  if (value) {
    return path.resolve(value);
  }

  // 没走启动器、直接 `node app\server.js` 运行安装版时（比如排查问题），
  // 认一下安装目录的形态：app 的上一级有 runtime\node.exe 就是安装/免安装版。
  const parent = path.dirname(PROJECT_DIR);

  if (fs.existsSync(path.join(parent, 'runtime', 'node.exe'))) {
    return parent;
  }

  return null;
}

const INSTALL_DIR = installDirFromEnv();

// 安装目录写不了时的退路（例如装到了 C:\Program Files 又没补 ACL）：
// 宁可退到用户目录也不能启动就崩，而且要把这件事报告出去（见 PATH_NOTES）。
function userFallbackRoot() {
  const localAppData = trimmed(process.env.LOCALAPPDATA);

  return localAppData
    ? path.join(localAppData, '我的相册')
    : path.join(os.homedir() || os.tmpdir(), '我的相册');
}

// 目录还不存在时也能判断"能不能在这里写"：一路上找到最近的已存在祖先再试写权限。
function isWritable(target) {
  let probe = path.resolve(target);

  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);

    if (parent === probe) {
      return false;
    }

    probe = parent;
  }

  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const PATH_NOTES = [];

function resolveDirectory({ envName, installSub, projectSub, what }) {
  const fromEnv = trimmed(process.env[envName]);

  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  if (INSTALL_DIR) {
    const wanted = path.join(INSTALL_DIR, installSub);

    if (isWritable(wanted)) {
      return wanted;
    }

    const fallback = path.join(userFallbackRoot(), installSub);

    PATH_NOTES.push(
      `${what}：安装目录 ${wanted} 不可写，已改用 ${fallback}（装在 Program Files 下时会出现这种情况）`
    );

    return fallback;
  }

  return path.join(PROJECT_DIR, projectSub);
}

const DATA_DIR = resolveDirectory({
  envName: 'MY_ALBUM_DATA_DIR',
  installSub: 'data',
  projectSub: 'data',
  what: '索引和设置',
});

const CACHE_DIR = resolveDirectory({
  envName: 'MY_ALBUM_CACHE_DIR',
  installSub: 'cache',
  projectSub: 'cache',
  what: '缓存',
});

// 默认照片目录只是"还没选文件夹时"的初值。安装目录下那个 photos 通常并不存在，
// 于是界面会照常让用户选一个文件夹 —— 和开发版的行为一致，不做任何"猜"。
function defaultPhotosDir() {
  const fromEnv = trimmed(process.env.MY_ALBUM_DEFAULT_PHOTOS);

  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  if (INSTALL_DIR) {
    return path.join(INSTALL_DIR, 'photos');
  }

  return path.join(PROJECT_DIR, 'photos');
}

const DEFAULT_PHOTOS_DIR = defaultPhotosDir();

module.exports = {
  PROJECT_DIR,
  INSTALL_DIR,
  DATA_DIR,
  CACHE_DIR,
  DEFAULT_PHOTOS_DIR,
  // 安装/免安装版的标志，界面和日志用它说明"数据放在哪"
  IS_INSTALLED: Boolean(INSTALL_DIR),
  PATH_NOTES,
  // 给测试用
  isWritable,
};