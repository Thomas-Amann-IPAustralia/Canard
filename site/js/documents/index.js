// Unstructured documents: recognise them, extract their text, split it into chunks
// and turn the chunks into rows for the upload (see chunker.js for the method).
import { COLUMNS, EMBEDDING, LIMITS } from '../schema.js';
import { validateCsvText, checkTokenLimits } from '../csv.js';
import { request, ApiError } from '../api.js';
import { embedEntries } from '../embedder.js';
import { CHUNKING, toUnits, semanticChunks, chunksFromGroups, neighbourDistances, chunkRows, rowsToCsv } from './chunker.js';
import { parseText, titleFromFilename } from './text.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';

export const DOCUMENT_ACCEPT = '.md,.markdown,.txt,.docx,.pdf';
const DOCUMENT_RE = /\.(md|markdown|txt|text|docx|pdf)$/i;
const HEADER_RE = new RegExp(`^\\uFEFF?\\s*${COLUMNS.map((c) => c.header.replace(/ /g, '\\s+')).join('\\s*,\\s*')}`, 'i');

/**
 * 'csv' for a spreadsheet, 'document' for something to chunk, or null. A .txt file is a
 * spreadsheet only when it starts with the spreadsheet's header row.
 */
export async function fileKind(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.txt')) {
    const head = await file.slice(0, 400).text();
    return HEADER_RE.test(head) ? 'csv' : 'document';
  }
  if (DOCUMENT_RE.test(name)) return 'document';
  if (/csv/.test(file.type)) return 'csv';
  return null;
}

/** Extract { title, date, blocks, pages? } from a document file. */
export async function extractDocument(file, { onProgress = () => {} } = {}) {
  if (file.size > LIMITS.maxDocumentBytes) {
    throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB. Documents can be at most ${LIMITS.maxDocumentBytes / 1e6} MB.`);
  }
  const name = file.name.toLowerCase();
  let doc;
  if (name.endsWith('.pdf')) doc = await parsePdf(new Uint8Array(await file.arrayBuffer()), { onProgress });
  else if (name.endsWith('.docx')) doc = await parseDocx(new Uint8Array(await file.arrayBuffer()));
  else doc = parseText(await file.text(), { markdown: !/\.(txt|text)$/.test(name), filename: file.name });
  if (!doc.blocks.some((b) => b.kind === 'text')) throw new Error(`${file.name} does not contain any text.`);
  return { ...doc, title: doc.title || titleFromFilename(file.name) };
}

function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Extract, embed and semantically chunk one document. onStage(label, detail) reports
 * progress and onDownload(loaded, total) the model download.
 * Returns the prepared document, ready for documentSheet() (and optionally refineDocument()).
 */
export async function prepareDocument(file, countTokens, { onStage = () => {}, onDownload = () => {} } = {}) {
  onStage('Reading');
  const doc = await extractDocument(file, { onProgress: (n, total) => onStage('Reading', `page ${n} of ${total}`) });
  const units = toUnits(doc.blocks, countTokens);
  if (!units.length) throw new Error(`${file.name} does not contain any text.`);
  onStage('Embedding paragraphs', `0 of ${units.length}`);
  const vectors = await embedEntries(units.map((u) => ({ title: u.heading.at(-1) || '', summary: u.text })), {
    onDownload,
    onProgress: (done, total) => onStage('Embedding paragraphs', `${done} of ${total}`),
  });
  const distances = neighbourDistances(vectors, units.length, EMBEDDING.dim);
  const chunks = semanticChunks(units, vectors, EMBEDDING.dim, { distances });
  return {
    file,
    filename: file.name,
    title: doc.title,
    date: doc.date || isoDay(file.lastModified || Date.now()),
    pages: doc.pages || null,
    units, vectors, distances,
    semantic: chunks,
    chunks,
    refined: false,
  };
}

/** Windows of units for the AI, each within the request limits and ending at a section break where possible. */
function refineWindows(units) {
  const maxChars = LIMITS.maxRefineChars * 0.9;
  const maxUnits = LIMITS.maxRefineUnits;
  const windows = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let chars = units[start].text.length;
    while (end + 1 < units.length && end + 1 - start < maxUnits && chars + units[end + 1].text.length <= maxChars) {
      end += 1;
      chars += units[end].text.length;
    }
    if (end + 1 < units.length) {
      for (let i = end; i > start + (end - start) / 2; i -= 1) {
        if (units[i].section !== units[i - 1].section) { end = i - 1; break; }
      }
    }
    windows.push([start, end]);
    start = end + 1;
  }
  return windows;
}

const FATAL = ['WRONG_PASSWORD', 'TOO_MANY_ATTEMPTS', 'READ_ONLY', 'LLM_DISABLED'];

/**
 * Ask the server's language model to regroup the document's units and title the chunks.
 * A window that fails keeps its semantic chunks. Returns { chunks, failed }.
 */
export async function refineDocument(doc, password, { signal, onProgress = () => {} } = {}) {
  const { dim } = EMBEDDING;
  const windows = refineWindows(doc.units);
  const starts = new Set(doc.semantic.map((c) => c.start));
  const results = new Array(windows.length);
  let failed = 0;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const w = next++;
      const [from, to] = windows[w];
      const units = doc.units.slice(from, to + 1);
      try {
        const out = await request('/api/documents/refine', {
          method: 'POST',
          signal,
          timeout: 180000,
          body: {
            password,
            title: doc.title.slice(0, 300),
            units: units.map((u) => ({ heading: u.heading.join(' › ').slice(0, 300), text: u.text })),
            hints: units.map((_, i) => i).filter((i) => i > 0 && starts.has(from + i)),
            targetWords: Math.round(CHUNKING.targetTokens * 0.75),
            maxWords: Math.round(CHUNKING.maxTokens * 0.75),
          },
        });
        results[w] = chunksFromGroups(doc.units, doc.vectors, dim, out.groups, from, { distances: doc.distances });
      } catch (err) {
        if (err?.name === 'AbortError' || (err instanceof ApiError && FATAL.includes(err.code))) throw err;
        failed += 1;
        results[w] = semanticChunks(doc.units, doc.vectors, dim, { from, to, distances: doc.distances });
      }
      done += 1;
      onProgress(done, windows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, windows.length) }, worker));
  return { chunks: results.flat(), failed, windows: windows.length };
}

/**
 * The sheet uploaded for a document: its chunks as a generated CSV, and the rows parsed
 * back from that CSV, so what is embedded is exactly what the server will store.
 * meta: { title, date, sourceType, link }.
 */
export function documentSheet(doc, meta, countTokens) {
  const csv = rowsToCsv(chunkRows(doc.chunks, meta));
  const result = validateCsvText(csv);
  const problems = result.errors.length ? result.errors : checkTokenLimits(result.rows, countTokens, EMBEDDING.maxTokens);
  return { filename: doc.filename, kind: 'document', csv, rows: result.rows, problems };
}
