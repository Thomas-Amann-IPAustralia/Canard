// HDBSCAN (Campello, Moulavi & Sander, 2013), following the reference hdbscan library
// and scikit-learn: core distances, the minimum spanning tree of the mutual
// reachability graph, the single-linkage hierarchy, the condensed tree, and flat
// clusters chosen by excess of mass. Exact (no approximate neighbours), which is
// fine for the few thousand low-dimensional points it is given here.

/** Squared Euclidean distance between rows a and b of a row-major n×d matrix. */
function dist2(X, d, a, b) {
  let s = 0;
  const ao = a * d;
  const bo = b * d;
  for (let t = 0; t < d; t += 1) {
    const x = X[ao + t] - X[bo + t];
    s += x * x;
  }
  return s;
}

/**
 * Core distance of every point: the distance to its minSamples-th nearest neighbour,
 * counting the point itself (as scikit-learn and the hdbscan library do).
 */
export function coreDistances(X, n, d, minSamples) {
  const core = new Float64Array(n);
  const k = Math.min(minSamples - 1, n - 1);
  if (k <= 0) return core;
  // A max-heap of the k smallest distances to other points.
  const heap = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    let size = 0;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const v = dist2(X, d, i, j);
      if (size < k) {
        let c = size;
        size += 1;
        while (c > 0) {
          const parent = (c - 1) >> 1;
          if (heap[parent] >= v) break;
          heap[c] = heap[parent];
          c = parent;
        }
        heap[c] = v;
      } else if (v < heap[0]) {
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          if (l >= k) break;
          const r = l + 1;
          const m = r < k && heap[r] > heap[l] ? r : l;
          if (heap[m] <= v) break;
          heap[c] = heap[m];
          c = m;
        }
        heap[c] = v;
      }
    }
    core[i] = Math.sqrt(heap[0]);
  }
  return core;
}

/**
 * Minimum spanning tree of the mutual reachability graph by Prim's algorithm on the
 * dense graph (O(n²) time, O(n) memory). Returns edges sorted by weight:
 * { from: Int32Array, to: Int32Array, weight: Float64Array } with n - 1 entries.
 */
export function mutualReachabilityMst(X, n, d, core) {
  const from = new Int32Array(Math.max(0, n - 1));
  const to = new Int32Array(Math.max(0, n - 1));
  const weight = new Float64Array(Math.max(0, n - 1));
  if (n < 2) return { from, to, weight };
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const bestFrom = new Int32Array(n).fill(-1);
  let current = 0;
  inTree[0] = 1;
  for (let e = 0; e < n - 1; e += 1) {
    const cc = core[current];
    let next = -1;
    let nextD = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (inTree[j]) continue;
      const mr = Math.max(Math.sqrt(dist2(X, d, current, j)), cc, core[j]);
      if (mr < best[j]) {
        best[j] = mr;
        bestFrom[j] = current;
      }
      if (best[j] < nextD) {
        nextD = best[j];
        next = j;
      }
    }
    from[e] = bestFrom[next];
    to[e] = next;
    weight[e] = nextD;
    inTree[next] = 1;
    current = next;
  }
  // Stable sort by weight so ties merge in a reproducible order.
  const order = [...Array(n - 1).keys()].sort((a, b) => weight[a] - weight[b] || a - b);
  return {
    from: Int32Array.from(order, (i) => from[i]),
    to: Int32Array.from(order, (i) => to[i]),
    weight: Float64Array.from(order, (i) => weight[i]),
  };
}

/**
 * Single-linkage hierarchy from sorted MST edges (scipy's linkage format). Row r merges
 * nodes left[r] and right[r] at distance[r] into node n + r of size size[r].
 */
