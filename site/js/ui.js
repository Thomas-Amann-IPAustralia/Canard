// Small DOM and formatting helpers. User-supplied text is always inserted with
// textContent, never as HTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Create an element. props: attributes, plus `text`, `class`, `on` ({ event: fn }),
 * `dataset` and `hidden`. Children may be nodes, strings or arrays.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'hidden') node.hidden = Boolean(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

const dateFormat = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Format an ISO date (YYYY-MM-DD) as, for example, 5 Mar 2024. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFormat.format(d);
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Show a transient message. kind: 'info' | 'success' | 'error'. */
export function toast(message, { kind = 'info', timeout = kind === 'error' ? 9000 : 4500, action = null } = {}) {
  const host = $('#toasts');
  const item = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'error' ? icon('alert') : kind === 'success' ? icon('check') : null,
    el('span', { text: message }));
  if (action) item.append(el('button', { class: 'link-btn', type: 'button', text: action.label, on: { click: () => { action.run(); item.remove(); } } }));
  item.append(el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', on: { click: () => item.remove() } }, icon('close')));
  host.append(item);
  if (timeout) setTimeout(() => item.remove(), timeout);
  return item;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export const sessionStore = {
  get(key) {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  },
};

/** Render a list of validation problems. */
export function problemList(problems) {
  return el('ul', { class: 'problem-list' }, problems.map((p) => el('li', {}, p.row ? el('strong', { text: `Row ${p.row}` }) : null, p.row ? ' ' : null,
    el('span', { text: p.row ? p.message.replace(new RegExp(`^Row ${p.row}:? ?`), '') : p.message }))));
}

/** Download text as a file. */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
