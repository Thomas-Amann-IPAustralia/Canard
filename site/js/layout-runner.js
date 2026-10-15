// Runs the layout pipeline across four web workers so t-SNE, UMAP, the Gaussian
// kernel PCA and the topic clustering compute at the same time. Falls back to the
// main thread if module workers are unavailable.
import { computeLayouts, finalise, smallLayouts, prepare } from './projection/index.js';
import { computeTopics } from './clustering/index.js';

// Rough share of the total time each stage takes, for the progress bar.
const WEIGHTS = { prepare: 0.3, tsne: 0.25, umap: 0.2, gauss: 0.1, topics: 0.15 };

function spawn() {
  return new Worker(new URL('./workers/layout.worker.js', import.meta.url), { type: 'module' });
}

/**
 * vectors: Float32Array (n × dim). Returns { coords, params, topics } where coords and
 * params are as from computeLayouts and topics is { labels: Int32Array, params } from
 * the clustering (see clustering/index.js).
 * signal: optional AbortSignal; onProgress(fraction, label).
 */
export async function computeLayoutsInWorkers(vectors, n, dim, { ids, previous, onProgress = () => {}, signal } = {}) {
  if (n < 4) {
    const { raw, params } = smallLayouts(vectors, n, dim);
    const topics = computeTopics(vectors, n, dim, null);
    return { coords: finalise(raw, n, { ids, previous }), params, topics: { labels: topics.labels, params: topics.params } };
  }
  if (typeof Worker === 'undefined') {
    const out = computeLayouts(vectors, n, dim, { ids, previous, progress: (f, label) => onProgress(0.8 * f, label) });
    const topics = computeTopics(vectors, n, dim, prepare(vectors, n, dim).knnUmap);
    return { ...out, topics: { labels: topics.labels, params: topics.params } };
  }
  const workers = [];
  const fractions = { prepare: 0, tsne: 0, umap: 0, gauss: 0, topics: 0 };
  const report = (task) => {
    const total = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * fractions[k], 0);
    onProgress(Math.min(0.999, total), fractions.prepare < 1 ? 'Comparing entries' : 'Running t-SNE, UMAP, kernel PCA and the clustering');
    return task;
  };
  const cleanup = () => workers.forEach((w) => w.terminate());
  try {
    return await new Promise((resolve, reject) => {
      const raw = {};
      const params = {};
      let prepared = null;
      const fail = (message) => reject(new Error(message));
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      const done = () => {
        if (raw.tsne && raw.umap && raw.gauss && raw.topics && prepared) {
          const topics = { labels: raw.topics, params: params.topics };
          delete raw.topics;
          delete params.topics;
          raw.pca = prepared.pcaY;
          params.pca = {};
          resolve({ coords: finalise(raw, n, { ids, previous }), params, topics });
        }
      };
      const handle = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          fractions[msg.task] = msg.fraction;
          report(msg.task);
        } else if (msg.type === 'error') {
          fail(`Layout calculation failed (${msg.task}): ${msg.message}`);
        } else if (msg.type === 'prepared') {
          prepared = msg;
          fractions.prepare = 1;
          report();
          const tsneWorker = spawn();
          const umapWorker = spawn();
          const topicsWorker = spawn();
          workers.push(tsneWorker, umapWorker, topicsWorker);
          for (const w of [tsneWorker, umapWorker, topicsWorker]) {
            w.onmessage = handle;
            w.onerror = (err) => fail(err.message || 'A layout worker stopped unexpectedly.');
          }
          tsneWorker.postMessage({ task: 'tsne', knn: msg.knnTsne, n, perplexity: msg.perplexity, pcaY: msg.pcaY });
          umapWorker.postMessage({ task: 'umap', knn: msg.knnUmap, n, nNeighbors: msg.nNeighbors, pcaY: msg.pcaY });
          topicsWorker.postMessage({ task: 'topics', vectors, n, dim, knn: msg.knnUmap });
        } else if (msg.type === 'result') {
          raw[msg.task] = msg.Y;
          params[msg.task] = msg.params;
          fractions[msg.task] = 1;
          report();
          done();
        }
      };
      const first = spawn();
      workers.push(first);
      first.onmessage = handle;
      first.onerror = (err) => fail(err.message || 'The layout worker could not start.');
      first.postMessage({ task: 'prepare', vectors, n, dim });
    });
  } finally {
    cleanup();
  }
}

/**
 * Only the topic clustering (used to recalculate a plot's clusters without changing
 * its layouts). Returns { labels: Int32Array, params }.
 */
export async function computeTopicsInWorker(vectors, n, dim, { onProgress = () => {}, signal } = {}) {
  if (typeof Worker === 'undefined' || n < 4) {
    const out = computeTopics(vectors, n, dim, null, { progress: onProgress });
    return { labels: out.labels, params: out.params };
  }
  const worker = spawn();
  try {
    return await new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      worker.onerror = (err) => reject(new Error(err.message || 'The clustering worker stopped unexpectedly.'));
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(msg.fraction);
        else if (msg.type === 'error') reject(new Error(`Clustering failed: ${msg.message}`));
        else if (msg.type === 'result') resolve({ labels: msg.Y, params: msg.params });
      };
      worker.postMessage({ task: 'topics', vectors, n, dim, knn: null });
    });
  } finally {
    worker.terminate();
  }
}
