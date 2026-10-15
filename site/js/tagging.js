// Tagging sessions: the password is entered once per browser session, then the
// server's signed token authorises each tag change.
import { request, keepAlive, ApiError, wake } from './api.js';
import { $, el, icon, sessionStore, toast } from './ui.js';

const KEY = 'canard.tagSession';
let session = sessionStore.get(KEY);
const listeners = new Set();

export function tagSession() {
  if (session && session.expiresAt * 1000 > Date.now() + 60000) return session;
  return null;
}

export function onSessionChange(fn) {
  listeners.add(fn);
}

function setSession(next) {
  session = next;
  sessionStore.set(KEY, next);
  keepAlive('tagging', Boolean(next));
  for (const fn of listeners) fn(tagSession());
}

export function lock() {
  setSession(null);
  toast('Tagging locked.');
}

/** Ask for the password. Resolves true once unlocked, false if cancelled. */
export function unlock() {
  const dlg = $('#dlg-unlock');
  wake().catch(() => {});
  return new Promise((resolve) => {
    const status = el('p', { class: 'form-status', role: 'status' });
    const input = el('input', { type: 'password', id: 'unlock-password', autocomplete: 'current-password', required: true });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Unlock' });
    const form = el('form', { method: 'dialog', class: 'form' },
      el('h2', { id: 'dlg-unlock-title', text: 'Unlock tagging' }),
      el('p', { text: 'Enter the tagging password. You will stay unlocked until you close this browser tab.' }),
      el('label', { for: 'unlock-password', text: 'Password' }), input, status,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn', type: 'button', text: 'Cancel', on: { click: () => dlg.close('cancel') } }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'form-status';
      status.textContent = 'Checking… (the server may take up to a minute to wake up)';
      try {
        const out = await request('/api/auth/session', { method: 'POST', body: { password: input.value } });
        setSession({ token: out.token, expiresAt: out.expiresAt });
        dlg.close('ok');
        toast('Tagging unlocked. Select points and add tags in the side panel.', { kind: 'success' });
      } catch (err) {
        status.className = 'form-status error';
        status.textContent = err instanceof ApiError ? err.message : 'Could not reach the server.';
        submit.disabled = false;
        input.select();
      }
    });
    dlg.replaceChildren(form);
    dlg.onclose = () => resolve(Boolean(tagSession()));
    dlg.showModal();
    input.focus();
  });
}

/** Send a tag change. Expired sessions prompt for the password and retry once. */
export async function sendTags(plotId, ids, { add = [], remove = [] }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const s = tagSession();
    if (!s) {
      if (!(await unlock())) throw new ApiError(401, 'CANCELLED', 'Tagging is locked.');
      continue;
    }
    try {
      return await request(`/api/plots/${encodeURIComponent(plotId)}/tags`, { method: 'POST', token: s.token, body: { ids, add, remove } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SESSION_EXPIRED') {
        setSession(null);
        continue;
      }
      throw err;
    }
  }
  throw new ApiError(401, 'SESSION_EXPIRED', 'Tagging is locked.');
}

export function renderTaggingButton(button) {
  const s = tagSession();
  button.replaceChildren(icon(s ? 'unlock' : 'lock'), el('span', { text: s ? 'Tagging unlocked' : 'Unlock tagging' }));
  button.setAttribute('aria-pressed', String(Boolean(s)));
  button.title = s ? 'Click to lock tagging again' : 'Enter the password to add tags';
  button.classList.toggle('btn-on', Boolean(s));
}

if (tagSession()) keepAlive('tagging', true);
