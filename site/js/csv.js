// CSV decoding, parsing and validation for uploaded spreadsheets.
//
// The server re-runs the same checks (server/app/validation.py) before anything is
// committed. Both implementations are exercised by the shared fixtures in
// tests/fixtures/csv, so error codes, row numbers and messages stay identical.
//
// Row numbers in messages are spreadsheet row numbers: the header is row 1 and a value
// containing a line break still counts as a single row, as it does in Excel.

import { COLUMNS, LIMITS, EMBEDDING, embeddingText } from './schema.js';

const EXPECTED_HEADERS = COLUMNS.map((c) => c.header);
const EXPECTED_LIST = EXPECTED_HEADERS.join(', ');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export class CsvProblem {
  constructor(code, message, row = null, column = null) {
    this.code = code;
    this.message = message;
    this.row = row;
    this.column = column;
  }
}

// Windows-1252 differs from Latin-1 only in 0x80-0x9F. Decoded by hand because some
// runtimes (including Node) treat the "windows-1252" label as plain Latin-1.
const CP1252_HIGH = [0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178];

function decodeWindows1252(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    const b = u8[i];
    out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
  }
  return out;
}

/**
 * Decode the bytes of an uploaded file. Returns { text, warnings, errors }.
 * UTF-8 is expected; files saved by Excel as plain "CSV (Comma delimited)" are
 * Windows-1252, so that is accepted as a fallback with a warning.
 */
export function decodeCsvBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const errors = [];
  const warnings = [];
  if (u8.length === 0) {
    errors.push(new CsvProblem('EMPTY_FILE', 'The file is empty.'));
    return { text: '', errors, warnings };
  }
  if (u8.length > LIMITS.maxCsvBytes) {
    errors.push(new CsvProblem('FILE_TOO_LARGE',
      `The file is ${(u8.length / 1e6).toFixed(1)} MB. The maximum size is ${LIMITS.maxCsvBytes / 1e6} MB.`));
    return { text: '', errors, warnings };
  }
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
    errors.push(new CsvProblem('NOT_CSV',
      'This looks like an Excel workbook (.xlsx), not a CSV file. In Excel, choose File > Save As and pick "CSV UTF-8 (Comma delimited)".'));
    return { text: '', errors, warnings };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    text = decodeWindows1252(u8);
    warnings.push(new CsvProblem('NOT_UTF8',
      'The file is not saved as UTF-8, so it was read using the Windows (Excel) character set. Check that special characters such as quotation marks and accents look right. To avoid this, save from Excel as "CSV UTF-8 (Comma delimited)".'));
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) {
    errors.push(new CsvProblem('NOT_CSV', 'This file contains binary data and is not a CSV text file.'));
    return { text: '', errors, warnings };
  }
  return { text, errors, warnings };
}

/**
 * Parse CSV text (RFC 4180, comma separated). Returns { records, error } where each
 * record is { row, fields }. Line breaks inside quoted values are kept as "\n".
 */
export function parseCsv(text) {
  const records = [];
  let fields = [];
  let field = '';
  let row = 1;
  let inQuotes = false;
  let quoteRow = 0;
  let afterQuote = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        afterQuote = true;
        i += 1;
        continue;
      }
      if (c === '\r') {
        field += '\n';
        i += text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === ',') {
      fields.push(field);
      field = '';
      afterQuote = false;
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      fields.push(field);
      records.push({ row, fields });
      fields = [];
      field = '';
      afterQuote = false;
      row += 1;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (afterQuote) {
      if (c === ' ' || c === '\t') { i += 1; continue; }
      return {
        records,
        error: new CsvProblem('BAD_QUOTE',
          `Row ${row}: there is text after a closing double quote. If a value contains double quotes, wrap the whole value in double quotes and double each quote inside it, for example "He said ""hello""".`,
          row),
      };
    }
    if (c === '"' && field.trim() === '') {
      inQuotes = true;
      quoteRow = row;
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) {
    return {
      records,
      error: new CsvProblem('UNCLOSED_QUOTE',
        `Row ${quoteRow}: a value starts with a double quote that is never closed. Check for a missing closing quotation mark.`,
        quoteRow),
    };
  }
  if (field !== '' || fields.length > 0 || afterQuote) {
    fields.push(field);
    records.push({ row, fields });
  }
  return { records, error: null };
}

