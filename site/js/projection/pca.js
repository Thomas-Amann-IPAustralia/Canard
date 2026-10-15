// Principal component analysis via subspace iteration on the covariance operator.
import { topEigen, fixSigns } from './linalg.js';

/** Project the n×d row-major matrix X onto its top k principal components. */
export function pca(X, n, d, k = 2) {
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i += 1) for (let t = 0; t < d; t += 1) mean[t] += X[i * d + t];
  for (let t = 0; t < d; t += 1) mean[t] /= Math.max(1, n);
  const Xc = new Float64Array(n * d);
  for (let i = 0; i < n; i += 1) for (let t = 0; t < d; t += 1) Xc[i * d + t] = X[i * d + t] - mean[t];
  const kk = Math.min(k, d, Math.max(1, n));
  const scale = 1 / Math.max(1, n - 1);
  const tmp = new Float64Array(n * Math.min(d, kk + 4));
  // C·Q = Xcᵀ (Xc Q) / (n - 1), without forming the d×d covariance.
  const multiply = (Q, p, out) => {
    tmp.fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < p; c += 1) {
        let s = 0;
        for (let t = 0; t < d; t += 1) s += Xc[i * d + t] * Q[t * p + c];
        tmp[i * p + c] = s;
      }
    }
    out.fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let t = 0; t < d; t += 1) {
        const x = Xc[i * d + t] * scale;
        for (let c = 0; c < p; c += 1) out[t * p + c] += x * tmp[i * p + c];
      }
    }
  };
  const { values, vectors } = topEigen(multiply, d, kk, { block: Math.min(d, kk + 4) });
  const Y = new Float64Array(n * k);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < kk; c += 1) {
      let s = 0;
      for (let t = 0; t < d; t += 1) s += Xc[i * d + t] * vectors[t * kk + c];
      Y[i * k + c] = s;
    }
  }
  fixSigns(Y, n, k);
  return { Y, values };
}
