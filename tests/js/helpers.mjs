import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenCounter } from '../../site/js/tokenizer.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

let counter;
export function tokenCounter() {
  counter ??= createTokenCounter(
    readJson('site/models/bge-small-en-v1.5/tokenizer.json'),
    readJson('site/models/bge-small-en-v1.5/tokenizer_config.json'),
  );
  return counter;
}