export function singleLinkage(mst, n) {
  const m = Math.max(0, n - 1);
  const left = new Int32Array(m);
  const right = new Int32Array(m);
  const distance = new Float64Array(m);
  const size = new Int32Array(m);
  const parent = new Int32Array(2 * n).fill(-1);
  const nodeSize = new Int32Array(2 * n);
  nodeSize.fill(1, 0, n);
  const find = (x) => {
    let root = x;
    while (parent[root] !== -1) root = parent[root];
    while (parent[x] !== -1) { const p = parent[x]; parent[x] = root; x = p; }
    return root;
  };
  for (let r = 0; r < m; r += 1) {
    const a = find(mst.from[r]);
    const b = find(mst.to[r]);
    const node = n + r;
    left[r] = a;
    right[r] = b;
    distance[r] = mst.weight[r];
    size[r] = nodeSize[a] + nodeSize[b];
    nodeSize[node] = size[r];
    parent[a] = node;
    parent[b] = node;
  }
  return { left, right, distance, size };
}

/** Every node below (and including) `node` in the single-linkage hierarchy. */
function descendants(tree, n, node) {
  const out = [];
  const stack = [node];
  while (stack.length) {
    const x = stack.pop();
    out.push(x);
    if (x >= n) {
      stack.push(tree.left[x - n], tree.right[x - n]);
    }
  }
  return out;
}

// Lambda (1 / distance) for a merge; zero distances (duplicate points) get a large
// finite value so stabilities stay finite.
const lambdaOf = (distance) => (distance > 1e-12 ? 1 / distance : 1e12);

/**
 * Condense the hierarchy: walk down from the root, and whenever a split sheds fewer
 * than minClusterSize points, treat those points as "falling out" of the cluster
 * rather than as a new cluster. Returns rows { parent, child, lambda, childSize };
 * clusters are numbered from n (the root) upwards, points keep their own index.
 */
export function condenseTree(tree, n, minClusterSize) {
  const parent = [];
  const child = [];
  const lambda = [];
  const childSize = [];
  if (n < 2) return { parent, child, lambda, childSize, root: n };
  const root = 2 * n - 2;
  const relabel = new Int32Array(root + 1);
  relabel[root] = n;
  let nextLabel = n + 1;
  const ignore = new Uint8Array(root + 1);
  const sizeOf = (x) => (x >= n ? tree.size[x - n] : 1);
  const push = (p, c, l, s) => { parent.push(p); child.push(c); lambda.push(l); childSize.push(s); };
  const fallOut = (from, sub, l) => {
    for (const x of descendants(tree, n, sub)) {
      if (x < n) push(from, x, l, 1);
      ignore[x] = 1;
    }
  };
  // Breadth-first from the root, as the reference implementation does.
  const queue = [root];
  for (let q = 0; q < queue.length; q += 1) {
    const node = queue[q];
    if (node < n) continue;
    queue.push(tree.left[node - n], tree.right[node - n]);
    if (ignore[node]) continue;
    const l = tree.left[node - n];
    const r = tree.right[node - n];
    const lam = lambdaOf(tree.distance[node - n]);
    const ls = sizeOf(l);
    const rs = sizeOf(r);
    const label = relabel[node];
    if (ls >= minClusterSize && rs >= minClusterSize) {
      relabel[l] = nextLabel++;
      push(label, relabel[l], lam, ls);
      relabel[r] = nextLabel++;
      push(label, relabel[r], lam, rs);
    } else if (ls < minClusterSize && rs < minClusterSize) {
      fallOut(label, l, lam);
      fallOut(label, r, lam);
    } else if (ls < minClusterSize) {
      relabel[r] = label;
      fallOut(label, l, lam);
    } else {
      relabel[l] = label;
      fallOut(label, r, lam);
    }
  }
  return { parent, child, lambda, childSize, root: n };
}

/** Stability of each condensed cluster: Σ (λ_leave − λ_birth) × size. Keyed by cluster id. */
export function stabilities(condensed) {
  const { parent, child, lambda, childSize, root } = condensed;
  const births = new Map([[root, 0]]);
  for (let r = 0; r < child.length; r += 1) if (childSize[r] > 1 || child[r] >= root) births.set(child[r], lambda[r]);
  const stability = new Map();
  for (const c of births.keys()) stability.set(c, 0);
  for (let r = 0; r < parent.length; r += 1) {
    const p = parent[r];
    stability.set(p, stability.get(p) + (lambda[r] - births.get(p)) * childSize[r]);
  }
  return stability;
}

