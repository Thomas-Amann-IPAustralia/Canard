// PDF documents. pdf.js (Mozilla) extracts positioned text runs; pdfItemsToBlocks()
// rebuilds lines and paragraphs from them, finds headings by font size, drops running
// headers, footers and page numbers, and re-joins words hyphenated across lines.
//
// pdf.js is loaded only when a PDF is chosen: from the copy on this site when the
// deployment includes one (scripts/fetch-model-assets.mjs), otherwise from jsDelivr.
// The "legacy" build is used because the modern one needs very recent browsers.

export const PDFJS_VERSION = '6.3.289';
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`;
const LOCAL = new URL('../../vendor/pdfjs/', import.meta.url).href;

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      for (const base of [LOCAL, CDN]) {
        try {
          const lib = await import(/* webpackIgnore: true */ `${base}pdf.min.mjs`);
          lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
          return lib;
        } catch {
          // Try the next source.
        }
      }
      throw new Error('Could not load the PDF reader from this site or from cdn.jsdelivr.net. Your network may be blocking it.');
    })();
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const PAGE_NUMBER_RE = /^(page\s*)?[-–(]?\s*\d{1,4}\s*[-–)]?(\s*(of|\/)\s*\d{1,4})?$/i;
const BULLET_RE = /^([•▪◦●■–-]|\d{1,3}[.)]|[a-z][.)])\s/i;

/** Lines of one page from its text items ({ str, x, y, size, width, eol }). */
function pageLines(items, page) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!it.str && !it.eol) continue;
    const size = it.size || 10;
    const sameLine = cur && Math.abs(it.y - cur.y) <= Math.max(size, cur.size) * 0.5;
    if (!sameLine && it.str.trim()) {
      if (cur) lines.push(cur);
      cur = { text: '', x: it.x, y: it.y, size, page, chars: 0, sizeChars: 0, end: it.x };
    }
    if (!cur) continue;
    if (it.str) {
      const gap = it.x - cur.end;
      if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && gap > size * 0.15) cur.text += ' ';
      cur.text += it.str;
      const n = it.str.trim().length;
      cur.sizeChars += size * n;
      cur.chars += n;
      cur.end = it.x + (it.width || 0);
    }
    if (it.eol) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim(), size: l.chars ? l.sizeChars / l.chars : l.size }))
    .filter((l) => l.text);
}

/**
 * Rebuild { kind: 'heading' | 'text', text, level?, page } blocks from the text items of
 * each page: pages = [{ items: [{ str, x, y, size, width, eol }] }] in PDF units (y up).
 */
export function pdfItemsToBlocks(pages) {
  let lines = pages.flatMap((p, i) => pageLines(p.items, i + 1));

  // Running headers and footers: the same text (ignoring digits) at the top or bottom
  // of most pages.
  if (pages.length >= 3) {
    const key = (l) => l.text.toLowerCase().replace(/\d+/g, '#');
    const byPage = Array.from({ length: pages.length + 1 }, () => []);
    for (const l of lines) byPage[l.page].push(l);
    const edges = new Set();
    const counts = new Map();
    for (const onPage of byPage) {
      const edge = [...onPage.slice(0, 2), ...onPage.slice(-2)];
      edge.forEach((l) => edges.add(l));
      for (const k of new Set(edge.map(key))) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const repeated = new Set([...counts].filter(([, c]) => c >= Math.max(3, pages.length * 0.5)).map(([k]) => k));
    lines = lines.filter((l) => !(edges.has(l) && repeated.has(key(l))));
  }
  lines = lines.filter((l) => !PAGE_NUMBER_RE.test(l.text));
  if (!lines.length) return [];

  // Body text size: the size most characters are set in.
  const bySize = new Map();
  for (const l of lines) {
    const s = Math.round(l.size * 2) / 2;
    bySize.set(s, (bySize.get(s) || 0) + l.text.length);
  }
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0][0];
  const isHeadingLine = (l) => l.size >= body * 1.15 && l.text.length <= 160 && !/[.,;]$/.test(l.text) && /\p{L}/u.test(l.text);
  const headingSizes = [...new Set(lines.filter(isHeadingLine).map((l) => Math.round(l.size * 2) / 2))].sort((a, b) => b - a);
  const levelOf = (l) => Math.min(3, headingSizes.indexOf(Math.round(l.size * 2) / 2) + 1);

  // Typical spacing between body lines, for spotting paragraph gaps.
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1];
    const b = lines[i];
    if (a.page === b.page && !isHeadingLine(a) && !isHeadingLine(b) && a.y > b.y) gaps.push(a.y - b.y);
  }
  const lineGap = median(gaps) || body * 1.2;
  const widths = lines.filter((l) => !isHeadingLine(l)).map((l) => l.end - l.x);
  const fullWidth = median(widths.filter((w) => w >= median(widths))) || 0;

  const blocks = [];
  let para = null;
  const flush = () => {
    if (para) blocks.push({ kind: 'text', text: para.text, page: para.page });
    para = null;
  };
  let prev = null;
  for (const l of lines) {
    if (isHeadingLine(l)) {
      flush();
      const last = blocks[blocks.length - 1];
      // A heading that wraps onto a second line.
      if (last?.kind === 'heading' && prev && isHeadingLine(prev) && prev.page === l.page
          && Math.abs(prev.size - l.size) < 0.5 && prev.y - l.y < l.size * 2) {
        last.text += ` ${l.text}`;
      } else {
        blocks.push({ kind: 'heading', level: levelOf(l), text: l.text, page: l.page });
      }
      prev = l;
      continue;
    }
    let startNew = !para;
    if (para && prev) {
      if (prev.page === l.page) {
        const gap = prev.y - l.y;
        if (gap > lineGap * 1.4 || gap < 0) startNew = true;
      } else if (/[.!?:"”)]$/.test(para.text)) {
        startNew = true; // A paragraph that ends at the bottom of a page.
      }
      const prevShort = fullWidth && prev.end - prev.x < fullWidth * 0.75;
      if (prevShort && /[.!?:"”]$/.test(prev.text)) startNew = true;
      if (BULLET_RE.test(l.text)) startNew = true;
    }
    if (startNew) {
      flush();
      para = { text: l.text, page: l.page };
    } else if (/\p{Ll}-$/u.test(para.text) && /^\p{Ll}/u.test(l.text)) {
      para.text = para.text.slice(0, -1) + l.text; // Re-join a hyphenated word.
    } else {
      para.text += ` ${l.text}`;
    }
    prev = l;
  }
  flush();
  return blocks;
}

/** Parse a PDF date such as D:20240115093000+11'00' into YYYY-MM-DD. */
export function pdfDate(value) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(value || '');
  if (!m) return null;
  return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}`;
}

