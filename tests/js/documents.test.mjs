import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNKING, toUnits, semanticChunks, chunksFromGroups, chunkTitles, chunkRows, rowsToCsv, splitSentences } from '../../site/js/documents/chunker.js';
import { parseText, stripInline } from '../../site/js/documents/text.js';
import { parseDocx, docxBlocks, headingStyles } from '../../site/js/documents/docx.js';
import { pdfItemsToBlocks, pdfDate } from '../../site/js/documents/pdf.js';
import { validateCsvText, checkTokenLimits } from '../../site/js/csv.js';
import { tokenCounter, zip } from './helpers.mjs';

// One token per word, plus the two special tokens, like the real counter for plain words.
const words = (text) => text.split(/\s+/).filter(Boolean).length + 2;
const para = (n, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

/** Unit vectors on one of a few orthogonal axes, so topics are perfectly separable. */
function topicVectors(topics, dim = 8) {
  const v = new Float32Array(topics.length * dim);
  topics.forEach((t, i) => { v[i * dim + t] = 1; });
  return v;
}

test('toUnits follows the heading path and splits long paragraphs at sentences', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} has exactly six words.`).join(' ');
  const units = toUnits([
    { kind: 'heading', level: 1, text: 'Report' },
    { kind: 'text', text: 'Intro text.' },
    { kind: 'heading', level: 2, text: 'Costs' },
    { kind: 'text', text: long, page: 3 },
    { kind: 'heading', level: 2, text: 'Benefits' },
    { kind: 'text', text: 'More.' },
  ], words, { maxUnitTokens: 40 });
  assert.deepEqual(units[0].heading, ['Report']);
  const costs = units.filter((u) => u.heading.at(-1) === 'Costs');
  assert.ok(costs.length >= 5);
  assert.ok(costs.every((u) => u.tokens <= 40 && u.page === 3 && u.para === costs[0].para));
  assert.deepEqual(units.at(-1).heading, ['Report', 'Benefits']);
  assert.ok(units.at(-1).section > costs[0].section);
});

test('toUnits splits a sentence with no punctuation by words', () => {
  const units = toUnits([{ kind: 'text', text: para(100) }], words, { maxUnitTokens: 30 });
  assert.equal(units.length, 4);
  assert.ok(units.every((u) => u.tokens <= 30));
});

test('splitSentences', () => {
  assert.deepEqual(splitSentences('One. Two? Three!'), ['One.', 'Two?', 'Three!']);
});

test('semanticChunks breaks where the topic changes and at headings', () => {
  const blocks = [];
  const topics = [];
  for (let i = 0; i < 6; i += 1) { blocks.push({ kind: 'text', text: para(30, 'a') }); topics.push(0); }
  for (let i = 0; i < 6; i += 1) { blocks.push({ kind: 'text', text: para(30, 'b') }); topics.push(1); }
  blocks.push({ kind: 'heading', level: 2, text: 'Next' });
  for (let i = 0; i < 3; i += 1) { blocks.push({ kind: 'text', text: para(30, 'c') }); topics.push(1); }
  const units = toUnits(blocks, words);
  const chunks = semanticChunks(units, topicVectors(topics), 8, { targetTokens: 1000, maxTokens: 1000, minTokens: 20 });
  assert.deepEqual(chunks.map((c) => [c.start, c.end]), [[0, 5], [6, 11], [12, 14]]);
  assert.deepEqual(chunks[2].heading, ['Next']);
  // Paragraphs are separated by blank lines.
  assert.equal(chunks[0].text.split('\n\n').length, 6);
});

test('semanticChunks never exceeds the token budget and covers every unit once', () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({ kind: 'text', text: para(20 + (i * 7) % 60) }));
  const units = toUnits(blocks, words);
  const vectors = topicVectors(units.map((_, i) => Math.floor(i / 3) % 8));
  const chunks = semanticChunks(units, vectors, 8);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, units.length - 1);
  chunks.forEach((c, i) => {
    assert.ok(c.tokens <= CHUNKING.maxTokens, `chunk ${i} has ${c.tokens} tokens`);
    if (i) assert.equal(c.start, chunks[i - 1].end + 1);
  });
});

test('semanticChunks merges small fragments into a neighbour', () => {
  const units = toUnits([
    { kind: 'heading', level: 1, text: 'A' },
    { kind: 'text', text: para(80) },
    { kind: 'heading', level: 1, text: 'B' },
    { kind: 'text', text: 'Short intro.' },
    { kind: 'text', text: para(80) },
  ], words);
  const chunks = semanticChunks(units, topicVectors([0, 1, 1]), 8);
  assert.deepEqual(chunks.map((c) => [c.start, c.end]), [[0, 0], [1, 2]]);
});

test('chunksFromGroups keeps AI titles and splits groups that are too long', () => {
  const units = toUnits(Array.from({ length: 6 }, () => ({ kind: 'text', text: para(100) })), words);
  const vectors = topicVectors([0, 0, 0, 1, 1, 1]);
  const chunks = chunksFromGroups(units, vectors, 8, [{ start: 0, end: 0, title: 'First' }, { start: 1, end: 5, title: 'Rest' }]);
  assert.equal(chunks[0].label, 'First');
  assert.ok(chunks.length > 2);
  assert.ok(chunks.slice(1).every((c) => /^Rest \(part \d of \d\)$/.test(c.label) && c.tokens <= CHUNKING.maxTokens));
});

test('chunk titles, rows and CSV round trip through the spreadsheet validator', () => {
  const chunks = [
    { heading: ['Intro'], text: '- a bullet that starts with a dash\n- and "quotes", commas' },
    { heading: ['Intro'], text: '=SUM(1) is just text here.' },
    { heading: [], text: 'No heading.' },
  ];
  assert.deepEqual(chunkTitles('My report', chunks), ['My report — Intro (1/2)', 'My report — Intro (2/2)', 'My report']);
  const rows = chunkRows(chunks, { title: 'My report', date: '2024-05-01', sourceType: 'Document', link: '' });
  const result = validateCsvText(rowsToCsv(rows));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map((r) => r.summary), chunks.map((c) => c.text));
  assert.deepEqual(result.rows.map((r) => r.link), ['', '', '']);
});

test('real chunks fit the model with their titles', () => {
  const count = tokenCounter();
  const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} discusses intellectual property, patents, trade marks and designs in some detail; it continues for a while.`).join('\n\n');
  const doc = parseText(`# A very long title about intellectual property policy in Australia and elsewhere\n\n${text}`);
  const units = toUnits(doc.blocks, count);
  const vectors = topicVectors(units.map((_, i) => i % 8));
  const rows = chunkRows(semanticChunks(units, vectors, 8), { title: doc.title, date: '2024-01-01', sourceType: 'Document' });
  const result = validateCsvText(rowsToCsv(rows));
  assert.deepEqual(checkTokenLimits(result.rows, count), []);
});

