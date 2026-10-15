// Loading plot data. The published copy on GitHub Pages is fast and needs no server;
// the API serves the latest committed copy, which matters for the minute or so after
// a change while GitHub Pages republishes the site.
import { API_BASE, fetchData } from './api.js';
import { storage } from './ui.js';

const DATA_BASE = new URL('../data/', import.meta.url);
const KNOWN_VERSIONS = 'canard.knownVersions';

async function fetchPages(path) {
  const url = new URL(path, DATA_BASE);
  url.searchParams.set('v', Date.now().toString(36));
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return res.json();
}

/** Remember the newest version of a plot this browser has seen or written. */
export function noteVersion(plotId, version) {
  const known = storage.get(KNOWN_VERSIONS, {});
  if (!known[plotId] || known[plotId] < version) {
    known[plotId] = version;
    storage.set(KNOWN_VERSIONS, known);
  }
}

export function knownVersion(plotId) {
  return storage.get(KNOWN_VERSIONS, {})[plotId] || 0;
}

export function emptyIndex() {
  return { schema: 1, plots: [] };
}

export async function loadIndex({ source = 'pages' } = {}) {
  const index = source === 'api' ? await fetchData('index.json') : await fetchPages('index.json');
  return index || emptyIndex();
}

/** Load plot.json and points.json for one plot. */
export async function loadPlot(plotId, { source = 'pages' } = {}) {
  const get = source === 'api' ? (p) => fetchData(p) : (p) => fetchPages(p);
  const [plot, points] = await Promise.all([get(`plots/${plotId}/plot.json`), get(`plots/${plotId}/points.json`)]);
  if (!plot || !points) return null;
  return { plot, points, source };
}

/**
 * Load the stored embedding vectors of every spreadsheet in a plot, keyed by point id.
 * The API copy is used when GitHub Pages may be behind.
 */
export async function loadVectors(plot, { source = 'pages', onProgress = () => {} } = {}) {
  const map = new Map();
  let done = 0;
  await Promise.all(plot.sheets.map(async (sheet) => {
    const path = `plots/${plot.id}/sheets/${sheet.id}/vectors.json`;
    let doc = source === 'api' ? await fetchData(path) : await fetchPages(path);
    if (!doc && source === 'pages' && API_BASE) doc = await fetchData(path);
    if (!doc) throw new Error(`The stored vectors for ${sheet.filename} are missing.`);
    doc.ids.forEach((id, i) => map.set(id, doc.vectors[i]));
    done += 1;
    onProgress(done / plot.sheets.length);
  }));
  return map;
}

export function sourceCsvUrl(plotId, sheetId) {
  return new URL(`plots/${plotId}/sheets/${sheetId}/source.csv`, DATA_BASE).href;
}
