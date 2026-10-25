// 打包：产出「安装包」用的载荷，以及一份可以直接双击运行的免安装版。
//
//   node tools/pack.js                  # 建载荷 + 安装包 + 免安装版（不需要 Inno Setup）
//   node tools/pack.js --installer      # 上面全做，再用 ISCC 编译一份 Inno 版安装包
//   node tools/pack.js --skip-check     # 跳过"真跑一遍服务"的自检（不推荐）
//
// 产出：
//   build/pack/staging/                 安装包的载荷（runtime\node.exe + app\ + MyAlbum.exe）
//   成品/我的相册-<版本>-安装包.exe       自己的安装程序（自包含）
//   成品/我的相册-<版本>-免安装版/        同一个载荷的拷贝，双击 MyAlbum.exe 就能用
//
// 过程里会做这些自检，任何一步失败就中断：
//   · 用载荷里的依赖真跑 sharp / HEIC 解码（含 ICC）/ mp4box / exifr / ffmpeg
//   · 用打包好的启动器真的拉起一次服务，探测 /api/cache、/api/source、/api/library/summary
//   · 安装载荷解压自检（字节数必须对得上）
//   · 给所有 exe 做代码签名（自签证书也能签；正式证书走环境变量，见 tools/sign.js）

'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const { signFiles } = require('./sign');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const BUILD = path.join(ROOT, 'build', 'pack');
const STAGING = path.join(BUILD, 'staging');
const PORTABLE_ROOT = path.join(WORKSPACE, '成品');
const NODE_MODULES = path.join(ROOT, 'node_modules');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const APP_FILES = ['server.js', 'lib', 'public', 'assets'];
const LAUNCHER_SOURCE = path.join(ROOT, 'installer', 'launcher', 'MyAlbum.cs');
const PICKER_SOURCE = path.join(ROOT, 'installer', 'picker', 'MyAlbumPicker.cs');
const PICKER_BUILD_DIR = path.join(ROOT, 'build', 'picker');
const SETUP_BUILD = path.join(BUILD, 'setup');
const SETUP_SOURCE = path.join(ROOT, 'installer', 'setup', 'MyAlbumSetup.cs');
const UNINSTALL_EXE = 'MyAlbumUninstall.exe';
const ISS_FILE = path.join(ROOT, 'installer', 'my-album.iss');

const conflicts = [];
const skipped = [];

function log(message) {
  console.log(message);
}

function findCsc() {
  const windows = process.env.WINDIR || 'C:\\Windows';

  const candidates = [
    path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function dirSize(target) {
  let total = 0;

  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else {
        total += (await fsp.stat(full)).size;
      }
    }
  }

  await walk(target);
  return total;
}

// --- 复制 -------------------------------------------------------------------

async function copyTree(from, to, { skipNames = [], filter = null } = {}) {
  const stat = await fsp.lstat(from);

  if (stat.isSymbolicLink()) {
    return copyTree(await fsp.realpath(from), to, { skipNames, filter });
  }

  if (stat.isDirectory()) {
    await fsp.mkdir(to, { recursive: true });

    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      if (skipNames.includes(entry.name)) {
        continue;
      }

      if (filter && !filter(entry)) {
        continue;
      }

      await copyTree(path.join(from, entry.name), path.join(to, entry.name), {
        skipNames,
        filter,
      });
    }

    return;
  }

  await fsp.copyFile(from, to);
}

// --- 生产依赖闭包 -----------------------------------------------------------
//
// pnpm 的真实包目录在 node_modules/.pnpm/<包名>@<版本>/node_modules/<包名>，
// 包与包之间的依赖是**同级目录里的符号链接**。走一遍这个结构，把每个包搬成
// 扁平的 node_modules/<包名>，Node 的解析规则就能在目标机上正常工作。

async function resolvePackage(fromDir, name) {
  const candidate = path.join(fromDir, name);

  try {
    await fsp.access(candidate);
    return await fsp.realpath(candidate);
  } catch {
    return null;
  }
}

