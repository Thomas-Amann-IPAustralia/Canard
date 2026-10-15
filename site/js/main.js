// Canard: application state and wiring.
import { METHODS } from './schema.js';
import { Scatter } from './scatter.js';
import { $, $$, el, icon, formatDate, plural, toast, debounce, storage, downloadText } from './ui.js';
import { emptyFilters, isFiltering, computeVisible, renderFilters, prepareSearch, matchSummary, applyPreset, UNTAGGED } from './filters.js';
import { readThemeColours, colourPoints, defaultHighlights, toggleHighlight, allValues, MAX_HIGHLIGHTS } from './colours.js';
import { renderDetails } from './details.js';
import { tagSession, onSessionChange, unlock, lock, sendTags, renderTaggingButton } from './tagging.js';
import { API_BASE, onStatus, wake } from './api.js';
import { loadIndex, loadPlot, noteVersion, knownVersion, emptyIndex } from './data.js';
import { toCsv } from './csv.js';
import { TERRITORY_VIEW, UNCLUSTERED, describeClusters, territoryMarkers, clusterValueLabel } from './cluster-view.js';

const LIST_PAGE = 100;
// The projections, then the growth territories view.
const VIEWS = [...METHODS, TERRITORY_VIEW];
const CLUSTER_COLOURS = new Set(['topic', 'territory']);

const state = {
  index: emptyIndex(),
  plot: null,
  points: [],
  coords: {},
  clusters: null, // see describeClusters; null when the plot has none
  colourBeforeTerritories: null,
  method: 'umap',
  tool: 'pan',
  selection: new Set(),
  focus: null,
  detailsOpen: false,
  filters: emptyFilters(),
  visible: new Uint8Array(0),
  visibleCount: 0,
  colourBy: storage.get('canard.colourBy', 'sourceType'),
  highlights: {},
  listLimit: LIST_PAGE,
  source: 'pages',
  theme: null,
};

let scatter;
let tagQueue = Promise.resolve();
let pendingPlotId = null;

// ---- helpers --------------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { plot: params.get('plot'), view: params.get('view') };
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.plot) params.set('plot', state.plot.id);
  params.set('view', state.method);
  history.replaceState(null, '', `#${params}`);
}

function pointIndexById() {
  return new Map(state.points.map((p, i) => [p.id, i]));
}

function sheetName(id) {
  return state.plot?.sheets.find((s) => s.id === id)?.filename || id;
}

/** How a value of the current "colour by" field is written. */
function valueLabel(by, v) {
  if (v === UNTAGGED) return 'Untagged';
  if (by === 'sheet') return sheetName(v);
  if (CLUSTER_COLOURS.has(by)) return clusterValueLabel(state.clusters, by, v);
  return v;
}

/** Colouring by clusters falls back to source type on a plot without clusters. */
function colourField() {
  return CLUSTER_COLOURS.has(state.colourBy) && !state.clusters ? 'sourceType' : state.colourBy;
}

function allTags() {
  const seen = new Map();
  for (const p of state.points) for (const t of p.tags || []) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// ---- rendering ----------------------------------------------------------------

function renderPlotSelect() {
  const select = $('#plot-select');
  const plots = state.index.plots;
  select.replaceChildren();
  if (!plots.length) {
    select.append(el('option', { text: 'No plots yet' }));
    select.disabled = true;
    return;
  }
  for (const p of plots) {
    select.append(el('option', { value: p.id, text: `${p.name} (${plural(p.points, 'entry', 'entries')})`, selected: state.plot?.id === p.id }));
  }
  select.disabled = false;
}

function renderMethodSwitch() {
  const host = $('#method-switch');
  host.replaceChildren(...VIEWS.map((m, i) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(state.method === m.key), dataset: { method: m.key },
    title: `${m.blurb} (${i + 1})`, text: m.label, on: { click: () => setMethod(m.key) },
  })));
  syncClusterControls();
}