/** Parse a PDF file's bytes into { title, date, blocks, pages }. */
export async function parsePdf(bytes, { onProgress = () => {} } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    task.destroy();
    if (err?.name === 'PasswordException') throw new Error('This PDF is password protected. Remove the password and choose it again.');
    throw new Error(`This PDF could not be read (${err?.message || err}).`);
  }
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({
        items: content.items.filter((it) => 'str' in it).map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          size: Math.hypot(it.transform[2], it.transform[3]) || it.height,
          width: it.width,
          eol: it.hasEOL,
        })),
      });
      page.cleanup();
      onProgress(n, doc.numPages);
    }
    const blocks = pdfItemsToBlocks(pages);
    if (!blocks.some((b) => b.kind === 'text')) {
      throw new Error('This PDF has no selectable text (it may be a scan). Text recognition (OCR) is not supported.');
    }
    const meta = await doc.getMetadata().catch(() => null);
    // Metadata titles are often left over from the authoring tool, so prefer the first heading over those.
    const metaTitle = (meta?.info?.Title || '').trim();
    const junk = !metaTitle || /^(microsoft (word|powerpoint) - |untitled)|\.(docx?|pptx?|indd|pdf)$/i.test(metaTitle);
    const title = junk ? blocks.find((b) => b.kind === 'heading')?.text || '' : metaTitle;
    return { title, date: pdfDate(meta?.info?.CreationDate), blocks, pages: doc.numPages };
  } finally {
    task.destroy();
  }
}
