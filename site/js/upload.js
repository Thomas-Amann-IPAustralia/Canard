// The upload dialog. A spreadsheet is validated instantly in the browser; documents
// (PDF, Word, Markdown, text) are read, embedded paragraph by paragraph and split into
// chunks, each of which becomes an entry. Either way the entries are embedded, every
// layout is computed, and the result goes to the server, which checks it again and
// commits it.
import { decodeCsvBytes, validateCsvText, checkTokenLimits, checkUrl, parseDate, CsvProblem } from './csv.js';
import { loadTokenCounter } from './tokenizer.js';
import { EMBEDDING, LIMITS } from './schema.js';
import { request, wake, keepAlive, ApiError, apiStatus, apiHealth, onStatus } from './api.js';
import { loadModel, embedEntries, stopEmbedding } from './embedder.js';
import { computeLayoutsInWorkers } from './layout-runner.js';
import { loadTerritoryCentroids, clusterPayload } from './cluster-data.js';
import { loadPlot, loadVectors, noteVersion } from './data.js';
import { DOCUMENT_ACCEPT, fileKind, prepareDocument, refineDocument, documentSheet } from './documents/index.js';
import { $, el, icon, plural, formatBytes, formatDate, problemList, toast, debounce } from './ui.js';

const STEPS = [
  { key: 'password', label: 'Checking the password' },
  { key: 'refine', label: 'Refining the chunks with AI' },
  { key: 'model', label: 'Loading the embedding model' },
  { key: 'embed', label: 'Embedding the entries' },
  { key: 'existing', label: 'Fetching the plot’s existing entries' },
  { key: 'layout', label: 'Calculating the layouts, topic clusters and growth territories' },
  { key: 'save', label: 'Saving to the GitHub repository' },
];

const PASSWORD_CODES = ['WRONG_PASSWORD', 'TOO_MANY_ATTEMPTS', 'READ_ONLY'];

