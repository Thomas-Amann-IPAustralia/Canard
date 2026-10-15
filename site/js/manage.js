// Spreadsheet management: list the spreadsheets in a plot, download the originals and
// delete a spreadsheet (or the whole plot) with the password.
import { request, wake, ApiError, keepAlive } from './api.js';
import { sourceCsvUrl, noteVersion } from './data.js';
import { $, el, icon, plural, formatDateTime, toast } from './ui.js';

function passwordForm({ label, confirmText, danger = true, onSubmit }) {
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
      await onSubmit(input.value);
    } catch (err) {
      status.className = 'form-status error';
      status.textContent = err instanceof ApiError ? err.message : 'Could not reach the server. Nothing was deleted.';
      button.disabled = false;
      input.select();
    }
  });
  setTimeout(() => input.focus(), 0);
  return form;
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
      const actions = el('div', { class: 'sheet-actions' },
        el('a', { class: 'btn btn-small', href: sourceCsvUrl(current.id, sheet.id), download: sheet.filename, text: 'Download original' }),
        el('button', {
          class: 'btn btn-small btn-danger-quiet', type: 'button', text: 'Delete…',
          on: {
            click: () => {
              actions.replaceWith(passwordForm({
                label: `Delete ${sheet.filename} and its ${plural(sheet.rows, 'entry', 'entries')} (including their tags) from this plot?`,
                confirmText: 'Delete spreadsheet',
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
          el('span', { class: 'entry-meta', text: `${plural(sheet.rows, 'entry', 'entries')} · uploaded ${formatDateTime(sheet.uploaded)}` })),
        actions);
    });
    const deletePlot = el('div', { class: 'danger-zone' },
      el('h3', { text: 'Delete this plot' }),
      el('p', { text: 'Removes the plot, every spreadsheet in it, and all tags. This cannot be undone (although the history stays in the GitHub repository).' }),
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
        el('h2', { id: 'dlg-manage-title', text: `Spreadsheets in “${current.name}”` }),
        el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Close', on: { click: () => dlg.close() } }, icon('close'))),
      current.description ? el('p', { class: 'lead', text: current.description }) : null,
      rows.length ? el('ul', { class: 'sheet-list' }, rows) : el('p', { class: 'empty-note', text: 'This plot has no spreadsheets. Upload one to add entries.' }),
      el('p', { class: 'field-hint', text: 'Deleting needs the upload password. Remaining entries keep their positions.' }),
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
    item('The four views',
      'UMAP keeps local neighbourhoods tight while preserving more of the overall shape. t-SNE separates tight clusters very clearly, but the distances between clusters are not meaningful. Gaussian kernel PCA is a smooth, repeatable projection using a Gaussian (RBF) similarity. PCA is a straight linear projection onto the two directions of greatest variation.',
      'All four layouts are calculated when a spreadsheet is uploaded, so switching between them is instant.'),
    item('Selecting and tagging',
      'Click a point to read it. Shift-click adds points to a selection, and the lasso (or Shift and drag) selects a group. Unlock tagging with the tagging password to add tags to a selection; tags are saved to the repository and can be used as filters.'),
    item('Where the data lives',
      'Everything (the original spreadsheets, the vectors, the tags and the layouts) is stored in the data folder of the GitHub repository, and every change is a commit. Viewing needs no password. Uploading, deleting and tagging go through a small server that checks the password before committing.'),
    item('Keyboard shortcuts',
      '1 to 4 switch views, P and L switch between pan and lasso, 0 fits all points, + and − zoom, arrow keys pan, and Escape clears the selection.')));
  dlg.showModal();
}
