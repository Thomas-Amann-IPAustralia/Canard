// Automatic topic clustering, in the style of BERTopic:
//
//   1. the entries' 384-dimension embeddings (already computed for the map),
//   2. UMAP down to five dimensions, with min_dist = 0 so clusters pack tightly,
//   3. HDBSCAN on those five dimensions, which finds clusters of any shape and leaves
//      entries that fit nowhere unclustered rather than forcing them into a cluster,
//   4. c-TF-IDF keywords for each cluster (see ctfidf.js; done when a plot is shown).
//
// The 2-D map is only a picture of the result: clustering happens in five dimensions,
// where far less of the neighbourhood structure has been thrown away.
import { gramMatrix } from '../projection/linalg.js';
import { knnFromGram } from '../projection/knn.js';
import { pca } from '../projection/pca.js';
import { umap, CLUSTER_A, CLUSTER_B } from '../projection/umap.js';
import { hdbscan } from './hdbscan.js';

export const CLUSTER_DIMS = 5;

/** Clustering settings for a plot of n entries. */
export function clusterParams(n) {
  // HDBSCAN's smallest cluster grows slowly with the plot: 3 entries for small plots,
  // 5 for a hundred, 12 for six hundred, at most 25.
  const minClusterSize = Math.max(3, Math.min(25, Math.round(Math.sqrt(n) / 2)));
  return {
    method: 'umap-hdbscan',
    nComponents: CLUSTER_DIMS,
    nNeighbors: Math.max(2, Math.min(15, n - 1)),
    minDist: 0,
    minClusterSize,
    // Fewer samples than the cluster size means fewer entries are left unclustered.
    minSamples: Math.min(minClusterSize, 5),
    selection: 'eom',
  };
}

/** Renumber clusters by size (0 is the largest); -1 stays as unclustered. */
export function relabelBySize(labels) {
  const counts = new Map();
  const first = new Map();
  labels.forEach((l, i) => {
    if (l < 0) return;
    counts.set(l, (counts.get(l) || 0) + 1);
    if (!first.has(l)) first.set(l, i);
  });
  const order = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || first.get(a) - first.get(b));
  const map = new Map(order.map((l, i) => [l, i]));
  return Int32Array.from(labels, (l) => (l < 0 ? -1 : map.get(l)));
}

/**
 * Cluster the entries. vectors: Float32Array (n × dim); knn: exact neighbours in the
 * embedding space with at least nNeighbors - 1 per point (the same graph as the UMAP
 * map), or null to work them out here. Returns { labels: Int32Array, params, clusterCount }.
 */
export function computeTopics(vectors, n, dim, knn = null, { seed = 42, progress = () => {} } = {}) {
  const params = clusterParams(n);
  const nothing = { labels: new Int32Array(n).fill(-1), params, clusterCount: 0 };
  // Too few entries to find even two clusters.
  if (n < Math.max(2 * params.minClusterSize, CLUSTER_DIMS + 2)) {
    progress(1);
    return nothing;
  }
  if (!knn) {
    knn = knnFromGram(gramMatrix(vectors, n, dim, (f) => progress(0.3 * f)), n, params.nNeighbors - 1);
    progress = ((outer) => (f) => outer(0.3 + 0.7 * f))(progress);
  }
  const k = Math.min(knn.k, params.nNeighbors - 1);
  const graph = k === knn.k ? knn : sliceNeighbours(knn, k);
  const init = pca(vectors, n, dim, CLUSTER_DIMS).Y;
  progress(0.05);
  const Y = umap(graph, n, init, {
    nComponents: CLUSTER_DIMS, nNeighbors: params.nNeighbors, a: CLUSTER_A, b: CLUSTER_B, seed,
    progress: (f) => progress(0.05 + 0.85 * f),
  });
  const result = hdbscan(Y, n, CLUSTER_DIMS, { minClusterSize: params.minClusterSize, minSamples: params.minSamples });
  progress(1);
  return { labels: relabelBySize(result.labels), params, clusterCount: result.clusterCount };
}

function sliceNeighbours(knn, k) {
  const n = knn.indices.length / knn.k;
  const indices = new Int32Array(n * k);
  const distances = new Float32Array(n * k);
  for (let i = 0; i < n; i += 1) {
    indices.set(knn.indices.subarray(i * knn.k, i * knn.k + k), i * k);
    distances.set(knn.distances.subarray(i * knn.k, i * knn.k + k), i * k);
  }
  return { indices, distances, k };
}
