// Token counting with the embedding model's own tokenizer (vendored, so validation
// works instantly without downloading the model).
import { Tokenizer } from '../vendor/hf-tokenizers-0.1.3.min.mjs';

export function createTokenCounter(tokenizerJson, tokenizerConfig) {
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  // encode() adds the [CLS] and [SEP] special tokens, which count towards the limit.
  return (text) => tokenizer.encode(text).ids.length;
}

let counterPromise = null;

export function loadTokenCounter() {
  if (!counterPromise) {
    const base = new URL('../models/bge-small-en-v1.5/', import.meta.url);
    counterPromise = Promise.all([
      fetch(new URL('tokenizer.json', base)).then((r) => r.json()),
      fetch(new URL('tokenizer_config.json', base)).then((r) => r.json()),
    ]).then(([json, config]) => createTokenCounter(json, config));
    counterPromise.catch(() => { counterPromise = null; });
  }
  return counterPromise;
}
