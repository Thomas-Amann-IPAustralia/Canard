// Serves the site locally the way GitHub Pages will: site/ at the root and the data
// folder at /data/.
//
//   node scripts/dev-server.mjs [port]
//
// Environment: CANARD_DATA_ROOT (default ./data) and CANARD_API_URL, which replaces
// config.js so the page talks to a local API (for example http://localhost:8787).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const dataRoot = path.resolve(process.env.CANARD_DATA_ROOT || path.join(root, 'data'));
const apiUrl = process.env.CANARD_API_URL;
const port = Number(process.argv[2] || process.env.PORT || 8000);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

export function startDevServer(listenPort = port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/config.js' && apiUrl) {
      res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-cache' });
      res.end(`window.CANARD_CONFIG = { apiBase: ${JSON.stringify(apiUrl)} };\n`);
      return;
    }
    const isData = rel.startsWith('/data/');
    const base = isData ? dataRoot : site;
    const file = path.resolve(base, `.${isData ? rel.slice(5) : rel}`);
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(listenPort, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startDevServer().then(() => console.log(`Canard site on http://localhost:${port} (data from ${dataRoot})`));
}
