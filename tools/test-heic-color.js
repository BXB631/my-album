// HEIC 色彩修复的测试：把 HEIC 里的 ICC 配置文件抠出来、补到中间 JPEG 上，
// 并确认下游 sharp（线上那条转换链）真的会按它把 P3 转成 sRGB。
//
//   node tools/test-heic-color.js
//
// 本机生成不出真的 HEIC（libvips 这个构建没有 HEVC 解码器、ffmpeg 也没有 HEIF 封装），
// 所以这里**自己拼一个最小的 HEIF 容器**（ftyp + meta/iprp/ipco/colr），
// 只放色彩盒子和几个别的东西 —— 要测的就是"从容器里读色彩配置"这段纯字节逻辑。
// 最后一段用真 sharp 跑一遍完整效果：补 ICC 前后像素均值必须不一样（= 真的转了），
// 而 keepIccProfile 那条路必须是"数值一个都不动、只换个标签"。

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const { readHeifColor, attachIccToJpeg } = require('../lib/heic-color');

const RUNTIME = path.join(__dirname, '..', 'test-runtime', 'heic-color');
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

// --- 拼盒子 -----------------------------------------------------------------

function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);

  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 'latin1');
  payload.copy(out, 8);

  return out;
}

function fullBox(type, payload) {
  const version = Buffer.alloc(4); // version + flags = 0
  return box(type, Buffer.concat([version, payload]));
}

function colrProf(icc) {
  return box('colr', Buffer.concat([Buffer.from('prof', 'latin1'), icc]));
}

function colrNclx(primaries, transfer, matrix, fullRange) {
  const payload = Buffer.alloc(11);

  payload.write('nclx', 0, 'latin1');
  payload.writeUInt16BE(primaries, 4);
  payload.writeUInt16BE(transfer, 6);
  payload.writeUInt16BE(matrix, 8);
  payload[10] = fullRange;

  return box('colr', payload);
}

