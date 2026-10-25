const fs = require('node:fs');
const path = require('node:path');

// 安装版是被启动器用"没有控制台窗口"的方式拉起来的，所以日志必须落文件，
// 否则用户出了问题什么都看不到（启动器会设 MY_ALBUM_LOG_FILE 指向 cache\server.log）。
//
// 做法很轻：只给 process.stdout / process.stderr 的 write 加一层"顺手写文件"，
// 业务代码一行都不用改；超过 2 MB 就截断重开，避免日志无限长大。
const MAX_BYTES = 2 * 1024 * 1024;

function startFileLog(file) {
  if (!file || typeof file !== 'string') {
    return null;
  }

  const target = path.resolve(file);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (fs.statSync(target).size > MAX_BYTES) {
      fs.rmSync(target, { force: true });
    }
  } catch {
    // 文件不存在、目录刚建好，都正常
  }

  let stream;

  try {
    stream = fs.createWriteStream(target, { flags: 'a' });
  } catch {
    return null;
  }

  const append = (chunk) => {
    try {
      stream.write(chunk);
    } catch {
      // 写不进去（磁盘满/权限）也不该影响服务本身
    }
  };

  append(`\n===== ${new Date().toISOString()} 启动 =====\n`);

  for (const name of ['stdout', 'stderr']) {
    const original = process[name].write.bind(process[name]);

    process[name].write = (chunk, encoding, callback) => {
      append(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      return original(chunk, encoding, callback);
    };
  }

  return stream;
}

module.exports = { startFileLog };