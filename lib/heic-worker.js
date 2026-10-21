const { parentPort } = require('node:worker_threads');
const heicConvert = require('heic-convert');

parentPort.on('message', async (message) => {
  try {
    const jpeg = await heicConvert({
      buffer: Buffer.from(message.buffer),
      format: 'JPEG',
      quality: message.quality,
    });

    parentPort.postMessage(
      { id: message.id, jpeg },
      [jpeg.buffer]
    );
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error.message || 'HEIC 转换失败',
    });
  }
});
