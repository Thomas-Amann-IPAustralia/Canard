// Copies everything the in-browser embedding model needs onto the site itself, so
// uploads work on networks that block Hugging Face or jsDelivr (common on government
// and corporate networks). The browser uses these copies when they are present and
// falls back to the public CDNs when they are not (for example on the dev server).
//
//   node scripts/fetch-model-assets.mjs [site folder] [cache folder]
//
// Defaults: site/ and .asset-cache/. Writes:
//   vendor/transformers/transformers.min.js
//   vendor/onnxruntime-web/ort-wasm-simd-threaded{,.asyncify}.{mjs,wasm}
//   vendor/pdfjs/pdf.min.mjs, pdf.worker.min.mjs (the PDF reader for document uploads)
//   models/<model id>/{config.json, tokenizer.json, tokenizer_config.json, onnx/model*.onnx}
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDING } from '../site/js/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.resolve(process.argv[2] || path.join(root, 'site'));
const cacheDir = path.resolve(process.argv[3] || path.join(root, '.asset-cache'));

// The worker names the transformers.js version it imports from the CDN; mirror that one.
const workerSource = fs.readFileSync(path.join(root, 'site/js/workers/embed.worker.js'), 'utf8');
const transformersVersion = workerSource.match(/@huggingface\/transformers@([^/'"]+)\//)?.[1];
if (!transformersVersion) throw new Error('Could not find the transformers.js version in embed.worker.js.');
const pdfSource = fs.readFileSync(path.join(root, 'site/js/documents/pdf.js'), 'utf8');
const pdfjsVersion = pdfSource.match(/PDFJS_VERSION = '([^']+)'/)?.[1];
if (!pdfjsVersion) throw new Error('Could not find the pdf.js version in documents/pdf.js.');

const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', bnb4: '_bnb4', q4f16: '_q4f16' };
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/model${DTYPE_SUFFIX[EMBEDDING.dtype] ?? ''}.onnx`];

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}.`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}

/** Download a file once into the cache folder, then copy it into the site. */
async function cached(url, cacheName, siteRel) {
  const cachePath = path.join(cacheDir, cacheName);
  if (!fs.existsSync(cachePath)) {
    console.log(`Downloading ${url}`);
    await download(url, cachePath);
  }
  const dest = path.join(siteDir, siteRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(cachePath, dest);
  return dest;
}

/** Download an npm package tarball (cached) and return the folder it unpacks to. */
async function npmPackage(name, version) {
  const dir = path.join(cacheDir, 'npm', `${name.replace('/', '__')}@${version}`);
  if (!fs.existsSync(path.join(dir, 'package', 'package.json'))) {
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    console.log(`Downloading ${tarball}`);
    const tgz = `${dir}.tgz`;
    await download(tarball, tgz);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    fs.rmSync(tgz);
  }
  return path.join(dir, 'package');
}

function copyInto(from, siteRel, { optional = false } = {}) {
  if (optional && !fs.existsSync(from)) return;
  const dest = path.join(siteDir, siteRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(from, dest);
}

const transformers = await npmPackage('@huggingface/transformers', transformersVersion);
copyInto(path.join(transformers, 'dist/transformers.min.js'), 'vendor/transformers/transformers.min.js');
copyInto(path.join(transformers, 'LICENSE'), 'vendor/transformers/LICENSE', { optional: true });

const ortVersion = JSON.parse(fs.readFileSync(path.join(transformers, 'package.json'), 'utf8')).dependencies['onnxruntime-web'];
const ort = await npmPackage('onnxruntime-web', ortVersion);
for (const f of ORT_FILES) copyInto(path.join(ort, 'dist', f), `vendor/onnxruntime-web/${f}`);
copyInto(path.join(ort, 'LICENSE'), 'vendor/onnxruntime-web/LICENSE', { optional: true });

const pdfjs = await npmPackage('pdfjs-dist', pdfjsVersion);
// The legacy build, which supports older browsers (see documents/pdf.js).
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copyInto(path.join(pdfjs, 'legacy/build', f), `vendor/pdfjs/${f}`);
copyInto(path.join(pdfjs, 'LICENSE'), 'vendor/pdfjs/LICENSE', { optional: true });

for (const f of MODEL_FILES) {
  await cached(`https://huggingface.co/${EMBEDDING.model}/resolve/main/${f}`, path.join('hf', EMBEDDING.model, f), path.join('models', EMBEDDING.model, f));
}

console.log(`Mirrored transformers.js ${transformersVersion}, ONNX Runtime Web ${ortVersion}, pdf.js ${pdfjsVersion} and ${EMBEDDING.model} (${EMBEDDING.dtype}) into ${siteDir}.`);
