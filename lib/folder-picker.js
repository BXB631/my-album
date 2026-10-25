const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CACHE_DIR } = require('./app-paths');

const SCRIPT_PATH = path.join(__dirname, 'folder-picker.ps1');
const PICKER_TIMEOUT_MS = 15 * 60 * 1000;

// 首选：自己编译的小 exe（不经过 PowerShell，启动快，也不用赌目标机器的 .NET 版本）。
// 找不到它才退回 PowerShell 脚本。
//   · 打包后：app\picker\MyAlbumPicker.exe
//   · 开发时：build\picker\MyAlbumPicker.exe（pnpm pack 会编译出来）
function pickerExe() {
  const candidates = [
    path.join(__dirname, '..', 'picker', 'MyAlbumPicker.exe'),
    path.join(__dirname, '..', 'build', 'picker', 'MyAlbumPicker.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// 存放"选择结果/脚本日志"的临时目录。
//
// 为什么不用 %TEMP%：以管理员身份运行（尤其是"输入了另一个管理员账号"的那种提权）时，
// 进程拿到的 %TEMP% 还是**原用户**的目录，但令牌已经是管理员的，于是 mkdtemp 直接
// EPERM —— 用户就是这么撞上的（"服务器读取照片时出错了"）。
//
// 所以按"谁一定能写"的顺序挨个试：
//   1. 应用自己的缓存目录（服务一直在往里写缩略图，普通身份/同用户提权都没问题）
//   2. 安装目录本身（缓存目录被改到别处时的退路）
//   3. 系统临时目录（正常情况下的兜底）
//   4. C:\Windows\Temp（管理员令牌一定写得进去 —— 正是 %TEMP% 失败那种场景）
//   5. %ProgramData%（同上，另一个一定可写的位置）
function workParents() {
  const cacheParent = path.dirname(CACHE_DIR);
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  const candidates = [
    path.join(CACHE_DIR, 'picker-'),
    path.join(cacheParent, 'picker-'),
    path.join(os.tmpdir(), 'my-album-picker-'),
    path.join(windowsDir, 'Temp', 'my-album-picker-'),
    path.join(programData, 'my-album-picker-'),
  ];

  const seen = new Set();

  return candidates.filter((candidate) => {
    const key = path.dirname(candidate).toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function makeWorkDir() {
  const attempts = [];
  const failures = [];

  for (const prefix of workParents()) {
    attempts.push(path.dirname(prefix));

    try {
      await fsp.mkdir(path.dirname(prefix), { recursive: true });
      return await fsp.mkdtemp(prefix);
    } catch (error) {
      failures.push(`${path.dirname(prefix)}（${error.code || error.message}）`);
    }
  }

  throw new Error(
    `建不了文件夹选择窗口需要的临时目录，这些位置都试过了：\r\n${failures.join('\r\n')}\r\n` +
      '（托盘图标右键里有“手动指定照片文件夹…”，可以直接用它选）'
  );
}

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
  // 2.0 只跑 Node 服务，没有 Electron 原生对话框，
  // 统一用 PowerShell 的 WinForms 文件夹选择窗口。
  if (process.platform !== 'win32') {
    throw new Error('系统文件夹选择窗口目前只支持 Windows');
  }

  const tempDir = await makeWorkDir();
  const resultPath = path.join(tempDir, 'selected.txt');
  const logPath = path.join(tempDir, 'picker.log');
  const logFd = fs.openSync(logPath, 'w');

  try {
    const exe = pickerExe();
    const child = exe
      ? spawn(
          exe,
          [
            `/out=${resultPath}`,
            `/initial=${initialPath || ''}`,
            '/description=选择存放照片的文件夹',
          ],
          { cwd: __dirname, windowsHide: true, stdio: ['ignore', logFd, logFd] }
        )
      : spawn(
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
            // 中文文案从命令行参数传进去：ps1 必须保持纯 ASCII
            // （PowerShell 5.1 会把没有 BOM 的 UTF-8 脚本按 ANSI 读，中文会变乱码甚至报语法错）
            '-Description',
            '选择存放照片的文件夹',
          ],
          { cwd: __dirname, windowsHide: true, stdio: ['ignore', logFd, logFd] }
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

module.exports = { pickFolder, makeWorkDir, workParents, pickerExe };