async function collectClosure(roots, output) {
  const seen = new Map(); // 包名 → 真实目录（第一个版本胜出）
  const queue = roots.map((name) => ({ name, fromDir: NODE_MODULES }));

  while (queue.length) {
    const { name, fromDir } = queue.shift();
    const real = await resolvePackage(fromDir, name);

    if (!real) {
      skipped.push(`${name}（在 ${path.relative(ROOT, fromDir)} 里找不到）`);
      continue;
    }

    if (seen.has(name)) {
      if (seen.get(name) !== real) {
        conflicts.push(`${name}：${seen.get(name)} → 保留，${real} → 丢弃`);
      }

      continue;
    }

    seen.set(name, real);
    output.set(name, real);

    let manifest;

    try {
      manifest = JSON.parse(await fsp.readFile(path.join(real, 'package.json'), 'utf8'));
    } catch {
      continue;
    }

    const deps = {
      ...(manifest.dependencies || {}),
      ...(manifest.optionalDependencies || {}),
    };

    // 包自己的依赖放在"包目录的兄弟位置"（pnpm 的虚拟 store 布局）
    const siblingDir = path.dirname(real);

    for (const dep of Object.keys(deps)) {
      queue.push({ name: dep, fromDir: siblingDir });
    }

    // peerDependencies 只在真的装上了才算数
    for (const dep of Object.keys(manifest.peerDependencies || {})) {
      if (!seen.has(dep)) {
        queue.push({ name: dep, fromDir: siblingDir });
      }
    }
  }

  return seen;
}

async function buildNodeModules(target) {
  const roots = Object.keys(pkg.dependencies || {});
  const closure = new Map();

  log(`· 解析生产依赖闭包（从 ${roots.length} 个直接依赖出发）…`);
  await collectClosure(roots, closure);

  await fsp.mkdir(target, { recursive: true });

  let bytes = 0;

  for (const [name, real] of closure) {
    const destination = path.join(target, name);
    await copyTree(real, destination, { skipNames: ['node_modules'] });
    bytes += await dirSize(destination);
  }

  log(
    `  包 ${closure.size} 个，合计 ${(bytes / 1048576).toFixed(1)} MB` +
      (conflicts.length ? `，同名冲突 ${conflicts.length} 处（保留先到的版本）` : '')
  );

  for (const note of skipped) {
    log(`  · 跳过（平台不需要或未安装）：${note}`);
  }

  for (const note of conflicts) {
    log(`  ! 依赖版本冲突：${note}`);
  }
}

// --- 瘦身：只删"肯定用不到"的东西 --------------------------------------------
//
// 原则：只删开发期产物和明确没被引用的构建产物，不碰任何会被 require 的文件。
// 删完会立刻用它自己的 node_modules 真跑一遍探针（pack-probe-native.js）验证。
async function prunePackageFiles(target) {
  const junkDirs = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'docs']);
  let removedBytes = 0;
  let removedFiles = 0;

  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (junkDirs.has(entry.name.toLowerCase())) {
          removedBytes += await dirSize(full);
          await fsp.rm(full, { recursive: true, force: true });
          continue;
        }

        await walk(full);
        continue;
      }

      const isMap = entry.name.endsWith('.map');
      const isTypeFile = entry.name.endsWith('.d.ts');
      // libheif-js 带了三份构建：我们只用 wasm-bundle（heic-decode 就是这么引的），
      // 另外两份（asm.js 的 libheif/ 和 ESM 的 .mjs）删掉省 5 MB。
      const isUnusedHeif =
        full.includes(`${path.sep}libheif-js${path.sep}`) &&
        (full.includes(`${path.sep}libheif${path.sep}`) ||
          full.endsWith('libheif-bundle.mjs'));

      if (isMap || isTypeFile || isUnusedHeif) {
        removedBytes += (await fsp.stat(full)).size;
        removedFiles += 1;
        await fsp.rm(full, { force: true });
      }
    }
  }

  await walk(target);

  log(
    `· 瘦身：删掉 ${removedFiles} 个用不到的文件` +
      `（source map / 类型声明 / 示例 / libheif 的另两份构建），省 ${(removedBytes / 1048576).toFixed(1)} MB`
  );
}

// --- 编译 -------------------------------------------------------------------

function buildPickerTool() {
  const csc = findCsc();

  if (!csc) {
    throw new Error('找不到 csc.exe（.NET Framework 4.x 自带）。请在 Windows 上打包。');
  }

  fs.mkdirSync(PICKER_BUILD_DIR, { recursive: true });

  const target = path.join(PICKER_BUILD_DIR, 'MyAlbumPicker.exe');

  execFileSync(csc, [
    '/nologo',
    '/target:winexe',
    `/out:${target}`,
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    `/win32icon:${path.join(ROOT, 'assets', 'icon.ico')}`,
    PICKER_SOURCE,
  ], { stdio: 'inherit' });

  log(`· 文件夹选择工具编译完成：${path.relative(ROOT, target)}`);

  return target;
}

