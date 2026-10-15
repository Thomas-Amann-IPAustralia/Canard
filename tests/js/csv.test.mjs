import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCsvBytes, parseCsv, csvCell, toCsv, validateCsvText } from '../../site/js/csv.js';
import { runCase } from '../../scripts/gen-csv-golden.mjs';
import { readJson } from './helpers.mjs';

const cases = readJson('tests/fixtures/csv/cases.json');
const golden = readJson('tests/fixtures/csv/golden.json');

for (const [i, c] of cases.entries()) {
  test(`csv fixture: ${c.name}`, () => {
    const result = runCase(c);
    assert.deepEqual(result.errors.map(({ code, row }) => ({ code, row })), c.errors);
    assert.equal(result.rows.length, c.rows);
    assert.deepEqual(result.warnings.map((w) => w.code), c.warnings ?? []);
    if (c.dates) assert.deepEqual(result.rows.map((r) => r.date), c.dates);
    if (c.first) for (const [k, v] of Object.entries(c.first)) assert.equal(result.rows[0][k], v);
    // Full messages must match the golden file that the Python suite also checks.
    assert.deepEqual(result, golden[i]);
  });
}

test('decode: UTF-8 with BOM', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Title,Café')]);
  const { text, errors, warnings } = decodeCsvBytes(bytes);
  assert.equal(text, 'Title,Café');
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test('decode: Windows-1252 falls back with a warning', () => {
  // "Caf\xe9 \x93quoted\x94" in Windows-1252
  const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]);
  const { text, warnings } = decodeCsvBytes(bytes);
  assert.equal(text, 'Café “q”');
  assert.equal(warnings[0].code, 'NOT_UTF8');
});

test('decode: Excel workbook and binary data are rejected', () => {
  assert.equal(decodeCsvBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])).errors[0].code, 'NOT_CSV');
  assert.equal(decodeCsvBytes(new Uint8Array([0x41, 0x00, 0x42])).errors[0].code, 'NOT_CSV');
  assert.equal(decodeCsvBytes(new Uint8Array([])).errors[0].code, 'EMPTY_FILE');
});

test('parse: quoted fields, escaped quotes and line breaks', () => {
  const { records, error } = parseCsv('a,"b ""c""\r\nd",e\r\nf,,"g"');
  assert.equal(error, null);
  assert.deepEqual(records, [
    { row: 1, fields: ['a', 'b "c"\nd', 'e'] },
    { row: 2, fields: ['f', '', 'g'] },
  ]);
});

test('export: values are quoted and formula injection is defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(toCsv([['a', 'b'], ['c', 'd\ne']]), 'a,b\r\nc,"d\ne"\r\n');
});

test('round trip: exported template rows validate', () => {
  const csv = toCsv([
    ['Title', 'Summary', 'Source link', 'Publication Date', 'Source type'],
    ['A, with comma', 'Line\nbreak "quoted"', 'https://example.com', '2024-01-02', 'News'],
  ]);
  const { errors, rows } = validateCsvText(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].summary, 'Line\nbreak "quoted"');
});
