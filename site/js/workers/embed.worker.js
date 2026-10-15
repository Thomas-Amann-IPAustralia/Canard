// Runs the embedding model (transformers.js) off the main thread.
// The model files are downloaded once and cached by the browser. The published site
// carries its own copy of the library, the ONNX Runtime files and the model (see
// scripts/fetch-model-assets.mjs), because many workplace networks block Hugging Face
// or jsDelivr. Without those copies (for example on the dev server) it uses the CDNs.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const LOCAL_TRANSFORMERS = new URL('../../vendor/transformers/transformers.min.js', import.meta.url).href;
const LOCAL_ORT = new URL('../../vendor/onnxruntime-web/', import.meta.url).href;
const LOCAL_MODELS = new URL('../../models/', import.meta.url).href;

let extractor = null;
let device = null;

function post(type, data = {}, transfer = []) {
  self.postMessage({ type, ...data }, transfer);
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Import transformers.js from the site's own copy if it has one, otherwise from jsDelivr. */
async function importTransformers() {
  if (await exists(LOCAL_TRANSFORMERS)) {
    const lib = await import(LOCAL_TRANSFORMERS);
    // Point ONNX Runtime at the matching local files instead of jsDelivr.
    const wasm = lib.env.backends.onnx?.wasm;
    if (wasm?.wasmPaths && typeof wasm.wasmPaths === 'object') {
      for (const [k, v] of Object.entries(wasm.wasmPaths)) wasm.wasmPaths[k] = LOCAL_ORT + v.split('/').pop();
    } else if (wasm) {
      wasm.wasmPaths = LOCAL_ORT;
    }
    return lib;
  }
  try {
    return await import(TRANSFORMERS_URL);
  } catch (e) {
    throw new Error(`Could not download the embedding library from cdn.jsdelivr.net. Your network may be blocking it. (${e?.message || e})`);
  }
}

async function load({ model, dtype, preferGpu }) {
  const { pipeline, env } = await importTransformers();
  // Use the site's copy of the model when it has one; otherwise download it from Hugging Face.
  // The copy is set up as the "remote" host because transformers.js checks remote files
  // with one-byte range requests, but downloads local files in full just to check them.
  const local = await exists(`${LOCAL_MODELS}${model}/config.json`);
  env.allowLocalModels = false;
  if (local) {
    env.remoteHost = LOCAL_MODELS;
    env.remotePathTemplate = '{model}/';
  }
  env.useBrowserCache = true;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      post('download', { loaded, total });
    }
  };
  // Use the GPU only when the browser can actually provide an adapter.
  let gpu = false;
  if (preferGpu && self.navigator?.gpu) {
    try { gpu = Boolean(await self.navigator.gpu.requestAdapter()); } catch { gpu = false; }
  }
  const d = gpu ? 'webgpu' : 'wasm';
  try {
    extractor = await pipeline('feature-extraction', model, { dtype, device: d, progress_callback });
  } catch (e) {
    // A bare network error ("Failed to fetch") does not say which server was unreachable.
    if (e instanceof TypeError && !local) {
      throw new Error(`Could not download the embedding model from huggingface.co. Your network may be blocking it. (${e.message})`);
    }
    throw e;
  }
  // A quick check that the device really works before committing to it.
  await extractor(['warm up'], { pooling: 'cls', normalize: true });
  device = d;
  return d;
}

async function embed({ texts, pooling, normalize, dim }) {
  const batch = device === 'webgpu' ? 32 : 8;
  const out = new Float32Array(texts.length * dim);
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch);
    const tensor = await extractor(chunk, { pooling, normalize });
    out.set(tensor.data.subarray(0, chunk.length * dim), i * dim);
    post('progress', { done: Math.min(texts.length, i + batch), total: texts.length });
  }
  return out;
}

self.onmessage = async (event) => {
  const { id, task } = event.data;
  try {
    if (task === 'load') {
      const d = extractor ? device : await load(event.data);
      post('loaded', { id, device: d });
    } else if (task === 'embed') {
      const vectors = await embed(event.data);
      post('embedded', { id, vectors }, [vectors.buffer]);
    }
  } catch (e) {
    post('error', { id, message: e?.message || String(e) });
  }
};