function buildLauncher(executablePath) {
  const csc = findCsc();

  if (!csc) {
    throw new Error('找不到 csc.exe（.NET Framework 4.x 自带）。请在 Windows 上打包。');
  }

  execFileSync(csc, [
    '/nologo',
    '/target:winexe',
    `/out:${executablePath}`,
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    `/win32icon:${path.join(ROOT, 'assets', 'icon.ico')}`,
    LAUNCHER_SOURCE,
  ], { stdio: 'inherit' });

  log(`· 启动器编译完成：${path.relative(ROOT, executablePath)}`);
}

// --- 自检：真的把服务跑起来 -------------------------------------------------

function request(port, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );

    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selfCheck() {
  const executable = path.join(STAGING, 'MyAlbum.exe');
  const cacheDir = path.join(STAGING, 'cache');
  const checkFile = path.join(cacheDir, 'pack-check.txt');
  const stopFile = path.join(cacheDir, 'pack-stop.txt');

  await fsp.rm(checkFile, { force: true });
  await fsp.rm(stopFile, { force: true });

  log('· 自检：用打包好的启动器真的拉起一次服务…');

  const child = spawn(executable, ['--check'], { cwd: STAGING, stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  let content = null;

  while (Date.now() < deadline) {
    try {
      content = (await fsp.readFile(checkFile, 'utf8')).trim();
      break;
    } catch {
      await delay(300);
    }

    if (child.exitCode !== null) {
      break;
    }
  }

  if (!content || content.startsWith('FAIL')) {
    throw new Error(
      `自检失败：${content || '启动器没有写出结果'}（看 build\\pack\\staging\\cache\\server.log）`
    );
  }

  const port = Number((/port=(\d+)/.exec(content) || [])[1]);

  if (!port) {
    throw new Error(`自检失败：${content}`);
  }

  const cacheStatus = await request(port, '/api/cache', 8000);
  log(`  服务起来了：/api/cache → HTTP ${cacheStatus}（端口 ${port}）`);

  if (cacheStatus !== 200) {
    throw new Error(`自检失败：/api/cache 返回 ${cacheStatus}`);
  }

  log(`  /api/source → HTTP ${await request(port, '/api/source', 8000)}`);
  log(`  /api/library/summary → HTTP ${await request(port, '/api/library/summary', 8000)}`);
  log(`  /api/health → HTTP ${await request(port, '/api/health', 8000)}`);

  // 让启动器自己收工（它会连带把 node 一起关掉，不留孤儿进程）
  await fsp.writeFile(stopFile, 'stop', 'utf8');

  for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt += 1) {
    await delay(500);
  }

  if (child.exitCode === null) {
    child.kill();
  }

  log('  自检通过 ✓');
}

// 自检会在载荷里留下日志/索引等运行产物，装到用户机器上不该带着它们
async function cleanRuntimeDirs() {
  for (const name of ['cache', 'data']) {
    await fsp.rm(path.join(STAGING, name), { recursive: true, force: true });
  }
}

function findHeicSample() {
  if (process.env.MY_ALBUM_PACK_HEIC) {
    return process.env.MY_ALBUM_PACK_HEIC;
  }

  const testmedia = path.join(WORKSPACE, 'testmedia');

  try {
    const entry = fs.readdirSync(testmedia).find((name) => /\.(heic|heif)$/i.test(name));
    return entry ? path.join(testmedia, entry) : '';
  } catch {
    return '';
  }
}

function verifyNativeDeps() {
  log('· 自检：用载荷里的依赖真跑一遍（sharp / HEIC 解码 + 补 ICC / ffmpeg）…');

  execFileSync(
    process.execPath,
    [path.join(__dirname, 'pack-probe-native.js'), path.join(STAGING, 'app'), findHeicSample()],
    { stdio: 'inherit' }
  );
}

// --- 组装 -------------------------------------------------------------------

async function buildStaging() {
  await fsp.rm(BUILD, { recursive: true, force: true });
  await fsp.mkdir(STAGING, { recursive: true });

  const appDir = path.join(STAGING, 'app');
  await fsp.mkdir(appDir, { recursive: true });

  log('· 复制应用文件…');

  for (const name of APP_FILES) {
    await copyTree(path.join(ROOT, name), path.join(appDir, name));
  }

  await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));

  for (const name of ['LICENSE', 'README.md']) {
    const from = path.join(ROOT, name);

    if (fs.existsSync(from)) {
      await fsp.copyFile(from, path.join(appDir, name));
    }
  }

  await fsp.mkdir(path.join(STAGING, 'runtime'), { recursive: true });
  await fsp.copyFile(process.execPath, path.join(STAGING, 'runtime', 'node.exe'));
  log(`· 自带 Node：${path.basename(process.execPath)}（${process.version}）`);

  await buildNodeModules(path.join(appDir, 'node_modules'));
  await prunePackageFiles(path.join(appDir, 'node_modules'));

  // 文件夹选择工具：装到 app\picker\，服务端优先用它（不经过 PowerShell）
  const pickerExe = buildPickerTool();
  await fsp.mkdir(path.join(appDir, 'picker'), { recursive: true });
  await fsp.copyFile(pickerExe, path.join(appDir, 'picker', 'MyAlbumPicker.exe'));

  buildLauncher(path.join(STAGING, 'MyAlbum.exe'));

  // 签名要在"打进载荷之前"做，否则装出来的 exe 是没签名的
  await signFiles([
    path.join(STAGING, 'MyAlbum.exe'),
    path.join(appDir, 'picker', 'MyAlbumPicker.exe'),
  ]);

  await fsp.writeFile(
    path.join(STAGING, 'install.json'),
    JSON.stringify(
      {
        name: '我的相册',
        version: VERSION,
        mode: 'installed',
        builtAt: new Date().toISOString(),
        node: process.version,
        paths: { cache: 'cache', data: 'data' },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  log('· 载荷就绪：build\\pack\\staging');
}

function listFiles(root) {
  const found = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push({
          relative: path.relative(root, full).split(path.sep).join('/'),
          full,
          size: fs.statSync(full).size,
        });
      }
    }
  }

  walk(root);
  // 顺序固定下来，装出来的东西每次一样
  found.sort((left, right) => (left.relative < right.relative ? -1 : 1));
  return found;
}

