// HEIC/HEIF 的色彩配置：把它从文件里抠出来，再按 JPEG 的规矩塞进中间产物。
//
// 背景（实测过的真事）：iPhone 的 HEIC 里带着一个**完整的 ICC 配置文件**
// （在 `meta/iprp/ipco/colr` 盒里，colour_type='prof'，约 536 字节，Display P3），
// libheif 解出来的 RGB 数据就是"按这个配置解释"的数值 —— 也就是 P3 的数值。
// 可我们转出来的中间 JPEG 是 jpeg-js 写的裸 JPEG，**没有 ICC**，
// 下游 sharp 只能把这些数值当成 sRGB，浏览器也是 —— 于是 iPhone 照片颜色就是偏的。
//
// 所以这里做两件事：
//   1. readHeifColor()    —— 从 HEIC/HEIF 里读出 ICC（或退一步读 nclx 的原色编号）
//   2. attachIccToJpeg()  —— 用 APP2/ICC_PROFILE 段把 ICC 附到 JPEG 上
// 中间产物带上 ICC 之后，下游的 sharp 就知道"这些像素是 P3"，会正确地转成 sRGB
// （sharp 的默认行为：不调用 withMetadata/keepIccProfile 时就是"转成 sRGB 并去掉元数据"）。

'use strict';

const ICC_PROFILE_ID = 'ICC_PROFILE\0';
// APP2 段的长度字段是 2 字节：2(自身) + 12(标识) + 1(序号) + 1(总数) + 数据 ≤ 65535
const MAX_ICC_CHUNK = 65535 - 2 - 12 - 1 - 1;

// nclx 的原色编号 → 我们认识的色彩空间名（只有 hvcC/nclx 的文件用得上）
const NCLX_PRIMARIES = {
  1: 'bt709',
  12: 'p3', // SMPTE ST 432-1（Display P3）
  9: 'bt2020',
};

function readBoxHeader(buffer, offset, end) {
  if (offset + 8 > end) {
    return null;
  }

  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  let header = 8;

  if (size === 1) {
    if (offset + 16 > end) {
      return null;
    }

    size = Number(buffer.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }

  if (size < header || offset + size > end) {
    return null;
  }

  return { type, size, header, body: offset + header, end: offset + size };
}

function eachBox(buffer, start, end, callback) {
  let offset = start;

  while (offset + 8 <= end) {
    const box = readBoxHeader(buffer, offset, end);

    if (!box) {
      return;
    }

    if (callback(box) === false) {
      return;
    }

    offset = box.end;
  }
}

function findBox(buffer, start, end, type) {
  let found = null;

  eachBox(buffer, start, end, (box) => {
    if (box.type === type) {
      found = box;
      return false;
    }

    return true;
  });

  return found;
}

// 从 HEIC/HEIF 的字节里取色彩配置。
// 返回 { icc, nclx, colourType }：icc 是完整的 ICC 配置文件（可能有），
// nclx 是"只有原色/传输/矩阵编号"那种情况（{ primaries, transfer, matrix, fullRange, name }）。
function readHeifColor(buffer) {
  const result = { icc: null, nclx: null, colourType: null };

  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return result;
  }

  const meta = findBox(buffer, 0, buffer.length, 'meta');

  if (!meta) {
    return result;
  }

  // meta 是 FullBox：4 字节 version/flags 之后才是子盒
  const iprp = findBox(buffer, meta.body + 4, meta.end, 'iprp');

  if (!iprp) {
    return result;
  }

  const ipco = findBox(buffer, iprp.body, iprp.end, 'ipco');

  if (!ipco) {
    return result;
  }

  eachBox(buffer, ipco.body, ipco.end, (box) => {
    if (box.type !== 'colr' || box.end - box.body < 4) {
      return true;
    }

    const colourType = buffer.toString('latin1', box.body, box.body + 4);

    if (colourType === 'prof' || colourType === 'rICC') {
      const icc = buffer.subarray(box.body + 4, box.end);

      if (icc.length) {
        result.icc = Buffer.from(icc);
        result.colourType = colourType;
        return false;
      }
    } else if (colourType === 'nclx' && box.end - box.body >= 11) {
      const primaries = buffer.readUInt16BE(box.body + 4);
      const transfer = buffer.readUInt16BE(box.body + 6);
      const matrix = buffer.readUInt16BE(box.body + 8);

      result.nclx = {
        primaries,
        transfer,
        matrix,
        fullRange: buffer[box.body + 10],
        name: NCLX_PRIMARIES[primaries] || null,
      };
      result.colourType = 'nclx';
    }

    return true;
  });

  return result;
}

// 把 ICC 作为 APP2/ICC_PROFILE 段插到 JPEG 的 SOI 之后。
// 纯字节拼接：不解码、不重编码，像素一个数都不动。
function attachIccToJpeg(jpeg, icc) {
  if (!icc || !icc.length || !Buffer.isBuffer(jpeg) || jpeg.length < 2) {
    return jpeg;
  }

  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return jpeg; // 不是 JPEG，别乱塞
  }

  const chunks = [];

  for (let offset = 0; offset < icc.length; offset += MAX_ICC_CHUNK) {
    chunks.push(icc.subarray(offset, Math.min(offset + MAX_ICC_CHUNK, icc.length)));
  }

  const segments = chunks.map((chunk, index) => {
    const segment = Buffer.alloc(2 + 2 + ICC_PROFILE_ID.length + 2 + chunk.length);

    segment.writeUInt16BE(0xffe2, 0);
    segment.writeUInt16BE(2 + ICC_PROFILE_ID.length + 2 + chunk.length, 2);
    segment.write(ICC_PROFILE_ID, 4, 'latin1');
    segment[4 + ICC_PROFILE_ID.length] = index + 1; // 序号从 1 开始
    segment[4 + ICC_PROFILE_ID.length + 1] = chunks.length;
    chunk.copy(segment, 4 + ICC_PROFILE_ID.length + 2);

    return segment;
  });

  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

module.exports = { readHeifColor, attachIccToJpeg };