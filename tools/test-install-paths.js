// 安装版目录规则的测试：缓存 / 索引 / 设置必须落在**安装目录**里，
// 而且"安装目录写不进去"（比如装到 Program Files 又没补 ACL）时要能安全退到用户目录，
// 并且把这件事报告出来（不能静默失败）。
//
//   node tools/test-install-paths.js
//
// 做法：app-paths.js 是在 require 那一刻读环境变量的，所以这里"换一套环境变量 +
// 清掉 require 缓存"就能把几种形态挨个跑一遍，不用起子进程。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PATHS_MODULE = require.resolve('../lib/app-paths');
const RUNTIME = path.join(ROOT, 'test-runtime', 'install-paths');

let failures = 0;
let checks = 0;

function check(condition, message, detail) {
  checks += 1;

  if (condition) {
    console.log(`  ✓ ${message}`);
    return true;
  }

  failures += 1;
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function isWritableReal(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function loadPaths(env) {
  for (const key of [
    'MY_ALBUM_INSTALL_DIR',
    'MY_ALBUM_CACHE_DIR',
    'MY_ALBUM_DATA_DIR',
    'MY_ALBUM_DEFAULT_PHOTOS',
  ]) {
    delete process.env[key];
  }

  Object.assign(process.env, env || {});

  delete require.cache[PATHS_MODULE];
  return require(PATHS_MODULE);
}

async function main() {
  await fs.promises.mkdir(RUNTIME, { recursive: true });
  fs.mkdirSync(path.join(RUNTIME, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(RUNTIME, 'runtime', 'node.exe'), '');
  fs.mkdirSync(path.join(RUNTIME, 'cache'), { recursive: true });

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const fallbackRoot = path.join(localAppData, '我的相册');

  console.log('安装版目录规则测试');

  console.log('\n[1] 安装目录可写 → 缓存/索引/设置全在安装目录里');
  {
    const paths = loadPaths({ MY_ALBUM_INSTALL_DIR: RUNTIME });

    check(paths.IS_INSTALLED === true, '认出了安装版（IS_INSTALLED=true）');
    check(
      paths.CACHE_DIR === path.join(RUNTIME, 'cache'),
      '缓存 = <安装目录>\\cache',
      paths.CACHE_DIR
    );
    check(
      paths.DATA_DIR === path.join(RUNTIME, 'data'),
      '索引和设置 = <安装目录>\\data',
      paths.DATA_DIR
    );
    check(paths.PATH_NOTES.length === 0, '没有回退，也就没有告警');
  }

  console.log('\n[2] 安装目录写不进去 → 退到用户目录，并且留下告警');
  {
    // 真实环境里"不可写"要看 ACL 和是否管理员，很难造得稳定；
    // 这里直接把 fs.accessSync 打桩成拒绝（app-paths 就是在 require 那一刻调它判断的），
    // 把"回退"这条分支本身测掉。测试不会真的往任何系统目录写东西。
    const blocked = path.join(RUNTIME, 'blocked-install');
    fs.mkdirSync(blocked, { recursive: true });

    const fsModule = require('node:fs');
    const originalAccessSync = fsModule.accessSync;

    fsModule.accessSync = function accessSync(target, mode) {
      if (String(target).startsWith(blocked)) {
        const error = new Error('EACCES: 模拟不可写');
        error.code = 'EACCES';
        throw error;
      }

      return originalAccessSync.call(fsModule, target, mode);
    };

    let paths;

    try {
      paths = loadPaths({ MY_ALBUM_INSTALL_DIR: blocked });
    } finally {
      fsModule.accessSync = originalAccessSync;
    }

    check(
      paths.CACHE_DIR === path.join(fallbackRoot, 'cache'),
      '缓存退到 %LOCALAPPDATA%\\我的相册\\cache',
      paths.CACHE_DIR
    );
    check(
      paths.DATA_DIR === path.join(fallbackRoot, 'data'),
      '索引也退到 %LOCALAPPDATA%\\我的相册\\data',
      paths.DATA_DIR
    );
    check(
      paths.PATH_NOTES.length >= 2 &&
        paths.PATH_NOTES.every((note) => note.includes('不可写')),
      '两处回退都写进了 PATH_NOTES（会被启动日志打出来）',
      paths.PATH_NOTES.join(' | ')
    );
    check(
      isWritableReal(blocked),
      '对照组：这个目录其实是可写的（说明回退是桩触发的，不是别的原因）'
    );
  }

  console.log('\n[3] 环境变量优先：显式指定的目录最优先');
  {
    const custom = path.join(RUNTIME, 'custom-cache');
    const paths = loadPaths({
      MY_ALBUM_INSTALL_DIR: RUNTIME,
      MY_ALBUM_CACHE_DIR: custom,
    });

    check(paths.CACHE_DIR === custom, 'MY_ALBUM_CACHE_DIR 覆盖安装目录', paths.CACHE_DIR);
    check(
      paths.DATA_DIR === path.join(RUNTIME, 'data'),
      '没被覆盖的那一项仍然跟着安装目录走',
      paths.DATA_DIR
    );
  }

  console.log('\n[4] 开发版（没有安装目录）→ 还是项目目录下的 data / cache');
  {
    const paths = loadPaths({});

    check(paths.IS_INSTALLED === false, '不算安装版');
    check(
      paths.CACHE_DIR === path.join(ROOT, 'cache'),
      '缓存 = <项目>\\cache',
      paths.CACHE_DIR
    );
    check(
      paths.DATA_DIR === path.join(ROOT, 'data'),
      '索引 = <项目>\\data',
      paths.DATA_DIR
    );
    check(paths.PATH_NOTES.length === 0, '开发版没有回退告警');
  }

  console.log('\n[5] 默认照片目录');
  {
    const dev = loadPaths({});
    const installed = loadPaths({ MY_ALBUM_INSTALL_DIR: RUNTIME });

    check(
      dev.DEFAULT_PHOTOS_DIR === path.join(ROOT, 'photos'),
      '开发版默认看 <项目>\\photos',
      dev.DEFAULT_PHOTOS_DIR
    );
    check(
      installed.DEFAULT_PHOTOS_DIR === path.join(RUNTIME, 'photos'),
      '安装版默认看 <安装目录>\\photos（通常不存在 → 界面让用户选文件夹）',
      installed.DEFAULT_PHOTOS_DIR
    );
  }

  console.log('\n[6] 文件夹选择器的工作目录');
  {
    // 选择窗口原来是往 %TEMP% 里建临时目录的：以管理员身份运行（尤其是"输入了另一个
    // 管理员账号"的提权）时，进程拿到的 %TEMP% 还是原用户的，但令牌是管理员的 →
    // mkdtemp 直接 EPERM，用户看到的就是"服务器读取照片时出错了"。
    // 现在改成优先用应用自己的缓存目录。
    const pickerModule = require.resolve('../lib/folder-picker');
    const fsModule = require('node:fs');

    const workCache = path.join(RUNTIME, 'picker-cache');
    loadPaths({ MY_ALBUM_CACHE_DIR: workCache });
    delete require.cache[pickerModule];

    const picker = require(pickerModule);
    const workDir = await picker.makeWorkDir();

    check(
      workDir.startsWith(workCache + path.sep),
      '临时目录建在缓存目录里（不再依赖 %TEMP%）',
      workDir
    );
    check(
      path.basename(workDir).startsWith('picker-'),
      '临时目录有名有姓（picker- 前缀）',
      path.basename(workDir)
    );
    check(
      fs.existsSync(workDir) && fs.statSync(workDir).isDirectory(),
      '临时目录真的建出来了'
    );

    // 缓存目录写不进去时，应该退到系统临时目录，而不是直接抛错
    const originalMkdtemp = fsModule.promises.mkdtemp;

    fsModule.promises.mkdtemp = function mkdtemp(prefix, ...rest) {
      if (String(prefix).startsWith(workCache)) {
        const error = new Error('EACCES: 模拟缓存目录不可写');
        error.code = 'EACCES';
        return Promise.reject(error);
      }

      return originalMkdtemp.call(fsModule.promises, prefix, ...rest);
    };

    let fallbackDir = '';

    try {
      fallbackDir = await picker.makeWorkDir();
    } finally {
      fsModule.promises.mkdtemp = originalMkdtemp;
    }

    check(
      fallbackDir.startsWith(RUNTIME + path.sep) && !fallbackDir.startsWith(workCache + path.sep),
      '缓存目录写不进去时退到安装目录',
      fallbackDir
    );

    // 再狠一点：缓存目录和安装目录都写不进去 → 退系统临时目录
    fsModule.promises.mkdtemp = function mkdtemp(prefix, ...rest) {
      const text = String(prefix);

      if (text.startsWith(workCache) || text.startsWith(RUNTIME)) {
        const error = new Error('EACCES: 模拟不可写');
        error.code = 'EACCES';
        return Promise.reject(error);
      }

      return originalMkdtemp.call(fsModule.promises, prefix, ...rest);
    };

    let thirdDir = '';

    try {
      thirdDir = await picker.makeWorkDir();
    } finally {
      fsModule.promises.mkdtemp = originalMkdtemp;
    }

    check(
      thirdDir.startsWith(os.tmpdir()),
      '两处都写不进去时退到系统临时目录',
      thirdDir
    );

    // 提权到"别的管理员账号"时，%TEMP% 也写不进去 —— 那条路必须能走到
    // C:\Windows\Temp / %ProgramData%（管理员令牌一定写得了）
    const parents = picker.workParents();
    const normalized = parents.map((item) => path.dirname(item).toLowerCase());

    check(
      normalized[0] === path.join(workCache).toLowerCase(),
      '第一优先还是自己的缓存目录',
      normalized[0]
    );
    check(
      normalized.some((item) => item.endsWith(path.join('windows', 'temp').toLowerCase())),
      '候选里有 C:\\Windows\\Temp（提权场景的救命稻草）',
      normalized.join(' | ')
    );
    check(
      normalized.some((item) => item.endsWith('programdata')),
      '候选里有 %ProgramData%'
    );

    // 全部写不进去时，错误信息要把试过的地方列出来（而不是只说"出错了"）
    fsModule.promises.mkdtemp = function mkdtemp() {
      const error = new Error('EPERM: 模拟全部不可写');
      error.code = 'EPERM';
      return Promise.reject(error);
    };

    let aggregate = '';

    try {
      await picker.makeWorkDir();
    } catch (error) {
      aggregate = error.message;
    } finally {
      fsModule.promises.mkdtemp = originalMkdtemp;
    }

    check(
      aggregate.includes('都试过了') && aggregate.includes('手动指定照片文件夹'),
      '全部失败时给出"试过哪些位置 + 怎么办"的提示',
      aggregate.split('\r\n')[0]
    );

    // PowerShell 5.1 会把没有 BOM 的 UTF-8 脚本按 ANSI 读：ps1 里出现中文就会乱码/报错。
    // 所以那个脚本必须保持纯 ASCII，中文文案靠命令行参数传进去。
    const scriptBytes = fs.readFileSync(path.join(ROOT, 'lib', 'folder-picker.ps1'));
    const nonAscii = [...scriptBytes].filter((byte) => byte > 0x7f).length;

    check(nonAscii === 0, 'folder-picker.ps1 是纯 ASCII（不会被 PS 5.1 读成乱码）', `${nonAscii} 个非 ASCII 字节`);

    // ps1 里有一条"血的教训"：FolderBrowserDialog.UseDescriptionForTitle 只存在于
    // .NET Core 5+，Windows PowerShell 5.1（.NET Framework）上根本没这个属性，
    // 赋值就 PropertyAssignmentException、整个选择窗口挂掉。
    const scriptText = scriptBytes.toString('utf8');

    check(
      !/^\s*\$dialog\.UseDescriptionForTitle\s*=/m.test(scriptText),
      'ps1 里没有给 UseDescriptionForTitle 赋值（.NET Framework 上没这个属性）'
    );

    // 真的把 PowerShell 脚本跑一遍（-SelfTest 只建对象、不弹窗）：
    // 语法、编码、属性可用性一起验掉。注意 stdio 用 ignore：
    // 受限环境里"用管道抓子进程输出"会 EPERM，所以结果写在 /ResultPath 文件里读。
    const selfTestPath = path.join(RUNTIME, 'picker-selftest.txt');
    fs.rmSync(selfTestPath, { force: true });

    const selfTest = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(ROOT, 'lib', 'folder-picker.ps1'),
        '-ResultPath',
        selfTestPath,
        '-SelfTest',
      ],
      { timeout: 60000, stdio: 'ignore' }
    );

    const selfTestText = fs.existsSync(selfTestPath)
      ? fs.readFileSync(selfTestPath, 'utf8')
      : '';

    check(
      selfTest.status === 0 && selfTestText.includes('SELFTEST OK'),
      'PowerShell 版选择脚本能正常初始化（-SelfTest）',
      `exit=${selfTest.status} 文件=${JSON.stringify(selfTestText.slice(0, 40))}`
    );

    // 首选其实是编译出来的小 exe（不经过 PowerShell）
    const exe = path.join(ROOT, 'build', 'picker', 'MyAlbumPicker.exe');

    if (fs.existsSync(exe)) {
      const probe = path.join(RUNTIME, 'picker-exe-selftest.txt');
      fs.rmSync(probe, { force: true });

      const exeTest = spawnSync(exe, [`/out=${probe}`, '/selftest'], {
        timeout: 60000,
        stdio: 'ignore',
      });

      check(
        exeTest.status === 0 && fs.readFileSync(probe, 'utf8').startsWith('SELFTEST OK'),
        'MyAlbumPicker.exe 能正常初始化（/selftest）',
        `exit=${exeTest.status}`
      );
    } else {
      check(false, 'MyAlbumPicker.exe 已编译（先跑一次 pnpm pack）', exe);
    }
  }

  console.log('');

  if (failures) {
    console.error(`安装目录规则测试失败 ${failures} 项（共 ${checks} 项）`);
    process.exitCode = 1;
    return;
  }

  console.log(`安装目录规则测试全部通过 ✓ （${checks} 项）`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});