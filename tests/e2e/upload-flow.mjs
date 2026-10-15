// End-to-end check of the whole workflow in a real browser: upload, views, lasso,
// tagging, reload and deletion. It starts the API (with a local data folder) and the
// static site itself.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/e2e/upload-flow.mjs
//
// Needs Python with server/requirements.txt installed. The embedding model is
// downloaded from Hugging Face on the first run. CANARD_E2E_ASSETS can point at a
// local mirror of jsDelivr and Hugging Face (paths /npm/... and /hf/...).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canard-e2e-'));
fs.mkdirSync(path.join(dataRoot, 'data'));
fs.writeFileSync(path.join(dataRoot, 'data/index.json'), JSON.stringify({ schema: 1, plots: [] }));
const API_PORT = Number(process.env.CANARD_E2E_API_PORT || 8787);
const SITE_PORT = Number(process.env.CANARD_E2E_SITE_PORT || 8000);

process.env.CANARD_DATA_ROOT = path.join(dataRoot, 'data');
process.env.CANARD_API_URL = `http://localhost:${API_PORT}`;

const api = spawn(process.env.PYTHON || 'python3', ['-m', 'uvicorn', 'app.main:app', '--port', String(API_PORT)], {
  cwd: path.join(root, 'server'),
  env: {
    ...process.env,
    CANARD_STORE: 'local',
    CANARD_LOCAL_ROOT: path.join(dataRoot, 'data'),
    CANARD_ADMIN_PASSWORD: 'admin-pw',
    CANARD_TAG_PASSWORD: 'tag-pw',
    CANARD_SESSION_SECRET: 'e2e',
    CANARD_ALLOWED_ORIGINS: `http://localhost:${SITE_PORT}`,
  },
  stdio: 'ignore',
});

const { startDevServer } = await import('../../scripts/dev-server.mjs');
const site = await startDevServer(SITE_PORT);
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const step = (s) => console.log(`- ${s}`);

try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://localhost:${API_PORT}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (process.env.CANARD_E2E_ASSETS) {
    const mirror = process.env.CANARD_E2E_ASSETS.replace(/\/$/, '');
    await context.route(/^https:\/\/(cdn\.jsdelivr\.net|huggingface\.co)\//, (route) => {
      const url = new URL(route.request().url());
      route.fulfill({ status: 302, headers: { location: url.hostname === 'huggingface.co' ? `${mirror}/hf${url.pathname}` : `${mirror}${url.pathname}` } });
    });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${SITE_PORT}/`);
  await page.waitForSelector('#empty-state:not([hidden])');

  step('upload the example spreadsheet to a new plot');
  await page.click('#btn-upload');
  await page.fill('#new-name', 'End-to-end');
  await page.setInputFiles('#upload-file', path.join(root, 'site/example.csv'));
  await page.waitForSelector('.callout-ok');
  await page.fill('#upload-password', 'admin-pw');
  await page.click('#dlg-upload button[type=submit]');
  await page.waitForSelector('#dlg-upload:not([open])', { state: 'attached', timeout: 600000 });
  await page.waitForSelector('#entry-list li');
  assert.match(await page.locator('#match-count').innerText(), /all 35 entries/);

  step('switch between the four views');
  for (const m of ['tsne', 'gauss', 'pca', 'umap']) {
    await page.click(`#method-switch [data-method="${m}"]`);
    assert.equal(await page.locator(`#method-switch [data-method="${m}"]`).getAttribute('aria-checked'), 'true');
  }

  step('lasso a group of points');
  await page.click('[data-tool="lasso"]');
  const box = await page.locator('#scatter').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  for (const [x, y] of [[box.x + box.width - 5, box.y + 5], [box.x + box.width - 5, box.y + box.height - 5], [box.x + 5, box.y + box.height - 5]]) {
    await page.mouse.move(x, y, { steps: 4 });
  }
  await page.mouse.up();
  assert.match(await page.locator('#selection-count').innerText(), /35 entries selected/);

  step('unlock tagging and tag the selection');
  await page.click('#details-body button:has-text("Unlock tagging")');
  await page.fill('#unlock-password', 'tag-pw');
  await page.click('#dlg-unlock button[type=submit]');
  await page.waitForSelector('#dlg-unlock:not([open])', { state: 'attached' });
  await page.fill('.tag-add input', 'Reviewed');
  await page.click('.tag-add button');
  await page.waitForFunction(() => document.querySelector('#filter-tags')?.textContent.includes('Reviewed'));

  step('reload: tags persist and the session is kept');
  await page.reload();
  await page.waitForSelector('#entry-list li');
  await page.waitForFunction(() => document.querySelector('#filter-tags')?.textContent.includes('Reviewed'));
  assert.match(await page.locator('#btn-tagging').innerText(), /unlocked/);

  step('delete the spreadsheet');
  await page.click('#btn-manage');
  await page.click('#dlg-manage .sheet button:has-text("Delete")');
  await page.fill('#dlg-manage .confirm-form input', 'admin-pw');
  await page.click('#dlg-manage .confirm-form button[type=submit]');
  await page.waitForSelector('#dlg-manage .empty-note');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#empty-state:not([hidden])');

  assert.deepEqual(errors, []);
  console.log('End-to-end flow passed.');
} finally {
  await browser.close();
  site.close();
  api.kill();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