// 载荷格式（C# 那边只用一个 DeflateStream 顺序读，见 installer/setup/MyAlbumSetup.cs）：
//   MYALBUM1\n
//   <条目数>\n
//   <相对路径>\t<字节数>\n   × N
//   \n
//   <所有文件按上面顺序首尾相接、整段 raw deflate>
async function buildPayload(target) {
  // 先把卸载器放进载荷（安装完它会躺在安装目录里）
  await fsp.copyFile(path.join(SETUP_BUILD, UNINSTALL_EXE), path.join(STAGING, UNINSTALL_EXE));

  const files = listFiles(STAGING).filter(
    (file) => !file.relative.startsWith('cache/') && !file.relative.startsWith('data/')
  );

  const header =
    ['MYALBUM1', String(files.length)]
      .concat(files.map((file) => `${file.relative}\t${file.size}`))
      .join('\n') + '\n\n';

  // 先把所有文件读进内存再整段压缩。
  // 试过"把 N 个读流依次 pipe 进同一个 deflate"，出来的载荷是坏的
  // （zlib 解到一半 Z_DATA_ERROR，安装时只还原得出第一个文件）—— 不折腾了，
  // 一个 Buffer.concat + deflateRawSync，简单、可验证；峰值内存约 300 MB，打包机扛得住。
  const parts = [];

  for (const file of files) {
    parts.push(await fsp.readFile(file.full));
  }

  const flat = Buffer.concat(parts);
  const compressed = zlib.deflateRawSync(flat, { level: 9 });
  const headerBuffer = Buffer.from(header, 'utf8');
  const payload = Buffer.concat([headerBuffer, compressed]);

  await fsp.writeFile(target, payload);

  // 自己先验一遍：载荷必须是"能完整解开、字节数正好对得上"的
  const inflated = zlib.inflateRawSync(payload.subarray(headerBuffer.length));

  if (inflated.length !== flat.length || !inflated.equals(flat)) {
    throw new Error(`安装载荷自检没过：解压出 ${inflated.length} 字节，应该是 ${flat.length} 字节`);
  }

  log(
    `· 安装载荷：${files.length} 个文件 → ${(payload.length / 1048576).toFixed(1)} MB` +
      `（未压缩 ${(flat.length / 1048576).toFixed(1)} MB，自检 ✓）`
  );

  return files.length;
}

async function buildSetup() {
  const csc = findCsc();

  if (!csc) {
    throw new Error('找不到 csc.exe（.NET Framework 4.x 自带）。请在 Windows 上打包。');
  }

  await fsp.mkdir(SETUP_BUILD, { recursive: true });

  const common = [
    '/nologo',
    '/target:winexe',
    '/nowarn:162,429', // /define 之后另一半代码必然"不可达"，不是问题
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:System.IO.Compression.dll',
    `/win32icon:${path.join(ROOT, 'assets', 'icon.ico')}`,
  ];

  log('· 编译卸载器…');
  const uninstallerPath = path.join(SETUP_BUILD, UNINSTALL_EXE);

  execFileSync(csc, [
    ...common,
    '/define:UNINSTALL',
    `/out:${uninstallerPath}`,
    SETUP_SOURCE,
  ], { stdio: 'inherit' });

  await signFiles([uninstallerPath]);

  const payload = path.join(SETUP_BUILD, 'payload.bin');
  await buildPayload(payload);

  const target = path.join(PORTABLE_ROOT, `我的相册-${VERSION}-安装包.exe`);
  await fsp.mkdir(PORTABLE_ROOT, { recursive: true });

  log('· 编译安装包…');
  execFileSync(csc, [
    ...common,
    `/out:${target}`,
    `/resource:${payload},payload.bin`,
    SETUP_SOURCE,
  ], { stdio: 'inherit' });

  await signFiles([target]);

  return target;
}