/**
 * Choose flat clusters by excess of mass and label every point (-1 for noise).
 * Returns { labels: Int32Array, probabilities: Float64Array, clusterCount }.
 */
export function extractClusters(condensed, n, { allowSingleCluster = false } = {}) {
  const labels = new Int32Array(n).fill(-1);
  const probabilities = new Float64Array(n);
  if (!condensed.parent.length) return { labels, probabilities, clusterCount: 0 };
  const { parent, child, lambda, childSize, root } = condensed;
  const stability = stabilities(condensed);
  const childrenOf = new Map();
  for (let r = 0; r < child.length; r += 1) {
    if (childSize[r] > 1) {
      if (!childrenOf.has(parent[r])) childrenOf.set(parent[r], []);
      childrenOf.get(parent[r]).push(child[r]);
    }
  }
  // Bottom-up (children always have larger ids than their parents).
  let nodes = [...stability.keys()].sort((a, b) => b - a);
  if (!allowSingleCluster) nodes = nodes.filter((c) => c !== root);
  const selected = new Map(nodes.map((c) => [c, true]));
  const clearBelow = (node) => {
    const stack = [...(childrenOf.get(node) || [])];
    while (stack.length) {
      const x = stack.pop();
      selected.set(x, false);
      stack.push(...(childrenOf.get(x) || []));
    }
  };
  for (const node of nodes) {
    const kids = childrenOf.get(node) || [];
    const subtree = kids.reduce((s, c) => s + stability.get(c), 0);
    if (subtree > stability.get(node)) {
      selected.set(node, false);
      stability.set(node, subtree);
    } else {
      clearBelow(node);
    }
  }
  const chosen = [...selected.entries()].filter(([, v]) => v).map(([c]) => c).sort((a, b) => a - b);
  const labelOf = new Map(chosen.map((c, i) => [c, i]));
  // Union every condensed edge whose child is not a chosen cluster, so each point
  // resolves to the chosen cluster above it (or the root, meaning noise).
  const up = new Map();
  for (let r = 0; r < child.length; r += 1) if (!labelOf.has(child[r])) up.set(child[r], parent[r]);
  const resolve = (x) => {
    let y = x;
    while (up.has(y) && !labelOf.has(y)) y = up.get(y);
    return y;
  };
  // Membership strength, as in scikit-learn: how long a point stays in its cluster,
  // relative to the largest lambda at which anything leaves that cluster.
  const pointLambda = new Float64Array(n);
  const deaths = new Map();
  for (let r = 0; r < child.length; r += 1) {
    if (child[r] < n) pointLambda[child[r]] = lambda[r];
    deaths.set(parent[r], Math.max(deaths.get(parent[r]) || 0, lambda[r]));
  }
  for (let i = 0; i < n; i += 1) {
    const c = resolve(i);
    if (!labelOf.has(c)) continue;
    labels[i] = labelOf.get(c);
    const m = deaths.get(c) || 0;
    probabilities[i] = m > 0 ? Math.min(pointLambda[i], m) / m : 1;
  }
  return { labels, probabilities, clusterCount: chosen.length };
}

/**
 * Run HDBSCAN on an n×d row-major matrix. Returns { labels, probabilities, clusterCount }
 * with labels from 0 and -1 for noise.
 */
export function hdbscan(X, n, d, { minClusterSize = 5, minSamples = minClusterSize, allowSingleCluster = false } = {}) {
  if (n < Math.max(2, minClusterSize)) {
    return { labels: new Int32Array(n).fill(-1), probabilities: new Float64Array(n), clusterCount: 0 };
  }
  const core = coreDistances(X, n, d, minSamples);
  const mst = mutualReachabilityMst(X, n, d, core);
  const tree = singleLinkage(mst, n);
  const condensed = condenseTree(tree, n, minClusterSize);
  return extractClusters(condensed, n, { allowSingleCluster });
}
