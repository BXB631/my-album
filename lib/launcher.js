const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CACHE_DIR } = require('./app-paths');

const PLAYLISTS_DIR = path.join(CACHE_DIR, 'playlists');
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
]);

let potPlayerChecked = false;
let potPlayerPath = null;

function findPotPlayer() {
  if (potPlayerChecked) {
    return potPlayerPath;
  }

  potPlayerChecked = true;

  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.POTPLAYER_PATH,
    'D:\\PotPlayer\\PotPlayerMini64.exe',
    'D:\\PotPlayer\\PotPlayerMini.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
    localAppData
      ? path.join(
          localAppData,
          'Programs',
          'PotPlayer',
          'PotPlayerMini64.exe'
        )
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      potPlayerPath = candidate;
      return potPlayerPath;
    }
  }

  return null;
}

function launchProcess(executable, args) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;

    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });

    child.once('spawn', () => {
      if (settled) {
        return;
      }

      settled = true;
      child.unref();
      resolve();
    });
  });
}

function listSiblingVideos(directory, targetPath) {
  const videos = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) {
        return false;
      }

      return VIDEO_EXTENSIONS.has(
        path.extname(entry.name).toLowerCase()
      );
    })
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const targetLower = targetPath.toLowerCase();
  const withoutTarget = videos.filter(
    (file) => file.toLowerCase() !== targetLower
  );

  return [targetPath, ...withoutTarget];
}

function writeVideoPlaylist(directory, targetPath, videos) {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });

  const key = crypto
    .createHash('sha1')
    .update(directory.toLowerCase())
    .digest('hex')
    .slice(0, 16);
  const playlistPath = path.join(PLAYLISTS_DIR, `${key}.m3u`);
  const lines = ['#EXTM3U'];

  for (const file of videos) {
    const name = path.basename(file).replace(/[\r\n]/g, ' ');
    lines.push(`#EXTINF:-1,${name}`);
    lines.push(file);
  }

  fs.writeFileSync(
    playlistPath,
    `\uFEFF${lines.join('\r\n')}\r\n`,
    'utf8'
  );

  return playlistPath;
}

async function openWithSystem(filePath) {
  const explorer = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'explorer.exe'
  );
  await launchProcess(explorer, [filePath]);
  return { app: 'system', appName: '系统默认应用' };
}

async function openOriginal(item) {
  if (!item || !item.absolutePath || !fs.existsSync(item.absolutePath)) {
    const error = new Error('原始文件不存在');
    error.status = 404;
    throw error;
  }

  if (item.type === 'video') {
    const executable = findPotPlayer();

    // PotPlayer is optional. Without it, hand the file to the user's default
    // video player instead of failing to open the video.
    if (!executable) {
      return openWithSystem(item.absolutePath);
    }

    const directory = path.dirname(item.absolutePath);
    const videos = listSiblingVideos(directory, item.absolutePath);
    const playlistPath = writeVideoPlaylist(
      directory,
      item.absolutePath,
      videos
    );

    await launchProcess(executable, [playlistPath]);
    return { app: 'potplayer', appName: 'PotPlayer' };
  }

  return openWithSystem(item.absolutePath);
}

module.exports = {
  findPotPlayer,
  openOriginal,
};
