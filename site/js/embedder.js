// Embeds entries in the browser with the same model for every upload.
//
// One worker loads the model (on the GPU where the browser offers one, otherwise
// WebAssembly on the CPU). For larger uploads on the CPU, extra workers load the
// model from the browser cache and share the work across cores.
import { EMBEDDING, embeddingText } from './schema.js';

const PARALLEL_MIN_ROWS = 48;

class EmbedWorker {
  constructor() {
    this.worker = new Worker(new URL('./workers/embed.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onDownload = () => {};
    this.onProgress = () => {};
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'download') return this.onDownload(msg.loaded, msg.total);
      if (msg.type === 'progress') return this.onProgress(msg.done, msg.total);
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') job.reject(new Error(msg.message));
      else job.resolve(msg);
    };
    this.worker.onerror = (e) => this.fail(new Error(e.message || 'The embedding worker failed to start.'));
  }

  call(task, data = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, task, ...data });
    });
  }

  fail(err) {
    for (const job of this.pending.values()) job.reject(err);
    this.pending.clear();
  }

  terminate() {
    this.worker.terminate();
    this.fail(new Error('Cancelled.'));
  }
}

let primary = null;
let device = null;
let loadPromise = null;
const helpers = new Set();
const modelArgs = { model: EMBEDDING.model, dtype: EMBEDDING.dtype };

function reset() {
  primary?.terminate();
  primary = null;
  device = null;
  loadPromise = null;
}

/**
 * Start downloading the model (safe to call early). Tries the GPU first; if that fails
 * the worker is restarted on the CPU (WebAssembly) backend, which works everywhere.
 */
export function loadModel(onDownload = () => {}) {
  if (primary) primary.onDownload = onDownload;
  if (!loadPromise) {
    primary = new EmbedWorker();
    primary.onDownload = onDownload;
    loadPromise = primary.call('load', { ...modelArgs, preferGpu: true })
      .catch((err) => {
        primary.terminate();
        primary = new EmbedWorker();
        primary.onDownload = onDownload;
        return primary.call('load', { ...modelArgs, preferGpu: false }).catch(() => { throw err; });
      })
      .then((msg) => { device = msg.device; return msg; });
    loadPromise.catch(() => reset());
  }
  return loadPromise;
}

function workerCount(rows) {
  if (device !== 'wasm' || rows < PARALLEL_MIN_ROWS) return 1;
  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 8;
  if (memory < 4) return 1;
  return Math.max(1, Math.min(4, cores - 1, Math.floor(rows / 24)));
}

/** Embed entries ({ title, summary }). Returns a Float32Array (n × dim). */
export async function embedEntries(entries, { onDownload = () => {}, onProgress = () => {} } = {}) {
  await loadModel(onDownload);
  const { dim } = EMBEDDING;
  const texts = entries.map((e) => embeddingText(e.title, e.summary));
  // Similar lengths in each batch means less padding, which is wasted work.
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const k = workerCount(texts.length);
  const shares = Array.from({ length: k }, () => []);
  order.forEach((idx, j) => shares[j % k].push(idx));
  const workers = [primary];
  try {
    for (let w = 1; w < k; w += 1) {
      const helper = new EmbedWorker();
      helpers.add(helper);
      workers.push(helper);
    }
    // Helpers read the model from the browser cache, so loading them is quick.
    await Promise.all(workers.slice(1).map((w) => w.call('load', { ...modelArgs, preferGpu: false })));
    const done = new Array(k).fill(0);
    const out = new Float32Array(texts.length * dim);
    await Promise.all(workers.map(async (w, wi) => {
      w.onProgress = (d) => {
        done[wi] = d;
        onProgress(done.reduce((s, x) => s + x, 0), texts.length);
      };
      const idx = shares[wi];
      const { vectors } = await w.call('embed', { texts: idx.map((i) => texts[i]), pooling: EMBEDDING.pooling, normalize: EMBEDDING.normalize, dim });
      idx.forEach((i, j) => out.set(vectors.subarray(j * dim, (j + 1) * dim), i * dim));
    }));
    return out;
  } finally {
    for (const w of workers.slice(1)) {
      w.terminate();
      helpers.delete(w);
    }
  }
}

export function stopEmbedding() {
  for (const w of helpers) w.terminate();
  helpers.clear();
  reset();
}
