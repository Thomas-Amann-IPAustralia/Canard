// Semantic chunking of an extracted document into entries for the plot.
//
// 1. toUnits() turns the document's blocks into paragraph-sized units, splitting long
//    paragraphs at sentence boundaries so every unit is well under the model's limit.
// 2. Each unit is embedded with the plot's model (by the caller).
// 3. semanticChunks() groups consecutive units into chunks. It breaks at new section
//    headings, where the meaning shifts most (the largest distances between neighbouring
//    units' embeddings) and before a chunk outgrows the token budget, then merges
//    fragments that are too small to stand on their own.
// 4. chunkRows() turns the chunks into the same rows a spreadsheet produces.
//
// Everything here is pure, so it runs in Node for the tests. countTokens(text) is the
// model's token counter, which includes the [CLS] and [SEP] special tokens.

import { COLUMNS, EMBEDDING } from '../schema.js';
import { toCsv } from '../csv.js';

export const CHUNKING = {
  // Tokens of chunk text (title excluded). The title is capped at maxTitleChars, so a
  // chunk always fits the model's 512 tokens together with its title.
  maxUnitTokens: 150,
  targetTokens: 250,
  maxTokens: 360,
  minTokens: 50,
  // Distances above this percentile (within the document) mark a change of topic.
  breakPercentile: 0.85,
  maxTitleChars: 140,
};

const SPECIAL_TOKENS = 2;

/** Tokens of text without the special tokens (the count is additive across words). */
function contentTokens(countTokens, text) {
  return Math.max(0, countTokens(text) - SPECIAL_TOKENS);
}

const SENTENCE_RE = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)\s*/g;

export function splitSentences(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  }
  return (text.match(SENTENCE_RE) || [text]).map((s) => s.trim()).filter(Boolean);
}

/** Pack pieces (sentences or words) greedily into strings of at most max tokens. */
function pack(pieces, countTokens, max, joiner = ' ') {
  const out = [];
  let cur = [];
  let curTokens = 0;
  for (const piece of pieces) {
    const t = contentTokens(countTokens, piece);
    if (t > max) {
      if (cur.length) out.push(cur.join(joiner));
      cur = [];
      curTokens = 0;
      if (/\s/.test(piece.trim())) out.push(...pack(piece.split(/\s+/).filter(Boolean), countTokens, max));
      else out.push(piece); // A single enormous "word"; the row check reports it.
      continue;
    }
    if (cur.length && curTokens + t > max) {
      out.push(cur.join(joiner));
      cur = [];
      curTokens = 0;
    }
    cur.push(piece);
    curTokens += t;
  }
  if (cur.length) out.push(cur.join(joiner));
  return out;
}

/**
 * Turn extracted blocks into units: { text, heading: string[], section, para, page, tokens }.
 * section increases at every heading, para at every source paragraph (a long paragraph
 * split into several units keeps one para number, so it is re-joined with spaces).
 */
export function toUnits(blocks, countTokens, { maxUnitTokens = CHUNKING.maxUnitTokens } = {}) {
  const units = [];
  let path = [];
  let section = 0;
  let para = 0;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = Math.max(1, block.level || 1);
      path = path.filter((h) => h.level < level);
      path.push({ level, text: block.text });
      section += 1;
      continue;
    }
    const text = block.text.trim();
    if (!text) continue;
    para += 1;
    const heading = path.map((h) => h.text);
    const tokens = contentTokens(countTokens, text);
    const pieces = tokens <= maxUnitTokens ? [text] : pack(splitSentences(text), countTokens, maxUnitTokens);
    for (const piece of pieces) {
      units.push({ text: piece, heading, section, para, page: block.page ?? null,
        tokens: pieces.length === 1 ? tokens : contentTokens(countTokens, piece) });
    }
  }
  return units;
}

function dot(vectors, dim, i, j) {
  let s = 0;
  const a = i * dim;
  const b = j * dim;
  for (let k = 0; k < dim; k += 1) s += vectors[a + k] * vectors[b + k];
  return s;
}

function quantile(values, q) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Distance between unit i-1 and unit i (index 0 is unused). Vectors are unit length. */
export function neighbourDistances(vectors, n, dim) {
  const d = new Float64Array(n);
  for (let i = 1; i < n; i += 1) d[i] = 1 - dot(vectors, dim, i - 1, i);
  return d;
}

function makeChunk(units, start, end) {
  const parts = [];
  for (let i = start; i <= end; i += 1) {
    const sameParagraph = i > start && units[i].para === units[i - 1].para;
    parts.push(i === start ? units[i].text : `${sameParagraph ? ' ' : '\n\n'}${units[i].text}`);
  }
  const pages = units.slice(start, end + 1).map((u) => u.page).filter((p) => p != null);
  let tokens = 0;
  for (let i = start; i <= end; i += 1) tokens += units[i].tokens;
  return {
    start, end, tokens,
    text: parts.join(''),
    heading: units[start].heading,
    pages: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
  };
}

/**
 * Group units [from, to] into chunks using their embeddings. Returns chunks
 * { start, end, text, heading, pages, tokens } covering every unit in order.
 */
