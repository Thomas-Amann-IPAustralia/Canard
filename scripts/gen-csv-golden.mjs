// Regenerates tests/fixtures/csv/golden.json from the JavaScript validator.
// Both the JavaScript and Python test suites compare their output with this file.
import fs from 'node:fs';
import path from 'node:path';
import { validateCsvText, checkTokenLimits } from '../site/js/csv.js';
import { ROOT, readJson, tokenCounter } from '../tests/js/helpers.mjs';

export function runCase(c) {
  const result = validateCsvText(c.csv);
  let { errors } = result;
  if (c.tokens && errors.length === 0) errors = checkTokenLimits(result.rows, tokenCounter());
  const plain = (p) => ({ code: p.code, row: p.row, column: p.column, message: p.message });
  return {
    name: c.name,
    errors: errors.map(plain),
    warnings: result.warnings.map(plain),
    rows: result.rows.map(({ tokens, ...r }) => (c.tokens ? { ...r, tokens } : r)),
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const cases = readJson('tests/fixtures/csv/cases.json');
  const golden = cases.map(runCase);
  fs.writeFileSync(path.join(ROOT, 'tests/fixtures/csv/golden.json'), `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`Wrote ${golden.length} golden results.`);
}
