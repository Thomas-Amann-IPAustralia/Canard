import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../../site/js/projection/linalg.js';
import { prepare } from '../../site/js/projection/index.js';
import { umap } from '../../site/js/projection/umap.js';
import { knnFromGram } from '../../site/js/projection/knn.js';
import { gramMatrix } from '../../site/js/projection/linalg.js';
import { hdbscan } from '../../site/js/clustering/hdbscan.js';
import { computeTopics, relabelBySize, clusterParams } from '../../site/js/clustering/index.js';
import { topicKeywords, candidateTerms } from '../../site/js/clustering/ctfidf.js';
import { describeClusters, hasClusters, UNCLUSTERED } from '../../site/js/cluster-view.js';
import { CLUSTERS, EMBEDDING, embeddingText } from '../../site/js/schema.js';
import {
  TERRITORIES, allTerritoryStatements, territoryCentroids, territorySimilarities, nearestTerritory, territoryLayout, territoryAnchors,
} from '../../site/js/territories.js';
import { readJson, tokenCounter } from './helpers.mjs';

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

/** Labels agree up to renumbering (noise must match noise). */
function sameClustering(a, b) {
  const map = new Map();
  const back = new Map();
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] < 0) !== (b[i] < 0)) return false;
    if (a[i] < 0) continue;
    if (map.has(a[i]) && map.get(a[i]) !== b[i]) return false;
    if (back.has(b[i]) && back.get(b[i]) !== a[i]) return false;
    map.set(a[i], b[i]);
    back.set(b[i], a[i]);
  }
  return true;
}

test('HDBSCAN matches scikit-learn on blobs with noise', () => {
  for (const c of readJson('tests/fixtures/hdbscan/sklearn-blobs.json')) {
    const n = c.X.length;
    const d = c.X[0].length;
    const out = hdbscan(Float64Array.from(c.X.flat()), n, d, { minClusterSize: c.minClusterSize, minSamples: c.minSamples });
    assert.ok(sameClustering(Array.from(out.labels), c.labels), c.note);
    for (let i = 0; i < n; i += 1) assert.ok(Math.abs(out.probabilities[i] - c.probabilities[i]) < 1e-3, `probability ${i}`);
  }
});

test('HDBSCAN copes with tiny and duplicated inputs', () => {
  assert.deepEqual(Array.from(hdbscan(new Float64Array(0), 0, 2).labels), []);
  assert.deepEqual(Array.from(hdbscan(Float64Array.from([0, 0, 1, 1]), 2, 2, { minClusterSize: 3 }).labels), [-1, -1]);
  // Two tight groups of identical points.
  const X = new Float64Array(40);
  for (let i = 0; i < 20; i += 1) X[2 * i] = i < 10 ? 0 : 5;
  const out = hdbscan(X, 20, 2, { minClusterSize: 5 });
  assert.equal(out.clusterCount, 2);
  assert.ok(Array.from(out.labels).every((l, i) => l === out.labels[i < 10 ? 0 : 10]));
  assert.ok(Array.from(out.probabilities).every(Number.isFinite));
});

test('UMAP optimises embeddings with more than two dimensions', () => {
  const { v } = clusteredVectors(60, 16, 3);
  const knn = knnFromGram(gramMatrix(v, 60, 16), 60, 10);
  const init = Float64Array.from({ length: 60 * 5 }, (_, i) => Math.sin(i));
  const Y = umap(knn, 60, init, { nComponents: 5, nNeighbors: 11, nEpochs: 50 });
  assert.equal(Y.length, 300);
  assert.ok(Y.every(Number.isFinite));
});

test('topic clustering recovers well-separated groups and is deterministic', () => {
  const { v, labels } = clusteredVectors(240, 32, 4, 5, 0.6);
  const prep = prepare(v, 240, 32);
  const a = computeTopics(v, 240, 32, prep.knnUmap);
  const b = computeTopics(v, 240, 32, null);
  assert.equal(a.clusterCount, 4);
  assert.deepEqual(a.labels, b.labels, 'same result with neighbours worked out internally');
  // Each found cluster is pure, and few entries are left unclustered.
  const found = Array.from(a.labels);
  const clustered = found.filter((l) => l >= 0).length;
  assert.ok(clustered / 240 > 0.9, `clustered ${clustered}`);
  assert.ok(sameClustering(found.map((l, i) => (l < 0 ? -1 : l)), found.map((l, i) => (l < 0 ? -1 : labels[i]))));
  // Clusters are numbered by size.
  const sizes = [0, 1, 2, 3].map((k) => found.filter((l) => l === k).length);
  assert.deepEqual(sizes, [...sizes].sort((x, y) => y - x));
  assert.equal(a.params.nComponents, 5);
});

test('topic clustering leaves very small plots unclustered', () => {
  const { v } = clusteredVectors(5, 8, 2);
  const out = computeTopics(v, 5, 8, null);
  assert.deepEqual(Array.from(out.labels), [-1, -1, -1, -1, -1]);
  assert.equal(clusterParams(24).minClusterSize, 3);
  assert.equal(clusterParams(600).minClusterSize, 12);
  assert.equal(clusterParams(5000).minClusterSize, 25);
});

test('relabelBySize numbers clusters from the largest', () => {
  assert.deepEqual(Array.from(relabelBySize([5, 2, 2, -1, 5, 2, 9])), [1, 0, 0, -1, 1, 0, 2]);
});

test('candidate terms skip stop words, numbers and possessives', () => {
  assert.deepEqual(candidateTerms("The Patent Office's 2024 review of trade marks"),
    ['patent', 'office', 'patent office', 'review', 'trade', 'marks', 'trade marks']);
});

