// Barnes-Hut t-SNE (van der Maaten, 2014), following scikit-learn's defaults:
// PCA initialisation, early exaggeration of 12 for 250 iterations, learning rate
// max(n / 48, 50) with scikit-learn's gradient scaling, and theta = 0.5.

const EPS = 1e-12;

/** Conditional affinities from k-nearest-neighbour distances, then symmetrised (CSR). */
export function jointProbabilities(knn, n, perplexity) {
  const { indices, distances, k } = knn;
  const cond = new Float64Array(n * k);
  const target = Math.log(perplexity);
  const d2 = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) d2[t] = distances[i * k + t] ** 2;
    let beta = 1;
    let lo = -Infinity;
    let hi = Infinity;
    for (let step = 0; step < 100; step += 1) {
      let sum = 0;
      for (let t = 0; t < k; t += 1) {
        const p = Math.exp(-d2[t] * beta);
        cond[i * k + t] = p;
        sum += p;
      }
      if (sum === 0) sum = 1e-8;
      let weighted = 0;
      for (let t = 0; t < k; t += 1) {
        cond[i * k + t] /= sum;
        weighted += d2[t] * cond[i * k + t];
      }
      const entropy = Math.log(sum) + beta * weighted;
      const diff = entropy - target;
      if (Math.abs(diff) <= 1e-5) break;
      if (diff > 0) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2;
      }
    }
  }
  // Symmetrise: P = (C + Cᵀ) / sum.
  const counts = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      counts[i + 1] += 1;
      counts[indices[i * k + t] + 1] += 1;
    }
  }
  for (let i = 0; i < n; i += 1) counts[i + 1] += counts[i];
  const fill = counts.slice(0, n);
  const cols = new Int32Array(counts[n]);
  const vals = new Float64Array(counts[n]);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      const v = cond[i * k + t];
      cols[fill[i]] = j; vals[fill[i]] = v; fill[i] += 1;
      cols[fill[j]] = i; vals[fill[j]] = v; fill[j] += 1;
    }
  }
  // Merge duplicate (i, j) entries within each row.
  const rowPtr = new Int32Array(n + 1);
  const outCols = [];
  const outVals = [];
  const slot = new Int32Array(n).fill(-1);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const start = outCols.length;
    for (let e = counts[i]; e < counts[i + 1]; e += 1) {
      const j = cols[e];
      if (slot[j] >= start) {
        outVals[slot[j]] += vals[e];
      } else {
        slot[j] = outCols.length;
        outCols.push(j);
        outVals.push(vals[e]);
      }
      total += vals[e];
    }
    rowPtr[i + 1] = outCols.length;
  }
  const P = Float64Array.from(outVals);
  for (let e = 0; e < P.length; e += 1) P[e] /= Math.max(total, EPS);
  return { rowPtr, cols: Int32Array.from(outCols), vals: P };
}

/** A reusable quadtree over 2-D points for the Barnes-Hut repulsive forces. */
class QuadTree {
  constructor(n) {
    this.grow(Math.max(64, 4 * n));
  }

  grow(cap) {
    const copy = (Old, size, fillValue) => {
      const a = new Old.constructor(size);
      if (fillValue !== undefined) a.fill(fillValue);
      a.set(Old.subarray(0, Math.min(Old.length, size)));
      return a;
    };
    if (!this.cap) {
      this.cx = new Float64Array(cap); this.cy = new Float64Array(cap); this.hw = new Float64Array(cap);
      this.mass = new Float64Array(cap); this.sx = new Float64Array(cap); this.sy = new Float64Array(cap);
      this.child = new Int32Array(cap * 4).fill(-1); this.point = new Int32Array(cap).fill(-1);
      this.leaf = new Uint8Array(cap);
    } else {
      this.cx = copy(this.cx, cap); this.cy = copy(this.cy, cap); this.hw = copy(this.hw, cap);
      this.mass = copy(this.mass, cap); this.sx = copy(this.sx, cap); this.sy = copy(this.sy, cap);
      this.child = copy(this.child, cap * 4, -1); this.point = copy(this.point, cap, -1);
      this.leaf = copy(this.leaf, cap);
    }
    this.cap = cap;
  }

  node(cx, cy, hw) {
    if (this.size >= this.cap) this.grow(this.cap * 2);
    const id = this.size;
    this.size += 1;
    this.cx[id] = cx; this.cy[id] = cy; this.hw[id] = hw;
    this.mass[id] = 0; this.sx[id] = 0; this.sy[id] = 0;
    this.child.fill(-1, id * 4, id * 4 + 4);
    this.point[id] = -1;
    this.leaf[id] = 1;
    return id;
  }

  childFor(id, x, y) {
    const q = (x >= this.cx[id] ? 1 : 0) + (y >= this.cy[id] ? 2 : 0);
    let c = this.child[id * 4 + q];
    if (c < 0) {
      const h = this.hw[id] / 2;
      c = this.node(this.cx[id] + (q & 1 ? h : -h), this.cy[id] + (q & 2 ? h : -h), h);
      this.child[id * 4 + q] = c;
    }
    return c;
  }