function normaliseHeader(value) {
  return value.replace(/^﻿/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isBlank(fields) {
  return fields.every((f) => f.trim() === '');
}

function trimTrailingEmpty(fields) {
  let end = fields.length;
  while (end > 0 && fields[end - 1].trim() === '') end -= 1;
  return fields.slice(0, end);
}

// Lengths and truncation work on code points so they match the Python implementation.
function charLength(value) {
  return Array.from(value).length;
}

function quoteValue(value, max = 60) {
  const chars = Array.from(value);
  const v = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
  return `"${v}"`;
}

const URL_RE = /^https?:\/\/([^\s/?#@]+@)?([^\s/?#:@]+)(:\d{1,5})?([/?#]\S*)?$/i;

/** Returns null when the link is acceptable, otherwise the reason it is not. */
export function checkUrl(value) {
  if (!/^https?:\/\//i.test(value)) {
    if (/^www\./i.test(value) || /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(value)) {
      return 'must start with http:// or https:// (for example https://www.example.com)';
    }
    return 'must be a web address starting with http:// or https://';
  }
  const m = URL_RE.exec(value);
  if (!m) return 'is not a valid web address (it may contain spaces)';
  const host = m[2];
  if (host.toLowerCase() !== 'localhost' && (!host.includes('.') || host.startsWith('.') || host.endsWith('.'))) {
    return 'does not contain a valid domain name';
  }
  return null;
}

function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * Parse a publication date. Returns { iso } on success or { error } describing the problem.
 * Day/month/year order is assumed for numeric dates (Australian convention).
 */
export function parseDate(value) {
  const v = value.trim();
  let y; let m; let d;
  let match;
  if ((match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v))) {
    y = +match[1]; m = +match[3]; d = +match[4];
  } else if ((match = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(v))) {
    d = +match[1]; m = +match[3]; y = +match[4];
    if (m > 12 && d <= 12) {
      return { error: 'looks like a month/day/year date. Dates are read as day/month/year (Australian format); YYYY-MM-DD is safest' };
    }
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(v))) {
    d = +match[1]; m = MONTHS[match[2].toLowerCase()]; y = +match[3];
    if (!m) return { error: `has an unrecognised month name "${match[2]}"` };
  } else if ((match = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v))) {
    m = MONTHS[match[1].toLowerCase()]; d = +match[2]; y = +match[3];
    if (!m) return { error: `has an unrecognised month name "${match[1]}"` };
  } else if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(v)) {
    return { error: 'has a two-digit year. Use a four-digit year, for example 2024-03-15 or 15/03/2024' };
  } else if (/^\d{4}(-\d{1,2})?$/.test(v)) {
    return { error: 'needs a full date. If only the year or month is known, use the first day, for example 2024-01-01' };
  } else {
    return { error: 'is not a recognised date. Use YYYY-MM-DD (for example 2024-03-15) or DD/MM/YYYY (for example 15/03/2024)' };
  }
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    return { error: 'is not a real calendar date' };
  }
  return { iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}` };
}

function collapseSpaces(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function cleanSummary(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeData(cells) {
  return cells.some((c) => /^https?:\/\//i.test(c.trim()) || parseDate(c).iso);
}

function checkHeader(record) {
  const raw = trimTrailingEmpty(record.fields);
  const cells = raw.map(normaliseHeader);
  const expected = EXPECTED_HEADERS.map(normaliseHeader);
  if (raw.length === 1 && (raw[0].includes(';') || raw[0].includes('\t'))) {
    const sep = raw[0].includes(';') ? 'semicolons (;)' : 'tabs';
    return [new CsvProblem('WRONG_DELIMITER',
      `The columns are separated by ${sep} instead of commas. In Excel, choose File > Save As and pick "CSV UTF-8 (Comma delimited)".`, 1)];
  }
  if (cells.length === expected.length && cells.every((c, i) => c === expected[i])) return [];
  if (looksLikeData(raw)) {
    return [new CsvProblem('HEADER_MISSING',
      `Row 1 must contain the column headings: ${EXPECTED_LIST}. It looks like it contains an entry instead. Download the template to see the expected layout.`, 1)];
  }
  if (cells.length === expected.length && [...cells].sort().join('|') === [...expected].sort().join('|')) {
    return [new CsvProblem('HEADER_ORDER',
      `The columns are in the wrong order. They must be: ${EXPECTED_LIST}.`, 1)];
  }
  const problems = [];
  if (cells.length !== expected.length) {
    const missing = EXPECTED_HEADERS.filter((h) => !cells.includes(normaliseHeader(h)));
    const extra = raw.filter((h) => !expected.includes(normaliseHeader(h)));
    let msg = `The header row has ${cells.length} column${cells.length === 1 ? '' : 's'} but exactly ${expected.length} are required: ${EXPECTED_LIST}.`;
    if (missing.length) msg += ` Missing: ${missing.join(', ')}.`;
    if (extra.length) msg += ` Not expected: ${extra.map((h) => quoteValue(h.trim(), 40)).join(', ')}.`;
    problems.push(new CsvProblem('HEADER_COLUMN_COUNT', msg, 1));
    return problems;
  }
  cells.forEach((c, i) => {
    if (c !== expected[i]) {
      problems.push(new CsvProblem('HEADER_MISMATCH',
        `Column ${i + 1} is headed ${quoteValue(raw[i].trim(), 40)} but should be "${EXPECTED_HEADERS[i]}".`, 1, EXPECTED_HEADERS[i]));
    }
  });
  return problems;
}

/**
 * Validate the structure and content of a CSV upload (everything except the token limit).
 * Returns { rows, errors, warnings }. rows is only meaningful when errors is empty.
 */
export function validateCsvText(input) {
  let text = input;
  const errors = [];
  const warnings = [];
  const rows = [];
  const add = (problem) => { errors.push(problem); };

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') {
    return { rows, warnings, errors: [new CsvProblem('EMPTY_FILE', 'The file is empty.')] };
  }
  if (text.includes('\u0000')) {
    return { rows, warnings, errors: [new CsvProblem('NOT_CSV', 'This file contains binary data and is not a CSV text file.')] };
  }
  const { records, error } = parseCsv(text);
  if (error) return { rows, warnings, errors: [error] };

  const headerProblems = checkHeader(records[0]);
  if (headerProblems.length) return { rows, warnings, errors: headerProblems };

  const width = EXPECTED_HEADERS.length;
  const seen = new Map();
  for (const record of records.slice(1)) {
    if (isBlank(record.fields)) continue;
    const { row } = record;
    const fields = record.fields.length > width ? trimTrailingEmpty(record.fields) : record.fields;
    if (fields.length < width) {
      add(new CsvProblem('ROW_TOO_FEW_VALUES',
        `Row ${row} has ${fields.length} value${fields.length === 1 ? '' : 's'} but ${width} are expected. Check for a missing comma, or a line break inside a value that is not wrapped in double quotes.`, row));
      continue;
    }
    if (fields.length > width) {
      add(new CsvProblem('ROW_TOO_MANY_VALUES',
        `Row ${row} has ${fields.length} values but ${width} are expected. If a value contains a comma, wrap the whole value in double quotes.`, row));
      continue;
    }
    const entry = {
      row,
      title: collapseSpaces(fields[0]),
      summary: cleanSummary(fields[1]),
      link: fields[2].trim(),
      date: '',
      sourceType: collapseSpaces(fields[4]),
    };
    let rowOk = true;
    const values = [entry.title, entry.summary, entry.link, fields[3].trim(), entry.sourceType];
    values.forEach((v, i) => {
      if (v === '') {
        rowOk = false;
        add(new CsvProblem('MISSING_VALUE', `Row ${row}: ${EXPECTED_HEADERS[i]} is empty. Every entry needs a value in all five columns.`, row, EXPECTED_HEADERS[i]));
      }
    });
    if (entry.link) {
      const reason = checkUrl(entry.link);
      if (reason) {
        rowOk = false;
        add(new CsvProblem('INVALID_URL', `Row ${row}: Source link ${quoteValue(entry.link)} ${reason}.`, row, 'Source link'));
      }
    }
    const rawDate = fields[3].trim();
    if (rawDate) {
      const parsed = parseDate(rawDate);
      if (parsed.error) {
        rowOk = false;
        add(new CsvProblem('INVALID_DATE', `Row ${row}: Publication Date ${quoteValue(rawDate, 40)} ${parsed.error}.`, row, 'Publication Date'));
      } else {
        entry.date = parsed.iso;
      }
    }
    if (charLength(entry.sourceType) > LIMITS.maxSourceTypeLength) {
      rowOk = false;
      add(new CsvProblem('SOURCE_TYPE_TOO_LONG',
        `Row ${row}: Source type is ${charLength(entry.sourceType)} characters long. Keep it to a short category of at most ${LIMITS.maxSourceTypeLength} characters, such as "Journal article" or "News".`, row, 'Source type'));
    }
    if (!rowOk) continue;
    const key = `${entry.title.toLowerCase()}\u0000${entry.link.toLowerCase()}`;
    if (seen.has(key)) {
      warnings.push(new CsvProblem('DUPLICATE_ROW', `Row ${row} repeats row ${seen.get(key)} (same title and source link). Both will be added.`, row));
    } else {
      seen.set(key, row);
    }
    rows.push(entry);
  }

  if (errors.length === 0 && rows.length === 0) {
    errors.push(new CsvProblem('NO_ROWS', 'The file has a header row but no entries below it.'));
  }
  if (errors.length === 0 && rows.length > LIMITS.maxRowsPerUpload) {
    errors.push(new CsvProblem('TOO_MANY_ROWS',
      `The file has ${rows.length} entries. At most ${LIMITS.maxRowsPerUpload} can be uploaded at once; split it into smaller files.`));
  }
  return { rows, warnings, errors: capProblems(errors) };
}

/**
 * Check that title + summary fit within the embedding model's token limit.
 * countTokens(text) must return the number of tokens including special tokens.
 */
export function checkTokenLimits(rows, countTokens, maxTokens = EMBEDDING.maxTokens) {
  const errors = [];
  for (const entry of rows) {
    const count = countTokens(embeddingText(entry.title, entry.summary));
    entry.tokens = count;
    if (count > maxTokens) {
      const over = count - maxTokens;
      const words = Math.max(1, Math.ceil(over * 0.75));
      errors.push(new CsvProblem('TOKEN_LIMIT',
        `Row ${entry.row} (${quoteValue(entry.title, 50)}): the title and summary together are ${count} tokens long, but the embedding model accepts at most ${maxTokens}. Shorten this entry by at least ${over} token${over === 1 ? '' : 's'} (roughly ${words} word${words === 1 ? '' : 's'}).`,
        entry.row, 'Summary'));
    }
  }
  return capProblems(errors);
}

export function capProblems(errors) {
  if (errors.length <= LIMITS.maxErrors) return errors;
  const extra = errors.length - LIMITS.maxErrors;
  return [...errors.slice(0, LIMITS.maxErrors),
    new CsvProblem('MORE_ERRORS', `…and ${extra} more problem${extra === 1 ? '' : 's'}. Fix the ones above and upload again to see the rest.`)];
}

/** Quote a value for CSV output, defusing spreadsheet formula injection. */
export function csvCell(value) {
  let v = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows) {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