test('c-TF-IDF finds the distinctive words of each cluster', () => {
  const texts = [
    'Counterfeit goods seized at the border\nCustoms seized counterfeit trade marks and fake goods.',
    'Counterfeit trade mark enforcement\nBrand owners report counterfeit goods sold online.',
    'Fake goods and trade marks\nEnforcement against counterfeit trade marks is rising.',
    'Patent examination times fall\nPatent examiners cleared the examination backlog.',
    'Faster patent examination\nThe office speeds up patent examination for small firms.',
    'Patent examination quality\nExaminers review patent claims for quality.',
    'A report on everything\nGeneral report.',
  ];
  const kw = topicKeywords(texts, [0, 0, 0, 1, 1, 1, -1]);
  assert.equal(kw.size, 2, 'unclustered entries get no keywords');
  const first = kw.get(0).map((k) => k.term);
  const second = kw.get(1).map((k) => k.term);
  assert.ok(first.slice(0, 3).includes('counterfeit'), first.join(', '));
  assert.ok(first.includes('trade marks'), `plural kept as the more common form: ${first.join(', ')}`);
  assert.ok(!first.includes('trade') && !first.includes('marks'), 'words inside a chosen phrase are not repeated');
  assert.ok(second.slice(0, 2).some((t) => t.startsWith('patent')), second.join(', '));
  assert.ok(!second.includes('counterfeit'));
  for (const list of kw.values()) for (const { score } of list) assert.ok(score > 0);
});

test('every growth territory statement fits the embedding model', () => {
  const counter = tokenCounter();
  const statements = allTerritoryStatements();
  assert.equal(TERRITORIES.length, CLUSTERS.territories);
  assert.equal(new Set(statements.map((s) => s.territory)).size, CLUSTERS.territories);
  for (const s of statements) {
    assert.ok(counter(embeddingText(s.title, s.summary)) <= EMBEDDING.maxTokens, s.summary.slice(0, 40));
    assert.ok(s.summary.endsWith('.'), s.summary);
  }
});

test('territory centroids are unit vectors and drive the assignment', () => {
  const dim = 8;
  const statements = allTerritoryStatements();
  // Fake statement embeddings: each territory's statements point along its own axis.
  const v = new Float32Array(statements.length * dim);
  statements.forEach((s, i) => { v[i * dim + s.territory] = 1; v[i * dim + 7] = 0.2; });
  const centroids = territoryCentroids(v, dim);
  for (let c = 0; c < CLUSTERS.territories; c += 1) {
    const norm = Math.hypot(...centroids.subarray(c * dim, (c + 1) * dim));
    assert.ok(Math.abs(norm - 1) < 1e-6);
  }
  const entries = Float32Array.from([0, 0, 0.9, 0.1, 0, 0, 0, 0.4, 0.6, 0, 0, 0, 0, 0, 0, 0.8]);
  const sims = territorySimilarities(entries, 2, dim, centroids);
  assert.equal(sims.length, 2 * CLUSTERS.territories);
  assert.equal(nearestTerritory(sims, 0), 2);
  assert.equal(nearestTerritory(sims, 1), 0);
});

test('the territories layout pulls entries towards their closest centroid', () => {
  const k = CLUSTERS.territories;
  const anchors = territoryAnchors(k);
  const sims = [
    0.80, 0.60, 0.60, 0.60, 0.60, // clearly territory 1
    0.60, 0.60, 0.60, 0.61, 0.80, // clearly territory 5
    0.70, 0.70, 0.70, 0.70, 0.70, // equally close to all
    0.75, 0.75, 0.60, 0.60, 0.60, // split between 1 and 2
  ];
  const Y = territoryLayout(sims, 4);
  const dist = (i, [x, y]) => Math.hypot(Y[2 * i] - x, Y[2 * i + 1] - y);
  assert.ok(dist(0, anchors[0]) < 0.2);
  assert.ok(dist(1, anchors[4]) < 0.2);
  assert.ok(Math.hypot(Y[4], Y[5]) < 1e-3);
  assert.ok(Math.abs(dist(3, anchors[0]) - dist(3, anchors[1])) < 1e-3);
  assert.ok(Y.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
  assert.deepEqual(Array.from(territoryLayout([], 0)), []);
});

test('describeClusters labels entries and ignores missing or stale data', () => {
  const points = [
    { title: 'Counterfeit goods', summary: 'Counterfeit trade marks seized.' },
    { title: 'Counterfeit online', summary: 'Counterfeit trade marks sold online.' },
    { title: 'Patent backlog', summary: 'Patent examination backlog.' },
  ];
  const sims = [0.9, 0.5, 0.5, 0.5, 0.5, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9];
  const doc = { points, clusters: { topic: [0, 0, -1], territory: sims } };
  assert.ok(hasClusters(doc));
  const info = describeClusters(doc);
  assert.deepEqual(points.map((p) => p.topic), ['0', '0', UNCLUSTERED]);
  assert.deepEqual(points.map((p) => p.territory), ['protect', 'protect', 'revisit']);
  assert.equal(info.topics.length, 1);
  assert.equal(info.topics[0].size, 2);
  assert.ok(info.topics[0].label.startsWith('1 · counterfeit'), info.topics[0].label);
  assert.deepEqual(info.territories.map((t) => t.size), [2, 0, 0, 0, 1]);
  assert.equal(info.coords.length, 6);
  // Clusters that do not cover every entry (for example from an older page) are ignored.
  const stale = { points: [...points, { title: 'x', summary: 'y' }], clusters: doc.clusters };
  assert.equal(hasClusters(stale), false);
  assert.equal(describeClusters(stale), null);
  assert.equal(stale.points[0].topic, undefined);
});
