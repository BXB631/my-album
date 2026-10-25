// 给 exe 做代码签名（Authenticode）。
//
//   node tools/sign.js <文件...>                  # 用开发自签证书签（会自动生成）
//   node tools/sign.js --required <文件...>        # 签不上就当失败
//
// 证书来源（优先级从高到低）：
//   1. MY_ALBUM_SIGN_PFX + MY_ALBUM_SIGN_PASSWORD   —— 你买的正经证书（.pfx）
//   2. MY_ALBUM_SIGN_THUMBPRINT                     —— 证书已经在证书库里（按指纹找）
//   3. 开发自签证书 build\signing\dev-cert.pfx      —— 默认，第一次自动生成
// 可选：MY_ALBUM_SIGN_TIMESTAMP=<URL> 加时间戳（需要联网；离线时别设）
//
// 说明：自签证书只能证明"这几个 exe 是同一个来源"，**不会**消掉别人机器上的
// SmartScreen 警告 —— 那需要 CA 签发的证书（EV 证书立刻有信誉，OV 要攒）。等你有正式证书，
// 把 pfx 路径塞进环境变量再打包即可，其余流程不用改。

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const RESULT_FILE = path.join(BUILD, 'signing', 'result.json');
// 开发用自签证书放在 build\ 外面：build\ 每次打包都会被清空，
// 放里面会导致每次打包换一张证书（指纹乱变、也没法累积"同源"印象）。
const DEV_PFX = path.join(ROOT, '.signing', 'dev-cert.pfx');

function runOnce(files) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.rmSync(RESULT_FILE, { force: true });

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'sign.ps1'),
    '-Files',
    ...files,
    '-ResultFile',
    RESULT_FILE,
  ];

  const pfx = process.env.MY_ALBUM_SIGN_PFX;
  const password = process.env.MY_ALBUM_SIGN_PASSWORD || '';

  if (pfx) {
    args.push('-Pfx', pfx, '-Password', password);
  } else if (process.env.MY_ALBUM_SIGN_THUMBPRINT) {
    args.push('-Thumbprint', process.env.MY_ALBUM_SIGN_THUMBPRINT);
  } else {
    args.push('-Pfx', DEV_PFX, '-EnsureDevCert');
  }

  if (process.env.MY_ALBUM_SIGN_TIMESTAMP) {
    args.push('-Timestamp', process.env.MY_ALBUM_SIGN_TIMESTAMP);
  }

  try {
    execFileSync('powershell.exe', args, { stdio: 'ignore' });
  } catch {
    // 失败细节从结果文件里读
  }

  try {
    return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
  } catch {
    return { ok: false, skipped: false, reason: '签名结果文件读不出来', entries: [] };
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function signFiles(files, { required = false, quiet = false, attempts = 3 } = {}) {
  const existing = files.filter((file) => fs.existsSync(file));

  if (existing.length === 0) {
    return { ok: true, skipped: true, reason: '没有需要签名的文件' };
  }

  let result = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = runOnce(existing);

    if (result.ok || result.skipped) {
      break;
    }

    // 最常见的原因是：csc 刚写完的大 exe 还在被杀毒/索引服务扫描，文件被占用。
    // 等一会儿重试一次基本就好了。
    if (attempt < attempts) {
      await delay(1500);
    }
  }

  if (!quiet) {
    if (result.skipped) {
      console.log(`· 代码签名：跳过（${result.reason || '没有可用证书'}）`);
    } else {
      console.log(
        `· 代码签名：${result.ok ? '成功' : '失败'}（${result.subject || '?'}，` +
          `${String(result.thumbprint || '').slice(0, 16)}…）`
      );

      for (const entry of result.entries || []) {
        const name = path.basename(entry.file);
        const marker = entry.subject ? '✓' : '✗';
        console.log(`    ${marker} ${name}  ${entry.status}${entry.error ? `  ${entry.error}` : ''}`);
      }
    }
  }

  if (required && !result.ok) {
    throw new Error(`代码签名没成功：${result.reason || '签名失败'}`);
  }

  // 不强制时，签不上只提示，不让打包失败
  return result;
}

if (require.main === module) {
  const required = process.argv.includes('--required');
  const files = process.argv.slice(2).filter((item) => !item.startsWith('--'));

  signFiles(files, { required }).then((result) => {
    if (!result.ok && !result.skipped) {
      process.exitCode = 1;
    }
  });
}

module.exports = { signFiles, DEV_PFX, RESULT_FILE };