  build(Y, n) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const x = Y[2 * i]; const y = Y[2 * i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.size = 0;
    const hw = Math.max(maxX - minX, maxY - minY) / 2 + 1e-5;
    this.node((minX + maxX) / 2, (minY + maxY) / 2, hw * 1.001);
    for (let i = 0; i < n; i += 1) this.insert(i, Y[2 * i], Y[2 * i + 1], Y);
  }

  insert(p, x, y, Y) {
    let id = 0;
    for (let depth = 0; ; depth += 1) {
      this.mass[id] += 1; this.sx[id] += x; this.sy[id] += y;
      if (this.leaf[id]) {
        if (this.point[id] < 0) { this.point[id] = p; return; }
        const other = this.point[id];
        const ox = Y[2 * other]; const oy = Y[2 * other + 1];
        // Coincident points (or extreme depth) share a leaf; its mass covers both.
        if ((ox === x && oy === y) || depth > 48) return;
        this.leaf[id] = 0;
        this.point[id] = -1;
        const oc = this.childFor(id, ox, oy);
        this.mass[oc] += this.mass[id] - 1; this.sx[oc] += this.sx[id] - x; this.sy[oc] += this.sy[id] - y;
        this.point[oc] = other;
      }
      id = this.childFor(id, x, y);
    }
  }
}

/**
 * Run Barnes-Hut t-SNE. P is the CSR joint-probability matrix; init is an n×2
 * Float64Array of starting positions. Returns the n×2 embedding (Float64Array).
 */
export function tsne(P, n, init, { iterations = 1000, exaggeration = 12, exploration = 250, theta = 0.5, progress = () => {} } = {}) {
  const Y = Float64Array.from(init);
  if (n < 2) return Y;
  const lr = Math.max(n / exaggeration / 4, 50);
  const update = new Float64Array(2 * n);
  const gains = new Float64Array(2 * n).fill(1);
  const grad = new Float64Array(2 * n);
  const neg = new Float64Array(2 * n);
  const tree = new QuadTree(n);
  const stack = new Int32Array(4096);
  const theta2 = theta * theta;
  const { rowPtr, cols, vals } = P;

  for (let iter = 0; iter < iterations; iter += 1) {
    const exag = iter < exploration ? exaggeration : 1;
    const momentum = iter < exploration ? 0.5 : 0.8;
    tree.build(Y, n);
    // Repulsive forces.
    let sumQ = 0;
    for (let i = 0; i < n; i += 1) {
      const xi = Y[2 * i]; const yi = Y[2 * i + 1];
      let fx = 0; let fy = 0;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const id = stack[--top];
        let m = tree.mass[id];
        if (m === 0) continue;
        let comx = tree.sx[id] / m;
        let comy = tree.sy[id] / m;
        const isLeaf = tree.leaf[id] === 1;
        if (isLeaf && tree.point[id] === i) {
          // Exclude the point itself; any coincident duplicates remain.
          if (m <= 1) continue;
          comx = (tree.sx[id] - xi) / (m - 1);
          comy = (tree.sy[id] - yi) / (m - 1);
          m -= 1;
        }
        const dx = xi - comx; const dy = yi - comy;
        const d2 = dx * dx + dy * dy;
        const width = 2 * tree.hw[id];
        if (isLeaf || width * width < theta2 * d2) {
          const q = 1 / (1 + d2);
          sumQ += m * q;
          const mult = m * q * q;
          fx += mult * dx; fy += mult * dy;
        } else {
          for (let c = 0; c < 4; c += 1) {
            const ch = tree.child[id * 4 + c];
            if (ch >= 0) stack[top++] = ch;
          }
        }
      }
      neg[2 * i] = fx; neg[2 * i + 1] = fy;
    }
    // Attractive forces and the gradient.
    const invQ = 1 / Math.max(sumQ, EPS);
    for (let i = 0; i < n; i += 1) {
      const xi = Y[2 * i]; const yi = Y[2 * i + 1];
      let ax = 0; let ay = 0;
      for (let e = rowPtr[i]; e < rowPtr[i + 1]; e += 1) {
        const j = cols[e];
        const dx = xi - Y[2 * j]; const dy = yi - Y[2 * j + 1];
        const w = vals[e] / (1 + dx * dx + dy * dy);
        ax += w * dx; ay += w * dy;
      }
      grad[2 * i] = 4 * (exag * ax - neg[2 * i] * invQ);
      grad[2 * i + 1] = 4 * (exag * ay - neg[2 * i + 1] * invQ);
    }
    for (let t = 0; t < 2 * n; t += 1) {
      const g = grad[t];
      if (update[t] * g < 0) gains[t] += 0.2;
      else gains[t] = Math.max(gains[t] * 0.8, 0.01);
      update[t] = momentum * update[t] - lr * gains[t] * g;
      Y[t] += update[t];
    }
    if (iter % 25 === 24) progress((iter + 1) / iterations);
  }
  progress(1);
  return Y;
}
