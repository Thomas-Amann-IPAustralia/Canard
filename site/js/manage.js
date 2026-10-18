// Spreadsheet management: list the spreadsheets in a plot, download the originals,
// delete a spreadsheet (or the whole plot) and recalculate the clusters, all with the
// upload password.
import { request, wake, ApiError, keepAlive } from './api.js';
import { sourceCsvUrl, noteVersion, loadPlot, loadVectors } from './data.js';
import { $, el, icon, plural, formatDateTime, formatBytes, toast } from './ui.js';
import { EMBEDDING } from './schema.js';
import { TERRITORIES_VERSION } from './territories.js';

function passwordForm({ label, confirmText, danger = true, onSubmit, failure = 'Could not reach the server. Nothing was deleted.' }) {
  const input = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', placeholder: 'Password' });
  const status = el('p', { class: 'form-status', role: 'status' });
  const button = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', text: confirmText });
  const form = el('form', { class: 'confirm-form' }, el('p', { text: label }), el('div', { class: 'confirm-row' }, input, button), status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) { input.focus(); return; }
    button.disabled = true;
    status.className = 'form-status';
    status.textContent = 'Working… (the server may take up to a minute to wake up)';
    try {
      await onSubmit(input.value, (text) => { status.textContent = text; });
    } catch (err) {
      status.className = 'form-status error';
      status.textContent = err instanceof ApiError ? err.message : (err?.message ? `${failure} (${err.message})` : failure);
      button.disabled = false;
      input.select();
    }
  });
  setTimeout(() => input.focus(), 0);
  return form;
}

/** Status of the plot's clusters and a button to recalculate them. */
function clustersSection(app, render) {
  const current = app.state.plot;
  const info = current.clustering;
  const version = info?.params?.territories?.version;
  let summary;
  if (!info || !app.state.clusters) summary = 'Not calculated yet. Plots uploaded before clustering was added need this once.';
  else if (version !== TERRITORIES_VERSION) summary = `Calculated ${formatDateTime(info.computed)} with an earlier version of the growth territories (${version || 'unknown'}; the current version is ${TERRITORIES_VERSION}).`;
  else summary = `Calculated ${formatDateTime(info.computed)}: ${plural(app.state.clusters.topics.length, 'topic cluster')}.`;
  const section = el('div', { class: 'clusters-zone' },
    el('h3', { text: 'Topic clusters and growth territories' }),
    el('p', { text: summary }),
    el('p', { class: 'field-hint', text: 'They are calculated whenever a spreadsheet is uploaded. Recalculate them after changing the growth territories, or for an older plot; the layouts do not change. This loads the embedding model (about 128 MB, downloaded only once).' }));
  const button = el('button', {
    class: 'btn', type: 'button', text: 'Recalculate clusters…',
    on: {
      click: () => button.replaceWith(passwordForm({
        label: `Recalculate the topic clusters and growth territories of “${current.name}”?`,
        confirmText: 'Recalculate', danger: false, failure: 'The clusters could not be recalculated. Nothing was changed.',
        onSubmit: async (password, setStatus) => {
          await recalculateClusters(app, current.id, password, setStatus);
          render();
        },
      })),
    },
  });
  section.append(button);
  return section;
}

