// Computes layouts off the main thread. One worker prepares the neighbours and then
// runs the Gaussian kernel PCA; three more run t-SNE, UMAP and the topic clustering
// in parallel.
import { prepare, runTsne, runUmap, runGauss } from '../projection/index.js';
import { computeTopics } from '../clustering/index.js';

self.onmessage = (event) => {
  const { task } = event.data;
  const progress = (f) => self.postMessage({ type: 'progress', task, fraction: f });
  try {
    if (task === 'prepare') {
      const { vectors, n, dim } = event.data;
      const prep = prepare(vectors, n, dim, progress);
      const { knnTsne, knnUmap, pcaY, perplexity, nNeighbors } = prep;
      // Send copies so this worker keeps the Gram matrix for kernel PCA.
      self.postMessage({
        type: 'prepared', perplexity, nNeighbors, pcaY,
        knnTsne: { indices: knnTsne.indices.slice(), distances: knnTsne.distances.slice(), k: knnTsne.k },
        knnUmap: { indices: knnUmap.indices.slice(), distances: knnUmap.distances.slice(), k: knnUmap.k },
      });
      self.postMessage({ type: 'progress', task: 'gauss', fraction: 0.05 });
      const gauss = runGauss(prep.G, n);
      self.postMessage({ type: 'result', task: 'gauss', Y: gauss.Y, params: gauss.params }, [gauss.Y.buffer]);
    } else if (task === 'tsne') {
      const { knn, n, perplexity, pcaY } = event.data;
      const out = runTsne(knn, n, perplexity, pcaY, progress);
      self.postMessage({ type: 'result', task, Y: out.Y, params: out.params }, [out.Y.buffer]);
    } else if (task === 'umap') {
      const { knn, n, nNeighbors, pcaY } = event.data;
      const out = runUmap(knn, n, nNeighbors, pcaY, { progress });
      self.postMessage({ type: 'result', task, Y: out.Y, params: out.params }, [out.Y.buffer]);
    } else if (task === 'topics') {
      const { vectors, n, dim, knn } = event.data;
      const out = computeTopics(vectors, n, dim, knn, { progress });
      self.postMessage({ type: 'result', task, Y: out.labels, params: out.params }, [out.labels.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', task, message: e?.message || String(e) });
  }
};