/** Enable the territories view and the cluster colours only when the plot has clusters. */
function syncClusterControls() {
  const missing = 'Clusters have not been calculated for this plot yet. Choose Spreadsheets > Recalculate clusters.';
  const button = $(`#method-switch [data-method="${TERRITORY_VIEW.key}"]`);
  if (button) {
    button.disabled = !state.clusters;
    button.title = state.clusters ? `${TERRITORY_VIEW.blurb} (${VIEWS.length})` : missing;
  }
  for (const option of $$('#colour-by option')) {
    if (!CLUSTER_COLOURS.has(option.value)) continue;
    option.disabled = !state.clusters;
    option.title = state.clusters ? '' : missing;
  }
  $('#colour-by').value = colourField();
}

/** Centroid markers in the territories view; topic labels when colouring by topic. */
function updateOverlay() {
  const info = state.clusters;
  scatter.setOverlay({
    anchors: info && state.method === TERRITORY_VIEW.key ? territoryMarkers() : [],
    groups: info && colourField() === 'topic' ? info.topics.map((t) => ({ text: t.short, members: t.members })) : [],
  });
}

function renderLegend(legend) {
  const host = $('#legend');
  host.replaceChildren();
  const by = colourField();
  if (state.points.length && !state.clusters) {
    host.append(el('span', { class: 'legend-note' },
      el('span', { text: 'Topic clusters and growth territories have not been calculated for this plot. ' }),
      el('button', { type: 'button', class: 'link-btn', text: 'Calculate them', on: { click: () => openManageDialog() } })));
  }
  if (by === 'none' || !state.points.length) return;
  if (by === 'date') {
    const ramp = legend[0];
    if (!ramp) return;
    const steps = el('span', { class: 'legend-ramp', role: 'img', 'aria-label': `Colour shows publication date in seven equal-sized groups, from ${ramp.from} to ${ramp.to}; half the entries are from ${ramp.mid} or earlier` },
      ramp.colours.map((c) => el('span', { style: `background:${c}` })));
    host.append(el('span', { class: 'legend-ramp-label', text: `Oldest (${ramp.from})` }), steps,
      el('span', { class: 'legend-ramp-label', text: `Newest (${ramp.to})` }),
      el('span', { class: 'legend-count', text: `Each shade holds about the same number of entries; the middle is ${ramp.mid}.` }));
    return;
  }
  for (const row of legend) {
    const swatch = el('span', { class: 'swatch', style: `background:${row.colour}` });
    if (row.kind === 'value') {
      host.append(el('button', {
        type: 'button', class: 'legend-item', title: `${row.label} (click to stop highlighting it)`,
        on: { click: () => { setHighlights(toggleHighlight(currentHighlights(), row.value)); } },
      }, swatch, el('span', { class: 'legend-label', text: row.label }), el('span', { class: 'legend-count', text: row.count.toLocaleString('en-AU') })));
    } else {
      host.append(el('span', { class: 'legend-item legend-other' }, swatch, el('span', { class: 'legend-label', text: row.label }), el('span', { class: 'legend-count', text: row.count.toLocaleString('en-AU') })));
    }
  }
  // Choose which values are highlighted (at most three, so colours stay distinguishable).
  const values = allValues(state.points, by);
  if (by === 'territory') values.sort((a, b) => valueLabel(by, a[0]).localeCompare(valueLabel(by, b[0]), 'en-AU', { numeric: true }));
  const picked = new Set(currentHighlights().map(([v]) => v));
  const menu = el('details', { class: 'menu legend-menu' },
    el('summary', { class: 'link-btn', text: 'Choose colours' }),
    el('div', { class: 'menu-panel' },
      el('p', { class: 'field-hint', text: `Highlight up to ${MAX_HIGHLIGHTS} values. Everything else stays grey.` }),
      el('div', { class: 'check-list' }, values.map(([v, count]) => {
        const input = el('input', { type: 'checkbox', checked: picked.has(v) });
        input.addEventListener('change', () => setHighlights(toggleHighlight(currentHighlights(), v), true));
        const label = valueLabel(by, v);
        return el('label', { class: 'check', title: label }, input, el('span', { class: 'check-label', text: label }), el('span', { class: 'check-count', text: String(count) }));
      }))));
  host.append(menu);
}

function currentHighlights() {
  const by = colourField();
  if (!state.highlights[by]) {
    state.highlights[by] = defaultHighlights(state.points, by).map((v, i) => [v, i + 1]);
  }
  return state.highlights[by];
}

