// The upload dialog: validate a CSV instantly in the browser, embed it, compute every
// layout, then hand the result to the server, which checks it again and commits it.
import { decodeCsvBytes, validateCsvText, checkTokenLimits, CsvProblem } from './csv.js';
import { loadTokenCounter } from './tokenizer.js';
import { EMBEDDING, LIMITS } from './schema.js';
import { request, wake, keepAlive, ApiError, apiStatus } from './api.js';
import { loadModel, embedEntries, stopEmbedding } from './embedder.js';
import { computeLayoutsInWorkers } from './layout-runner.js';
import { loadPlot, loadVectors, noteVersion } from './data.js';
import { $, el, icon, plural, formatBytes, formatDate, problemList, toast } from './ui.js';

const STEPS = [
  { key: 'password', label: 'Checking the password' },
  { key: 'model', label: 'Loading the embedding model' },
  { key: 'embed', label: 'Embedding the entries' },
  { key: 'existing', label: 'Fetching the plot’s existing entries' },
  { key: 'layout', label: 'Calculating the t-SNE, UMAP, Gaussian and PCA layouts' },
  { key: 'save', label: 'Saving to the GitHub repository' },
];

export function openUpload(app) {
  const dlg = $('#dlg-upload');
  const plots = app.state.index.plots;
  const current = app.state.plot;
  wake().catch(() => {});
  loadTokenCounter().catch(() => {});
  keepAlive('upload', true);

  let parsed = null; // { rows, warnings, filename, text }
  let busy = false;
  let controller = null;
  let cachedVectors = null; // embeddings survive a retry after a conflict

  const destExisting = el('input', { type: 'radio', name: 'dest', value: 'existing', id: 'dest-existing', checked: plots.length > 0, disabled: plots.length === 0 });
  const destNew = el('input', { type: 'radio', name: 'dest', value: 'new', id: 'dest-new', checked: plots.length === 0 });
  const plotSelect = el('select', { id: 'dest-plot', 'aria-label': 'Existing plot' },
    plots.map((p) => el('option', { value: p.id, selected: current && p.id === current.id, text: `${p.name} (${plural(p.points, 'entry', 'entries')})` })));
  const nameInput = el('input', { type: 'text', id: 'new-name', maxlength: String(LIMITS.maxPlotNameLength), placeholder: 'For example: Patent policy reading list' });
  const descInput = el('textarea', { id: 'new-desc', rows: '2', maxlength: String(LIMITS.maxPlotDescriptionLength), placeholder: 'Optional' });
  const fileInput = el('input', { type: 'file', id: 'upload-file', accept: '.csv,text/csv', class: 'visually-hidden' });
  const fileLabel = el('span', { class: 'dropzone-file', text: 'No file chosen' });
  const dropzone = el('label', { class: 'dropzone', for: 'upload-file' },
    icon('upload'), el('span', {}, el('strong', { text: 'Choose a CSV file' }), ' or drag it here'), fileLabel);
  const check = el('div', { class: 'upload-check', 'aria-live': 'polite' });
  const password = el('input', { type: 'password', id: 'upload-password', autocomplete: 'current-password' });
  const progress = el('ol', { class: 'steps', hidden: true });
  const status = el('div', { class: 'form-status', role: 'status' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Upload and map entries', disabled: true });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });

  const newFields = el('div', { class: 'new-plot-fields' },
    el('label', { for: 'new-name', text: 'Name of the new plot' }), nameInput,
    el('label', { for: 'new-desc', text: 'Description' }), descInput);

  const form = el('form', { class: 'form upload-form', novalidate: true },
    el('h2', { id: 'dlg-upload-title', text: 'Upload a spreadsheet' }),
    el('p', { class: 'lead' },
      'Each row becomes a point on the plot. The file must be a CSV with five columns, in this order: ',
      el('strong', { text: 'Title, Summary, Source link, Publication Date, Source type' }), '. ',
      el('a', { href: 'template.csv', download: 'canard-template.csv', text: 'Download the template' }), ' or ',
      el('a', { href: 'example.csv', download: 'canard-example.csv', text: 'an example' }), '.'),
    el('fieldset', { class: 'dest' },
      el('legend', { text: 'Where should the entries go?' }),
      el('div', { class: 'radio-row' }, destExisting, el('label', { for: 'dest-existing', text: 'Add to an existing plot' }), plotSelect),
      el('div', { class: 'radio-row' }, destNew, el('label', { for: 'dest-new', text: 'Create a new plot' })),
      newFields),
    dropzone, fileInput, check,
    el('div', { class: 'password-row' },
      el('label', { for: 'upload-password', text: 'Upload password' }), password,
      el('p', { class: 'field-hint', text: 'Needed for every upload or deletion.' })),
    progress, status,
    el('div', { class: 'dialog-actions' }, cancel, submit));

  const destination = () => (destNew.checked ? 'new' : 'existing');
  const syncDest = () => {
    newFields.hidden = destination() !== 'new';
    plotSelect.disabled = destination() !== 'existing';
    if (parsed) recheckCapacity();
    updateSubmit();
  };
  const updateSubmit = () => {
    const destOk = destination() === 'new' ? nameInput.value.trim().length > 0 : Boolean(plotSelect.value);
    submit.disabled = busy || !parsed?.ok || !password.value || !destOk;
  };

  function showProblems(title, problems, filename) {
    check.replaceChildren(el('div', { class: 'callout callout-error' },
      el('h3', {}, icon('alert'), el('span', { text: title })),
      el('p', { text: `${filename} was not accepted. Fix the ${problems.length === 1 ? 'problem' : 'problems'} below in your spreadsheet, save it as CSV and choose it again.` }),
      problemList(problems)));
  }

  function targetPlotEntry() {
    return destination() === 'existing' ? plots.find((p) => p.id === plotSelect.value) : null;
  }

  function recheckCapacity() {
    const target = targetPlotEntry();
    const existing = target ? target.points : 0;
    if (parsed.rows && existing + parsed.rows.length > LIMITS.maxPointsPerPlot) {
      parsed.ok = false;
      showProblems('Upload denied: the plot would be too large', [new CsvProblem('PLOT_TOO_LARGE',
        `This plot already has ${existing} entries and the file adds ${parsed.rows.length}. A plot can hold at most ${LIMITS.maxPointsPerPlot} entries; create a new plot instead.`)], parsed.filename);
    } else if (parsed.rows && parsed.tokensOk) {
      parsed.ok = true;
      showReady();
    }
    updateSubmit();
  }

  function showReady() {
    const { rows, warnings, filename } = parsed;
    const extra = [...warnings];
    const target = destination() === 'existing' && app.state.plot && app.state.plot.id === plotSelect.value ? app.state : null;
    if (target) {
      const seen = new Map(target.points.map((p) => [`${p.title.toLowerCase()}\u0000${p.link.toLowerCase()}`, p]));
      for (const r of rows) {
        if (seen.has(`${r.title.toLowerCase()}\u0000${r.link.toLowerCase()}`)) {
          extra.push(new CsvProblem('ALREADY_IN_PLOT', `Row ${r.row} is already in this plot (same title and source link). It will be added again.`, r.row));
        }
      }
    }
    const types = new Map();
    for (const r of rows) types.set(r.sourceType, (types.get(r.sourceType) || 0) + 1);
    const preview = el('table', { class: 'preview' },
      el('thead', {}, el('tr', {}, ['Row', 'Title', 'Published', 'Source type'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, rows.slice(0, 5).map((r) => el('tr', {},
        el('td', { text: String(r.row) }), el('td', { text: r.title }), el('td', { text: formatDate(r.date) }), el('td', { text: r.sourceType })))));
    check.replaceChildren(el('div', { class: 'callout callout-ok' },
      el('h3', {}, icon('check'), el('span', { text: `${plural(rows.length, 'entry', 'entries')} ready to upload` })),
      el('p', { text: `${filename} · ${[...types.entries()].map(([t, c]) => `${c} ${t}`).join(', ')}` }),
      preview,
      rows.length > 5 ? el('p', { class: 'field-hint', text: `…and ${rows.length - 5} more.` }) : null),
    ...(extra.length ? [el('div', { class: 'callout callout-warn' },
      el('h3', {}, icon('alert'), el('span', { text: 'Please check' })), problemList(extra))] : []));
  }

  async function onFile(file) {
    cachedVectors = null;
    parsed = null;
    updateSubmit();
    if (!file) return;
    fileLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
    check.replaceChildren(el('p', { class: 'checking', text: 'Checking the file…' }));
    if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) {
      parsed = { ok: false };
      showProblems('Upload denied: not a CSV file', [new CsvProblem('NOT_CSV',
        `"${file.name}" is not a .csv file. In Excel, choose File > Save As and pick "CSV UTF-8 (Comma delimited)".`)], file.name);
      return;
    }
    const decoded = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
    if (decoded.errors.length) {
      parsed = { ok: false };
      showProblems('Upload denied', decoded.errors, file.name);
      return;
    }
    const result = validateCsvText(decoded.text);
    if (result.errors.length) {
      parsed = { ok: false };
      showProblems(`Upload denied: ${plural(result.errors.length, 'problem')} found`, result.errors, file.name);
      return;
    }
    let counter;
    try {
      counter = await loadTokenCounter();
    } catch {
      parsed = { ok: false };
      check.replaceChildren(el('p', { class: 'form-status error', text: 'Could not load the tokenizer to check entry lengths. Check your connection and choose the file again.' }));
      return;
    }
    const tokenErrors = checkTokenLimits(result.rows, counter, EMBEDDING.maxTokens);
    if (tokenErrors.length) {
      parsed = { ok: false };
      showProblems(`Upload denied: ${plural(tokenErrors.length, 'entry', 'entries')} too long for the embedding model`, tokenErrors, file.name);
      return;
    }
    parsed = { ok: true, tokensOk: true, rows: result.rows, warnings: [...decoded.warnings, ...result.warnings], filename: file.name, text: decoded.text };
    recheckCapacity();
    // The file is valid, so start fetching the model now to save time later.
    loadModel().catch(() => {});
  }

  function setStep(key, state, detail = '') {
    const li = progress.querySelector(`[data-step="${key}"]`);
    if (!li) return;
    li.dataset.state = state;
    li.querySelector('.step-detail').textContent = detail;
  }

  function resetSteps(includeExisting) {
    progress.replaceChildren(...STEPS.filter((s) => includeExisting || s.key !== 'existing').map((s) => el('li', { dataset: { step: s.key, state: 'waiting' } },
      el('span', { class: 'step-icon', 'aria-hidden': 'true' }), el('span', { class: 'step-label', text: s.label }), el('span', { class: 'step-detail' }))));
    progress.hidden = false;
  }

  async function run() {
    busy = true;
    updateSubmit();
    status.textContent = '';
    status.className = 'form-status';
    controller = new AbortController();
    const { signal } = controller;
    const dest = destination();
    const plotId = dest === 'existing' ? plotSelect.value : null;
    resetSteps(dest === 'existing');
    [destExisting, destNew, plotSelect, nameInput, descInput, fileInput, password].forEach((x) => { x.disabled = true; });

    // The password check also wakes the server, so run it alongside the embedding.
    setStep('password', 'active', apiStatus() === 'ready' ? '' : 'Waking the server (up to a minute)…');
    const passwordCheck = request('/api/auth/check', { method: 'POST', body: { password: password.value }, signal })
      .then(() => setStep('password', 'done'))
      .catch((err) => { setStep('password', 'error'); controller.abort(); throw err; });
    passwordCheck.catch(() => {});

    // Fails as soon as the password is rejected, so nothing waits on a doomed upload.
    const passwordFailure = passwordCheck.then(() => new Promise(() => {}));
    passwordFailure.catch(() => {});

    try {
      if (!cachedVectors) {
        // Embedding keeps running if the password is wrong, so a retry can reuse it.
        cachedVectors = (async () => {
          setStep('model', 'active');
          await loadModel((loaded, total) => setStep('model', 'active', total ? `${formatBytes(loaded)} of ${formatBytes(total)} (only downloaded once)` : ''));
          setStep('model', 'done');
          setStep('embed', 'active', `0 of ${parsed.rows.length}`);
          return embedEntries(parsed.rows, { onProgress: (done, total) => setStep('embed', 'active', `${done} of ${total}`) });
        })();
        cachedVectors.catch(() => { cachedVectors = null; });
      } else {
        setStep('model', 'done');
        setStep('embed', 'active');
      }
      const vectors = await Promise.race([cachedVectors, passwordFailure]);
      setStep('embed', 'done');
      await Promise.race([passwordCheck, passwordFailure]);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      // Existing entries come from the latest committed version of the plot.
      let base = { ids: [], coords: null, vectors: [] };
      if (plotId) {
        setStep('existing', 'active');
        const fresh = await loadPlot(plotId, { source: 'api' });
        if (!fresh) throw new ApiError(404, 'PLOT_NOT_FOUND', 'That plot no longer exists.');
        const vecMap = await loadVectors(fresh.plot, { onProgress: (f) => setStep('existing', 'active', `${Math.round(f * 100)}%`) });
        const ids = fresh.points.points.map((p) => p.id);
        const missing = ids.filter((id) => !vecMap.has(id));
        if (missing.length) throw new Error(`Stored vectors are missing for ${missing.length} existing entries.`);
        base = { ids, coords: fresh.points.coords, vectors: ids.map((id) => vecMap.get(id)) };
        setStep('existing', 'done', plural(ids.length, 'entry', 'entries'));
      }

      setStep('layout', 'active');
      const n = base.ids.length + parsed.rows.length;
      const dim = EMBEDDING.dim;
      const all = new Float32Array(n * dim);
      base.vectors.forEach((v, i) => all.set(v, i * dim));
      all.set(vectors, base.ids.length * dim);
      const newIds = parsed.rows.map((r) => `new-${r.row}`);
      const started = performance.now();
      const layout = await computeLayoutsInWorkers(all, n, dim, {
        ids: [...base.ids, ...newIds],
        previous: base.coords ? { ids: base.ids, coords: base.coords } : null,
        signal,
        onProgress: (f, label) => setStep('layout', 'active', `${label} · ${Math.round(f * 100)}%`),
      });
      setStep('layout', 'done', `${((performance.now() - started) / 1000).toFixed(1)} s`);

      setStep('save', 'active', 'Committing to GitHub…');
      const round6 = (x) => Math.round(x * 1e6) / 1e6;
      const body = {
        password: password.value,
        filename: parsed.filename,
        csv: parsed.text,
        vectors: parsed.rows.map((_, i) => Array.from(vectors.subarray(i * dim, (i + 1) * dim), round6)),
        baseIds: base.ids,
        coords: Object.fromEntries(Object.entries(layout.coords).map(([k, v]) => [k, Array.from(v)])),
        layoutParams: layout.params,
        embedding: { model: EMBEDDING.model, dtype: EMBEDDING.dtype, pooling: EMBEDDING.pooling, normalize: EMBEDDING.normalize, dim },
        ...(plotId ? { plotId } : { newPlot: { name: nameInput.value.trim(), description: descInput.value.trim() } }),
      };
      const out = await request('/api/upload', { method: 'POST', body, timeout: 180000 });
      setStep('save', 'done');
      noteVersion(out.plot.id, out.plot.version);
      busy = false;
      dlg.close('done');
      app.applyServerUpdate(out, { selectPlot: true, animate: Boolean(plotId) });
      toast(`Added ${plural(parsed.rows.length, 'entry', 'entries')} to “${out.plot.name}”. GitHub Pages will publish the change within a few minutes; you can keep working.`, { kind: 'success', timeout: 8000 });
    } catch (err) {
      busy = false;
      const passwordProblem = err instanceof ApiError && ['WRONG_PASSWORD', 'TOO_MANY_ATTEMPTS', 'READ_ONLY'].includes(err.code);
      for (const li of progress.querySelectorAll('[data-state="active"]')) li.dataset.state = passwordProblem ? 'waiting' : 'error';
      [destExisting, destNew, plotSelect, nameInput, descInput, fileInput, password].forEach((x) => { x.disabled = false; });
      if (plots.length === 0) destExisting.disabled = true;
      syncDest();
      status.className = 'form-status error';
      if (err?.name === 'AbortError' && !(err instanceof ApiError)) {
        status.textContent = '';
      } else if (err instanceof ApiError && err.problems) {
        status.textContent = '';
        showProblems('The server rejected the spreadsheet', err.problems, parsed.filename);
      } else if (err instanceof ApiError && err.code === 'WRONG_PASSWORD') {
        status.textContent = 'That password is not correct. Nothing was uploaded.';
        password.select();
      } else if (err instanceof ApiError && err.code === 'PLOT_CHANGED') {
        status.textContent = `${err.message} Your file is still selected, so choose “Upload” again.`;
      } else {
        status.textContent = err?.message || 'Something went wrong. Nothing was uploaded.';
      }
      updateSubmit();
    }
  }

  destExisting.addEventListener('change', syncDest);
  destNew.addEventListener('change', syncDest);
  plotSelect.addEventListener('change', syncDest);
  nameInput.addEventListener('input', updateSubmit);
  password.addEventListener('input', updateSubmit);
  fileInput.addEventListener('change', () => onFile(fileInput.files[0]));
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    if (!busy && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!submit.disabled) run();
  });
  cancel.addEventListener('click', () => {
    if (busy) {
      controller?.abort();
      stopEmbedding();
      cachedVectors = null;
    }
    dlg.close('cancel');
  });
  dlg.oncancel = (e) => {
    // Escape during the final save would leave the outcome unclear, so wait for it.
    if (busy && progress.querySelector('[data-step="save"][data-state="active"]')) e.preventDefault();
    else if (busy) { controller?.abort(); stopEmbedding(); }
  };
  dlg.onclose = () => keepAlive('upload', false);

  syncDest();
  dlg.replaceChildren(form);
  dlg.showModal();
}