test('markdown: headings, lists, emphasis and code', () => {
  const doc = parseText([
    'Big title', '=========', '',
    'Some *emphasised* text with a [link](https://x.com)', 'that wraps.', '',
    '## Section', '',
    '- one', '- **two**', '',
    '> quoted', '> lines', '',
    '```', 'code block', '```', '',
    '| a | b |', '|---|---|', '| 1 | 2 |',
  ].join('\n'), { filename: 'notes.md' });
  assert.equal(doc.title, 'Big title');
  assert.deepEqual(doc.blocks, [
    { kind: 'heading', level: 1, text: 'Big title' },
    { kind: 'text', text: 'Some emphasised text with a link that wraps.' },
    { kind: 'heading', level: 2, text: 'Section' },
    { kind: 'text', text: '- one\n- two' },
    { kind: 'text', text: 'quoted lines' },
    { kind: 'text', text: 'code block' },
    { kind: 'text', text: 'a | b\n1 | 2' },
  ]);
  assert.equal(stripInline('snake_case_name and __bold__'), 'snake_case_name and bold');
});

test('plain text: title from the file name', () => {
  const doc = parseText('First paragraph\nwrapped.\n\nSecond *stays*.', { markdown: false, filename: 'meeting_notes.txt' });
  assert.equal(doc.title, 'meeting notes');
  assert.deepEqual(doc.blocks.map((b) => b.text), ['First paragraph wrapped.', 'Second *stays*.']);
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, style = '', extra = '') => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('docx: headings from styles, lists, tables and core properties', async () => {
  const documentXml = `<?xml version="1.0"?><w:document ${W}><w:body>
    ${p('Annual report', 'Title')}
    ${p('Background', 'Heading1')}
    <w:p><w:r><w:t>Tom &amp; Jerry said</w:t></w:r><w:r><w:tab/><w:t>hello.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Split </w:t></w:r><w:r><w:t>runs</w:t></w:r><w:r><w:br/><w:t>and a break</w:t></w:r></w:p>
    ${p('First point', '', '<w:numPr><w:ilvl w:val="0"/></w:numPr>')}
    ${p('Second point', '', '<w:numPr><w:ilvl w:val="0"/></w:numPr>')}
    ${p('Custom heading', 'MyHeading')}
    <w:p/>
    <w:tbl><w:tr><w:tc>${p('Name')}</w:tc><w:tc>${p('Value')}</w:tc></w:tr><w:tr><w:tc>${p('A')}</w:tc><w:tc>${p('1')}</w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const stylesXml = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My heading"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  const coreXml = '<cp:coreProperties><dc:title>Report &amp; accounts</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2024-06-30T01:02:03Z</dcterms:created></cp:coreProperties>';
  const bytes = await zip([
    ['[Content_Types].xml', '<Types/>', false],
    ['word/document.xml', documentXml, true],
    ['word/styles.xml', stylesXml, false],
    ['docProps/core.xml', coreXml, true],
  ]);
  const doc = await parseDocx(bytes);
  assert.equal(doc.title, 'Report & accounts');
  assert.equal(doc.date, '2024-06-30');
  assert.deepEqual(doc.blocks, [
    { kind: 'heading', level: 1, text: 'Annual report' },
    { kind: 'heading', level: 1, text: 'Background' },
    { kind: 'text', text: 'Tom & Jerry said hello.' },
    { kind: 'text', text: 'Split runs\nand a break' },
    { kind: 'text', text: '- First point\n- Second point' },
    { kind: 'heading', level: 2, text: 'Custom heading' },
    { kind: 'text', text: 'Name | Value\nA | 1' },
  ]);
  assert.equal(headingStyles(stylesXml).get('MyHeading'), 2);
  assert.deepEqual(docxBlocks(`<w:body>${p('X', 'Heading3')}</w:body>`), [{ kind: 'heading', level: 3, text: 'X' }]);
  await assert.rejects(parseDocx(new Uint8Array([1, 2, 3])), /not a valid Word document/);
});

/** Text items for a page: [text, y, size] lines, each a single item ending its line. */
function page(lines, x = 72) {
  return { items: lines.map(([str, y, size = 10, width = str.length * 5]) => ({ str, x, y, size, width, eol: true })) };
}

test('pdf: paragraphs, headings, hyphenation, headers and page numbers', () => {
  const header = ['Company confidential', 780, 8];
  const pages = [
    page([header, ['Introduction', 740, 16], ['The patent system is a bargain between inven-', 700, 10, 400], ['tors and the public.', 688, 10, 100],
      ['A second paragraph starts after a gap and runs on', 660, 10, 400], ['to the next page without a full stop', 648, 10, 400], ['1', 40, 8]]),
    page([header, ['and continues here.', 740, 10, 90], ['Costs of filing', 700, 13], ['Fees are high.', 680, 10, 70], ['2', 40, 8]]),
    page([header, ['Final words.', 740, 10, 60], ['3', 40, 8]]),
  ];
  const blocks = pdfItemsToBlocks(pages);
  assert.deepEqual(blocks.map(({ kind, text, level }) => (kind === 'heading' ? { kind, level, text } : { kind, text })), [
    { kind: 'heading', level: 1, text: 'Introduction' },
    { kind: 'text', text: 'The patent system is a bargain between inventors and the public.' },
    { kind: 'text', text: 'A second paragraph starts after a gap and runs on to the next page without a full stop and continues here.' },
    { kind: 'heading', level: 2, text: 'Costs of filing' },
    { kind: 'text', text: 'Fees are high.' },
    { kind: 'text', text: 'Final words.' },
  ]);
  assert.equal(blocks[1].page, 1);
  assert.equal(pdfDate("D:20240115093000+11'00'"), '2024-01-15');
  assert.equal(pdfDate(''), null);
});

test('pdf: items on one line are joined with spaces where there is a gap', () => {
  const blocks = pdfItemsToBlocks([{ items: [
    { str: 'Hello', x: 72, y: 700, size: 10, width: 25 },
    { str: 'world', x: 100, y: 700, size: 10, width: 25 },
    { str: 'again', x: 125, y: 700.5, size: 10, width: 25, eol: true },
  ] }]);
  assert.deepEqual(blocks.map((b) => b.text), ['Hello worldagain']);
});