async function recalculateClusters(app, plotId, password, setStatus) {
  // Check the password first (this also wakes the server) so no heavy work is wasted.
  await request('/api/auth/check', { method: 'POST', body: { password } });
  const [{ loadModel }, { computeTopicsInWorker }, { loadTerritoryCentroids, clusterPayload }] = await Promise.all([
    import('./embedder.js'), import('./layout-runner.js'), import('./cluster-data.js')]);
  setStatus('Fetching the plot’s entries and their stored vectors…');
  const fresh = await loadPlot(plotId, { source: 'api' });
  if (!fresh) throw new ApiError(404, 'PLOT_NOT_FOUND', 'That plot no longer exists.');
  const vecMap = await loadVectors(fresh.plot);
  const ids = fresh.points.points.map((p) => p.id);
  if (ids.some((id) => !vecMap.has(id))) throw new Error('Some stored vectors are missing.');
  const { dim } = EMBEDDING;
  const vectors = new Float32Array(ids.length * dim);
  ids.forEach((id, i) => vectors.set(vecMap.get(id), i * dim));
  setStatus('Loading the embedding model…');
  await loadModel((loaded, total) => setStatus(total ? `Loading the embedding model: ${formatBytes(loaded)} of ${formatBytes(total)} (downloaded only once)` : 'Loading the embedding model…'));
  setStatus('Embedding the growth territories…');
  const centroids = await loadTerritoryCentroids();
  setStatus('Clustering the entries…');
  const topics = await computeTopicsInWorker(vectors, ids.length, dim, { onProgress: (f) => setStatus(`Clustering the entries… ${Math.round(f * 100)}%`) });
  setStatus('Saving to the GitHub repository…');
  const out = await request(`/api/plots/${encodeURIComponent(plotId)}/clusters`, {
    method: 'POST', body: { password, baseIds: ids, ...clusterPayload(vectors, ids.length, topics, centroids) }, timeout: 180000,
  });
  noteVersion(plotId, out.plot.version);
  app.applyServerUpdate(out);
  const found = new Set(topics.labels.filter((l) => l >= 0)).size;
  toast(`Recalculated the clusters: ${plural(found, 'topic cluster')}.`, { kind: 'success' });
}