function fakeHeic(properties) {
  const ftyp = box(
    'ftyp',
    Buffer.concat([
      Buffer.from('heic', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('heicmif1', 'latin1'),
    ])
  );
  const ispe = box('ispe', (() => {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(4032, 4);
    payload.writeUInt32BE(3024, 8);
    return payload;
  })());
  const ipco = box('ipco', Buffer.concat([...properties, ispe]));
  const ipma = fullBox('ipma', Buffer.alloc(8));
  const iprp = box('iprp', Buffer.concat([ipco, ipma]));
  const meta = fullBox('meta', iprp);

  return Buffer.concat([ftyp, meta, box('mdat', Buffer.alloc(16))]);
}

function fakeIcc(size, seed = 7) {
  const icc = Buffer.alloc(size);

  for (let index = 0; index < size; index += 1) {
    icc[index] = (index * 31 + seed) % 251;
  }

  return icc;
}

async function main() {
  await fsp.mkdir(RUNTIME, { recursive: true });

  console.log('HEIC 色彩修复测试（ICC 抠取 + 补进 JPEG + sharp 转换效果）');

  console.log('\n[1] 从 HEIF 容器里读色彩配置');
  const icc536 = fakeIcc(536);
  const prof = readHeifColor(fakeHeic([colrProf(icc536)]));

  check(
    prof.colourType === 'prof' && prof.icc && prof.icc.equals(icc536),
    'colr=prof 时能原样读回整块 ICC（536 字节）',
    `colourType=${prof.colourType} 长度=${prof.icc?.length}`
  );

  const nclx = readHeifColor(fakeHeic([colrNclx(12, 13, 6, 1)]));

  check(
    nclx.icc === null &&
      nclx.nclx?.primaries === 12 &&
      nclx.nclx?.transfer === 13 &&
      nclx.nclx?.matrix === 6 &&
      nclx.nclx?.fullRange === 1 &&
      nclx.nclx?.name === 'p3',
    'colr=nclx 时读出原色/传输/矩阵编号，并认出 Display P3',
    JSON.stringify(nclx.nclx)
  );

  check(
    readHeifColor(Buffer.from('这不是 HEIF')).icc === null,
    '不是 HEIF 的字节不会瞎读（返回空）'
  );

  console.log('\n[2] 把 ICC 补进 JPEG（APP2 / ICC_PROFILE）');
  const jpeg = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 200, g: 60, b: 30 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  const tagged = attachIccToJpeg(jpeg, icc536);
  const taggedMeta = await sharp(tagged).metadata();

  check(tagged[0] === 0xff && tagged[1] === 0xd8, '补完还是 JPEG（SOI 打头）');
  check(
    tagged.length === jpeg.length + 2 + 2 + 12 + 2 + icc536.length,
    '只多了一个 APP2 段的字节数（没动像素数据）',
    `${jpeg.length} → ${tagged.length}`
  );
  check(
    tagged.includes(Buffer.from('ICC_PROFILE\0', 'latin1')),
    '段标识是 ICC_PROFILE'
  );
  check(
    taggedMeta.hasProfile === true && taggedMeta.icc?.equals(icc536) === true,
    'sharp 能把这个 ICC 读出来（字节一致）',
    `${taggedMeta.icc?.length} 字节`
  );

  const beforeStats = await sharp(jpeg).stats();
  const taggedStats = await sharp(tagged).stats();

  check(
    beforeStats.channels.every(
      (channel, index) => Math.abs(channel.mean - taggedStats.channels[index].mean) < 1e-6
    ),
    '补 ICC 这一步本身不改像素（均值一个数都不变）'
  );

  const big = fakeIcc(150000, 3);
  const bigTagged = attachIccToJpeg(jpeg, big);
  const bigMeta = await sharp(bigTagged).metadata();

  check(
    bigMeta.icc?.length === big.length,
    '超过 65519 字节的 ICC 会切成多段，sharp 拼回来还是完整的',
    `${big.length} → ${bigMeta.icc?.length}`
  );

  check(
    attachIccToJpeg(jpeg, null) === jpeg,
    '没有 ICC 时原样返回（不动文件）'
  );

  console.log('\n[3] 下游 sharp 真的会按这个 ICC 转成 sRGB');

  // 造一张"结构上等同于 HEIC 中间产物"的图：像素是 P3 数值 + 带着真的 P3 ICC。
  // 办法：先在 sRGB 里画一个饱和色（参照），再让 sharp 把它转成 P3 并打上 P3 标签 ——
  // 于是"按标签看"还是原来那个颜色，"把数值当 sRGB 看"就偏色。
  const base = await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 240, g: 40, b: 90 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  const p3Tagged = await sharp(base)
    .withIccProfile('p3')
    .jpeg({ quality: 100 })
    .toBuffer();
  const p3Meta = await sharp(p3Tagged).metadata();

  check(
    p3Meta.hasProfile === true && p3Meta.icc?.length > 100,
    '造出一张带真 P3 ICC 的图（用来对照）',
    `${p3Meta.icc?.length} 字节`
  );

  const means = async (buffer) =>
    (await sharp(buffer).stats()).channels.slice(0, 3).map((channel) => channel.mean);
  const line = (values) => values.map((value) => value.toFixed(2)).join('/');

  const baseMeans = await means(
    await sharp(base).resize(64, 64).jpeg({ quality: 95 }).toBuffer()
  );

  // 线上那条路：拿着一张带 ICC 的图，什么都不说（默认 = 转成 sRGB 并去掉元数据）
  const fixedBuffer = await sharp(p3Tagged)
    .resize(64, 64)
    .jpeg({ quality: 95 })
    .toBuffer();
  const fixedMeans = await means(fixedBuffer);
  const fixedMeta = await sharp(fixedBuffer).metadata();

  check(
    fixedMeans.every((value, index) => Math.abs(value - baseMeans[index]) < 2),
    '有 ICC 时 sharp 会正确转成 sRGB：和参照图颜色一致（这就是修复后的色彩）',
    `参照=${line(baseMeans)} 修复后=${line(fixedMeans)}`
  );
  check(
    fixedMeta.hasProfile === false,
    '转换后的预览不带 ICC（就是 sRGB 数值，任何看图工具都不会再看错）'
  );

  // 对照：keepIccProfile 那条路"数值一个不动、只带标签"，正是修复前的观感
  const keptBuffer = await sharp(p3Tagged)
    .resize(64, 64)
    .keepIccProfile()
    .jpeg({ quality: 95 })
    .toBuffer();
  const keptMeans = await means(keptBuffer);
  const keptMeta = await sharp(keptBuffer).metadata();

  check(
    keptMeans.some((value, index) => Math.abs(value - baseMeans[index]) > 2),
    '对照：不转换、只带标签的那条路，数值就是偏的（= 修复前的现象）',
    `参照=${line(baseMeans)} 只带标签=${line(keptMeans)}`
  );
  check(
    keptMeta.icc?.length === p3Meta.icc?.length,
    'keepIccProfile 确实保住了 P3 标签',
    `${keptMeta.icc?.length} 字节`
  );

  console.log('\n[4] 真实 HEIC（可选：给了路径就跑真文件 + 真 worker）');
  const realHeic = process.argv[2];

  if (realHeic) {
    const heicConvert = require('heic-convert');
    const { convertHeic, shutdownHeicPool } = require('../lib/heic-pool');
    const source = await fsp.readFile(realHeic);
    const color = readHeifColor(source);

    check(
      color.icc !== null && color.icc.length > 100,
      `真实 HEIC 里读到了 ICC（${color.icc?.length ?? 0} 字节，colourType=${color.colourType}）`
    );

    // 修复前：WASM 转出来的裸 JPEG（没有色彩标签）
    const raw = Buffer.from(
      await heicConvert({ buffer: source, format: 'JPEG', quality: 0.92 })
    );

    // 修复后：走真实 worker（heic-pool）—— 产物应该带着同一份 ICC
    const converted = await convertHeic(source, 0.92);
    const convertedMeta = await sharp(converted).metadata();

    check(
      convertedMeta.hasProfile === true &&
        convertedMeta.icc?.equals(color.icc) === true,
      'worker 转出来的中间产物带着同一份 ICC（修复的核心一步）',
      `hasProfile=${convertedMeta.hasProfile} icc=${convertedMeta.icc?.length ?? 0} 字节`
    );
    check(
      source.length > 0 && source.toString('latin1', 4, 8) === 'ftyp',
      'convertHeic 不再把调用方的 Buffer detach（transfer 会把 ArrayBuffer 拿走）',
      `长度 ${source.length}，第 4~8 字节=${source.toString('latin1', 4, 8)}`
    );

    // 真实照片的观感：补 ICC 之后 sharp 转出来的数值必须和"当 sRGB 用"不一样
    const means = async (buffer) =>
      (await sharp(buffer).stats()).channels.slice(0, 3).map((channel) => channel.mean);
    const oldMeans = await means(
      await sharp(raw).resize(256, 256).jpeg({ quality: 90 }).toBuffer()
    );
    const newMeans = await means(
      await sharp(converted).resize(256, 256).jpeg({ quality: 90 }).toBuffer()
    );

    check(
      oldMeans.some((value, index) => Math.abs(value - newMeans[index]) > 0.2),
      '真实照片：修复前后数值确实不同（越饱和的照片差得越多）',
      `修复前=${oldMeans.map((v) => v.toFixed(2)).join('/')} ` +
        `修复后=${newMeans.map((v) => v.toFixed(2)).join('/')}`
    );

    shutdownHeicPool();
  } else {
    console.log('  · 没给 .HEIC 路径，跳过（用法：node tools/test-heic-color.js "路径\\x.HEIC"）');
  }

  await fsp.rm(RUNTIME, { recursive: true, force: true });

  console.log('');

  if (failures) {
    console.error(`HEIC 色彩测试失败 ${failures} 项（共 ${checks} 项）`);
    process.exitCode = 1;
    return;
  }

  console.log(`HEIC 色彩测试全部通过 ✓ （${checks} 项）`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});