// Small dense linear-algebra helpers for the projection algorithms.
// Matrices are row-major typed arrays.

/** Seeded pseudo-random generator (mulberry32). Returns floats in [0, 1). */
export function makeRng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pack an array of vectors into a row-major Float32Array. */
export function packRows(vectors, dim) {
  const n = vectors.length;
  const out = new Float32Array(n * dim);
  for (let i = 0; i < n; i += 1) out.set(vectors[i], i * dim);
  return out;
}

/**
 * Gram matrix G = X Xᵀ (n×n, Float32). Calls progress(fraction) between row blocks.
 */
export function gramMatrix(X, n, d, progress = () => {}) {
  const G = new Float32Array(n * n);
  const xi = new Float64Array(d);
  for (let i = 0; i < n; i += 1) {
    const io = i * d;
    for (let t = 0; t < d; t += 1) xi[t] = X[io + t];
    for (let j = i; j < n; j += 1) {
      const jo = j * d;
      let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
      let t = 0;
      for (; t + 3 < d; t += 4) {
        s0 += xi[t] * X[jo + t];
        s1 += xi[t + 1] * X[jo + t + 1];
        s2 += xi[t + 2] * X[jo + t + 2];
        s3 += xi[t + 3] * X[jo + t + 3];
      }
      for (; t < d; t += 1) s0 += xi[t] * X[jo + t];
      const s = s0 + s1 + s2 + s3;
      G[i * n + j] = s;
      G[j * n + i] = s;
    }
    if ((i & 63) === 63) progress((i + 1) * (2 * n - i) / (n * (n + 1)));
  }
  progress(1);
  return G;
}

/**
 * Eigen-decomposition of a small symmetric matrix (k×k, row-major) by cyclic Jacobi.
 * Returns { values, vectors } sorted by descending eigenvalue; vectors are columns.
 */
export function jacobiEigen(A, k) {
  const a = Float64Array.from(A);
  const v = new Float64Array(k * k);
  for (let i = 0; i < k; i += 1) v[i * k + i] = 1;
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let p = 0; p < k; p += 1) for (let q = p + 1; q < k; q += 1) off += a[p * k + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < k; p += 1) {
      for (let q = p + 1; q < k; q += 1) {
        const apq = a[p * k + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * k + q] - a[p * k + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let r = 0; r < k; r += 1) {
          const arp = a[r * k + p];
          const arq = a[r * k + q];
          a[r * k + p] = c * arp - s * arq;
          a[r * k + q] = s * arp + c * arq;
        }
        for (let r = 0; r < k; r += 1) {
          const apr = a[p * k + r];
          const aqr = a[q * k + r];
          a[p * k + r] = c * apr - s * aqr;
          a[q * k + r] = s * apr + c * aqr;
        }
        for (let r = 0; r < k; r += 1) {
          const vrp = v[r * k + p];
          const vrq = v[r * k + q];
          v[r * k + p] = c * vrp - s * vrq;
          v[r * k + q] = s * vrp + c * vrq;
        }
      }
    }
  }
  const order = [...Array(k).keys()].sort((x, y) => a[y * k + y] - a[x * k + x]);
  const values = new Float64Array(k);
  const vectors = new Float64Array(k * k);
  order.forEach((src, dst) => {
    values[dst] = a[src * k + src];
    for (let r = 0; r < k; r += 1) vectors[r * k + dst] = v[r * k + src];
  });
  return { values, vectors };
}

/** Orthonormalise the columns of an n×p matrix in place (modified Gram-Schmidt). */
function orthonormalise(Q, n, p, rng) {
  for (let c = 0; c < p; c += 1) {
    for (let pass = 0; pass < 2; pass += 1) {
      for (let prev = 0; prev < c; prev += 1) {
        let dot = 0;
        for (let i = 0; i < n; i += 1) dot += Q[i * p + c] * Q[i * p + prev];
        for (let i = 0; i < n; i += 1) Q[i * p + c] -= dot * Q[i * p + prev];
      }
    }
    let norm = 0;
    for (let i = 0; i < n; i += 1) norm += Q[i * p + c] ** 2;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      // Degenerate column: replace with a random direction and re-orthogonalise.
      for (let i = 0; i < n; i += 1) Q[i * p + c] = rng() - 0.5;
      c -= 1;
      continue;
    }
    for (let i = 0; i < n; i += 1) Q[i * p + c] /= norm;
  }
}

/**
 * Leading eigenpairs of a symmetric positive semi-definite operator by subspace
 * iteration with Rayleigh-Ritz. multiply(Q, p, out) must write A·Q into out
 * (both n×p, row-major). Returns { values, vectors } for the top k.
 */
export function topEigen(multiply, n, k, { block = Math.min(n, k + 4), maxIter = 300, tol = 1e-7, seed = 7 } = {}) {
  const p = Math.min(n, Math.max(block, k));
  const rng = makeRng(seed);
  let Q = new Float64Array(n * p);
  for (let i = 0; i < Q.length; i += 1) Q[i] = rng() - 0.5;
  orthonormalise(Q, n, p, rng);
  const Z = new Float64Array(n * p);
  let prev = new Float64Array(k).fill(Infinity);
  let values = new Float64Array(k);
  let iterations = 0;
  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    multiply(Q, p, Z);
    // Rayleigh-Ritz: H = Qᵀ A Q, rotate the basis onto H's eigenvectors.
    const H = new Float64Array(p * p);
    for (let a = 0; a < p; a += 1) {
      for (let b = a; b < p; b += 1) {
        let s = 0;
        for (let i = 0; i < n; i += 1) s += Q[i * p + a] * Z[i * p + b];
        H[a * p + b] = s;
        H[b * p + a] = s;
      }
    }
    const eig = jacobiEigen(H, p);
    const next = new Float64Array(n * p);
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < p; c += 1) {
        let s = 0;
        for (let r = 0; r < p; r += 1) s += Z[i * p + r] * eig.vectors[r * p + c];
        next[i * p + c] = s;
      }
    }
    values = eig.values.slice(0, k);
    let converged = true;
    for (let c = 0; c < k; c += 1) {
      if (Math.abs(values[c] - prev[c]) > tol * Math.max(1, Math.abs(values[c]))) converged = false;
    }
    prev = values;
    orthonormalise(next, n, p, rng);
    Q = next;
    if (converged && iter > 2) break;
  }
  // Final Ritz vectors from the converged basis.
  multiply(Q, p, Z);
  const H = new Float64Array(p * p);
  for (let a = 0; a < p; a += 1) {
    for (let b = a; b < p; b += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += Q[i * p + a] * Z[i * p + b];
      H[a * p + b] = s;
      H[b * p + a] = s;
    }
  }
  const eig = jacobiEigen(H, p);
  const vectors = new Float64Array(n * k);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < k; c += 1) {
      let s = 0;
      for (let r = 0; r < p; r += 1) s += Q[i * p + r] * eig.vectors[r * p + c];
      vectors[i * k + c] = s;
    }
  }
  return { values: eig.values.slice(0, k), vectors, iterations };
}

/** Make each column's largest-magnitude entry positive so results are reproducible. */
export function fixSigns(Y, n, k) {
  for (let c = 0; c < k; c += 1) {
    let best = 0;
    for (let i = 0; i < n; i += 1) if (Math.abs(Y[i * k + c]) > Math.abs(best)) best = Y[i * k + c];
    if (best < 0) for (let i = 0; i < n; i += 1) Y[i * k + c] = -Y[i * k + c];
  }
}
