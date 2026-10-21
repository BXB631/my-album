const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, 'folder-picker.ps1');
const PICKER_TIMEOUT_MS = 15 * 60 * 1000;

function waitForPicker(child, logFd, logPath) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = async (exitCode, spawnError) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      try {
        fs.closeSync(logFd);
      } catch {
        // 已经关闭时忽略。
      }

      if (spawnError) {
        reject(spawnError);
        return;
      }

      if (exitCode === 0) {
        resolve();
        return;
      }

      if (exitCode === 2) {
        resolve('canceled');
        return;
      }

      let detail = '';

      try {
        detail = (await fsp.readFile(logPath, 'utf8'))
          .trim()
          .split('\n')
          .slice(-4)
          .join(' ');
      } catch {
        // 没有日志时使用通用错误。
      }

      reject(new Error(detail || `文件夹选择窗口异常退出（${exitCode}）`));
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(-1, new Error('文件夹选择超时，请重试'));
    }, PICKER_TIMEOUT_MS);

    child.once('error', (error) => finish(-1, error));
    child.once('close', (code) => finish(code, null));
  });
}

async function pickFolder({ initialPath = '' } = {}) {
  // The Electron main process installs a native dialog hook so that the
  // folder picker also works from the packaged app (no PowerShell child).
  if (typeof globalThis.__myAlbumPickFolder === 'function') {
    return globalThis.__myAlbumPickFolder({ initialPath });
  }

  if (process.platform !== 'win32') {
    throw new Error('系统文件夹选择窗口目前只支持 Windows');
  }

  const tempDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'my-album-folder-picker-')
  );
  const resultPath = path.join(tempDir, 'selected.txt');
  const logPath = path.join(tempDir, 'picker.log');
  const logFd = fs.openSync(logPath, 'w');

  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT_PATH,
        '-ResultPath',
        resultPath,
        '-InitialPath',
        initialPath || '',
      ],
      {
        cwd: __dirname,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
      }
    );

    const result = await waitForPicker(child, logFd, logPath);

    if (result === 'canceled') {
      return { canceled: true };
    }

    let selectedPath = '';

    try {
      selectedPath = (await fsp.readFile(resultPath, 'utf8')).trim();
    } catch {
      throw new Error('没有读取到所选文件夹，请重试');
    }

    if (!selectedPath) {
      return { canceled: true };
    }

    return { canceled: false, path: selectedPath };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { pickFolder };