function setHighlights(next, keepMenuOpen = false) {
  state.highlights[colourField()] = next;
  refreshColours();
  if (keepMenuOpen) $('.legend-menu')?.setAttribute('open', '');
}

function refreshColours() {
  if (!state.theme) state.theme = readThemeColours();
  const by = colourField();
  const highlights = by === 'none' || by === 'date' ? [] : currentHighlights();
  const { colourIdx, palette, legend } = colourPoints(state.points, by, highlights, state.theme, state.visible, (v) => valueLabel(by, v));
  scatter.setAppearance({ colourIdx, palette });
  renderLegend(legend);
  updateOverlay();
}

function renderEntryList() {
  const list = $('#entry-list');
  const idx = [];
  state.points.forEach((p, i) => { if (state.visible[i]) idx.push(i); });
  idx.sort((a, b) => state.points[b].date.localeCompare(state.points[a].date) || a - b);
  const shown = idx.slice(0, state.listLimit);
  list.replaceChildren(...shown.map((i) => {
    const p = state.points[i];
    return el('li', {}, el('button', {
      type: 'button', class: 'entry-button', 'aria-current': state.selection.has(i) ? 'true' : null,
      on: { click: () => selectFromList(i), mouseenter: () => scatter.highlight(i), mouseleave: () => scatter.highlight(null) },
    }, el('span', { class: 'entry-title', text: p.title }), el('span', { class: 'entry-meta', text: `${formatDate(p.date)} · ${p.sourceType}${p.tags?.length ? ` · ${p.tags.join(', ')}` : ''}` })));
  }));
  const more = $('#btn-more-entries');
  more.hidden = idx.length <= shown.length;
  more.textContent = `Show more (${(idx.length - shown.length).toLocaleString('en-AU')} remaining)`;
  $('#entry-list-heading').textContent = `Matching entries (${idx.length.toLocaleString('en-AU')})`;
}

function renderSelectionBar() {
  const bar = $('#selection-bar');
  const n = state.selection.size;
  bar.hidden = n === 0;
  $('#selection-count').textContent = `${plural(n, 'entry', 'entries')} selected`;
  $('#btn-selection-open').hidden = state.detailsOpen;
}

