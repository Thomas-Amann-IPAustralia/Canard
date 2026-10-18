// End-to-end check of the whole workflow in a real browser: upload, views, clusters,
// lasso, tagging, reload, recalculating clusters, deletion and document uploads. It starts the API (with a local data folder) and the
// static site itself.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/e2e/upload-flow.mjs
//
// Needs Python with server/requirements.txt installed. The embedding model is
// downloaded from Hugging Face on the first run. CANARD_E2E_ASSETS can point at a
// local mirror of jsDelivr and Hugging Face (paths /npm/... and /hf/...). Set
// CANARD_LLM_API_KEY (and optionally CANARD_LLM_PROVIDER/MODEL) to also test AI refinement.
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

  step('topic clusters and the growth territories view');
  await page.click('#method-switch [data-method="territory"]');
  assert.equal(await page.locator('#method-switch [data-method="territory"]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#colour-by').inputValue(), 'territory');
  // Only territories that some entry is nearest to are listed.
  const territories = await page.locator('#filter-territory .check').count();
  assert.ok(territories >= 1 && territories <= 5, `${territories} territories listed`);
  await page.click('#method-switch [data-method="umap"]');
  await page.selectOption('#colour-by', 'topic');
  assert.ok(await page.locator('#filter-topic .check').count() >= 1);
  await page.click('#entry-list li button');
  await page.waitForSelector('#details-body .similarity-list li:nth-child(5)');
  await page.click('#btn-close-details');

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

  step('recalculate the clusters');
  await page.click('#btn-manage');
  await page.click('#dlg-manage button:has-text("Recalculate clusters")');
  await page.fill('#dlg-manage .clusters-zone input', 'admin-pw');
  await page.click('#dlg-manage .clusters-zone button[type=submit]');
  await page.waitForSelector('.toast:has-text("Recalculated the clusters")', { timeout: 600000 });

  step('delete the spreadsheet');
  await page.click('#dlg-manage .sheet button:has-text("Delete")');
  await page.fill('#dlg-manage .confirm-form input', 'admin-pw');
  await page.click('#dlg-manage .confirm-form button[type=submit]');
  await page.waitForSelector('#dlg-manage .empty-note');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#empty-state:not([hidden])');

  step('upload documents (Markdown, Word and PDF) to the same plot');
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canard-docs-'));
  const notes = fs.readFileSync(path.join(root, 'tests/fixtures/documents/ip-policy-notes.md'), 'utf8');
  const { docx } = await import('../js/helpers.mjs');
  const sections = notes.split('\n').filter(Boolean).map((line) => (line.startsWith('## ') ? ['Heading1', line.slice(3)] : line.startsWith('# ') ? ['Title', line.slice(2)] : ['', line]));
  fs.writeFileSync(path.join(docsDir, 'notes.docx'), await docx(sections, { title: 'Notes in Word' }));
  const printer = await context.newPage();
  await printer.setContent(`<h1>Printed notes</h1>${notes.split('\n').filter((l) => l && !l.startsWith('# ')).map((l) => (l.startsWith('## ') ? `<h2>${l.slice(3)}</h2>` : `<p>${l}</p>`)).join('')}`);
  fs.writeFileSync(path.join(docsDir, 'notes.pdf'), await printer.pdf({ format: 'A4' }));
  await printer.close();
  await page.click('.empty-actions button');
  await page.setInputFiles('#upload-file', [path.join(root, 'tests/fixtures/documents/ip-policy-notes.md'), path.join(docsDir, 'notes.docx'), path.join(docsDir, 'notes.pdf')]);
  await page.waitForSelector('#dlg-upload .callout-ok', { timeout: 600000 });
  assert.equal(await page.locator('#dlg-upload .doc-card[data-status="ready"]').count(), 3);
  const pdfCard = page.locator('#dlg-upload .doc-card').nth(2);
  await pdfCard.locator('input[type=url]').fill('https://example.com/notes.pdf');
  if (await page.locator('#upload-refine').isVisible()) {
    step('…refining the chunks with AI');
    await page.check('#upload-refine');
  }
  await page.fill('#upload-password', 'admin-pw');
  await page.click('#dlg-upload button[type=submit]');
  await page.waitForSelector('#dlg-upload:not([open])', { state: 'attached', timeout: 600000 });
  await page.waitForSelector('#entry-list li');
  const count = Number((await page.locator('#match-count').innerText()).match(/(\d+) entries/)[1]);
  assert.ok(count >= 6, `expected at least 6 chunks, got ${count}`);
  await page.locator('#entry-list li button').first().click();
  await page.waitForSelector('#details-body dt:has-text("Document")');
  const link = await page.locator('#details-body .source-link').count();
  const docName = await page.locator('#details-body dt:has-text("Document") + dd').innerText();
  assert.equal(link, docName.startsWith('notes.pdf') ? 1 : 0, 'only the PDF has a source link');
  await page.click('#btn-close-details');

  step('delete one document');
  await page.click('#btn-manage');
  await page.waitForSelector('#dlg-manage .sheet');
  assert.equal(await page.locator('#dlg-manage .sheet').count(), 3);
  await page.click('#dlg-manage .sheet:has-text("notes.docx") button:has-text("Delete")');
  await page.fill('#dlg-manage .confirm-form input', 'admin-pw');
  await page.click('#dlg-manage .confirm-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#dlg-manage .sheet').length === 2);
  await page.keyboard.press('Escape');
  fs.rmSync(docsDir, { recursive: true, force: true });

  assert.deepEqual(errors, []);
  console.log('End-to-end flow passed.');
} finally {
  await browser.close();
  site.close();
  api.kill();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