export function openManage(app) {
  const dlg = $('#dlg-manage');
  const { plot } = app.state;
  if (!plot) return;
  wake().catch(() => {});
  keepAlive('manage', true);
  dlg.onclose = () => keepAlive('manage', false);

  const render = () => {
    const current = app.state.plot;
    const rows = current.sheets.map((sheet) => {
      // A document's original is not stored, only the chunks made from it (as a CSV).
      const isDoc = sheet.kind === 'document';
      const actions = el('div', { class: 'sheet-actions' },
        el('a', {
          class: 'btn btn-small', href: sourceCsvUrl(current.id, sheet.id),
          download: isDoc ? `${sheet.filename.replace(/\.[a-z0-9]+$/i, '')}-chunks.csv` : sheet.filename,
          text: isDoc ? 'Download chunks' : 'Download original',
        }),
        el('button', {
          class: 'btn btn-small btn-danger-quiet', type: 'button', text: 'Delete…',
          on: {
            click: () => {
              actions.replaceWith(passwordForm({
                label: `Delete ${sheet.filename} and its ${plural(sheet.rows, 'entry', 'entries')} (including their tags) from this plot?`,
                confirmText: isDoc ? 'Delete document' : 'Delete spreadsheet',
                onSubmit: async (password) => {
                  const out = await request(`/api/plots/${encodeURIComponent(current.id)}/sheets/${encodeURIComponent(sheet.id)}/delete`, { method: 'POST', body: { password } });
                  noteVersion(current.id, out.plot.version);
                  app.applyServerUpdate(out, { animate: true });
                  toast(`Deleted ${sheet.filename}.`, { kind: 'success' });
                  render();
                },
              }));
            },
          },
        }));
      return el('li', { class: 'sheet' },
        el('div', { class: 'sheet-info' },
          el('strong', { text: sheet.filename }),
          el('span', { class: 'entry-meta', text: `${isDoc ? `Document · ${plural(sheet.rows, 'chunk')}` : plural(sheet.rows, 'entry', 'entries')} · uploaded ${formatDateTime(sheet.uploaded)}` })),
        actions);
    });
    const deletePlot = el('div', { class: 'danger-zone' },
      el('h3', { text: 'Delete this plot' }),
      el('p', { text: 'Removes the plot, every spreadsheet and document in it, and all tags. This cannot be undone (although the history stays in the GitHub repository).' }),
      el('button', {
        class: 'btn btn-danger-quiet', type: 'button', text: 'Delete plot…',
        on: {
          click: (e) => {
            e.currentTarget.replaceWith(passwordForm({
              label: `Delete the plot “${current.name}”?`,
              confirmText: 'Delete plot',
              onSubmit: async (password) => {
                const out = await request(`/api/plots/${encodeURIComponent(current.id)}/delete`, { method: 'POST', body: { password } });
                dlg.close();
                app.applyIndex(out.index, { removed: current.id });
                toast(`Deleted the plot “${current.name}”.`, { kind: 'success' });
              },
            }));
          },
        },
      }));
    dlg.replaceChildren(el('div', { class: 'form' },
      el('div', { class: 'dialog-head' },
        el('h2', { id: 'dlg-manage-title', text: `Spreadsheets and documents in “${current.name}”` }),
        el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Close', on: { click: () => dlg.close() } }, icon('close'))),
      current.description ? el('p', { class: 'lead', text: current.description }) : null,
      rows.length ? el('ul', { class: 'sheet-list' }, rows) : el('p', { class: 'empty-note', text: 'This plot has no spreadsheets or documents. Upload one to add entries.' }),
      el('p', { class: 'field-hint', text: 'Deleting needs the upload password. Remaining entries keep their positions and clusters.' }),
      rows.length ? clustersSection(app, render) : null,
      deletePlot));
  };
  render();
  dlg.showModal();
}

export function openHelp() {
  const dlg = $('#dlg-help');
  const item = (title, ...text) => el('div', {}, el('h3', { text: title }), ...text.map((t) => el('p', { text: t })));
  dlg.replaceChildren(el('div', { class: 'form help' },
    el('div', { class: 'dialog-head' },
      el('h2', { id: 'dlg-help-title', text: 'How Canard works' }),
      el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Close', on: { click: () => dlg.close() } }, icon('close'))),
    item('From spreadsheet to map',
      'Each row of an uploaded CSV is turned into a 384-dimension vector by the bge-small-en-v1.5 embedding model, using its title and summary. Entries about similar things end up with similar vectors.',
      'The vectors are then projected to two dimensions so they can be plotted. Points close together are semantically similar; the axes themselves have no meaning.'),
    item('From documents to map',
      'Uploaded documents (PDF, Word, Markdown or text) are split into passages in the browser. The text is first divided at its headings and paragraphs, and each paragraph is embedded. Consecutive paragraphs are then grouped into chunks of up to about 360 tokens, starting a new chunk at each section heading and wherever the meaning shifts most from one paragraph to the next.',
      'If the server has an AI service set up, you can also ask it to choose the chunk boundaries and give each chunk a title. It never rewrites the text. Each chunk then becomes an entry, mapped exactly like a spreadsheet row.'),
    item('The four projections',
      'UMAP keeps local neighbourhoods tight while preserving more of the overall shape. t-SNE separates tight clusters very clearly, but the distances between clusters are not meaningful. Gaussian kernel PCA is a smooth, repeatable projection using a Gaussian (RBF) similarity. PCA is a straight linear projection onto the two directions of greatest variation.',
      'All four layouts are calculated when a spreadsheet is uploaded, so switching between them is instant.'),
    item('Topic clusters',
      'Entries are grouped automatically, in the style of BERTopic. UMAP first reduces the 384-dimension vectors to five dimensions (keeping far more of the structure than the two shown on screen), then HDBSCAN finds dense groups of any shape and leaves entries that fit no group unclustered instead of forcing them into one.',
      'Each cluster is described by keywords from class-based TF-IDF (c-TF-IDF): the titles and summaries of a cluster are pooled into one document, and words that are frequent in that cluster but rare in the others score highest. Colour by “Topic cluster” to see them; each cluster is labelled on the plot.'),
    item('Growth territories',
      'An opinionated alternative to automatic clustering, like k-means with five fixed centroids. Each of IP Australia’s five growth territories becomes a centroid: every statement in it (its aim, “imagine a world where”, recent changes, jobs to be done and “why now”) is embedded by the same model and the statements are averaged. Each entry belongs to the territory it is most similar to.',
      'The Territories view shows the five centroids as labelled rings. Each entry sits among them according to how much more similar it is to each territory than to the others: close to a ring when it clearly belongs there, between rings when it is split, near the middle when it is equally close to all.'),
    item('Selecting and tagging',
      'Click a point to read it. Shift-click adds points to a selection, and the lasso (or Shift and drag) selects a group. Unlock tagging with the tagging password to add tags to a selection; tags are saved to the repository and can be used as filters.'),
    item('Where the data lives',
      'Everything (the original spreadsheets, the vectors, the tags and the layouts) is stored in the data folder of the GitHub repository, and every change is a commit. Viewing needs no password. Uploading, deleting and tagging go through a small server that checks the password before committing.'),
    item('Keyboard shortcuts',
      '1 to 5 switch views, P and L switch between pan and lasso, 0 fits all points, + and − zoom, arrow keys pan, and Escape clears the selection.')));
  dlg.showModal();
}
