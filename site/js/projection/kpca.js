// Kernel PCA with a Gaussian (RBF) kernel.
import { makeRng, topEigen, fixSigns } from './linalg.js';

function medianSquaredDistance(G, n, seed) {
  const sq = (i) => G[i * n + i];
  const pairs = (n * (n - 1)) / 2;
  const samples = [];
  if (pairs <= 200000) {
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) samples.push(Math.max(0, sq(i) + sq(j) - 2 * G[i * n + j]));
    }
  } else {
    const rng = makeRng(seed);
    while (samples.length < 200000) {
      const i = Math.floor(rng() * n);
      const j = Math.floor(rng() * n);
      if (i !== j) samples.push(Math.max(0, sq(i) + sq(j) - 2 * G[i * n + j]));
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] || 1;
}

/**
 * Gaussian kernel PCA. G is the n×n Gram matrix of the inputs and is overwritten with
 * the kernel matrix. The bandwidth follows the median heuristic, scaled by bandwidth.
 */
export function gaussianKpca(G, n, { k = 2, bandwidth = 0.5, seed = 11, block = 8, tol = 1e-5, maxIter = 60 } = {}) {
  const Y = new Float64Array(n * k);
  if (n < 2) return { Y, values: new Float64Array(k), sigma: 0 };
  const sigma2 = medianSquaredDistance(G, n, seed) * bandwidth;
  const gamma = 1 / (2 * sigma2);
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i += 1) sq[i] = G[i * n + i];
  for (let i = 0; i < n; i += 1) {
    G[i * n + i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const d2 = Math.max(0, sq[i] + sq[j] - 2 * G[i * n + j]);
      const v = Math.exp(-gamma * d2);
      G[i * n + j] = v;
      G[j * n + i] = v;
    }
  }
  const rowMean = new Float64Array(n);
  let grand = 0;
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (let j = 0; j < n; j += 1) s += G[i * n + j];
    rowMean[i] = s / n;
    grand += s;
  }
  grand /= n * n;
  let Qt = new Float64Array(0);
  // Centred kernel times Q: Kc = K - 1K/n - K1/n + 11ᵀK1/n².
  const multiply = (Q, p, out) => {
    if (Qt.length !== n * p) Qt = new Float64Array(n * p);
    const colSum = new Float64Array(p);
    const meanDot = new Float64Array(p);
    for (let j = 0; j < n; j += 1) {
      for (let c = 0; c < p; c += 1) {
        const q = Q[j * p + c];
        Qt[c * n + j] = q;
        colSum[c] += q;
        meanDot[c] += rowMean[j] * q;
      }
    }
    for (let i = 0; i < n; i += 1) {
      const row = i * n;
      for (let c = 0; c < p; c += 1) {
        const col = c * n;
        let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
        let j = 0;
        for (; j + 3 < n; j += 4) {
          s0 += G[row + j] * Qt[col + j];
          s1 += G[row + j + 1] * Qt[col + j + 1];
          s2 += G[row + j + 2] * Qt[col + j + 2];
          s3 += G[row + j + 3] * Qt[col + j + 3];
        }
        for (; j < n; j += 1) s0 += G[row + j] * Qt[col + j];
        out[i * p + c] = s0 + s1 + s2 + s3 - rowMean[i] * colSum[c] - meanDot[c] + grand * colSum[c];
      }
    }
  };
  const { values, vectors, iterations } = topEigen(multiply, n, k, { block: Math.min(n, block), tol, maxIter, seed });
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < k; c += 1) Y[i * k + c] = vectors[i * k + c] * Math.sqrt(Math.max(0, values[c]));
  }
  fixSigns(Y, n, k);
  return { Y, values, sigma: Math.sqrt(sigma2), iterations };
}
