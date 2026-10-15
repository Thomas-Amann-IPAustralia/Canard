// Runs the layout pipeline across three web workers so t-SNE, UMAP and the Gaussian
// kernel PCA compute at the same time. Falls back to the main thread if module
// workers are unavailable.
import { computeLayouts, finalise, smallLayouts } from './projection/index.js';

// Rough share of the total time each stage takes, for the progress bar.
const WEIGHTS = { prepare: 0.3, tsne: 0.3, umap: 0.25, gauss: 0.15 };

function spawn() {
  return new Worker(new URL('./workers/layout.worker.js', import.meta.url), { type: 'module' });
}

/**
 * vectors: Float32Array (n × dim). Returns { coords, params } like computeLayouts.
 * signal: optional AbortSignal; onProgress(fraction, label).
 */
export async function computeLayoutsInWorkers(vectors, n, dim, { ids, previous, onProgress = () => {}, signal } = {}) {
  if (n < 4) {
    const { raw, params } = smallLayouts(vectors, n, dim);
    return { coords: finalise(raw, n, { ids, previous }), params };
  }
  if (typeof Worker === 'undefined') {
    return computeLayouts(vectors, n, dim, { ids, previous, progress: onProgress });
  }
  const workers = [];
  const fractions = { prepare: 0, tsne: 0, umap: 0, gauss: 0 };
  const labels = { prepare: 'Comparing entries', tsne: 'Running t-SNE', umap: 'Running UMAP', gauss: 'Running Gaussian kernel PCA' };
  const report = (task) => {
    const total = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * fractions[k], 0);
    onProgress(Math.min(0.999, total), fractions.prepare < 1 ? labels.prepare : 'Running t-SNE, UMAP and kernel PCA');
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
        if (raw.tsne && raw.umap && raw.gauss && prepared) {
          raw.pca = prepared.pcaY;
          params.pca = {};
          resolve({ coords: finalise(raw, n, { ids, previous }), params });
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
          workers.push(tsneWorker, umapWorker);
          for (const w of [tsneWorker, umapWorker]) {
            w.onmessage = handle;
            w.onerror = (err) => fail(err.message || 'A layout worker stopped unexpectedly.');
          }
          tsneWorker.postMessage({ task: 'tsne', knn: msg.knnTsne, n, perplexity: msg.perplexity, pcaY: msg.pcaY });
          umapWorker.postMessage({ task: 'umap', knn: msg.knnUmap, n, nNeighbors: msg.nNeighbors, pcaY: msg.pcaY });
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
