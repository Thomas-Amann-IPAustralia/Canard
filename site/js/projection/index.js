// Computes every 2-D layout for a set of embeddings. Runs inside a web worker in the
// browser and directly under Node in the tests.
import { gramMatrix, jacobiEigen } from './linalg.js';
import { knnFromGram } from './knn.js';
import { pca } from './pca.js';
import { gaussianKpca } from './kpca.js';
import { jointProbabilities, tsne } from './tsne.js';
import { umap } from './umap.js';

export const METHOD_KEYS = ['umap', 'tsne', 'gauss', 'pca'];

function sliceKnn(knn, k) {
  if (k >= knn.k) return knn;
  const n = knn.indices.length / knn.k;
  const indices = new Int32Array(n * k);
  const distances = new Float32Array(n * k);
  for (let i = 0; i < n; i += 1) {
    indices.set(knn.indices.subarray(i * knn.k, i * knn.k + k), i * k);
    distances.set(knn.distances.subarray(i * knn.k, i * knn.k + k), i * k);
  }
  return { indices, distances, k };
}

/** Centre on the bounding box and scale so every coordinate lies in [-1, 1]. */
export function normalise(Y, n) {
  const out = new Float64Array(2 * n);
  if (n === 0) return out;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, Y[2 * i]); maxX = Math.max(maxX, Y[2 * i]);
    minY = Math.min(minY, Y[2 * i + 1]); maxY = Math.max(maxY, Y[2 * i + 1]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 || 1;
  for (let i = 0; i < n; i += 1) {
    out[2 * i] = (Y[2 * i] - cx) / half;
    out[2 * i + 1] = (Y[2 * i + 1] - cy) / half;
  }
  return out;
}

/**
 * Rotate (or reflect) a new layout to best match the previous positions of the points
 * it shares with them (orthogonal Procrustes), so an updated plot keeps its orientation.
 * pairs is a list of [newIndex, oldX, oldY].
 */
export function alignTo(Y, n, pairs) {
  if (pairs.length < 3) return Y;
  let ncx = 0; let ncy = 0; let ocx = 0; let ocy = 0;
  for (const [i, ox, oy] of pairs) { ncx += Y[2 * i]; ncy += Y[2 * i + 1]; ocx += ox; ocy += oy; }
  ncx /= pairs.length; ncy /= pairs.length; ocx /= pairs.length; ocy /= pairs.length;
  // M = Ynewᵀ Yold (2×2) for the centred shared points.
  let m00 = 0; let m01 = 0; let m10 = 0; let m11 = 0;
  for (const [i, ox, oy] of pairs) {
    const nx = Y[2 * i] - ncx; const ny = Y[2 * i + 1] - ncy;
    const px = ox - ocx; const py = oy - ocy;
    m00 += nx * px; m01 += nx * py; m10 += ny * px; m11 += ny * py;
  }
  // SVD of M via the eigen-decompositions of MᵀM and MMᵀ: R = U Vᵀ.
  const mtm = jacobiEigen([m00 * m00 + m10 * m10, m00 * m01 + m10 * m11, m00 * m01 + m10 * m11, m01 * m01 + m11 * m11], 2);
  const V = mtm.vectors;
  // U columns = M v / σ.
  const U = new Float64Array(4);
  for (let c = 0; c < 2; c += 1) {
    const ux = m00 * V[c] + m01 * V[2 + c];
    const uy = m10 * V[c] + m11 * V[2 + c];
    const s = Math.hypot(ux, uy);
    if (s < 1e-12) return Y;
    U[c] = ux / s; U[2 + c] = uy / s;
  }
  const r00 = U[0] * V[0] + U[1] * V[1];
  const r01 = U[0] * V[2] + U[1] * V[3];
  const r10 = U[2] * V[0] + U[3] * V[1];
  const r11 = U[2] * V[2] + U[3] * V[3];
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const x = Y[2 * i] - ncx; const y = Y[2 * i + 1] - ncy;
    out[2 * i] = x * r00 + y * r10;
    out[2 * i + 1] = x * r01 + y * r11;
  }
  return out;
}

function fallbackLayout(n) {
  // One or two points: place them on a line.
  const Y = new Float64Array(2 * n);
  if (n === 2) { Y[0] = -0.5; Y[2] = 0.5; }
  return Y;
}

/**
 * Shared preparation: Gram matrix, nearest neighbours and the PCA layout that seeds
 * t-SNE and UMAP. Returns null for fewer than four points (see smallLayouts).
 */
