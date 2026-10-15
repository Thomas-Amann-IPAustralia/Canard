// Client for the Canard API on Render.
//
// Render's free tier puts the service to sleep after 15 minutes without traffic, and
// waking it takes up to about a minute. Viewing never needs the API, so the page
// starts waking it in the background as soon as it loads; by the time someone has
// chosen a file or typed a password it is usually ready.

const config = window.CANARD_CONFIG || {};
export const API_BASE = (config.apiBase || '').replace(/\/+$/, '');

const listeners = new Set();
let status = API_BASE ? 'unknown' : 'unconfigured';
let health = null;
let wakePromise = null;
let keepAliveTimer = null;
const keepAliveReasons = new Set();

export class ApiError extends Error {
  constructor(status, code, message, problems = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

function setStatus(next) {
  if (next === status) return;
  status = next;
  for (const fn of listeners) fn(status, health);
}

export function onStatus(fn) {
  listeners.add(fn);
  fn(status, health);
  return () => listeners.delete(fn);
}

export function apiStatus() {
  return status;
}

export function apiHealth() {
  return health;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const outer = options.signal;
  if (outer) outer.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wake the API and resolve when it answers. Retries for up to two minutes, since a
 * cold start on Render can fail or time out the first request.
 */
export function wake() {
  if (!API_BASE) return Promise.reject(new ApiError(0, 'NOT_CONFIGURED', 'No editing server is configured for this site.'));
  if (status === 'ready' && health) return Promise.resolve(health);
  if (wakePromise) return wakePromise;
  const started = Date.now();
  // Only show "waking" if the first answer takes a moment (a warm server replies fast).
  const slow = setTimeout(() => { if (status !== 'ready') setStatus('waking'); }, 1200);
  wakePromise = (async () => {
    let delay = 1500;
    while (Date.now() - started < 120000) {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/health`, { cache: 'no-store' }, 75000);
        if (res.ok) {
          health = await res.json();
          clearTimeout(slow);
          setStatus('ready');
          return health;
        }
      } catch { /* sleeping, starting or offline; try again */ }
      if (status !== 'waking') setStatus('waking');
      await sleep(delay);
      delay = Math.min(delay * 1.5, 8000);
    }
    clearTimeout(slow);
    setStatus('offline');
    throw new ApiError(0, 'OFFLINE', 'The editing server is not responding. Please try again in a minute.');
  })();
  wakePromise.finally(() => { wakePromise = null; }).catch(() => {});
  return wakePromise;
}

/** Keep the server awake while someone is actively editing (upload dialog open, tagging unlocked). */
export function keepAlive(reason, on) {
  if (on) keepAliveReasons.add(reason);
  else keepAliveReasons.delete(reason);
  if (keepAliveReasons.size && !keepAliveTimer && API_BASE) {
    keepAliveTimer = setInterval(() => {
      if (document.visibilityState === 'visible') fetch(`${API_BASE}/api/health`, { cache: 'no-store' }).catch(() => {});
    }, 10 * 60 * 1000);
  } else if (!keepAliveReasons.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function parseError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const err = body?.error;
  if (err) return new ApiError(res.status, err.code, err.message, err.problems || null);
  return new ApiError(res.status, 'HTTP_ERROR', `The server returned an error (${res.status}).`);
}

/**
 * Call the API. Wakes the server first if needed. A request that fails because the
 * server went back to sleep is retried once after waking it again.
 */
export async function request(path, { method = 'GET', body = undefined, token = null, signal = undefined, timeout = 120000 } = {}) {
  await wake();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetchWithTimeout(`${API_BASE}${path}`, init, timeout);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt === 0) {
        setStatus('waking');
        health = null;
        await wake();
        continue;
      }
      throw new ApiError(0, 'NETWORK', 'Could not reach the editing server. Check your connection and try again.');
    }
    if ((res.status === 502 || res.status === 503) && attempt === 0 && !(await res.clone().json().catch(() => null))?.error) {
      // Render's proxy answers 502/503 while the service restarts.
      health = null;
      setStatus('waking');
      await wake();
      continue;
    }
    if (!res.ok) throw await parseError(res);
    return res.json();
  }
  throw new ApiError(0, 'NETWORK', 'Could not reach the editing server.');
}

/** Fetch a data file through the API (always the latest committed version). */
export async function fetchData(path) {
  await wake();
  const res = await fetchWithTimeout(`${API_BASE}/api/data/${path}`, { cache: 'no-store' }, 60000);
  if (res.status === 404) return null;
  if (!res.ok) throw await parseError(res);
  return res.json();
}
