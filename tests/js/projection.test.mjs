import test from 'node:test';
import assert from 'node:assert/strict';
import { jacobiEigen, topEigen, makeRng, gramMatrix } from '../../site/js/projection/linalg.js';
import { knnFromGram } from '../../site/js/projection/knn.js';
import { computeLayouts, alignTo, normalise, METHOD_KEYS } from '../../site/js/projection/index.js';

function clusteredVectors(n, dim, clusters, seed = 3, noise = 0.3) {
  const rng = makeRng(seed);
  const centres = Array.from({ length: clusters }, () => Array.from({ length: dim }, () => rng() - 0.5));
  const v = new Float32Array(n * dim);
  const labels = [];
  for (let i = 0; i < n; i += 1) {
    const c = i % clusters;
    labels.push(c);
    let s = 0;
    for (let t = 0; t < dim; t += 1) {
      const x = centres[c][t] + (rng() - 0.5) * noise;
      v[i * dim + t] = x;
      s += x * x;
    }
    s = Math.sqrt(s);
    for (let t = 0; t < dim; t += 1) v[i * dim + t] /= s;
  }
  return { v, labels };
}

// Fraction of points whose nearest 2-D neighbour shares their cluster label.
function neighbourAgreement(coords, labels) {
  const n = labels.length;
  let agree = 0;
  for (let i = 0; i < n; i += 1) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const d = (coords[2 * i] - coords[2 * j]) ** 2 + (coords[2 * i + 1] - coords[2 * j + 1]) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    if (labels[best] === labels[i]) agree += 1;
  }
  return agree / n;
}

test('jacobiEigen recovers eigenpairs of a symmetric matrix', () => {
  const { values, vectors } = jacobiEigen([2, 1, 0, 1, 2, 0, 0, 0, 5], 3);
  assert.deepEqual(Array.from(values).map((v) => +v.toFixed(8)), [5, 3, 1]);
  // First eigenvector is ±e3.
  assert.ok(Math.abs(Math.abs(vectors[2 * 3 + 0]) - 1) < 1e-9);
});

test('topEigen finds the leading eigenvalues of a PSD operator', () => {
  const n = 50;
  const diag = Array.from({ length: n }, (_, i) => n - i);
  const multiply = (Q, p, out) => {
    for (let i = 0; i < n; i += 1) for (let c = 0; c < p; c += 1) out[i * p + c] = diag[i] * Q[i * p + c];
  };
  const { values } = topEigen(multiply, n, 2, { tol: 1e-10, maxIter: 500 });
  assert.ok(Math.abs(values[0] - 50) < 1e-6);
  assert.ok(Math.abs(values[1] - 49) < 1e-6);
});

test('knnFromGram matches brute force', () => {
  const { v } = clusteredVectors(60, 8, 3);
  const G = gramMatrix(v, 60, 8);
  const knn = knnFromGram(G, 60, 5);
  for (let i = 0; i < 60; i += 1) {
    const d = [];
    for (let j = 0; j < 60; j += 1) {
      if (j === i) continue;
      let s = 0;
      for (let t = 0; t < 8; t += 1) s += (v[i * 8 + t] - v[j * 8 + t]) ** 2;
      d.push([Math.sqrt(s), j]);
    }
    d.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let t = 0; t < 5; t += 1) {
      assert.ok(Math.abs(knn.distances[i * 5 + t] - d[t][0]) < 1e-5);
    }
  }
});

test('alignTo undoes a rotation and reflection', () => {
  const rng = makeRng(9);
  const n = 30;
  const old = Float64Array.from({ length: 2 * n }, () => rng() * 2 - 1);
  const a = 1.1;
  const moved = new Float64Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    // Rotate by a and mirror in the x axis.
    const x = old[2 * i] * Math.cos(a) - old[2 * i + 1] * Math.sin(a);
    const y = old[2 * i] * Math.sin(a) + old[2 * i + 1] * Math.cos(a);
    moved[2 * i] = x + 3;
    moved[2 * i + 1] = -y - 2;
  }
  const pairs = Array.from({ length: n }, (_, i) => [i, old[2 * i], old[2 * i + 1]]);
  const aligned = alignTo(moved, n, pairs);
  const cx = old.filter((_, t) => t % 2 === 0).reduce((s, x) => s + x, 0) / n;
  const cy = old.filter((_, t) => t % 2 === 1).reduce((s, x) => s + x, 0) / n;
  for (let i = 0; i < n; i += 1) {
    assert.ok(Math.abs(aligned[2 * i] - (old[2 * i] - cx)) < 1e-9);
    assert.ok(Math.abs(aligned[2 * i + 1] - (old[2 * i + 1] - cy)) < 1e-9);
  }
});

test('normalise maps coordinates into [-1, 1]', () => {
  const out = normalise(Float64Array.from([0, 0, 10, 4, 5, 2]), 3);
  assert.deepEqual(Array.from(out), [-1, -0.4, 1, 0.4, 0, 0]);
});

test('every method separates well-defined clusters', () => {
  const { v, labels } = clusteredVectors(240, 32, 4, 5, 0.6);
  const { coords } = computeLayouts(v, 240, 32);
  for (const key of METHOD_KEYS) {
    const c = coords[key];
    assert.equal(c.length, 480);
    assert.ok(c.every((x) => Number.isFinite(x) && x >= -1 && x <= 1), key);
    assert.ok(neighbourAgreement(c, labels) > 0.95, `${key} agreement`);
  }
});

test('layouts are deterministic', () => {
  const { v } = clusteredVectors(80, 16, 3);
  const a = computeLayouts(v, 80, 16).coords;
  const b = computeLayouts(v, 80, 16).coords;
  for (const key of METHOD_KEYS) assert.deepEqual(a[key], b[key]);
});

test('tiny and degenerate inputs produce finite layouts', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 7]) {
    const { v } = clusteredVectors(n, 8, 2);
    const { coords } = computeLayouts(v, n, 8);
    for (const key of METHOD_KEYS) {
      assert.equal(coords[key].length, 2 * n);
      assert.ok(coords[key].every(Number.isFinite), `${key} n=${n}`);
    }
  }
  // Identical vectors (duplicate rows) must not break anything.
  const same = new Float32Array(20 * 4).fill(0.5);
  const { coords } = computeLayouts(same, 20, 4);
  for (const key of METHOD_KEYS) assert.ok(coords[key].every(Number.isFinite), key);
});

test('updated layouts keep the orientation of the previous version', () => {
  const { v } = clusteredVectors(120, 16, 3, 11);
  const ids = Array.from({ length: 120 }, (_, i) => `p${i}`);
  const first = computeLayouts(v.subarray(0, 100 * 16), 100, 16, { ids: ids.slice(0, 100) });
  const second = computeLayouts(v, 120, 16, { ids, previous: { ids: ids.slice(0, 100), coords: first.coords } });
  // PCA is linear, so shared points should land close to where they were.
  let err = 0;
  for (let i = 0; i < 100; i += 1) {
    err += Math.hypot(first.coords.pca[2 * i] - second.coords.pca[2 * i], first.coords.pca[2 * i + 1] - second.coords.pca[2 * i + 1]);
  }
  assert.ok(err / 100 < 0.15, `mean shift ${err / 100}`);
});
