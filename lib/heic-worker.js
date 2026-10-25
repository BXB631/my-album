// HEIC → JPEG 的后台转换（跑在 worker 线程里，避免阻塞主线程）。
//
// 关键一步：**把 HEIC 里那个 ICC 配置文件补到中间 JPEG 上**。
// jpeg-js 写出来的裸 JPEG 没有色彩标签，下游 sharp 只能把这些像素当成 sRGB ——
// 而 libheif 解出来的是"文件里写的色彩空间"（iPhone 是 Display P3）的数值，
// 于是 iPhone 照片看起来偏色。补上 ICC 之后 sharp 就知道这是 P3，
// 会按它默认的行为正确转成 sRGB（见 lib/heic-color.js 里的说明）。

const { parentPort } = require('node:worker_threads');
const heicConvert = require('heic-convert');
const { readHeifColor, attachIccToJpeg } = require('./heic-color');

parentPort.on('message', async (message) => {
  try {
    const source = Buffer.from(message.buffer);
    const converted = await heicConvert({
      buffer: source,
      format: 'JPEG',
      quality: message.quality,
    });

    const jpeg = Buffer.from(converted);
    const color = readHeifColor(source);
    const tagged = attachIccToJpeg(jpeg, color.icc);

    parentPort.postMessage(
      {
        id: message.id,
        jpeg: tagged,
        // 给日志/测试用：这次到底补上了多少字节的 ICC
        iccBytes: color.icc ? color.icc.length : 0,
        colourType: color.colourType,
      },
      [tagged.buffer]
    );
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error.message || 'HEIC 转换失败',
    });
  }
});