// Turns a plot's stored clusters (points.json "clusters") into what the page shows:
// a value on every entry for colouring and filtering ("topic" and "territory"), the
// keywords of each topic cluster, and the coordinates of the territories view.
import { CLUSTERS } from './schema.js';
import { TERRITORIES, nearestTerritory, territoryAnchors, territoryLayout } from './territories.js';
import { topicKeywords } from './clustering/ctfidf.js';

export const UNCLUSTERED = '\u0000unclustered';

// The extra view, shown after the projections. It is worked out in the browser from
// the stored similarities, so it needs no stored coordinates.
export const TERRITORY_VIEW = {
  key: 'territory',
  label: 'Territories',
  blurb: 'Growth territories. Each territory’s centroid is fixed by its own text; every entry sits among the five according to how similar it is to each, and belongs to the closest.',
};

/** True when the points document carries usable clusters for every entry. */
export function hasClusters(pointsDoc) {
  const c = pointsDoc?.clusters;
  const n = pointsDoc?.points?.length || 0;
  return Boolean(c && n && c.topic?.length === n && c.territory?.length === CLUSTERS.territories * n);
}

/**
 * Work out everything the page needs from the stored clusters, and set `topic` and
 * `territory` on each point (the values used by colouring, filters and the export).
 * Returns null when the plot has no clusters, otherwise
 * { topics: [{ key, number, keywords, label, size, members }], territories: [...], sims, coords }.
 */
export function describeClusters(pointsDoc) {
  const points = pointsDoc.points;
  if (!hasClusters(pointsDoc)) {
    for (const p of points) { delete p.topic; delete p.territory; }
    return null;
  }
  const { topic, territory: sims } = pointsDoc.clusters;
  const k = CLUSTERS.territories;
  const keywords = topicKeywords(points.map((p) => `${p.title}\n${p.summary}`), topic);
  const groups = new Map();
  topic.forEach((t, i) => {
    if (t < 0) return;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(i);
  });
  // Numbered by size, largest first (stored labels already are, but deletions can
  // change the order).
  const topics = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .map(([t, members], idx) => {
      const words = (keywords.get(t) || []).map((w) => w.term);
      const number = idx + 1;
      return {
        key: String(t), number, keywords: words, size: members.length, members: Int32Array.from(members),
        short: `${number} · ${words.slice(0, 2).join(', ') || 'no keywords'}`,
        label: `${number} · ${words.slice(0, 4).join(', ') || 'no keywords'}`,
      };
    });
  const territories = TERRITORIES.map((t, c) => ({ key: t.key, number: c + 1, name: t.name, aim: t.aim, size: 0, label: `${c + 1} · ${t.name}` }));
  points.forEach((p, i) => {
    p.topic = topic[i] < 0 ? UNCLUSTERED : String(topic[i]);
    const c = nearestTerritory(sims, i, k);
    p.territory = TERRITORIES[c].key;
    territories[c].size += 1;
  });
  return { topics, territories, sims, coords: territoryLayout(sims, points.length, { k }) };
}

/** The labelled centroid markers of the territories view. */
export function territoryMarkers() {
  return territoryAnchors(CLUSTERS.territories).map(([x, y], c) => ({ x, y, label: `${c + 1} ${TERRITORIES[c].name}`, short: String(c + 1) }));
}

/** How a topic or territory value is written in legends, filters and tooltips. */
export function clusterValueLabel(info, by, value) {
  if (value === UNCLUSTERED) return 'Unclustered';
  if (!info) return value;
  if (by === 'topic') return info.topics.find((t) => t.key === value)?.label || value;
  if (by === 'territory') return info.territories.find((t) => t.key === value)?.label || value;
  return value;
}

/** An entry's similarities to the five territories, most similar first. */
export function entrySimilarities(info, i) {
  const k = CLUSTERS.territories;
  return info.territories
    .map((t, c) => ({ ...t, similarity: info.sims[i * k + c] }))
    .sort((a, b) => b.similarity - a.similarity || a.number - b.number);
}