function renderEmptyState() {
  const box = $('#empty-state');
  if (!state.index.plots.length) {
    box.replaceChildren(
      el('h2', { text: 'No plots yet' }),
      el('p', { text: 'Upload a spreadsheet of sources to create the first semantic map. Each row needs a title, a summary, a source link, a publication date and a source type.' }),
      el('div', { class: 'empty-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', on: { click: () => openUploadDialog() } }, icon('upload'), el('span', { text: 'Upload a spreadsheet' })),
        el('a', { class: 'btn', href: 'template.csv', download: 'canard-template.csv', text: 'Download the CSV template' })));
    box.hidden = false;
  } else if (state.plot && !state.points.length) {
    box.replaceChildren(el('h2', { text: 'This plot is empty' }),
      el('p', { text: 'All of its spreadsheets have been deleted. Upload a spreadsheet to add entries.' }),
      el('div', { class: 'empty-actions' }, el('button', { class: 'btn btn-primary', type: 'button', on: { click: () => openUploadDialog() } }, icon('upload'), el('span', { text: 'Upload a spreadsheet' }))));
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

/** Re-apply filters and redraw everything that depends on them. */
function refresh() {
  renderFilters(state.filters, state.points, state.plot?.sheets || [], onFiltersChanged, state.clusters);
  const { visible, count } = computeVisible(state.points, state.filters);
  state.visible = visible;
  state.visibleCount = count;
  // Hidden entries cannot stay selected.
  if (state.filters.hide) for (const i of [...state.selection]) if (!visible[i]) state.selection.delete(i);
  if (state.focus !== null && state.filters.hide && !visible[state.focus]) state.focus = null;
  scatter.setAppearance({ visible, hideNonMatching: state.filters.hide, selected: state.selection, focus: state.detailsOpen ? state.focus : null });
  refreshColours();
  $('#match-count').textContent = state.points.length ? matchSummary(count, state.points.length) : '';
  $('#btn-clear-filters').hidden = !isFiltering(state.filters);
  $('#btn-export').disabled = count === 0;
  $('#btn-manage').disabled = !state.plot;
  renderEntryList();
  renderSelectionBar();
  renderDetails(app);
  renderEmptyState();
}

/** Cheaper update when only the selection or focus changed. */
function refreshSelection() {
  scatter.setAppearance({ selected: state.selection, focus: state.detailsOpen ? state.focus : null });
  renderEntryList();
  renderSelectionBar();
  renderDetails(app);
}

const onFiltersChanged = () => {
  state.listLimit = LIST_PAGE;
  refresh();
};

// ---- actions ----------------------------------------------------------------

function setMethod(key, { animate = true } = {}) {
  if (!VIEWS.some((m) => m.key === key)) return;
  if (key === TERRITORY_VIEW.key && !state.clusters) return;
  const entering = key === TERRITORY_VIEW.key && state.method !== key;
  const leaving = key !== TERRITORY_VIEW.key && state.method === TERRITORY_VIEW.key;
  state.method = key;
  storage.set('canard.method', key);
  $$('#method-switch [role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.method === key)));
  // The territories view colours entries by territory; leaving it restores the
  // previous colouring unless it was changed in the meantime.
  if (entering && state.colourBy !== 'territory') {
    state.colourBeforeTerritories = state.colourBy;
    setColourBy('territory', { remember: false });
  } else if (leaving && state.colourBeforeTerritories && state.colourBy === 'territory') {
    setColourBy(state.colourBeforeTerritories, { remember: false });
    state.colourBeforeTerritories = null;
  }
  updateOverlay();
  const coords = state.coords[key];
  if (coords) scatter.setPositions(coords, { animate, fit: true });
  writeHash();
}

function setColourBy(by, { remember = true } = {}) {
  state.colourBy = by;
  if (remember) {
    storage.set('canard.colourBy', by);
    state.colourBeforeTerritories = null;
  }
  $('#colour-by').value = colourField();
  refreshColours();
}

function setTool(tool) {
  state.tool = tool;
  scatter.setTool(tool);
  $$('[data-tool]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === tool)));
}

function clearSelection() {
  state.selection = new Set();
  state.focus = null;
  state.detailsOpen = false;
  refreshSelection();
}

function focusPoint(i) {
  state.focus = i;
  state.detailsOpen = true;
  refreshSelection();
  $('#details-body').scrollTop = 0;
}

function selectFromList(i) {
  state.selection = new Set([i]);
  state.focus = i;
  state.detailsOpen = true;
  scatter.reveal(i);
  refreshSelection();
  closeDrawers();
}

function onPointClick(i, { additive }) {
  if (i === null) {
    if (!additive) clearSelection();
    return;
  }
  if (additive) {
    const next = new Set(state.selection);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    state.selection = next;
    state.focus = next.size === 1 ? [...next][0] : null;
  } else {
    state.selection = new Set([i]);
    state.focus = i;
  }
  state.detailsOpen = state.selection.size > 0;
  hideTooltip();
  refreshSelection();
}

function onLasso(indices, mode) {
  let next;
  if (mode === 'replace') next = new Set(indices);
  else if (mode === 'add') next = new Set([...state.selection, ...indices]);
  else next = new Set([...state.selection].filter((i) => !indices.includes(i)));
  state.selection = next;
  state.focus = next.size === 1 ? [...next][0] : null;
  state.detailsOpen = next.size > 0;
  refreshSelection();
  if (indices.length === 0 && mode === 'replace') toast('No matching points inside the lasso.');
}

// Mirror of the server's tag rules, applied immediately so the interface feels instant.
function applyTagsLocally(ids, add, remove) {
  const spelling = new Map(allTags().map((t) => [t.toLowerCase(), t]));
  const adds = add.map((t) => spelling.get(t.toLowerCase()) || t);
  const removeKeys = new Set(remove.map((t) => t.toLowerCase()));
  const byId = pointIndexById();
  for (const id of ids) {
    const p = state.points[byId.get(id)];
    if (!p) continue;
    const tags = (p.tags || []).filter((t) => !removeKeys.has(t.toLowerCase()));
    for (const t of adds) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    p.tags = tags;
  }
}

function tag(ids, { add = [], remove = [] }) {
  if (!state.plot) return Promise.resolve();
  const plotId = state.plot.id;
  const job = async () => {
    if (!tagSession() && !(await unlock())) return;
    if (state.plot?.id !== plotId) return;
    const byId = pointIndexById();
    const before = new Map(ids.map((id) => [id, [...(state.points[byId.get(id)]?.tags || [])]]));
    applyTagsLocally(ids, add, remove);
    refresh();
    try {
      const out = await sendTags(plotId, ids, { add, remove });
      if (state.plot?.id !== plotId) return;
      const map = pointIndexById();
      for (const [id, tags] of Object.entries(out.updates)) {
        const p = state.points[map.get(id)];
        if (p) p.tags = tags;
      }
      state.plot.version = out.version;
      noteVersion(plotId, out.version);
      const entry = state.index.plots.find((p) => p.id === plotId);
      if (entry) entry.version = out.version;
      refresh();
    } catch (err) {
      if (state.plot?.id === plotId) {
        const map = pointIndexById();
        for (const [id, tags] of before) {
          const p = state.points[map.get(id)];
          if (p) p.tags = tags;
        }
        refresh();
      }
      if (err.code !== 'CANCELLED') toast(`Tags were not saved: ${err.message}`, { kind: 'error' });
    }
  };
  tagQueue = tagQueue.then(job, job);
  return tagQueue;
}

/** Install plot data, keeping the selection (by id) when the same plot is refreshed. */
function setPlotData({ plot, points, source }, { animate = false, keepSelection = false } = {}) {
  const previousIndex = pointIndexById();
  const previousPos = scatter.pos;
  const keepIds = keepSelection ? new Set([...state.selection].map((i) => state.points[i]?.id)) : new Set();
  const focusId = keepSelection && state.focus !== null ? state.points[state.focus]?.id : null;
  const samePlot = state.plot?.id === plot.id;
  state.plot = plot;
  state.points = points.points;
  state.source = source;
  state.coords = Object.fromEntries(Object.entries(points.coords).map(([k, v]) => [k, Float32Array.from(v)]));
  state.clusters = describeClusters(points);
  if (state.clusters) state.coords[TERRITORY_VIEW.key] = state.clusters.coords;
  else if (state.method === TERRITORY_VIEW.key) {
    state.method = 'umap';
    $$('#method-switch [role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.method === 'umap')));
  }
  // Opening a plot straight into the territories view colours it by territory too.
  if (state.clusters && state.method === TERRITORY_VIEW.key && state.colourBy !== 'territory' && !state.colourBeforeTerritories) {
    state.colourBeforeTerritories = state.colourBy;
    state.colourBy = 'territory';
  }
  syncClusterControls();
  prepareSearch(state.points);
  const byId = pointIndexById();
  state.selection = new Set([...keepIds].filter((id) => byId.has(id)).map((id) => byId.get(id)));
  state.focus = focusId && byId.has(focusId) ? byId.get(focusId) : null;
  if (!state.selection.size) state.detailsOpen = false;
  if (!samePlot) state.highlights = {};
  // Highlighted values that no longer exist are dropped; the rest keep their colour.
  for (const by of Object.keys(state.highlights)) {
    const present = new Set(allValues(state.points, by).map(([v]) => v));
    state.highlights[by] = state.highlights[by].filter(([v]) => present.has(v));
  }
  noteVersion(plot.id, plot.version);
  storage.set('canard.plot', plot.id);
  const target = state.coords[state.method] || new Float32Array(0);
  let start = null;
  if (animate && samePlot) {
    // Existing points glide from where they are; new points appear in place.
    start = Float32Array.from(target);
    state.points.forEach((p, i) => {
      const j = previousIndex.get(p.id);
      if (j !== undefined && 2 * j + 1 < previousPos.length) {
        start[2 * i] = previousPos[2 * j];
        start[2 * i + 1] = previousPos[2 * j + 1];
      }
    });
  }
  scatter.setPositions(target, { animate: Boolean(start), start, fit: !samePlot || !keepSelection || Boolean(start) });
  renderPlotSelect();
  writeHash();
  document.title = `${plot.name} · Canard`;
  refresh();
}

async function selectPlot(id, { keepSelection = false } = {}) {
  const entry = state.index.plots.find((p) => p.id === id);
  if (!entry) return;
  const loading = $('#plot-loading');
  loading.hidden = false;
  try {
    // The published copy shows instantly; a newer version is fetched afterwards.
    let data = await loadPlot(id, { source: 'pages' }).catch(() => null);
    if (!data && API_BASE) data = await loadPlot(id, { source: 'api' });
    if (!data) throw new Error('This plot’s files could not be found.');
    // If GitHub Pages is still publishing a newer version, say so and fetch it.
    if (data.plot.version < Math.max(entry.version, knownVersion(id)) && API_BASE) {
      showBanner('GitHub Pages is still publishing the latest changes, so they are being loaded from the server instead.');
      wake().then(() => loadPlot(id, { source: 'api' })).then((fresh) => {
        if (fresh && state.plot?.id === id) setPlotData(fresh, { keepSelection: true });
        hideBanner();
      }).catch(() => {});
    }
    setPlotData(data, { keepSelection });
  } catch (err) {
    toast(`Could not load the plot: ${err.message}`, { kind: 'error' });
  } finally {
    loading.hidden = true;
  }
}

function applyIndex(index, { removed = null } = {}) {
  state.index = index;
  if (removed && state.plot?.id === removed) {
    state.plot = null;
    state.points = [];
    state.coords = {};
    state.clusters = null;
    state.selection = new Set();
    state.focus = null;
    state.detailsOpen = false;
    scatter.setPositions(new Float32Array(0));
    document.title = 'Canard';
    if (index.plots.length) selectPlot(index.plots[0].id);
  }
  renderPlotSelect();
  refresh();
}

/** Apply a response from the server (upload, deletion) to the local state. */
function applyServerUpdate(out, { selectPlot: select = false, animate = false } = {}) {
  if (out.index) state.index = out.index;
  if (out.plot && out.points && (select || state.plot?.id === out.plot.id)) {
    const samePlot = state.plot?.id === out.plot.id;
    setPlotData({ plot: out.plot, points: out.points, source: 'api' }, { animate: animate && samePlot, keepSelection: samePlot });
  }
  renderPlotSelect();
}

async function checkFreshness() {
  try {
    const latest = await loadIndex({ source: 'api' });
    const current = state.plot;
    const known = new Map(state.index.plots.map((p) => [p.id, p.version]));
    const changed = latest.plots.length !== state.index.plots.length || latest.plots.some((p) => known.get(p.id) !== p.version);
    if (!changed) return;
    state.index = latest;
    renderPlotSelect();
    const entry = current && latest.plots.find((p) => p.id === current.id);
    if (pendingPlotId && latest.plots.some((p) => p.id === pendingPlotId) && pendingPlotId !== current?.id) {
      const id = pendingPlotId;
      pendingPlotId = null;
      await selectPlot(id);
    } else if (current && !entry) {
      applyIndex(latest, { removed: current.id });
      toast('This plot has been deleted.', { kind: 'info' });
    } else if (entry && entry.version > current.version) {
      const fresh = await loadPlot(current.id, { source: 'api' });
      if (fresh) {
        setPlotData(fresh, { keepSelection: true, animate: true });
        toast('Loaded the latest changes to this plot.');
      }
    } else if (!current && latest.plots.length) {
      selectPlot(latest.plots[0].id);
    } else {
      refresh();
    }
    hideBanner();
  } catch { /* the published copy is still shown */ }
}

function exportCsv() {
  const info = state.clusters;
  const rows = [['Title', 'Summary', 'Source link', 'Publication Date', 'Source type', 'Tags', 'Spreadsheet',
    ...(info ? ['Topic cluster', 'Growth territory'] : [])]];
  state.points.forEach((p, i) => {
    if (!state.visible[i]) return;
    rows.push([p.title, p.summary, p.link, p.date, p.sourceType, (p.tags || []).join('; '), sheetName(p.sheet),
      ...(info ? [valueLabel('topic', p.topic), info.territories.find((t) => t.key === p.territory)?.name || ''] : [])]);
  });
  const name = (state.plot?.name || 'canard').replace(/[^\w-]+/g, '-').toLowerCase();
  downloadText(`${name}-entries.csv`, `﻿${toCsv(rows)}`);
}

// ---- chrome -------------------------------------------------------------------

function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = false;
}

function hideBanner() {
  $('#banner').hidden = true;
}

const tooltip = () => $('#tooltip');
function hideTooltip() {
  tooltip().hidden = true;
}

function showTooltip(i, clientX, clientY) {
  if (i === null) { hideTooltip(); return; }
  const p = state.points[i];
  const tip = tooltip();
  tip.replaceChildren(...[
    el('strong', { text: p.title }),
    el('span', { class: 'tooltip-meta', text: `${formatDate(p.date)} · ${p.sourceType}` }),
    state.clusters ? el('span', { class: 'tooltip-meta', text: `Topic ${p.topic === UNCLUSTERED ? 'none (unclustered)' : valueLabel('topic', p.topic)}` }) : null,
    state.clusters ? el('span', { class: 'tooltip-meta', text: `Closest territory: ${valueLabel('territory', p.territory)}` }) : null,
    p.tags?.length ? el('span', { class: 'tooltip-tags', text: p.tags.join(', ') }) : null,
    state.visible[i] ? null : el('span', { class: 'tooltip-note', text: 'Does not match the current filters' }),
  ].filter(Boolean));
  tip.hidden = false;
  const wrap = $('#canvas-wrap').getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = clientX - wrap.left + 14;
  let y = clientY - wrap.top + 14;
  if (x + w > wrap.width - 8) x = clientX - wrap.left - w - 14;
  if (y + h > wrap.height - 8) y = clientY - wrap.top - h - 14;
  tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
}

function renderServerStatus(status) {
  const pill = $('#server-status');
  const upload = $('#btn-upload');
  const tagging = $('#btn-tagging');
  if (status === 'unconfigured') {
    pill.hidden = true;
    upload.disabled = true;
    tagging.disabled = true;
    upload.title = 'Editing is not set up for this site (no server address in config.js).';
    tagging.title = upload.title;
    return;
  }
  const text = {
    unknown: 'Connecting to the editing server…',
    waking: 'Waking the editing server (free hosting sleeps when idle; this can take a minute)',
    ready: 'Editing server ready',
    offline: 'Editing server unavailable',
  }[status];
  pill.hidden = false;
  pill.dataset.status = status;
  pill.title = text;
  pill.replaceChildren(el('span', { class: 'status-dot', 'aria-hidden': 'true' }), el('span', { class: 'status-text', text: status === 'waking' ? 'Waking server…' : status === 'ready' ? 'Server ready' : status === 'offline' ? 'Server unavailable' : 'Connecting…' }));
  pill.setAttribute('aria-label', text);
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { if (theme) localStorage.setItem('canard.theme', theme); else localStorage.removeItem('canard.theme'); } catch { /* ignore */ }
  onThemeChanged();
}

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function onThemeChanged() {
  state.theme = readThemeColours();
  scatter.setColours(state.theme);
  $('#btn-theme').textContent = currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  refreshColours();
}

function closeDrawers() {
  document.body.classList.remove('filters-open');
}

async function openManageDialog() {
  (await import('./manage.js')).openManage(app);
}

let uploadModule = null;
async function openUploadDialog() {
  uploadModule ??= await import('./upload.js');
  uploadModule.openUpload(app);
}

// ---- start-up -------------------------------------------------------------------

const app = {
  state, refresh, tag, allTags, focusPoint, clearSelection, applyServerUpdate, applyIndex, selectPlot,
};

function bindControls() {
  $('#plot-select').addEventListener('change', (e) => {
    state.filters = emptyFilters();
    state.selection = new Set();
    state.focus = null;
    state.detailsOpen = false;
    selectPlot(e.target.value);
  });
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-fit').addEventListener('click', () => scatter.fit());
  const colourBy = $('#colour-by');
  colourBy.value = state.colourBy;
  colourBy.addEventListener('change', () => setColourBy(colourBy.value));
  const search = $('#filter-search');
  const onSearch = debounce(() => { state.filters.text = search.value; onFiltersChanged(); }, 150);
  search.addEventListener('input', onSearch);
  $('#filter-search-scope').addEventListener('change', (e) => { state.filters.scope = e.target.value; onFiltersChanged(); });
  $('#filter-date-from').addEventListener('change', (e) => { state.filters.dateFrom = e.target.value; state.filters.preset = 'custom'; onFiltersChanged(); });
  $('#filter-date-to').addEventListener('change', (e) => { state.filters.dateTo = e.target.value; state.filters.preset = 'custom'; onFiltersChanged(); });
  $('#filter-hide').addEventListener('change', (e) => { state.filters.hide = e.target.checked; onFiltersChanged(); });
  $('#btn-clear-filters').addEventListener('click', () => {
    const hide = state.filters.hide;
    state.filters = emptyFilters();
    state.filters.hide = hide;
    applyPreset(state.filters, 'any');
    onFiltersChanged();
  });
  $('#btn-more-entries').addEventListener('click', () => { state.listLimit += LIST_PAGE; renderEntryList(); });
  $('#btn-close-details').addEventListener('click', () => { state.detailsOpen = false; refreshSelection(); });
  $('#btn-selection-open').addEventListener('click', () => { state.detailsOpen = true; refreshSelection(); });
  $('#btn-selection-clear').addEventListener('click', clearSelection);
  $('#btn-upload').addEventListener('click', openUploadDialog);
  $('#btn-manage').addEventListener('click', openManageDialog);
  $('#btn-help').addEventListener('click', async () => { $('.app-header .menu').open = false; (await import('./manage.js')).openHelp(); });
  $('#btn-export').addEventListener('click', () => { $('.app-header .menu').open = false; exportCsv(); });
  $('#btn-theme').addEventListener('click', () => { $('.app-header .menu').open = false; applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
  $('#btn-tagging').addEventListener('click', () => (tagSession() ? lock() : unlock()));
  $('#btn-open-filters').addEventListener('click', () => document.body.classList.add('filters-open'));
  $$('[data-close-panel]').forEach((b) => b.addEventListener('click', closeDrawers));
  document.addEventListener('click', (e) => {
    for (const menu of $$('details.menu[open]')) if (!menu.contains(e.target)) menu.open = false;
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) onThemeChanged(); });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= VIEWS.length) setMethod(VIEWS[n - 1].key);
    else if (e.key === 'l' || e.key === 'L') setTool('lasso');
    else if (e.key === 'p' || e.key === 'P') setTool('pan');
    else if (e.key === '0' && e.target !== $('#scatter')) scatter.fit();
    else if (e.key === 'Escape') { clearSelection(); closeDrawers(); }
  });
  onSessionChange(() => { renderTaggingButton($('#btn-tagging')); renderDetails(app); });
  window.addEventListener('hashchange', () => {
    const { plot, view } = readHash();
    if (view && view !== state.method) setMethod(view);
    if (plot && plot !== state.plot?.id) selectPlot(plot);
  });
}

async function start() {
  const canvas = $('#scatter');
  canvas.tabIndex = 0;
  scatter = new Scatter(canvas, {
    onHover: showTooltip,
    onClick: onPointClick,
    onLasso,
    onEscape: clearSelection,
  });
  const hash = readHash();
  state.method = VIEWS.some((m) => m.key === hash.view) ? hash.view : storage.get('canard.method', 'umap');
  renderMethodSwitch();
  bindControls();
  onThemeChanged();
  setTool('pan');
  renderTaggingButton($('#btn-tagging'));
  applyPreset(state.filters, 'any');

  // Wake the editing server straight away so it is ready when needed.
  let checked = false;
  onStatus((status) => {
    renderServerStatus(status);
    if (status === 'ready' && !checked) {
      checked = true;
      checkFreshness();
    }
  });
  if (API_BASE) wake().catch(() => {});

  $('#plot-loading').hidden = false;
  try {
    state.index = await loadIndex();
  } catch (err) {
    toast(`Could not load the list of plots: ${err.message}`, { kind: 'error' });
  }
  $('#plot-loading').hidden = true;
  renderPlotSelect();
  const requested = hash.plot || storage.get('canard.plot');
  const wanted = [hash.plot, storage.get('canard.plot')].find((id) => id && state.index.plots.some((p) => p.id === id));
  // A plot created moments ago may not be published yet; select it once the server lists it.
  if (requested && !wanted) pendingPlotId = requested;
  const first = wanted || state.index.plots[0]?.id;
  if (first) await selectPlot(first);
  else refresh();
}

start();