async function copyToPortable() {
  const target = path.join(PORTABLE_ROOT, `我的相册-${VERSION}-免安装版`);

  await fsp.mkdir(PORTABLE_ROOT, { recursive: true });

  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `旧的免安装版目录删不掉（${error.code || error.message}）：\n` +
        `  ${target}\n` +
        '  多半是上一次启动的相册还在跑（它占着里面的 exe）。\n' +
        '  从托盘右键"退出"，或在任务管理器里结束 MyAlbum.exe / node.exe，然后重跑打包。'
    );
  }

  log('· 生成免安装版…');
  await copyTree(STAGING, target, { skipNames: ['cache', 'data', UNINSTALL_EXE] });

  return target;
}

// --- 可选的 Inno Setup 路径 -------------------------------------------------

function findIscc() {
  const explicit = process.env.ISCC_PATH;

  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function buildInnoInstaller() {
  const iscc = findIscc();

  if (!iscc) {
    log('');
    log('· 没找到 Inno Setup 的 ISCC.exe，跳过 Inno 版安装包。');
    log('  （我们自己的安装包已经产出了；这条只是额外可选项）');
    return false;
  }

  log(`· 用 Inno Setup 编译额外一份安装包（${iscc}）…`);
  execFileSync(iscc, [`/DMyAppVersion=${VERSION}`, `/DMyPayload=${STAGING}`, ISS_FILE], {
    stdio: 'inherit',
  });

  return true;
}

// --- 主流程 -----------------------------------------------------------------

async function main() {
  const withInstaller = process.argv.includes('--installer');
  const skipCheck = process.argv.includes('--skip-check');

  log(`我的相册 ${VERSION} · 打包`);
  log('');

  await buildStaging();
  verifyNativeDeps();

  if (!skipCheck) {
    await selfCheck();
    await cleanRuntimeDirs();
  }

  const setupExe = await buildSetup();
  log(`· 安装包：${path.relative(WORKSPACE, setupExe)}`);

  let portable = null;

  try {
    portable = await copyToPortable();
    log(`· 免安装版：${path.relative(WORKSPACE, portable)}`);
  } catch (error) {
    // 免安装版只是附带的产物：上一次的相册还在跑就会删不掉目录，
    // 这种情况不该让整个打包失败（安装包已经好了）。
    log('');
    log(`! 免安装版没有重新生成：${error.message}`);
    log('  （安装包不受影响；想刷新免安装版就先把正在跑的相册退出，再重跑打包）');
  }

  let innoBuilt = false;

  if (withInstaller) {
    innoBuilt = buildInnoInstaller();
  }

  const payloadBytes = await dirSize(STAGING);
  const setupBytes = (await fsp.stat(setupExe)).size;

  log('');
  log(`完成：载荷 ${(payloadBytes / 1048576).toFixed(1)} MB（未压缩）`);
  log(`      安装包 ${(setupBytes / 1048576).toFixed(1)} MB`);

  if (portable) {
    log(`      免安装版 ${((await dirSize(portable)) / 1048576).toFixed(1)} MB`);
  } else {
    log('      免安装版 未更新（见上面的提示）');
  }

  log('');
  log('安装包用法：双击 → 装到 %USERPROFILE%\\AppData\\Local\\Programs\\我的相册');
  log('           静默/自动化：安装包.exe /silent /dir=<路径> /noshortcuts /nolaunch');
  log('           卸载：<安装目录>\\MyAlbumUninstall.exe（缓存和索引一起删）');
  log('');
  log('整理成 GitHub Release 用的形式：pnpm release');

  if (!innoBuilt) {
    log('');
    log('（另有一份 Inno Setup 脚本 installer\\my-album.iss，装了 Inno Setup 6 后');
    log('  可以用 `node tools\\pack.js --installer` 再产出一个 Inno 版安装包。）');
  }
}

main().catch((error) => {
  console.error('');
  console.error(`打包失败：${error.message}`);
  process.exitCode = 1;
});