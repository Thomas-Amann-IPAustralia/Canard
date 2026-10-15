// Exact k-nearest neighbours from a Gram matrix (Euclidean distances).

/**
 * Returns { indices: Int32Array(n*k), distances: Float32Array(n*k), k } with each row
 * sorted by ascending distance and the point itself excluded.
 */
export function knnFromGram(G, n, k) {
  const kk = Math.max(0, Math.min(k, n - 1));
  const indices = new Int32Array(n * kk);
  const distances = new Float32Array(n * kk);
  if (kk === 0) return { indices, distances, k: kk };
  const heapD = new Float64Array(kk);
  const heapI = new Int32Array(kk);
  for (let i = 0; i < n; i += 1) {
    const gii = G[i * n + i];
    let size = 0;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const d2 = Math.max(0, gii + G[j * n + j] - 2 * G[i * n + j]);
      if (size < kk) {
        // Sift up into a max-heap.
        let c = size;
        size += 1;
        while (c > 0) {
          const parent = (c - 1) >> 1;
          if (heapD[parent] >= d2) break;
          heapD[c] = heapD[parent];
          heapI[c] = heapI[parent];
          c = parent;
        }
        heapD[c] = d2;
        heapI[c] = j;
      } else if (d2 < heapD[0]) {
        // Replace the root and sift down.
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          if (l >= kk) break;
          const r = l + 1;
          const m = r < kk && heapD[r] > heapD[l] ? r : l;
          if (heapD[m] <= d2) break;
          heapD[c] = heapD[m];
          heapI[c] = heapI[m];
          c = m;
        }
        heapD[c] = d2;
        heapI[c] = j;
      }
    }
    const order = [...Array(kk).keys()].sort((a, b) => heapD[a] - heapD[b] || heapI[a] - heapI[b]);
    for (let t = 0; t < kk; t += 1) {
      indices[i * kk + t] = heapI[order[t]];
      distances[i * kk + t] = Math.sqrt(heapD[order[t]]);
    }
  }
  return { indices, distances, k: kk };
}
