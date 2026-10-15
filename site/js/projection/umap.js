// UMAP (McInnes, Healy & Melville, 2018), following umap-learn's reference
// implementation: fuzzy simplicial set from exact k-nearest neighbours, PCA
// initialisation scaled to [0, 10], and SGD with negative sampling.
import { makeRng } from './linalg.js';

// a and b for min_dist = 0.1 and spread = 1.0 (umap-learn's find_ab_params).
const DEFAULT_A = 1.5769434603113077;
const DEFAULT_B = 0.8950608779109733;
// a and b for min_dist = 0.0 and spread = 1.0, used for the clustering embedding:
// with no minimum distance, points in a cluster pack tightly, which suits HDBSCAN.
export const CLUSTER_A = 1.9328083973431500;
export const CLUSTER_B = 0.7904949732233831;

/**
 * Fuzzy simplicial set from k-nearest neighbours (self excluded). Returns symmetric
 * COO arrays { rows, cols, weights }. nNeighbors counts the point itself, as in umap-learn.
 */
export function fuzzySimplicialSet(knn, n, nNeighbors) {
  const { indices, distances, k } = knn;
  const target = Math.log2(nNeighbors);
  const sigmas = new Float64Array(n);
  const rhos = new Float64Array(n);
  let meanAll = 0;
  for (let e = 0; e < n * k; e += 1) meanAll += distances[e];
  meanAll /= Math.max(1, n * k);
  for (let i = 0; i < n; i += 1) {
    let rho = 0;
    let rowMean = 0;
    for (let t = 0; t < k; t += 1) {
      const d = distances[i * k + t];
      rowMean += d;
      if (rho === 0 && d > 0) rho = d;
    }
    rowMean /= Math.max(1, k);
    rhos[i] = rho;
    let lo = 0;
    let hi = Infinity;
    let mid = 1;
    for (let step = 0; step < 64; step += 1) {
      let psum = 0;
      for (let t = 0; t < k; t += 1) {
        const d = distances[i * k + t] - rho;
        psum += d > 0 ? Math.exp(-d / mid) : 1;
      }
      if (Math.abs(psum - target) < 1e-5) break;
      if (psum > target) {
        hi = mid;
        mid = (lo + hi) / 2;
      } else {
        lo = mid;
        mid = hi === Infinity ? mid * 2 : (lo + hi) / 2;
      }
    }
    sigmas[i] = rho > 0 ? Math.max(mid, 1e-3 * rowMean) : Math.max(mid, 1e-3 * meanAll);
  }
  // Directed memberships, then fuzzy union: w = a + b - a·b.
  const directed = new Map();
  const key = (i, j) => i * n + j;
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      const d = distances[i * k + t] - rhos[i];
      const w = d <= 0 || sigmas[i] === 0 ? 1 : Math.exp(-d / sigmas[i]);
      directed.set(key(i, j), w);
    }
  }
  const rows = [];
  const cols = [];
  const weights = [];
  const done = new Set();
  for (const kk of directed.keys()) {
    const i = Math.floor(kk / n);
    const j = kk - i * n;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const pair = key(lo, hi);
    if (done.has(pair)) continue;
    done.add(pair);
    const a = directed.get(key(lo, hi)) ?? 0;
    const b = directed.get(key(hi, lo)) ?? 0;
    const v = a + b - a * b;
    if (v > 0) {
      rows.push(lo, hi);
      cols.push(hi, lo);
      weights.push(v, v);
    }
  }
  return { rows: Int32Array.from(rows), cols: Int32Array.from(cols), weights: Float64Array.from(weights) };
}

function clip(v) {
  return v > 4 ? 4 : v < -4 ? -4 : v;
}

/**
 * Optimise a UMAP embedding with nComponents dimensions (2 for the plotted layout,
 * about 5 for clustering). init is an n×nComponents Float64Array (for example PCA
 * output). Returns the embedding as an n×nComponents Float64Array.
 */
export function umap(knn, n, init, { nComponents = 2, nNeighbors = 15, nEpochs = n <= 10000 ? 500 : 200, negativeSampleRate = 5, a = DEFAULT_A, b = DEFAULT_B, seed = 42, progress = () => {} } = {}) {
  const dims = nComponents;
  const graph = fuzzySimplicialSet(knn, n, nNeighbors);
  let maxW = 0;
  for (const w of graph.weights) if (w > maxW) maxW = w;
  // Drop edges too weak to be sampled during optimisation.
  const head = [];
  const tail = [];
  const eps = [];
  for (let e = 0; e < graph.weights.length; e += 1) {
    const w = graph.weights[e];
    if (w < maxW / nEpochs) continue;
    head.push(graph.rows[e]);
    tail.push(graph.cols[e]);
    eps.push(nEpochs / ((w / maxW) * nEpochs));
  }
  const m = head.length;
  const headA = Int32Array.from(head);
  const tailA = Int32Array.from(tail);
  const epochsPerSample = Float64Array.from(eps);
  const epochsPerNeg = epochsPerSample.map((v) => v / negativeSampleRate);
  const nextSample = Float64Array.from(epochsPerSample);
  const nextNeg = Float64Array.from(epochsPerNeg);

  // Scale the initial layout to [0, 10] on each axis, as umap-learn does.
  const Y = new Float64Array(dims * n);
  for (let c = 0; c < dims; c += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      lo = Math.min(lo, init[dims * i + c]);
      hi = Math.max(hi, init[dims * i + c]);
    }
    const span = hi - lo || 1;
    for (let i = 0; i < n; i += 1) Y[dims * i + c] = (10 * (init[dims * i + c] - lo)) / span;
  }
  const rng = makeRng(seed);
  const twoAB = 2 * a * b;
  const delta = new Float64Array(dims);
  for (let epoch = 0; epoch < nEpochs; epoch += 1) {
    const alpha = 1 - epoch / nEpochs;
    for (let e = 0; e < m; e += 1) {
      if (nextSample[e] > epoch) continue;
      const j = dims * headA[e];
      const k = dims * tailA[e];
      let d2 = 0;
      for (let c = 0; c < dims; c += 1) {
        delta[c] = Y[j + c] - Y[k + c];
        d2 += delta[c] * delta[c];
      }
      if (d2 > 0) {
        const pb = Math.exp(b * Math.log(d2));
        const coeff = (-twoAB * pb / d2) / (a * pb + 1);
        for (let c = 0; c < dims; c += 1) {
          const g = clip(coeff * delta[c]) * alpha;
          Y[j + c] += g;
          Y[k + c] -= g;
        }
      }
      nextSample[e] += epochsPerSample[e];
      const nNeg = Math.floor((epoch - nextNeg[e]) / epochsPerNeg[e]);
      for (let p = 0; p < nNeg; p += 1) {
        const r = Math.floor(rng() * n);
        if (r === headA[e]) continue;
        const ro = dims * r;
        d2 = 0;
        for (let c = 0; c < dims; c += 1) {
          delta[c] = Y[j + c] - Y[ro + c];
          d2 += delta[c] * delta[c];
        }
        if (d2 > 0) {
          const coeff = (2 * b) / ((0.001 + d2) * (a * Math.exp(b * Math.log(d2)) + 1));
          for (let c = 0; c < dims; c += 1) Y[j + c] += clip(coeff * delta[c]) * alpha;
        }
      }
      nextNeg[e] += nNeg * epochsPerNeg[e];
    }
    if (epoch % 20 === 19) progress((epoch + 1) / nEpochs);
  }
  progress(1);
  return Y;
}
