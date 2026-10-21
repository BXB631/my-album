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

    worker.postMessage(
      {
        id: job.id,
        buffer: job.buffer,
        quality: job.quality,
      },
      [job.buffer.buffer]
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

module.exports = { convertHeic };