export function prepare(vectors, n, dim, progress = () => {}) {
  if (n < 4) return null;
  const G = gramMatrix(vectors, n, dim, (f) => progress(0.8 * f));
  const perplexity = Math.max(2, Math.min(30, (n - 1) / 3));
  const nNeighbors = Math.max(2, Math.min(15, n - 1));
  const knn = knnFromGram(G, n, Math.max(Math.floor(3 * perplexity), nNeighbors - 1));
  progress(0.9);
  const pcaY = pca(vectors, n, dim, 2).Y;
  progress(1);
  return {
    G,
    pcaY,
    perplexity,
    nNeighbors,
    knnTsne: sliceKnn(knn, Math.floor(3 * perplexity)),
    knnUmap: sliceKnn(knn, nNeighbors - 1),
  };
}

export function runTsne(knn, n, perplexity, pcaY, progress = () => {}) {
  // Start from the PCA layout scaled to a standard deviation of 1e-4.
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += pcaY[2 * i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i += 1) sd += (pcaY[2 * i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const init = pcaY.map((v) => (v / sd) * 1e-4);
  const iterations = n > 2500 ? 750 : 1000;
  const P = jointProbabilities(knn, n, perplexity);
  const Y = tsne(P, n, init, { iterations, progress });
  return { Y, params: { perplexity: +perplexity.toFixed(2), iterations, theta: 0.5, init: 'pca' } };
}

export function runUmap(knn, n, nNeighbors, pcaY, { seed = 42, progress = () => {} } = {}) {
  const Y = umap(knn, n, pcaY, { nNeighbors, seed, progress });
  return { Y, params: { nNeighbors, minDist: 0.1, init: 'pca' } };
}

export function runGauss(G, n) {
  const { Y, sigma } = gaussianKpca(G, n, { bandwidth: 0.5 });
  return { Y, params: { kernel: 'rbf', sigma: +sigma.toFixed(4) } };
}

/** Layouts for fewer than four points, where the neighbour-based methods do not apply. */
export function smallLayouts(vectors, n, dim) {
  const base = n < 3 ? fallbackLayout(n) : pca(vectors, n, dim, 2).Y;
  const raw = {};
  for (const key of METHOD_KEYS) raw[key] = base;
  return { raw, params: { note: 'Fewer than four points: every method shows the PCA layout.' } };
}

/** Align each raw layout with the previous one, normalise to [-1, 1] and round. */
export function finalise(raw, n, { ids = null, previous = null } = {}) {
  const coords = {};
  const prevIndex = new Map();
  if (previous && ids) previous.ids.forEach((id, i) => prevIndex.set(id, i));
  for (const key of METHOD_KEYS) {
    let Y = raw[key];
    const prev = previous?.coords?.[key];
    if (prev && ids) {
      const pairs = [];
      ids.forEach((id, i) => {
        const j = prevIndex.get(id);
        if (j !== undefined) pairs.push([i, prev[2 * j], prev[2 * j + 1]]);
      });
      Y = alignTo(Y, n, pairs);
    }
    const norm = normalise(Y, n);
    coords[key] = Float32Array.from(norm, (v) => Math.round(v * 1e4) / 1e4);
  }
  return coords;
}

/**
 * Compute every layout sequentially (used by the tests; the browser runs the stages
 * in parallel workers, see js/layout-runner.js).
 * vectors: Float32Array (n×dim, row-major). previous: optional { ids, coords } from the
 * stored plot. Returns { coords: { method: Float32Array(2n) }, params }.
 */
export function computeLayouts(vectors, n, dim, { ids = null, previous = null, progress = () => {} } = {}) {
  if (n < 4) {
    const { raw, params } = smallLayouts(vectors, n, dim);
    return { coords: finalise(raw, n, { ids, previous }), params };
  }
  const prep = prepare(vectors, n, dim, (f) => progress(0.2 * f, 'Comparing entries'));
  const tsneOut = runTsne(prep.knnTsne, n, prep.perplexity, prep.pcaY, (f) => progress(0.2 + 0.4 * f, 'Running t-SNE'));
  const umapOut = runUmap(prep.knnUmap, n, prep.nNeighbors, prep.pcaY, { progress: (f) => progress(0.6 + 0.3 * f, 'Running UMAP') });
  const gaussOut = runGauss(prep.G, n);
  const raw = { umap: umapOut.Y, tsne: tsneOut.Y, gauss: gaussOut.Y, pca: prep.pcaY };
  const params = { umap: umapOut.params, tsne: tsneOut.params, gauss: gaussOut.params, pca: {} };
  progress(1, 'Done');
  return { coords: finalise(raw, n, { ids, previous }), params };
}