export function openUpload(app) {
  const dlg = $('#dlg-upload');
  const plots = app.state.index.plots;
  const current = app.state.plot;
  wake().catch(() => {});
  loadTokenCounter().catch(() => {});
  keepAlive('upload', true);

  let mode = null; // 'csv' | 'documents'
  let parsed = null; // CSV: { ok, tokensOk, rows, warnings, filename, text }
  let docs = []; // documents: [{ file, status, doc, error, fields, card }]
  let generation = 0; // ignores documents still being prepared after new files are chosen
  let busy = false;
  let controller = null;
  let cachedEmbedding = null; // { sheets, vectors } survives a retry after a conflict

  const destExisting = el('input', { type: 'radio', name: 'dest', value: 'existing', id: 'dest-existing', checked: plots.length > 0, disabled: plots.length === 0 });
  const destNew = el('input', { type: 'radio', name: 'dest', value: 'new', id: 'dest-new', checked: plots.length === 0 });
  const plotSelect = el('select', { id: 'dest-plot', 'aria-label': 'Existing plot' },
    plots.map((p) => el('option', { value: p.id, selected: current && p.id === current.id, text: `${p.name} (${plural(p.points, 'entry', 'entries')})` })));
  const nameInput = el('input', { type: 'text', id: 'new-name', maxlength: String(LIMITS.maxPlotNameLength), placeholder: 'For example: Patent policy reading list' });
  const descInput = el('textarea', { id: 'new-desc', rows: '2', maxlength: String(LIMITS.maxPlotDescriptionLength), placeholder: 'Optional' });
  const fileInput = el('input', { type: 'file', id: 'upload-file', accept: `.csv,text/csv,${DOCUMENT_ACCEPT}`, multiple: true, class: 'visually-hidden' });
  const fileLabel = el('span', { class: 'dropzone-file', text: 'No file chosen' });
  const dropzone = el('label', { class: 'dropzone', for: 'upload-file' },
    icon('upload'), el('span', {}, el('strong', { text: 'Choose a spreadsheet or documents' }), ' or drag them here'), fileLabel);
  const check = el('div', { class: 'upload-check', 'aria-live': 'polite' });
  const docList = el('div', { class: 'doc-list' });
  const refineBox = el('input', { type: 'checkbox', id: 'upload-refine' });
  const refineRow = el('div', { class: 'refine-row', hidden: true },
    el('div', { class: 'checkbox-row' }, refineBox, el('label', { for: 'upload-refine', text: 'Refine the chunks with AI' })),
    el('p', { class: 'field-hint', text: 'Sends the documents’ text to the AI service set up on the server, which chooses where each chunk starts and ends and writes its title. The text itself is not changed. This adds a minute or so per document.' }));
  const password = el('input', { type: 'password', id: 'upload-password', autocomplete: 'current-password' });
  const progress = el('ol', { class: 'steps', hidden: true });
  const status = el('div', { class: 'form-status', role: 'status' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Upload and map entries', disabled: true });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });

  const newFields = el('div', { class: 'new-plot-fields' },
    el('label', { for: 'new-name', text: 'Name of the new plot' }), nameInput,
    el('label', { for: 'new-desc', text: 'Description' }), descInput);

  const knownTypes = [...new Set((app.state.points || []).map((p) => p.sourceType))].sort();
  const typeList = el('datalist', { id: 'upload-source-types' }, ['Document', ...knownTypes.filter((t) => t !== 'Document')].map((t) => el('option', { value: t })));

  const form = el('form', { class: 'form upload-form', novalidate: true },
    el('h2', { id: 'dlg-upload-title', text: 'Upload a spreadsheet or documents' }),
    el('p', { class: 'lead' },
      el('strong', { text: 'Spreadsheet: ' }), 'each row becomes a point. Use a CSV with five columns, in this order: Title, Summary, Source link (optional), Publication Date, Source type. ',
      el('a', { href: 'template.csv', download: 'canard-template.csv', text: 'Download the template' }), ' or ',
      el('a', { href: 'example.csv', download: 'canard-example.csv', text: 'an example' }), '.'),
    el('p', { class: 'lead' },
      el('strong', { text: 'Documents: ' }), 'PDF, Word (.docx), Markdown or text files are split into passages by meaning, and each passage becomes a point. You can upload several at once. Their text is stored in the public GitHub repository.'),
    el('fieldset', { class: 'dest' },
      el('legend', { text: 'Where should the entries go?' }),
      el('div', { class: 'radio-row' }, destExisting, el('label', { for: 'dest-existing', text: 'Add to an existing plot' }), plotSelect),
      el('div', { class: 'radio-row' }, destNew, el('label', { for: 'dest-new', text: 'Create a new plot' })),
      newFields),
    dropzone, fileInput, check, docList, typeList, refineRow,
    el('div', { class: 'password-row' },
      el('label', { for: 'upload-password', text: 'Upload password' }), password,
      el('p', { class: 'field-hint', text: 'Needed for every upload or deletion.' })),
    progress, status,
    el('div', { class: 'dialog-actions' }, cancel, submit));

  const destination = () => (destNew.checked ? 'new' : 'existing');
  const syncDest = () => {
    newFields.hidden = destination() !== 'new';
    plotSelect.disabled = destination() !== 'existing';
    if (mode === 'csv' && parsed) recheckCapacity();
    if (mode === 'documents') showDocumentSummary();
    updateSubmit();
  };
  const updateSubmit = () => {
    const destOk = destination() === 'new' ? nameInput.value.trim().length > 0 : Boolean(plotSelect.value);
    const fileOk = mode === 'csv' ? Boolean(parsed?.ok) : mode === 'documents' && documentsReady();
    submit.disabled = busy || !fileOk || !password.value || !destOk;
  };
  const invalidate = () => { cachedEmbedding = null; };

  function showProblems(title, problems, filename, hint = 'in your spreadsheet, save it as CSV and choose it again') {
    check.replaceChildren(el('div', { class: 'callout callout-error' },
      el('h3', {}, icon('alert'), el('span', { text: title })),
      el('p', { text: `${filename} was not accepted. Fix the ${problems.length === 1 ? 'problem' : 'problems'} below ${hint}.` }),
      problemList(problems)));
  }

  function targetPlotEntry() {
    return destination() === 'existing' ? plots.find((p) => p.id === plotSelect.value) : null;
  }

  function capacityProblem(adding) {
    const target = targetPlotEntry();
    const existing = target ? target.points : 0;
    if (existing + adding <= LIMITS.maxPointsPerPlot) return null;
    return new CsvProblem('PLOT_TOO_LARGE',
      `This plot already has ${existing} entries and the upload adds ${adding}. A plot can hold at most ${LIMITS.maxPointsPerPlot} entries; create a new plot instead.`);
  }

  // ---- Spreadsheets -------------------------------------------------------------

  function recheckCapacity() {
    const problem = parsed.rows ? capacityProblem(parsed.rows.length) : null;
    if (problem) {
      parsed.ok = false;
      showProblems('Upload denied: the plot would be too large', [problem], parsed.filename);
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

  async function onCsvFile(file) {
    mode = 'csv';
    check.replaceChildren(el('p', { class: 'checking', text: 'Checking the file…' }));
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

  // ---- Documents ----------------------------------------------------------------

  function metaOf(entry) {
    const f = entry.fields;
    return { title: f.title.value.trim(), date: f.date.value, sourceType: f.type.value.trim().replace(/\s+/g, ' '), link: f.link.value.trim() };
  }

  /** Problems with a document's details, keyed by field. */
  function fieldProblems(entry) {
    const meta = metaOf(entry);
    const out = {};
    if (!meta.title) out.title = 'Give the document a title.';
    const date = parseDate(meta.date || '');
    if (date.error) out.date = 'Choose the publication date.';
    if (!meta.sourceType) out.type = 'Give a source type, such as "Report".';
    else if (Array.from(meta.sourceType).length > LIMITS.maxSourceTypeLength) out.type = `Keep the source type to ${LIMITS.maxSourceTypeLength} characters.`;
    if (meta.link) {
      const reason = checkUrl(meta.link);
      if (reason) out.link = `The link ${reason}.`;
    }
    return out;
  }

  function totalChunks() {
    return docs.reduce((s, d) => s + (d.doc ? d.doc.chunks.length : 0), 0);
  }

  function documentsReady() {
    if (!docs.length || docs.some((d) => d.status !== 'ready')) return false;
    if (docs.some((d) => Object.keys(fieldProblems(d)).length)) return false;
    const total = totalChunks();
    return total > 0 && total <= LIMITS.maxRowsPerUpload && !capacityProblem(total);
  }

  function showDocumentSummary() {
    if (mode !== 'documents') return;
    const preparing = docs.filter((d) => d.status === 'waiting' || d.status === 'preparing').length;
    const failed = docs.filter((d) => d.status === 'error').length;
    const total = totalChunks();
    if (preparing) {
      check.replaceChildren(el('p', { class: 'checking', text: `Splitting ${plural(docs.length, 'document')} into chunks… This loads the embedding model (about 128 MB, downloaded only once).` }));
    } else if (failed) {
      check.replaceChildren(el('div', { class: 'callout callout-error' },
        el('h3', {}, icon('alert'), el('span', { text: `${plural(failed, 'document')} could not be read` })),
        el('p', { text: 'Remove it (×) or choose the files again.' })));
    } else if (total > LIMITS.maxRowsPerUpload) {
      check.replaceChildren(el('div', { class: 'callout callout-error' },
        el('h3', {}, icon('alert'), el('span', { text: 'Too many chunks for one upload' })),
        el('p', { text: `These documents make ${total} chunks; at most ${LIMITS.maxRowsPerUpload} can be uploaded at once. Upload fewer documents at a time.` })));
    } else if (capacityProblem(total)) {
      check.replaceChildren(el('div', { class: 'callout callout-error' },
        el('h3', {}, icon('alert'), el('span', { text: 'Upload denied: the plot would be too large' })),
        el('p', { text: capacityProblem(total).message })));
    } else if (docs.length) {
      check.replaceChildren(el('div', { class: 'callout callout-ok' },
        el('h3', {}, icon('check'), el('span', { text: `${plural(total, 'chunk')} from ${plural(docs.length, 'document')} ready to upload` })),
        el('p', { class: 'field-hint', text: 'Check each document’s details below. Its title starts the title of every chunk.' })));
    } else {
      check.replaceChildren();
    }
  }

  function renderPreview(entry) {
    const { doc } = entry;
    const meta = metaOf(entry);
    const sheet = documentSheet(doc, { ...meta, date: meta.date || '2000-01-01', sourceType: meta.sourceType || 'Document', title: meta.title || doc.title }, entry.counter);
    const rows = sheet.rows.length ? sheet.rows : [];
    entry.preview.replaceChildren(
      el('summary', { text: `${plural(doc.chunks.length, 'chunk')}${doc.pages ? ` from ${plural(doc.pages, 'page')}` : ''}${doc.refined ? ' (refined with AI)' : ''} · preview` }),
      el('ol', { class: 'chunk-preview' }, rows.slice(0, 12).map((r, i) => el('li', {},
        el('strong', { text: r.title }),
        el('span', { class: 'entry-meta', text: ` · ${plural(doc.chunks[i].tokens, 'token')}` }),
        el('p', { text: r.summary.length > 280 ? `${r.summary.slice(0, 279)}…` : r.summary })))),
      rows.length > 12 ? el('p', { class: 'field-hint', text: `…and ${rows.length - 12} more.` }) : null);
  }

  function renderCard(entry) {
    const { file } = entry;
    const remove = el('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Remove ${file.name}`, text: '×' });
    remove.addEventListener('click', () => {
      if (busy) return;
      docs = docs.filter((d) => d !== entry);
      entry.card.remove();
      invalidate();
      if (!docs.length) { mode = null; fileLabel.textContent = 'No file chosen'; refineRow.hidden = true; }
      else fileLabel.textContent = plural(docs.length, 'document');
      showDocumentSummary();
      updateSubmit();
    });
    const head = el('div', { class: 'doc-head' },
      el('div', { class: 'sheet-info' }, el('strong', { text: file.name }), el('span', { class: 'entry-meta', text: formatBytes(file.size) })),
      remove);
    const body = [];
    if (entry.status === 'waiting' || entry.status === 'preparing') {
      body.push(el('p', { class: 'checking doc-status', text: entry.stage || 'Waiting…' }));
    } else if (entry.status === 'error') {
      body.push(el('p', { class: 'form-status error', text: entry.error }));
    } else {
      const f = entry.fields;
      const errs = fieldProblems(entry);
      const field = (key, label, input, hint) => el('div', { class: 'doc-field' },
        el('label', { for: input.id, text: label }), input,
        errs[key] ? el('p', { class: 'field-error', text: errs[key] }) : hint ? el('p', { class: 'field-hint', text: hint }) : null);
      body.push(el('div', { class: 'doc-fields' },
        field('title', 'Title', f.title),
        field('date', 'Publication date', f.date),
        field('type', 'Source type', f.type),
        field('link', 'Source link (optional)', f.link, 'Where the original can be read online.')),
      entry.preview);
    }
    const card = el('div', { class: 'doc-card', dataset: { status: entry.status } }, head, ...body);
    if (entry.card) entry.card.replaceWith(card);
    entry.card = card;
    return card;
  }

  function createFields(entry) {
    const id = `doc-${Math.random().toString(36).slice(2, 8)}`;
    const { doc } = entry;
    entry.fields = {
      title: el('input', { type: 'text', id: `${id}-title`, value: doc.title, maxlength: '200' }),
      date: el('input', { type: 'date', id: `${id}-date`, value: doc.date || '' }),
      type: el('input', { type: 'text', id: `${id}-type`, value: 'Document', list: 'upload-source-types', maxlength: String(LIMITS.maxSourceTypeLength) }),
      link: el('input', { type: 'url', id: `${id}-link`, placeholder: 'https://', inputmode: 'url' }),
    };
    entry.preview = el('details', { class: 'chunk-details' });
    const refresh = debounce(() => {
      for (const [key, input] of Object.entries(entry.fields)) {
        const msg = fieldProblems(entry)[key];
        const holder = input.parentElement;
        holder?.querySelector('.field-error')?.remove();
        if (msg) holder?.append(el('p', { class: 'field-error', text: msg }));
        input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      }
      if (entry.preview.open || !entry.previewRendered) renderPreview(entry);
      updateSubmit();
    }, 250);
    for (const input of Object.values(entry.fields)) {
      input.addEventListener('input', () => { invalidate(); updateSubmit(); refresh(); });
    }
    entry.preview.addEventListener('toggle', () => { if (entry.preview.open) renderPreview(entry); });
  }

  async function onDocuments(files) {
    mode = 'documents';
    parsed = null;
    const gen = ++generation;
    docList.replaceChildren();
    docs = files.map((file) => ({ file, status: 'waiting', stage: 'Waiting…' }));
    for (const entry of docs) docList.append(renderCard(entry));
    refineRow.hidden = !apiHealth()?.llm;
    showDocumentSummary();
    let counter;
    try {
      counter = await loadTokenCounter();
    } catch {
      check.replaceChildren(el('p', { class: 'form-status error', text: 'Could not load the tokenizer. Check your connection and choose the files again.' }));
      return;
    }
    for (const entry of [...docs]) {
      if (gen !== generation) return;
      if (!docs.includes(entry)) continue;
      entry.status = 'preparing';
      entry.counter = counter;
      renderCard(entry);
      const line = () => entry.card.querySelector('.doc-status');
      try {
        entry.doc = await prepareDocument(entry.file, counter, {
          onStage: (label, detail) => {
            entry.stage = detail ? `${label}: ${detail}` : `${label}…`;
            if (gen === generation && line()) line().textContent = entry.stage;
          },
          onDownload: (loaded, total) => {
            if (gen === generation && total && line()) line().textContent = `Loading the embedding model: ${formatBytes(loaded)} of ${formatBytes(total)} (only downloaded once)`;
          },
        });
        if (gen !== generation) return;
        entry.status = 'ready';
        createFields(entry);
        renderCard(entry);
        renderPreview(entry);
        entry.previewRendered = true;
      } catch (err) {
        if (gen !== generation) return;
        entry.status = 'error';
        entry.error = err?.message || String(err);
        renderCard(entry);
      }
      showDocumentSummary();
      updateSubmit();
    }
  }

  // ---- Choosing files -----------------------------------------------------------

  async function onFiles(list) {
    const files = [...(list || [])];
    invalidate();
    parsed = null;
    generation += 1;
    docs = [];
    docList.replaceChildren();
    refineRow.hidden = true;
    mode = null;
    updateSubmit();
    if (!files.length) return;
    fileLabel.textContent = files.length === 1 ? `${files[0].name} (${formatBytes(files[0].size)})` : `${files.length} files`;
    check.replaceChildren(el('p', { class: 'checking', text: 'Checking the files…' }));
    const name = files.length === 1 ? files[0].name : `${files.length} files`;
    if (files.length > LIMITS.maxFilesPerUpload) {
      showProblems('Upload denied: too many files', [new CsvProblem('TOO_MANY_FILES', `Choose at most ${LIMITS.maxFilesPerUpload} documents at a time.`)], name, 'and choose the files again');
      return;
    }
    const kinds = await Promise.all(files.map(fileKind));
    const unknown = files.filter((_, i) => !kinds[i]);
    if (unknown.length) {
      showProblems('Upload denied: unsupported file type', unknown.map((f) => new CsvProblem('NOT_SUPPORTED',
        `"${f.name}" is not a CSV spreadsheet or a supported document (.pdf, .docx, .md, .txt). Save Excel workbooks as "CSV UTF-8 (Comma delimited)"; save other documents as PDF.`)), name, 'and choose the files again');
      return;
    }
    if (kinds.includes('csv')) {
      if (files.length > 1) {
        showProblems('Upload denied: one spreadsheet at a time', [new CsvProblem('MIXED_FILES',
          'Upload a single CSV spreadsheet on its own, or choose only documents (several at once is fine).')], name, 'and choose the files again');
        return;
      }
      await onCsvFile(files[0]);
      return;
    }
    await onDocuments(files);
  }

  // ---- Uploading ----------------------------------------------------------------

  function setStep(key, state, detail = '') {
    const li = progress.querySelector(`[data-step="${key}"]`);
    if (!li) return;
    li.dataset.state = state;
    li.querySelector('.step-detail').textContent = detail;
  }

  function resetSteps({ existing, refine }) {
    progress.replaceChildren(...STEPS
      .filter((s) => (existing || s.key !== 'existing') && (refine || s.key !== 'refine'))
      .map((s) => el('li', { dataset: { step: s.key, state: 'waiting' } },
        el('span', { class: 'step-icon', 'aria-hidden': 'true' }), el('span', { class: 'step-label', text: s.label }), el('span', { class: 'step-detail' }))));
    progress.hidden = false;
  }

  /** The sheets to upload: { filename, kind, csv, rows }. Throws with problems if any. */
  function buildSheets() {
    if (mode === 'csv') return [{ filename: parsed.filename, kind: 'spreadsheet', csv: parsed.text, rows: parsed.rows }];
    return docs.map((entry) => {
      const sheet = documentSheet(entry.doc, metaOf(entry), entry.counter);
      if (sheet.problems.length) throw new ApiError(422, 'INVALID_CSV', `${entry.file.name} could not be prepared.`, sheet.problems.map((p) => ({ ...p, file: entry.file.name })));
      return sheet;
    });
  }

  const inputs = () => [destExisting, destNew, plotSelect, nameInput, descInput, fileInput, password, refineBox,
    ...docs.flatMap((d) => (d.fields ? Object.values(d.fields) : []))];

  async function run() {
    busy = true;
    updateSubmit();
    status.textContent = '';
    status.className = 'form-status';
    controller = new AbortController();
    const { signal } = controller;
    const dest = destination();
    const plotId = dest === 'existing' ? plotSelect.value : null;
    const refine = mode === 'documents' && !refineRow.hidden && refineBox.checked;
    resetSteps({ existing: dest === 'existing', refine });
    inputs().forEach((x) => { x.disabled = true; });

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
      if (!cachedEmbedding) {
        // Embedding keeps running if the password is wrong, so a retry can reuse it.
        cachedEmbedding = (async () => {
          if (refine) {
            // The AI is only asked once the password is known to be right.
            await passwordCheck;
            const todo = docs.filter((d) => !d.doc.refined);
            let windowsFailed = 0;
            for (const [i, entry] of todo.entries()) {
              setStep('refine', 'active', `${entry.file.name} (${i + 1} of ${todo.length})`);
              const out = await refineDocument(entry.doc, password.value, { signal });
              entry.doc.chunks = out.chunks;
              entry.doc.refined = out.failed < out.windows;
              windowsFailed += out.failed;
              renderPreview(entry);
            }
            setStep('refine', 'done', windowsFailed ? `${plural(windowsFailed, 'part')} kept the automatic chunks` : '');
            showDocumentSummary();
          } else if (mode === 'documents') {
            for (const entry of docs) {
              if (entry.doc.refined) { entry.doc.chunks = entry.doc.semantic; entry.doc.refined = false; renderPreview(entry); }
            }
            showDocumentSummary();
          }
          const sheets = buildSheets();
          const rows = sheets.flatMap((s) => s.rows);
          if (rows.length > LIMITS.maxRowsPerUpload) {
            throw new Error(`This upload has ${rows.length} entries; at most ${LIMITS.maxRowsPerUpload} can be uploaded at once.`);
          }
          const capacity = capacityProblem(rows.length);
          if (capacity) throw new Error(capacity.message);
          setStep('model', 'active');
          await loadModel((loaded, total) => setStep('model', 'active', total ? `${formatBytes(loaded)} of ${formatBytes(total)} (only downloaded once)` : ''));
          setStep('model', 'done');
          setStep('embed', 'active', `0 of ${rows.length}`);
          const vectors = await embedEntries(rows, { onProgress: (done, total) => setStep('embed', 'active', `${done} of ${total}`) });
          // The growth territory centroids are embedded with the same model (a few seconds).
          setStep('embed', 'active', 'Embedding the growth territories');
          await loadTerritoryCentroids();
          return { sheets, vectors };
        })();
        cachedEmbedding.catch(() => { cachedEmbedding = null; });
      } else {
        setStep('refine', 'done');
        setStep('model', 'done');
        setStep('embed', 'active');
      }
      const { sheets, vectors } = await Promise.race([cachedEmbedding, passwordFailure]);
      const newRows = sheets.reduce((s, sh) => s + sh.rows.length, 0);
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
      const n = base.ids.length + newRows;
      const dim = EMBEDDING.dim;
      const all = new Float32Array(n * dim);
      base.vectors.forEach((v, i) => all.set(v, i * dim));
      all.set(vectors, base.ids.length * dim);
      const newIds = sheets.flatMap((s, si) => s.rows.map((r) => `new-${si}-${r.row}`));
      const started = performance.now();
      const layout = await computeLayoutsInWorkers(all, n, dim, {
        ids: [...base.ids, ...newIds],
        previous: base.coords ? { ids: base.ids, coords: base.coords } : null,
        signal,
        onProgress: (f, label) => setStep('layout', 'active', `${label} · ${Math.round(f * 100)}%`),
      });
      const centroids = await loadTerritoryCentroids();
      const grouping = clusterPayload(all, n, layout.topics, centroids);
      const found = new Set(layout.topics.labels.filter((l) => l >= 0)).size;
      setStep('layout', 'done', `${((performance.now() - started) / 1000).toFixed(1)} s · ${plural(found, 'topic cluster')}`);

      setStep('save', 'active', 'Committing to GitHub…');
      const round6 = (x) => Math.round(x * 1e6) / 1e6;
      let offset = 0;
      const body = {
        password: password.value,
        sheets: sheets.map((s) => {
          const out = {
            filename: s.filename, kind: s.kind, csv: s.csv,
            vectors: s.rows.map((_, i) => Array.from(vectors.subarray((offset + i) * dim, (offset + i + 1) * dim), round6)),
          };
          offset += s.rows.length;
          return out;
        }),
        baseIds: base.ids,
        coords: Object.fromEntries(Object.entries(layout.coords).map(([k, v]) => [k, Array.from(v)])),
        layoutParams: layout.params,
        ...grouping,
        embedding: { model: EMBEDDING.model, dtype: EMBEDDING.dtype, pooling: EMBEDDING.pooling, normalize: EMBEDDING.normalize, dim },
        ...(plotId ? { plotId } : { newPlot: { name: nameInput.value.trim(), description: descInput.value.trim() } }),
      };
      const out = await request('/api/upload', { method: 'POST', body, timeout: 180000 });
      setStep('save', 'done');
      noteVersion(out.plot.id, out.plot.version);
      busy = false;
      dlg.close('done');
      app.applyServerUpdate(out, { selectPlot: true, animate: Boolean(plotId) });
      const from = mode === 'documents' ? ` from ${plural(sheets.length, 'document')}` : '';
      toast(`Added ${plural(newRows, 'entry', 'entries')}${from} to “${out.plot.name}”. GitHub Pages will publish the change within a few minutes; you can keep working.`, { kind: 'success', timeout: 8000 });
    } catch (err) {
      busy = false;
      const passwordProblem = err instanceof ApiError && PASSWORD_CODES.includes(err.code);
      for (const li of progress.querySelectorAll('[data-state="active"]')) li.dataset.state = passwordProblem ? 'waiting' : 'error';
      inputs().forEach((x) => { x.disabled = false; });
      if (plots.length === 0) destExisting.disabled = true;
      syncDest();
      status.className = 'form-status error';
      const filename = mode === 'csv' ? parsed.filename : plural(docs.length, 'document');
      if (err?.name === 'AbortError' && !(err instanceof ApiError)) {
        status.textContent = '';
      } else if (err instanceof ApiError && err.problems) {
        status.textContent = '';
        const problems = err.problems.map((p) => (p.file && mode === 'documents' ? { ...p, message: `${p.file}: ${p.message}` } : p));
        showProblems(mode === 'csv' ? 'The server rejected the spreadsheet' : 'The server rejected the upload', problems, filename,
          mode === 'csv' ? undefined : 'and try again');
      } else if (err instanceof ApiError && err.code === 'WRONG_PASSWORD') {
        status.textContent = 'That password is not correct. Nothing was uploaded.';
        password.select();
      } else if (err instanceof ApiError && err.code === 'PLOT_CHANGED') {
        status.textContent = `${err.message} Your ${mode === 'csv' ? 'file is' : 'documents are'} still selected, so choose “Upload” again.`;
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
  refineBox.addEventListener('change', invalidate);
  fileInput.addEventListener('change', () => onFiles(fileInput.files));
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    if (!busy && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!submit.disabled) run();
  });
  // The AI option appears once the server reports that it is set up.
  const stopWatching = onStatus(() => {
    if (mode === 'documents' && !busy) refineRow.hidden = !apiHealth()?.llm;
  });
  cancel.addEventListener('click', () => {
    if (busy) {
      controller?.abort();
      stopEmbedding();
      cachedEmbedding = null;
    }
    dlg.close('cancel');
  });
  dlg.oncancel = (e) => {
    // Escape during the final save would leave the outcome unclear, so wait for it.
    if (busy && progress.querySelector('[data-step="save"][data-state="active"]')) e.preventDefault();
    else if (busy) { controller?.abort(); stopEmbedding(); }
  };
  dlg.onclose = () => {
    generation += 1;
    stopWatching();
    keepAlive('upload', false);
  };

  syncDest();
  dlg.replaceChildren(form);
  dlg.showModal();
}
