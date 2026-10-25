// 打包自检用的小探针：**用载荷里的依赖**真跑一遍重活，确认打包没有把功能弄坏。
// 由 tools/pack.js 调用（不进安装包）。
//
//   node tools/pack-probe-native.js <载荷的 app 目录> [一个真实 .HEIC 路径]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const appDir = path.resolve(process.argv[2]);
const heicSample = process.argv[3] || '';

// 关键：用 createRequire 从载荷里的 server.js 位置解析包名，
// 这样和真实运行时完全一致（绝对路径 require 会绕过 package.json 的 exports 映射）。
const load = createRequire(path.join(appDir, 'server.js'));

(async () => {
  const sharp = load('sharp');
  const heicConvert = load('heic-convert');
  const { readHeifColor, attachIccToJpeg } = require(
    path.join(appDir, 'lib', 'heic-color')
  );

  console.log(`  sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`);
  console.log(`  heic-convert：${typeof heicConvert === 'function' ? '可用' : '不可用'}`);
  console.log(`  mp4box：${typeof load('mp4box').createFile === 'function' ? '可用' : '不可用'}`);
  console.log(`  exifr：${typeof load('exifr').parse === 'function' ? '可用' : '不可用'}`);

  // sharp 真转一张图（缩略图/预览都靠它）
  const jpeg = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();

  console.log(`  sharp 编码产出：${jpeg.length} 字节（JPEG 头 ${jpeg.subarray(0, 2).toString('hex')}）`);

  // HEIC 解码 + 补 ICC（有真实素材时）
  if (heicSample && fs.existsSync(heicSample)) {
    const startedAt = Date.now();
    const source = fs.readFileSync(heicSample);
    const converted = Buffer.from(
      await heicConvert({ buffer: source, format: 'JPEG', quality: 0.9 })
    );
    const color = readHeifColor(source);
    const tagged = attachIccToJpeg(converted, color.icc);
    const meta = await sharp(tagged).metadata();

    console.log(
      `  HEIC 解码：${path.basename(heicSample)} → ${(converted.length / 1048576).toFixed(2)} MB，` +
        `${Date.now() - startedAt} ms；容器里 ICC=${color.icc ? color.icc.length : 0} 字节，` +
        `补完 sharp 看到 profile=${meta.hasProfile ? meta.icc?.length ?? '?' : '无'}`
    );

    if (!color.icc || !meta.hasProfile) {
      throw new Error('HEIC 色彩修复在打包后的载荷里失效了');
    }
  } else {
    console.log('  · 没给真实 .HEIC 样本，跳过解码检查');
  }

  // ffmpeg 二进制（视频封面/转码靠它）。
  // 注意：不能用"管道捕获输出"的方式跑它 —— 受限环境里开不了命名管道会 EPERM，
  // 所以把输出重定向到一个文件描述符（文件，不是管道），和 app 里 runFfmpeg 的做法一致。
  const { spawnSync } = require('node:child_process');
  const ffmpeg = path.join(appDir, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
  const versionLog = path.join(appDir, '..', 'ffmpeg-version.txt');
  const fd = fs.openSync(versionLog, 'w');

  let ffmpegStatus = -1;

  try {
    ffmpegStatus = spawnSync(ffmpeg, ['-version'], { stdio: ['ignore', fd, fd] }).status;
  } finally {
    fs.closeSync(fd);
  }

  const firstLine = fs.existsSync(versionLog)
    ? fs.readFileSync(versionLog, 'utf8').split('\n')[0]
    : '';
  fs.rmSync(versionLog, { force: true });

  if (ffmpegStatus !== 0) {
    throw new Error(`ffmpeg 跑不起来（退出码 ${ffmpegStatus}）`);
  }

  console.log(`  ffmpeg：${firstLine.slice(0, 64)}`);
})().catch((error) => {
  console.error(`  ✗ 探针失败：${error.message}`);
  process.exitCode = 1;
});