export function semanticChunks(units, vectors, dim, options = {}) {
  const { targetTokens, maxTokens, minTokens, breakPercentile } = { ...CHUNKING, ...options };
  const from = options.from ?? 0;
  const to = options.to ?? units.length - 1;
  if (to < from) return [];
  const dist = options.distances || neighbourDistances(vectors, units.length, dim);
  const inside = [];
  for (let i = from + 1; i <= to; i += 1) if (units[i].section === units[i - 1].section) inside.push(dist[i]);
  const threshold = quantile(inside, breakPercentile);
  const median = quantile(inside, 0.5);

  // Greedy pass: each boundary is decided looking only at the chunk so far.
  const bounds = [[from, from]];
  let curTokens = units[from].tokens;
  for (let i = from + 1; i <= to; i += 1) {
    const t = units[i].tokens;
    const newSection = units[i].section !== units[i - 1].section;
    const big = curTokens >= minTokens;
    const split = (newSection && big)
      || curTokens + t > maxTokens
      || (big && dist[i] > threshold)
      || (big && curTokens + t > targetTokens && dist[i] > median);
    if (split) {
      bounds.push([i, i]);
      curTokens = t;
    } else {
      bounds[bounds.length - 1][1] = i;
      curTokens += t;
    }
  }

  // Merge fragments below minTokens into the neighbour they are closer to, if it fits.
  const tokensOf = ([s, e]) => { let x = 0; for (let i = s; i <= e; i += 1) x += units[i].tokens; return x; };
  let merged = true;
  while (merged && bounds.length > 1) {
    merged = false;
    for (let k = 0; k < bounds.length; k += 1) {
      const size = tokensOf(bounds[k]);
      if (size >= minTokens) continue;
      const prev = k > 0 ? bounds[k - 1] : null;
      const next = k < bounds.length - 1 ? bounds[k + 1] : null;
      const fitsPrev = prev && tokensOf(prev) + size <= maxTokens;
      const fitsNext = next && tokensOf(next) + size <= maxTokens;
      // A lone fragment at the start of a section usually introduces what follows.
      const prevScore = fitsPrev ? 1 - dist[bounds[k][0]] - (units[bounds[k][0]].section !== units[prev[1]].section ? 1 : 0) : -Infinity;
      const nextScore = fitsNext ? 1 - dist[next[0]] - (units[next[0]].section !== units[bounds[k][1]].section ? 0.5 : 0) : -Infinity;
      if (prevScore === -Infinity && nextScore === -Infinity) continue;
      if (prevScore >= nextScore) {
        prev[1] = bounds[k][1];
        bounds.splice(k, 1);
      } else {
        next[0] = bounds[k][0];
        bounds.splice(k, 1);
      }
      merged = true;
      break;
    }
  }
  return bounds.map(([s, e]) => makeChunk(units, s, e));
}

/**
 * Chunks from groups chosen by a language model ({ start, end, title } over units
 * [offset, offset + n)). Any group over the token budget is split semantically.
 */
export function chunksFromGroups(units, vectors, dim, groups, offset = 0, options = {}) {
  const maxTokens = options.maxTokens ?? CHUNKING.maxTokens;
  const distances = options.distances || neighbourDistances(vectors, units.length, dim);
  const out = [];
  for (const g of groups) {
    const start = offset + g.start;
    const end = offset + g.end;
    const whole = makeChunk(units, start, end);
    if (whole.tokens <= maxTokens) {
      out.push({ ...whole, label: g.title });
      continue;
    }
    const parts = semanticChunks(units, vectors, dim, { ...options, from: start, to: end, distances });
    parts.forEach((p, i) => out.push({ ...p, label: `${g.title} (part ${i + 1} of ${parts.length})` }));
  }
  return out;
}

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Title of a chunk: the document title, then the AI title or the nearest heading. */
export function chunkTitles(docTitle, chunks) {
  const max = CHUNKING.maxTitleChars;
  const doc = truncate(docTitle.trim().replace(/\s+/g, ' ') || 'Untitled document', 70);
  const labels = chunks.map((c) => (c.label || c.heading.at(-1) || '').trim().replace(/\s+/g, ' '));
  // Number chunks that would otherwise share a title (several chunks of one section).
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
  const seen = new Map();
  return labels.map((label) => {
    let suffix = '';
    if (counts.get(label) > 1) {
      seen.set(label, (seen.get(label) || 0) + 1);
      suffix = ` (${seen.get(label)}/${counts.get(label)})`;
    }
    if (!label || label.toLowerCase() === doc.toLowerCase()) return truncate(`${doc}${suffix}`, max);
    return `${doc} — ${truncate(label, max - doc.length - 3 - suffix.length)}${suffix}`;
  });
}

/**
 * The rows for a document's chunks, as a spreadsheet would provide them.
 * meta: { title, date (YYYY-MM-DD), sourceType, link }.
 */
export function chunkRows(chunks, meta) {
  const titles = chunkTitles(meta.title, chunks);
  return chunks.map((c, i) => ({
    title: titles[i],
    summary: c.text,
    link: meta.link || '',
    date: meta.date,
    sourceType: meta.sourceType,
  }));
}

/** The stored source.csv for a document's chunks (no formula defusing: it is data, not a download). */
export function rowsToCsv(rows) {
  return toCsv([COLUMNS.map((c) => c.header), ...rows.map((r) => COLUMNS.map((c) => r[c.key]))], { defuse: false });
}

export const MAX_ROW_TOKENS = EMBEDDING.maxTokens;
