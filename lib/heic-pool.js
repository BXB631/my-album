const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_COUNT = Math.max(
  1,
  Math.min(4, (os.availableParallelism?.() || os.cpus().length) - 1)
);
const WORKER_PATH = path.join(__dirname, 'heic-worker.js');

const queue = [];
const workers = [];
const pending = new Map();
let nextJobId = 0;
let started = false;

function createWorker() {
  const worker = new Worker(WORKER_PATH);
  worker.busy = false;
  worker.currentJobId = null;

  worker.on('message', (message) => {
    const job = pending.get(message.id);
    pending.delete(message.id);
    worker.busy = false;
    worker.currentJobId = null;

    if (!job) {
      dispatch();
      return;
    }

    if (message.error) {
      job.reject(new Error(message.error));
    } else {
      job.resolve(Buffer.from(message.jpeg));
    }

    dispatch();
  });

  const handleFailure = (error) => {
    const job = worker.currentJobId
      ? pending.get(worker.currentJobId)
      : null;

    if (job) {
      pending.delete(worker.currentJobId);
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }

    worker.busy = false;
    worker.currentJobId = null;

    const index = workers.indexOf(worker);
    if (index >= 0) {
      workers.splice(index, 1);
    }

    if (!workers.length) {
      started = false;
    }

    dispatch();
  };

  worker.on('error', handleFailure);
  worker.on('exit', (code) => {
    if (code !== 0) {
      handleFailure(new Error(`HEIC worker exited with code ${code}`));
    }
  });

  workers.push(worker);
  return worker;
}

function ensureWorkers() {
  if (started) {
    return;
  }

  started = true;

  while (workers.length < WORKER_COUNT) {
    createWorker();
  }
}

function dispatch() {
  if (!queue.length) {
    return;
  }

  ensureWorkers();

  for (const worker of workers) {
    if (worker.busy) {
      continue;
    }

    const job = queue.shift();

    if (!job) {
      return;
    }

    worker.busy = true;
    worker.currentJobId = job.id;
    pending.set(job.id, job);

    // 复制一份再转移（transfer）：直接把调用方的 ArrayBuffer 转移出去会把它 **detach**，
    // 调用方之后再用那个 Buffer 就会炸（"Cannot perform Construct on a detached ArrayBuffer"）；
    // 而且小文件可能落在 Buffer 的内存池里，转移会连累池子里别的 Buffer。
    // 一次 memcpy（几 MB，约 1 ms）换掉这两个坑，比 1 秒的解码便宜得多。
    const payload = new Uint8Array(job.buffer);

    worker.postMessage(
      {
        id: job.id,
        buffer: payload,
        quality: job.quality,
      },
      [payload.buffer]
    );
  }
}

function convertHeic(buffer, quality = 0.94) {
  return new Promise((resolve, reject) => {
    const job = {
      id: ++nextJobId,
      buffer,
      quality,
      resolve,
      reject,
    };

    queue.push(job);
    dispatch();
  });
}

// 收工：把 worker 线程都关掉。worker 会一直活着，脚本/测试跑完不关就退不出进程。
function shutdownHeicPool() {
  for (const worker of workers.splice(0)) {
    worker.terminate();
  }

  started = false;
}

module.exports = { convertHeic, shutdownHeicPool };
