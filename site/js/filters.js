// Filtering by metadata: text in the title or summary, publication date, source type,
// tags and spreadsheet. Source links are deliberately not filterable.
import { $, el, plural } from './ui.js';

export const UNTAGGED = '\u0000untagged';

export const DATE_PRESETS = [
  { key: 'any', label: 'Any time' },
  { key: '1y', label: 'Last 12 months', years: 1 },
  { key: '3y', label: 'Last 3 years', years: 3 },
  { key: '5y', label: 'Last 5 years', years: 5 },
];

export function emptyFilters() {
  return { text: '', scope: 'both', preset: 'any', dateFrom: '', dateTo: '', sourceType: new Set(), tags: new Set(), sheet: new Set(), hide: false };
}

export function isFiltering(f) {
  return Boolean(f.text.trim() || f.dateFrom || f.dateTo || f.sourceType.size || f.tags.size || f.sheet.size);
}

function isoDaysAgo(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function applyPreset(f, key) {
  const preset = DATE_PRESETS.find((p) => p.key === key);
  f.preset = key;
  f.dateFrom = preset?.years ? isoDaysAgo(preset.years) : '';
  f.dateTo = '';
}

function terms(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Build a predicate for every filter except `skip` (used for faceted counts). */
function predicate(f, skip = null) {
  const words = terms(f.text);
  return (p) => {
    if (words.length && skip !== 'text') {
      const hay = f.scope === 'title' ? p._title : f.scope === 'summary' ? p._summary : `${p._title}\n${p._summary}`;
      for (const w of words) if (!hay.includes(w)) return false;
    }
    if (skip !== 'date') {
      if (f.dateFrom && p.date < f.dateFrom) return false;
      if (f.dateTo && p.date > f.dateTo) return false;
    }
    if (skip !== 'sourceType' && f.sourceType.size && !f.sourceType.has(p.sourceType)) return false;
    if (skip !== 'sheet' && f.sheet.size && !f.sheet.has(p.sheet)) return false;
    if (skip !== 'tags' && f.tags.size) {
      const tags = p.tags || [];
      if (!(tags.length ? tags.some((t) => f.tags.has(t)) : f.tags.has(UNTAGGED))) return false;
    }
    return true;
  };
}

/** Lower-cased search fields, cached on each point. */
export function prepareSearch(points) {
  for (const p of points) {
    p._title = p.title.toLowerCase();
    p._summary = p.summary.toLowerCase();
  }
}

export function computeVisible(points, f) {
  const test = predicate(f);
  const out = new Uint8Array(points.length);
  let count = 0;
  points.forEach((p, i) => {
    if (test(p)) { out[i] = 1; count += 1; }
  });
  return { visible: out, count };
}

/** Counts per value for each facet, honouring every other active filter. */
export function facetCounts(points, f, sheets) {
  const facet = (key, valuesOf) => {
    const test = predicate(f, key);
    const counts = new Map();
    for (const p of points) {
      if (!test(p)) continue;
      for (const v of valuesOf(p)) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return counts;
  };
  const totals = (valuesOf) => {
    const counts = new Map();
    for (const p of points) for (const v of valuesOf(p)) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  };
  const tagValues = (p) => (p.tags?.length ? p.tags : [UNTAGGED]);
  return {
    sourceType: { live: facet('sourceType', (p) => [p.sourceType]), total: totals((p) => [p.sourceType]) },
    tags: { live: facet('tags', tagValues), total: totals(tagValues) },
    sheet: { live: facet('sheet', (p) => [p.sheet]), total: totals((p) => [p.sheet]), labels: new Map(sheets.map((s) => [s.id, s.filename])) },
  };
}

function renderCheckList(container, hint, key, data, f, onChange) {
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.value : null;
  container.replaceChildren();
  const values = [...data.total.keys()].sort((a, b) => {
    if (a === UNTAGGED) return 1;
    if (b === UNTAGGED) return -1;
    return (data.total.get(b) - data.total.get(a)) || String(a).localeCompare(String(b));
  });
  // Keep checked values that no longer exist out of the filter.
  for (const v of [...f[key]]) if (!data.total.has(v)) f[key].delete(v);
  hint.textContent = f[key].size ? `${f[key].size} selected` : '';
  if (!values.length) {
    container.append(el('p', { class: 'empty-note', text: key === 'tags' ? 'No tags yet.' : 'None.' }));
    return;
  }
  for (const v of values) {
    const live = data.live.get(v) || 0;
    const label = v === UNTAGGED ? 'Untagged' : data.labels?.get(v) || v;
    const input = el('input', { type: 'checkbox', checked: f[key].has(v), dataset: { value: v } });
    input.addEventListener('change', () => {
      if (input.checked) f[key].add(v);
      else f[key].delete(v);
      onChange();
    });
    container.append(el('label', { class: `check${live ? '' : ' check-empty'}`, title: label },
      input, el('span', { class: 'check-label', text: label }), el('span', { class: 'check-count', text: live.toLocaleString('en-AU') })));
    if (focused === v) input.focus();
  }
}

/** Render every filter control from the current state. */
export function renderFilters(f, points, sheets, onChange) {
  const facets = facetCounts(points, f, sheets);
  renderCheckList($('#filter-sourceType'), $('#hint-sourceType'), 'sourceType', facets.sourceType, f, onChange);
  renderCheckList($('#filter-tags'), $('#hint-tags'), 'tags', facets.tags, f, onChange);
  renderCheckList($('#filter-sheet'), $('#hint-sheet'), 'sheet', facets.sheet, f, onChange);
  const presets = $('#date-presets');
  presets.replaceChildren(...DATE_PRESETS.map((p) => el('button', {
    type: 'button', role: 'radio', class: 'chip', 'aria-checked': String(f.preset === p.key), text: p.label,
    on: { click: () => { applyPreset(f, p.key); onChange(); } },
  })));
  $('#filter-date-from').value = f.dateFrom;
  $('#filter-date-to').value = f.dateTo;
  if ($('#filter-search') !== document.activeElement) $('#filter-search').value = f.text;
  $('#filter-search-scope').value = f.scope;
  $('#filter-hide').checked = f.hide;
}

export function matchSummary(count, total) {
  return count === total ? `Showing all ${plural(total, 'entry', 'entries')}` : `Showing ${count.toLocaleString('en-AU')} of ${plural(total, 'entry', 'entries')}`;
}
