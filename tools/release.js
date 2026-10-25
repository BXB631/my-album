// 把打包好的东西整理成"可以直接传到 GitHub Release"的样子。
//
//   node tools/release.js            # 产出 release\v<版本>\
//
// 产出（release\v<版本>\）：
//   我的相册-<版本>-安装包.exe        安装程序（已签名）
//   我的相册-<版本>-免安装版.zip      解开就能用（双击 MyAlbum.exe）
//   我的相册-<版本>-源码.zip          要上传到仓库源码（不含 node_modules / 构建产物）
//   SHA256SUMS.txt                   校验和（贴到 Release 说明里给用户核对）
//   RELEASE-NOTES.md                 直接当 Release 正文用
//   PUSH-TO-GITHUB.md                一步步的上传命令
//
// 依赖：PowerShell 的 [System.IO.Compression.ZipFile]（.NET Framework 自带）来打 zip。

'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const RELEASE_ROOT = path.join(WORKSPACE, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TARGET = path.join(RELEASE_ROOT, `v${VERSION}`);

// 源码包里不要带的东西
const SOURCE_EXCLUDES = new Set([
  'node_modules',
  'build',
  'cache',
  'data',
  'test-runtime',
  'release',
  '成品',
  '.git',
  // 开发用自签证书（带私钥）绝不能发出去
  '.signing',
]);

function log(message) {
  console.log(message);
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

// 说明：脚本本身必须保持纯 ASCII（PowerShell 5.1 把无 BOM 的 UTF-8 脚本按 ANSI 读），
// 所以路径一律当**参数**传进去 —— 参数是 UTF-16，中文不会出问题。
// （踩过坑：把中文路径直接写进 .ps1，写文件时用 ascii 编码，路径就烂了。）
const ZIP_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Excludes = '',
  [Parameter(Mandatory = $true)][string]$CountFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$excludeList = @()
if ($Excludes.Length -gt 0) { $excludeList = $Excludes.Split(',') }

if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }

$files = Get-ChildItem -LiteralPath $Source -Recurse -File | Where-Object {
  $relative = $_.FullName.Substring($Source.Length + 1)
  $top = $relative.Split([char]92, [char]47)[0]
  -not ($excludeList -contains $top)
}

$archive = [System.IO.Compression.ZipFile]::Open($Target, 'Create')
try {
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Source.Length + 1)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $archive.Dispose()
}

[System.IO.File]::WriteAllText($CountFile, [string]$files.Count, (New-Object System.Text.UTF8Encoding($false)))
`;

function zipDirectory(source, target, excludes = new Set()) {
  const scriptPath = path.join(ROOT, 'build', 'release-zip.ps1');
  const countFile = path.join(ROOT, 'build', 'release-zip-count.txt');

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, ZIP_SCRIPT, 'ascii');
  fs.rmSync(countFile, { force: true });

  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Source',
      source,
      '-Target',
      target,
      '-Excludes',
      [...excludes].join(','),
      '-CountFile',
      countFile,
    ],
    { stdio: 'ignore' }
  );

  if (!fs.existsSync(target)) {
    throw new Error(`打包失败：${target} 没生成（看 ${scriptPath}）`);
  }

  return fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8').trim()) || 0 : 0;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findArtifact(pattern) {
  const folder = path.join(WORKSPACE, '成品');

  if (!fs.existsSync(folder)) {
    return null;
  }

  const candidates = fs
    .readdirSync(folder)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(folder, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  return candidates[0] || null;
}

function releaseNotes(assets) {
  return `# 我的相册 ${VERSION}

本地照片/视频浏览器：扫一个文件夹，按时间轴浏览，支持 HEIC 直出与色彩修复、实况照片、
HEVC 视频直出（转码兜底）、大相册流式加载。自包含，**目标机器不需要装 Node**。

## 下载哪个

| 文件 | 说明 |
| --- | --- |
| \`我的相册-${VERSION}-安装包.exe\` | 推荐。双击安装到 \`%USERPROFILE%\\AppData\\Local\\Programs\\我的相册\`，装完有桌面快捷方式；卸载时连缓存一起删 |
| \`我的相册-${VERSION}-免安装版.zip\` | 解压后双击 \`MyAlbum.exe\` 就能用（缓存/索引/设置都在这个文件夹里） |
| \`我的相册-${VERSION}-源码.zip\` | 源码（想看代码/自己构建用） |

## 校验（可选）

\`\`\`
${assets.map((asset) => `${asset.hash}  ${asset.name}`).join('\n')}
\`\`\`

Windows 上核对：

\`\`\`powershell
Get-FileHash .\\我的相册-${VERSION}-安装包.exe -Algorithm SHA256
\`\`\`

## 安装/使用

1. 双击安装包 → 选目录（默认在用户目录下）→ 安装（会请求一次管理员权限，用于登记"免 UAC 启动"）
2. 双击桌面快捷方式 → 用你默认的浏览器开一个无边框窗口
3. 进相册后点 **选择照片文件夹**，选你的照片目录
4. 退出：托盘图标右键 → 退出（关窗口不会退出）

## 说明

- **首次运行会被 SmartScreen 拦一下**：安装包是用自签证书签的，只能证明"这一批文件同源"，
  别人机器上仍然会提示"未知发布者"。要有正式信誉需要 CA 签发的代码签名证书。
- 数据位置：安装版的缓存/索引/设置都在安装目录里（\`cache\`、\`data\`）；
  卸载会连它们一起删掉，原始照片不受影响。
- 已知限制：浏览器/显卡不支持 HEVC 时会转码（第一次看会等一两秒）；
  HEIC 预览有 2560px 上限；实况照片需要 HEIC + MOV 同名配对。

完整改动见仓库里的 \`CHANGELOG.md\`。
`;
}

