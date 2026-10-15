// Point colouring. Scatter plots can show at most three categorical colours before
// pairs become hard to tell apart (all marks can be neighbours), so "colour by" picks
// up to three values to highlight and folds the rest into a neutral "Other". A value
// keeps its colour for as long as it stays highlighted.
import { UNTAGGED } from './filters.js';
import { UNCLUSTERED } from './cluster-view.js';

export const MAX_HIGHLIGHTS = 3;
const SEQ_STEPS = 7;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function readThemeColours() {
  return {
    surface: cssVar('--plot-surface'),
    ink: cssVar('--ink'),
    dim: cssVar('--point-dim'),
    ring: cssVar('--plot-surface'),
    lassoFill: cssVar('--lasso-fill'),
    other: cssVar('--point-other'),
    series: [cssVar('--series-1'), cssVar('--series-2'), cssVar('--series-3')],
    single: cssVar('--series-1'),
    seq: Array.from({ length: SEQ_STEPS }, (_, i) => cssVar(`--seq-${i}`)),
  };
}

function valuesOf(point, by) {
  if (by === 'tags') return point.tags?.length ? point.tags : [UNTAGGED];
  return [point[by]];
}

/** The most common values, used as the default highlights. */
export function defaultHighlights(points, by) {
  const counts = new Map();
  for (const p of points) for (const v of valuesOf(p, by)) if (v !== UNTAGGED && v !== UNCLUSTERED) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, MAX_HIGHLIGHTS).map(([v]) => v);
}

/**
 * Work out each point's colour.
 * highlights: array of up to three [value, slot] pairs. Returns
 * { colourIdx, palette, legend } where legend rows are { label, colour, count, value?, kind }.
 */
export function colourPoints(points, by, highlights, theme, visible, labelFor = (v) => v) {
  const n = points.length;
  const colourIdx = new Uint8Array(n);
  if (by === 'none') {
    return { colourIdx, palette: [theme.single], legend: [] };
  }
  if (by === 'date') {
    // Publication dates are usually skewed towards recent years, so colour by rank
    // (equal numbers of entries per step) rather than on a linear time scale.
    const order = points.map((p, i) => i).sort((a, b) => points[a].date.localeCompare(points[b].date));
    let rank = 0;
    order.forEach((i, k) => {
      if (k > 0 && points[i].date !== points[order[k - 1]].date) rank = k;
      colourIdx[i] = Math.min(SEQ_STEPS - 1, Math.floor((rank / Math.max(1, n)) * SEQ_STEPS));
    });
    const year = (i) => points[i].date.slice(0, 4);
    const legend = n ? [{ kind: 'ramp', colours: theme.seq, from: year(order[0]), mid: year(order[Math.floor(n / 2)]), to: year(order[n - 1]) }] : [];
    return { colourIdx, palette: theme.seq, legend };
  }
  // Slot 0 is "Other"; slots 1-3 are the highlighted values.
  const palette = [theme.other, ...theme.series];
  const slotOf = new Map(highlights.map(([v, slot]) => [v, slot]));
  const counts = new Array(MAX_HIGHLIGHTS + 1).fill(0);
  points.forEach((p, i) => {
    let slot = 0;
    for (const v of valuesOf(p, by)) {
      const s = slotOf.get(v);
      if (s !== undefined && (slot === 0 || s < slot)) slot = s;
    }
    colourIdx[i] = slot;
    if (visible[i]) counts[slot] += 1;
  });
  const legend = [...highlights].sort((a, b) => a[1] - b[1]).map(([v, slot]) => ({
    kind: 'value', value: v, label: labelFor(v), colour: palette[slot], count: counts[slot],
  }));
  legend.push({ kind: 'other', label: 'Everything else', colour: theme.other, count: counts[0] });
  return { colourIdx, palette, legend };
}

/** Toggle a value's highlight, keeping existing slots stable. */
export function toggleHighlight(highlights, value) {
  if (highlights.some(([v]) => v === value)) return highlights.filter(([v]) => v !== value);
  const used = new Set(highlights.map(([, s]) => s));
  let next = highlights;
  if (highlights.length >= MAX_HIGHLIGHTS) {
    // Replace the oldest highlight and reuse its colour.
    const [, slot] = highlights[0];
    return [...highlights.slice(1), [value, slot]];
  }
  for (let s = 1; s <= MAX_HIGHLIGHTS; s += 1) {
    if (!used.has(s)) { next = [...highlights, [value, s]]; break; }
  }
  return next;
}

export function allValues(points, by) {
  const counts = new Map();
  for (const p of points) for (const v of valuesOf(p, by)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
