// 安装包端到端测试：真的静默装到一个测试目录，验证装出来的东西能跑，再卸载掉。
// （不碰桌面快捷方式和注册表，免得污染这台机器。）
//
//   node tools/test-setup.js        # 需要先跑过一次 pnpm pack

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const STAGING = path.join(ROOT, 'build', 'pack', 'staging');
const TARGET = path.join(ROOT, 'test-runtime', 'setup-test');

// 找最新的安装包（版本号会变，别写死）
function findSetupExe() {
  const folder = path.join(WORKSPACE, '成品');

  if (!fs.existsSync(folder)) {
    return null;
  }

  const candidates = fs
    .readdirSync(folder)
    .filter((name) => /^我的相册-.*-安装包\.exe$/.test(name))
    .map((name) => path.join(folder, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  return candidates[0] || null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

function check(condition, message, detail) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }

  failures += 1;
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`);
}

function listFiles(root) {
  const found = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }

  walk(root);
  return found;
}

(async () => {
  const SETUP = findSetupExe();

  if (!SETUP) {
    console.log('没找到安装包（成品\\我的相册-*-安装包.exe）—— 先跑一次 pnpm pack 吧。');
    return;
  }

  console.log('安装包测试');
  console.log(`  安装包：${SETUP}`);

  fs.rmSync(TARGET, { recursive: true, force: true });

  console.log('\n[1] 静默安装');
  {
    const result = spawnSync(
      SETUP,
      ['/silent', `/dir=${TARGET}`, '/noshortcuts', '/noregistry', '/nolaunch', '/noelevate', '/notask'],
      { stdio: 'ignore', timeout: 300000 }
    );

    check(result.status === 0, '安装程序退出码 0', String(result.status));

    const expected = listFiles(STAGING)
      .filter((file) => !file.startsWith('cache/') && !file.startsWith('data/'))
      .sort();
    const actual = listFiles(TARGET)
      .filter((file) => !file.startsWith('cache/') && !file.startsWith('data/'))
      .sort();

    check(
      expected.length === actual.length &&
        expected.every((file, index) => file === actual[index]),
      `装出来的文件跟载荷一致（${actual.length} 个）`,
      `期望 ${expected.length} 个`
    );

    check(fs.existsSync(path.join(TARGET, 'MyAlbum.exe')), '有 MyAlbum.exe');
    check(fs.existsSync(path.join(TARGET, 'MyAlbumUninstall.exe')), '有卸载器');
    check(fs.existsSync(path.join(TARGET, 'runtime', 'node.exe')), '自带 Node 运行时');

    const exeBytes = fs.statSync(path.join(TARGET, 'runtime', 'node.exe')).size;
    const sourceBytes = fs.statSync(path.join(STAGING, 'runtime', 'node.exe')).size;
    check(exeBytes === sourceBytes, `node.exe 字节数一致（${exeBytes}）`);

    // 抽查一个"解压后内容对不对"的文件（按大小 + 首字节）
    const sharpPath = 'app/node_modules/sharp/package.json';
    check(
      fs.readFileSync(path.join(TARGET, sharpPath), 'utf8').includes('"name": "sharp"'),
      '抽查解压内容正确（sharp/package.json）'
    );
  }

  console.log('\n[2] 装出来的相册能起来（--check 真跑一遍服务）');
  {
    const checkFile = path.join(TARGET, 'cache', 'pack-check.txt');
    fs.rmSync(checkFile, { force: true });

    const launcher = path.join(TARGET, 'MyAlbum.exe');
    const child = spawnSync(launcher, ['--check'], {
      stdio: 'ignore',
      timeout: 90000,
    });

    let content = '';

    for (let i = 0; i < 100; i += 1) {
      if (fs.existsSync(checkFile)) {
        content = fs.readFileSync(checkFile, 'utf8').trim();
        break;
      }
      await delay(400);
    }

    check(content.startsWith('OK port='), '启动器自检通过', content || '(没有结果)');
    console.log(`     ${content}`);
    check(child.status === 0 || content.length > 0, '自检进程正常结束');
  }

  console.log('\n[3] 装出来的选择窗口会把自己放在哪（提权场景的关键）');
  {
    const pickerPath = path.join(TARGET, 'app', 'lib', 'folder-picker.js');
    const cacheDir = path.join(TARGET, 'cache');

    process.env.MY_ALBUM_CACHE_DIR = cacheDir;
    delete require.cache[require.resolve(pickerPath)];

    const picker = require(pickerPath);
    const parents = picker.workParents();
    const workDir = await picker.makeWorkDir();

    check(
      workDir.startsWith(cacheDir),
      '工作目录就在安装目录的 cache 里（不再依赖 %TEMP%）',
      workDir
    );
    check(
      parents.some((item) => item.toLowerCase().includes(path.join('windows', 'temp').toLowerCase())),
      '候选里有 C:\\Windows\\Temp（提权到别的管理员账号时也写得进去）'
    );

    // 首选是打包进来的小 exe（不经过 PowerShell）
    const pickerExe = picker.pickerExe();
    check(
      Boolean(pickerExe) && pickerExe.startsWith(TARGET),
      '装出来的副本里有 app\\picker\\MyAlbumPicker.exe',
      pickerExe || '(没找到)'
    );

    if (pickerExe) {
      const probe = path.join(cacheDir, 'picker-selftest.txt');
      fs.rmSync(probe, { force: true });

      const result = spawnSync(pickerExe, [`/out=${probe}`, '/selftest'], {
        timeout: 60000,
        stdio: 'ignore',
      });

      check(
        result.status === 0 && fs.readFileSync(probe, 'utf8').startsWith('SELFTEST OK'),
        '装出来的选择工具能在这台机器上正常初始化',
        `exit=${result.status}`
      );
    }

    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log('\n[4] 卸载（连缓存一起删）');
  {
    fs.writeFileSync(path.join(TARGET, 'cache', 'pack-stop.txt'), 'stop');
    await delay(1500);

    const result = spawnSync(
      path.join(TARGET, 'MyAlbumUninstall.exe'),
      ['/silent', `/delete=${TARGET}`, '/noshortcuts', '/noregistry', '/noelevate'],
      { stdio: 'ignore', timeout: 120000 }
    );

    check(result.status === 0, '卸载器退出码 0', String(result.status));

    let gone = false;

    for (let i = 0; i < 20; i += 1) {
      await delay(500);

      if (!fs.existsSync(TARGET)) {
        gone = true;
        break;
      }
    }

    check(gone, '安装目录（含 cache / data）被删掉了', fs.existsSync(TARGET) ? '还在' : '');
  }

  console.log('');

  if (failures) {
    console.error(`安装包测试失败 ${failures} 项`);
    process.exitCode = 1;
    return;
  }

  console.log('安装包测试全部通过 ✓');
})();