const pushGuide = (assets) => `# 传到 GitHub（照抄即可）

## 1. 源码仓库

把 \`2.0\` 这个目录作为仓库根目录（它已经是干净的：\`node_modules\`、\`build\`、\`cache\`、
\`data\`、\`test-runtime\`、\`成品\` 都在 \`.gitignore\` 里）。

\`\`\`powershell
cd <2.0 目录>
git init
git add .
git commit -m "我的相册 ${VERSION}"
git branch -M main
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
\`\`\`

> 仓库里放了 \`.gitattributes\`：\`.bat\` / \`.ps1\` 按 CRLF 存，\`.ps1\` 还要保持纯 ASCII
> （PowerShell 5.1 会把没有 BOM 的 UTF-8 当 ANSI 读，中文会变乱码甚至报语法错）。

## 2. 打 tag + 建 Release

用 GitHub CLI（推荐）：

\`\`\`powershell
git tag v${VERSION}
git push origin v${VERSION}

gh release create v${VERSION} \`
  --title "我的相册 ${VERSION}" \`
  --notes-file release\\v${VERSION}\\RELEASE-NOTES.md \`
${assets.map((asset) => `  "release\\v${VERSION}\\${asset.name}"`).join(" `\n")}
\`\`\`

没有 gh 就手动来：仓库页面 → Releases → Draft a new release → 选 tag \`v${VERSION}\` →
把 \`RELEASE-NOTES.md\` 的内容贴进说明 → 把上面几个文件拖进附件区 → Publish。

## 3. 以后发新版

1. 改 \`package.json\` 的 \`version\`
2. 更新 \`CHANGELOG.md\`
3. \`pnpm pack\`（会编译 + 自检 + 签名）、\`pnpm release\`（整理 release 目录）
4. 重复第 2 步（tag + Release）
`;

async function main() {
  log(`我的相册 ${VERSION} · 整理发布件`);

  const installer = findArtifact(/^我的相册-.*-安装包\.exe$/);
  // 免安装版的 zip 直接从 build\pack\staging 打（那是刚通过自检的那棵树），
  // 不去碰 成品\ 里的目录 —— 万一有进程占着它的文件，打包也不会受影响。
  const staging = path.join(ROOT, 'build', 'pack', 'staging');

  if (!installer) {
    throw new Error('成品\\ 里没有找到安装包，先跑一次 `pnpm pack` 吧。');
  }

  if (!fs.existsSync(path.join(staging, 'MyAlbum.exe'))) {
    throw new Error('build\\pack\\staging 里没有东西，先跑一次 `pnpm pack` 吧。');
  }

  await fsp.rm(TARGET, { recursive: true, force: true });
  await fsp.mkdir(TARGET, { recursive: true });

  const installerName = `我的相册-${VERSION}-安装包.exe`;
  const portableName = `我的相册-${VERSION}-免安装版.zip`;
  const sourceName = `我的相册-${VERSION}-源码.zip`;

  log('· 复制安装包…');
  await fsp.copyFile(installer, path.join(TARGET, installerName));

  log('· 打免安装版的 zip…');
  const portableCount = zipDirectory(
    staging,
    path.join(TARGET, portableName),
    new Set(['cache', 'data', 'MyAlbumUninstall.exe'])
  );

  log('· 打源码 zip…');
  const sourceCount = zipDirectory(ROOT, path.join(TARGET, sourceName), SOURCE_EXCLUDES);

  const assets = [installerName, portableName, sourceName].map((name) => {
    const file = path.join(TARGET, name);
    return { name, size: fs.statSync(file).size, hash: sha256(file) };
  });

  await fsp.writeFile(
    path.join(TARGET, 'SHA256SUMS.txt'),
    assets.map((asset) => `${asset.hash}  ${asset.name}`).join('\n') + '\n',
    'utf8'
  );

  await fsp.writeFile(path.join(TARGET, 'RELEASE-NOTES.md'), releaseNotes(assets), 'utf8');
  await fsp.writeFile(path.join(TARGET, 'PUSH-TO-GITHUB.md'), pushGuide(assets), 'utf8');

  log('');
  log(`产出目录：release\\v${VERSION}\\`);

  for (const asset of assets) {
    log(`  ${asset.name}  ${(asset.size / 1048576).toFixed(1)} MB  ${asset.hash.slice(0, 16)}…`);
  }

  log(`  SHA256SUMS.txt / RELEASE-NOTES.md / PUSH-TO-GITHUB.md`);
  log('');
  log(`（免安装版 ${portableCount} 个文件；源码 ${sourceCount} 个文件）`);

  const total = await dirSize(TARGET);
  log(`合计 ${(total / 1048576).toFixed(1)} MB`);
}

main().catch((error) => {
  console.error('');
  console.error(`整理发布件失败：${error.message}`);
  process.exitCode = 1;
});