// The side pane: one entry's summary and source link, or a summary of a selection,
// with tag editing for both.
import { $, el, icon, formatDate, plural } from './ui.js';
import { tagSession, unlock } from './tagging.js';
import { LIMITS } from './schema.js';

function paragraphs(text) {
  return text.split(/\n{2,}/).map((para) => el('p', {}, para.split('\n').flatMap((line, i) => (i ? [el('br'), line] : [line]))));
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return link; }
}

function parseTags(text) {
  return text.split(',').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function tagEditor(app, { chips, ids, label }) {
  const canEdit = Boolean(tagSession());
  const wrap = el('section', { class: 'tag-editor', 'aria-label': label });
  wrap.append(el('h4', { text: 'Tags' }));
  const list = el('ul', { class: 'tag-list' });
  if (!chips.length) list.append(el('li', { class: 'empty-note', text: 'No tags yet.' }));
  for (const { tag, count } of chips) {
    const chip = el('li', { class: 'tag' }, el('span', { text: tag }));
    if (count !== undefined && count < ids.length) chip.append(el('span', { class: 'tag-count', text: `${count}/${ids.length}` }));
    if (canEdit) {
      chip.append(el('button', {
        type: 'button', class: 'tag-remove', 'aria-label': `Remove tag ${tag}${ids.length > 1 ? ' from all selected entries' : ''}`,
        on: { click: () => app.tag(ids, { remove: [tag] }) },
      }, icon('close')));
    }
    list.append(chip);
  }
  wrap.append(list);
  if (canEdit) {
    const listId = `tag-suggestions-${Math.random().toString(36).slice(2, 8)}`;
    const input = el('input', {
      type: 'text', list: listId, maxlength: String(LIMITS.maxTagLength * 4), placeholder: 'Add tags, separated by commas',
      'aria-label': ids.length > 1 ? `Add tags to ${ids.length} entries` : 'Add tags',
    });
    const datalist = el('datalist', { id: listId }, app.allTags().map((t) => el('option', { value: t })));
    const form = el('form', { class: 'tag-add' }, input, datalist,
      el('button', { class: 'btn btn-small', type: 'submit', text: ids.length > 1 ? `Add to ${ids.length}` : 'Add' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const tags = parseTags(input.value);
      const tooLong = tags.find((t) => t.length > LIMITS.maxTagLength);
      if (tooLong) {
        input.setCustomValidity(`Tags can be at most ${LIMITS.maxTagLength} characters.`);
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      if (!tags.length) return;
      app.tag(ids, { add: tags });
      input.value = '';
      requestAnimationFrame(() => $('.tag-add input', $('#details-body'))?.focus());
    });
    wrap.append(form);
  } else {
    wrap.append(el('button', {
      type: 'button', class: 'btn btn-small', on: { click: () => unlock() },
    }, icon('lock'), el('span', { text: 'Unlock tagging to edit tags' })));
  }
  return wrap;
}

function single(app, i) {
  const p = app.state.points[i];
  const sheet = app.state.plot.sheets.find((s) => s.id === p.sheet);
  const sel = app.state.selection;
  const body = [];
  if (sel.size > 1) {
    body.push(el('button', { type: 'button', class: 'link-btn back-link', text: `← Back to ${plural(sel.size, 'selected entry', 'selected entries')}`, on: { click: () => app.focusPoint(null) } }));
  }
  body.push(
    el('h3', { class: 'detail-title', text: p.title }),
    el('dl', { class: 'detail-meta' },
      el('div', {}, el('dt', { text: 'Published' }), el('dd', { text: formatDate(p.date) })),
      el('div', {}, el('dt', { text: 'Source type' }), el('dd', { text: p.sourceType })),
      el('div', {}, el('dt', { text: 'Spreadsheet' }), el('dd', { text: sheet ? `${sheet.filename}, row ${p.row}` : `Row ${p.row}` }))),
    el('a', { class: 'btn btn-primary source-link', href: p.link, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { text: 'Open original source' }), icon('external')),
    el('p', { class: 'source-host', text: hostOf(p.link) }),
    tagEditor(app, { chips: (p.tags || []).map((tag) => ({ tag })), ids: [p.id], label: 'Tags for this entry' }),
    el('section', { class: 'detail-summary', 'aria-label': 'Summary' }, el('h4', { text: 'Summary' }), paragraphs(p.summary)),
  );
  return body;
}

function multiple(app) {
  const idx = [...app.state.selection];
  const points = idx.map((i) => app.state.points[i]);
  const ids = points.map((p) => p.id);
  const counts = new Map();
  for (const p of points) for (const t of p.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  const types = new Map();
  for (const p of points) types.set(p.sourceType, (types.get(p.sourceType) || 0) + 1);
  const sorted = idx.slice().sort((a, b) => app.state.points[b].date.localeCompare(app.state.points[a].date));
  return [
    el('h3', { class: 'detail-title', text: `${plural(idx.length, 'entry', 'entries')} selected` }),
    el('p', { class: 'detail-sub', text: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c} ${t}`).join(' · ') }),
    tagEditor(app, { chips, ids, label: 'Tags for the selected entries' }),
    el('section', { class: 'selected-list' },
      el('h4', { text: 'Entries' }),
      el('ol', {}, sorted.map((i) => {
        const p = app.state.points[i];
        return el('li', {}, el('button', { type: 'button', class: 'entry-button', on: { click: () => app.focusPoint(i) } },
          el('span', { class: 'entry-title', text: p.title }),
          el('span', { class: 'entry-meta', text: `${formatDate(p.date)} · ${p.sourceType}` })));
      }))),
    el('button', { type: 'button', class: 'btn', text: 'Clear selection', on: { click: () => app.clearSelection() } }),
  ];
}

export function renderDetails(app) {
  const panel = $('#details-panel');
  const { focus, selection, detailsOpen } = app.state;
  const show = detailsOpen && (focus !== null || selection.size > 0);
  panel.hidden = !show;
  document.body.classList.toggle('details-open', show);
  if (!show) return;
  const body = $('#details-body');
  const scroll = body.scrollTop;
  const keepScroll = body.dataset.key === `${focus}:${selection.size}`;
  $('#details-heading').textContent = focus !== null ? 'Entry' : 'Selection';
  body.replaceChildren(...(focus !== null ? single(app, focus) : multiple(app)));
  body.dataset.key = `${focus}:${selection.size}`;
  if (keepScroll) body.scrollTop = scroll;
}
