// Runs the embedding model (transformers.js) off the main thread.
// The model files are downloaded once from Hugging Face and cached by the browser.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

let extractor = null;
let device = null;

function post(type, data = {}, transfer = []) {
  self.postMessage({ type, ...data }, transfer);
}

async function load({ model, dtype, preferGpu }) {
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
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
  extractor = await pipeline('feature-extraction', model, { dtype, device: d, progress_callback });
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
