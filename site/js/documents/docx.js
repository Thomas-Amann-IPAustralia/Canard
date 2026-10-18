// Word (.docx) documents, read without any library: a .docx file is a ZIP archive and
// the text lives in word/document.xml. Deflated entries are inflated with the
// browser's built-in DecompressionStream. Headings come from the paragraph styles
// (Title, Heading 1-9, or any style with an outline level), list paragraphs are kept
// together and each table row becomes one line.

const DECODER = new TextDecoder('utf-8');

/** Read a ZIP archive's central directory. Returns Map(name -> entry). */
export function readZipDirectory(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid Word document (it is not a ZIP archive).');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let k = 0; k < count; k += 1) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('This Word document is damaged.');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = DECODER.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The uncompressed bytes of one ZIP entry. */
export async function readZipEntry(u8, entry) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const p = entry.offset;
  if (view.getUint32(p, true) !== 0x04034b50) throw new Error('This Word document is damaged.');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = u8.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('This Word document uses an unsupported kind of compression.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (xml, tag) => new RegExp(`<${tag}\\b[^>]*\\bw:val="([^"]*)"`).exec(xml)?.[1];

/** Heading level (1-9) for each paragraph style id that is a heading. */
export function headingStyles(stylesXml = '') {
  const levels = new Map();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = /w:styleId="([^"]+)"/.exec(m[1])?.[1];
    if (!id) continue;
    const name = (attr(m[2], 'w:name') || '').toLowerCase();
    const outline = attr(m[2], 'w:outlineLvl');
    let level = null;
    if (name === 'title') level = 1;
    else if (/^heading \d$/.test(name)) level = Number(name.slice(8));
    else if (outline != null && Number(outline) < 9) level = Number(outline) + 1;
    if (level) levels.set(id, level);
  }
  return levels;
}

function styleLevel(styleId, styles) {
  if (!styleId) return null;
  if (styles.has(styleId)) return styles.get(styleId);
  // Documents without styles.xml still use the built-in ids.
  if (/^title$/i.test(styleId)) return 1;
  const m = /^heading\s?(\d)$/i.exec(styleId);
  return m ? Number(m[1]) : null;
}

function paragraphText(xml) {
  let text = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t\s*\/>|<w:(tab|br|cr)\b[^>]*\/>|<w:noBreakHyphen\s*\/>/g)) {
    if (m[1] != null) text += decodeXml(m[1]);
    else if (m[2] === 'tab') text += ' ';
    else if (m[2]) text += '\n';
    else if (m[0].startsWith('<w:noBreakHyphen')) text += '-';
  }
  return text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** Blocks from the XML of word/document.xml. */
export function docxBlocks(documentXml, styles = new Map()) {
  const blocks = [];
  let list = [];
  const flushList = () => {
    if (list.length) blocks.push({ kind: 'text', text: list.join('\n') });
    list = [];
  };
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const xml = m[0];
    if (xml.startsWith('<w:tbl>')) {
      flushList();
      const rows = [];
      for (const row of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)]
          .map((c) => [...c[0].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0])).filter(Boolean).join(' '));
        if (cells.some(Boolean)) rows.push(cells.join(' | '));
      }
      if (rows.length) blocks.push({ kind: 'text', text: rows.join('\n') });
      continue;
    }
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(xml)?.[0] || '';
    const text = paragraphText(xml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ''));
    if (!text) continue;
    const outline = attr(pPr, 'w:outlineLvl');
    const level = styleLevel(attr(pPr, 'w:pStyle'), styles) ?? (outline != null && Number(outline) < 9 ? Number(outline) + 1 : null);
    if (level && text.length <= 300) {
      flushList();
      blocks.push({ kind: 'heading', level, text: text.replace(/\s+/g, ' ') });
    } else if (/<w:numPr>/.test(pPr)) {
      list.push(`- ${text}`);
    } else {
      flushList();
      blocks.push({ kind: 'text', text });
    }
  }
  flushList();
  return blocks;
}

function coreProperties(xml = '') {
  const title = decodeXml(/<dc:title>([^<]*)<\/dc:title>/.exec(xml)?.[1] || '').trim();
  const created = /<dcterms:created\b[^>]*>(\d{4}-\d{2}-\d{2})/.exec(xml)?.[1] || null;
  return { title, date: created };
}

/** Parse a .docx file's bytes into { title, date, blocks }. */
export async function parseDocx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = readZipDirectory(u8);
  const text = async (name) => (entries.has(name) ? DECODER.decode(await readZipEntry(u8, entries.get(name))) : null);
  const documentXml = await text('word/document.xml');
  if (documentXml == null) throw new Error('This file is not a Word document (word/document.xml is missing).');
  const styles = headingStyles((await text('word/styles.xml')) || '');
  const blocks = docxBlocks(documentXml, styles);
  const core = coreProperties((await text('docProps/core.xml')) || '');
  const firstHeading = blocks.find((b) => b.kind === 'heading');
  return { title: core.title || firstHeading?.text || '', date: core.date, blocks };
}
