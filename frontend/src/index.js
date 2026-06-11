/* Docker Manager UI — single-page application (webpack-bundled) */
import './styles.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    auth: null,             // { user, basic }
    config: { allow_destructive: true, version: '—' },
    route: 'dashboard',
    data: {},
  };

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
    { id: 'containers', label: 'Containers', icon: '📦' },
    { id: 'stacks', label: 'Stacks', icon: '🧱' },
    { id: 'images', label: 'Images', icon: '🗂️' },
    { id: 'networks', label: 'Networks', icon: '🌐' },
    { id: 'volumes', label: 'Volumes', icon: '💾' },
    { id: 'activity', label: 'Activity', icon: '📈' },
    { id: 'registries', label: 'Registries', icon: '🔑' },
    { id: 'sessions', label: 'Sessions', icon: '🪪' },
    { id: 'system', label: 'System', icon: '⚙️' },
  ];

  // ---------- Storage ----------
  const STORAGE_KEY = 'docker-manager.auth';

  function loadAuth() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveAuth(auth) {
    if (auth) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    else sessionStorage.removeItem(STORAGE_KEY);
  }

  // ---------- API ----------
  function authHeader() {
    return state.auth && state.auth.token ? `Bearer ${state.auth.token}` : '';
  }

  /**
   * Shared fetch wrapper. Adds the bearer token, picks a content-type
   * for JSON bodies, auto-logs-out on 401, and routes the response
   * through the right reader depending on `opts.responseType`:
   *
   *   - 'json' (default): parses JSON, returns object
   *   - 'text':           returns text
   *   - 'blob':           returns Blob (used for file/archive download)
   *   - 'response':       returns the raw Response (caller wants headers
   *                        or streaming control)
   *
   * #21: download / upload / edit calls now route through here too so
   * they share the 401 auto-logout behaviour. Previously they used raw
   * fetch and a 401 would leave the SPA "logged in" but unable to do
   * anything until the user manually re-loaded.
   */
  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const ah = authHeader();
    if (ah) headers.set('Authorization', ah);
    if (
      opts.body &&
      !(opts.body instanceof FormData) &&
      !(opts.body instanceof Blob) &&
      !(opts.body instanceof ArrayBuffer) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json');
    }
    const responseType = opts.responseType || 'auto';
    // Strip our extension so it doesn't leak into the underlying fetch().
    const { responseType: _ignored, ...fetchOpts } = opts;
    const res = await fetch(path, { ...fetchOpts, headers });
    if (res.status === 401) {
      // The session is already gone server-side (revoked / expired
      // / forged) — calling /logout would recurse 401 → logout →
      // 401. Skip the round-trip and just clear local state.
      logout({ silent: true });
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = j.detail || JSON.stringify(j); } catch {}
      const err = new Error(`${res.status}: ${detail}`);
      err.status = res.status;
      try { err.body = await res.clone().json(); } catch {}
      throw err;
    }
    if (responseType === 'response') return res;
    if (responseType === 'blob') return res.blob();
    if (res.status === 204) return null;
    if (responseType === 'text') return res.text();
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ---------- Toasts ----------
  function toast(msg, kind = 'info') {
    const host = document.getElementById('toast-host');
    const el = document.createElement('div');
    const tones = {
      info: 'bg-slate-800/90 text-slate-100 border-slate-700',
      success: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
      error: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
      warn: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    };
    el.className = `pointer-events-auto fade-in border rounded-lg px-4 py-2 text-sm shadow-lg backdrop-blur ${tones[kind] || tones.info}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 3500);
    setTimeout(() => el.remove(), 4000);
  }

  // ---------- Modal ----------
  //
  // P0 #2: titles are set via textContent on the rendered <h3>, NOT
  // interpolated into the innerHTML scaffold. The previous version
  // injected `${title}` into innerHTML directly, which made every
  // caller's `title: 'Edit: ' + filename` an XSS sink because file
  // names inside volumes are attacker-controlled (any process running
  // inside a container can write a file named '<img src=x onerror=...>').
  function modal({ title, body, actions, size = 'lg', onBeforeClose, ref }) {
    return new Promise((resolve) => {
      const host = document.getElementById('modal-host');
      const wrap = document.createElement('div');
      wrap.className = 'fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 fade-in';
      const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[98vw]' };
      const heights = { full: 'h-[96vh]' };
      wrap.innerHTML = `
        <div class="w-full ${widths[size] || widths.lg} ${heights[size] || 'max-h-[90vh]'} overflow-hidden flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
          <div class="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <h3 class="text-sm font-semibold" data-role="title"></h3>
            <button class="text-slate-400 hover:text-white" data-act="close">✕</button>
          </div>
          <div class="flex-1 overflow-auto scroll-thin p-5" data-role="body"></div>
          <div class="flex justify-end gap-2 border-t border-slate-800 bg-slate-900/50 px-5 py-3" data-role="actions"></div>
        </div>`;
      // Title via textContent — never innerHTML. Callers that want
      // rich-text titles (e.g. a "dirty" bullet badge) must use the
      // `ref.titleEl` handle and build their own DOM nodes.
      const titleEl = wrap.querySelector('[data-role="title"]');
      titleEl.textContent = String(title == null ? '' : title);
      const bodyEl = wrap.querySelector('[data-role="body"]');
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body instanceof Node) bodyEl.appendChild(body);

      const actionsEl = wrap.querySelector('[data-role="actions"]');
      const tryClose = async (val) => {
        // onBeforeClose returning false (or a Promise resolving to false)
        // cancels the close. Used by the editor to prompt "discard unsaved
        // changes?" before letting the user dismiss the modal.
        if (onBeforeClose) {
          try { if ((await onBeforeClose(val)) === false) return; } catch { /* ignore */ }
        }
        wrap.remove(); resolve(val);
      };
      // Forced close — skips the onBeforeClose hook. Used by action
      // buttons whose own onClick already handled the dirty-state
      // confirmation (e.g. Save → close on success).
      const forceClose = (val) => { wrap.remove(); resolve(val); };

      (actions || [{ label: 'Close', value: null, kind: 'secondary' }]).forEach((a) => {
        const b = document.createElement('button');
        const kinds = {
          primary: 'bg-sky-500 hover:bg-sky-400 text-slate-950',
          danger: 'bg-rose-500 hover:bg-rose-400 text-white',
          secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700',
        };
        b.className = `rounded-md px-3 py-1.5 text-sm font-medium transition ${kinds[a.kind] || kinds.secondary}`;
        b.textContent = a.label;
        b.onclick = async () => {
          if (a.onClick) {
            try { const r = await a.onClick(); if (r === false) return; } catch (e) { toast(e.message, 'error'); return; }
          }
          // Action buttons skip the onBeforeClose hook by default — their
          // onClick is expected to handle any save/discard logic itself.
          // Cancel actions can opt in by setting `confirmBeforeClose: true`.
          if (a.confirmBeforeClose) tryClose(a.value); else forceClose(a.value);
        };
        actionsEl.appendChild(b);
      });
      wrap.querySelector('[data-act="close"]').onclick = () => tryClose(null);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) tryClose(null); });

      // Optional handle for callers that need to mutate the modal after mount
      // (the editor uses it to toggle title text + resize on full-screen).
      if (ref) {
        ref.titleEl = wrap.querySelector('[data-role="title"]');
        ref.bodyEl = bodyEl;
        ref.container = wrap.querySelector('.w-full');
        ref.close = forceClose;
        ref.resize = (newSize) => {
          const w = widths[newSize] || widths.lg;
          const h = heights[newSize] || 'max-h-[90vh]';
          const c = ref.container;
          // Remove any previous width/height utility, then add the new ones.
          c.className = c.className
            .replace(/max-w-\S+/g, '').replace(/max-h-\S+/g, '').replace(/\bh-\S+/g, '');
          c.classList.add(...w.split(' '), ...h.split(' '));
        };
      }
      host.appendChild(wrap);
    });
  }

  /**
   * Modal-based replacement for `window.prompt`. Returns the entered
   * string, or null if cancelled. Validates the input with the
   * caller-supplied `validate(value)` callback — return null for OK,
   * a string for the error message.
   */
  function inputModal({
    title = 'Input',
    label = 'Value',
    initial = '',
    placeholder = '',
    okLabel = 'OK',
    validate = () => null,
  } = {}) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <label class="block">
        <span class="text-xs uppercase tracking-wider text-slate-400" data-role="label"></span>
        <input data-role="input" type="text"
               class="mt-2 w-full rounded border-slate-700 bg-slate-950 text-sm" />
      </label>
      <p data-role="err" class="mt-2 text-xs text-rose-300 hidden"></p>`;
    wrap.querySelector('[data-role="label"]').textContent = label;
    const input = wrap.querySelector('[data-role="input"]');
    input.value = initial;
    input.placeholder = placeholder;
    const err = wrap.querySelector('[data-role="err"]');
    function setErr(msg) {
      if (msg) { err.textContent = msg; err.classList.remove('hidden'); }
      else { err.textContent = ''; err.classList.add('hidden'); }
    }
    // Focus the input on next tick after the modal mounts.
    setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 50);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const btn = [...document.querySelectorAll('#modal-host button')]
          .find((b) => b.textContent.trim() === okLabel);
        btn && btn.click();
      }
    });
    return modal({
      title, body: wrap, size: 'sm',
      actions: [
        { label: 'Cancel', value: null, kind: 'secondary' },
        { label: okLabel, kind: 'primary', value: 'ok', onClick: async () => {
          const v = input.value;
          const msg = validate(v);
          if (msg) { setErr(msg); return false; }
        }},
      ],
    }).then((res) => (res === 'ok' ? input.value : null));
  }

  function confirmModal(message, { danger = false, confirmLabel = 'Confirm' } = {}) {
    return modal({
      title: 'Confirm',
      size: 'sm',
      body: `<p class="text-sm text-slate-300">${message}</p>`,
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
      ],
    });
  }

  // ---------- Bulk selection + action bar helper ----------
  //
  // Every list view in the SPA needs the same multi-select infrastructure:
  // a Set of keys to track selection, a header checkbox that selects every
  // visible row, a per-row checkbox, and a sticky action bar that appears
  // when ≥1 row is selected. Rather than reimplement it 6 times we
  // centralise the plumbing here. Each view supplies:
  //
  //   key(item)         — how to identify a row (id, name, etc.)
  //   isEligible(item)  — can the row be selected at all? (e.g. system
  //                       networks aren't bulk-deletable)
  //   onChange()        — called whenever the selection size changes
  //
  // and gets back:
  //
  //   selected         — Set<key>
  //   wireRow(rowEl)   — attaches the row checkbox change handler
  //   selectAllCheckbox(items) → HTML for the header checkbox + JS to wire
  //   bulkBar({...})   — the action-bar DOM node (hidden when empty)
  //   handleBulkResp(out) — common per-item toast surfacing for backend
  //                        `{succeeded, failed, results: [...]}`
  //
  // None of this is mandatory — views that need bespoke behaviour
  // (e.g. system-network rows hide the checkbox entirely) can opt out
  // of any individual helper.
  function createBulkSelection({ key = (x) => x.id, isEligible = () => true, onChange } = {}) {
    const selected = new Set();
    return {
      selected,
      // Filter the currently-loaded items down to those eligible to
      // appear in bulk actions. Pages may show ineligible rows but
      // mustn't put them in the selection.
      eligibleOf(items) {
        return (items || []).filter(isEligible);
      },
      // Drop any selections whose underlying row has disappeared from
      // the loaded set — called from each view's refresh handler so
      // selections survive a redraw but don't accumulate ghosts.
      pruneAgainst(items) {
        const live = new Set((items || []).map(key));
        for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
      },
      add(k) { selected.add(k); onChange && onChange(selected); },
      delete(k) { selected.delete(k); onChange && onChange(selected); },
      clear() { selected.clear(); onChange && onChange(selected); },
      has(k) { return selected.has(k); },
      get size() { return selected.size; },
      values() { return [...selected]; },
    };
  }

  /**
   * Build the shared bulk action bar DOM. Hidden when selection is empty.
   *
   *   actions: [{label, kind, onClick(selected: string[])}]
   *
   * onClick is invoked with the current selection array; if it
   * returns truthy / resolves to truthy, the bar's selection is
   * cleared after the action (typical for delete-style ops). Each
   * action button is full-keyboard-accessible (button element, no
   * <a href>).
   */
  function bulkBar(bulkSel, { actions = [], emptyLabel = 'selected' } = {}) {
    const bar = document.createElement('div');
    bar.className = 'mb-2 hidden items-center justify-between rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs';
    const left = document.createElement('span');
    const count = document.createElement('span');
    count.className = 'font-semibold text-sky-200';
    count.textContent = '0';
    left.appendChild(count);
    left.appendChild(document.createTextNode(` ${emptyLabel}`));
    const right = document.createElement('div');
    right.className = 'flex items-center flex-wrap gap-2';

    const buttons = actions.map((a) => {
      const b = document.createElement('button');
      const kinds = {
        primary:   'bg-sky-500/80 hover:bg-sky-500 text-slate-950',
        success:   'bg-emerald-500/80 hover:bg-emerald-500 text-white',
        warn:      'bg-amber-500/80 hover:bg-amber-500 text-slate-950',
        danger:    'bg-rose-500/80 hover:bg-rose-500 text-white',
        secondary: 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100',
      };
      b.className = `rounded ${kinds[a.kind] || kinds.secondary} px-2 py-1 disabled:opacity-50`;
      b.textContent = a.label;
      b.onclick = async () => {
        const ids = bulkSel.values();
        if (!ids.length) return;
        b.disabled = true;
        try {
          const clearAfter = await a.onClick(ids);
          if (clearAfter !== false) bulkSel.clear();
        } finally {
          b.disabled = false;
          render();
        }
      };
      right.appendChild(b);
      return b;
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-slate-300';
    clearBtn.textContent = 'Clear';
    clearBtn.onclick = () => { bulkSel.clear(); render(); };
    right.appendChild(clearBtn);

    bar.appendChild(left);
    bar.appendChild(right);

    function render() {
      if (bulkSel.size === 0) {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
      } else {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
        count.textContent = String(bulkSel.size);
      }
    }

    render();
    return { el: bar, render, buttons };
  }

  /**
   * Surface a bulk-response `{succeeded, failed, results}` to the user
   * uniformly — one toast per failure, one summary toast at the end.
   * `verb` is used for the summary (e.g. "Started", "Deleted").
   */
  function handleBulkResponse(out, verb, idLabel = (r) => r.id || r.name) {
    for (const r of out.results || []) {
      if (!r.ok) toast(`${idLabel(r)}: ${r.error || 'failed'}`, 'error');
    }
    const total = (out.succeeded || 0) + (out.failed || 0);
    if (out.succeeded) {
      toast(
        `${verb} ${out.succeeded}${out.failed ? ` of ${total}` : ''}`,
        out.failed ? 'warn' : 'success',
      );
    } else if (out.failed) {
      toast(`${verb} failed for all ${out.failed} item${out.failed === 1 ? '' : 's'}`, 'error');
    }
  }

  // ---------- Helpers ----------
  function fmtBytes(n) {
    if (n == null) return '—';
    const u = ['B','KB','MB','GB','TB','PB'];
    let i = 0; let v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString();
  }
  function shortId(id) { return (id || '').replace(/^sha256:/, '').slice(0, 12); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function statusBadge(status) {
    const s = (status || '').toLowerCase();
    const tone =
      s === 'running' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : s === 'paused' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
      : s === 'restarting' ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
      : 'bg-slate-700/40 text-slate-300 border border-slate-600/40';
    return `<span class="badge ${tone}">${escapeHtml(s || 'unknown')}</span>`;
  }

  // ---------- Auth flow ----------
  //
  // logout() now hits the backend to revoke the server-side session
  // FIRST, then clears local auth state. If the call fails (network
  // down, server gone), we still clear locally — the user wanted to
  // sign out and we shouldn't trap them in a stale logged-in state
  // — but they may need an admin to revoke the now-orphaned session
  // from the Sessions pane.
  //
  // `silent: true` skips the toast (useful for the auto-logout path
  // from the api() 401 handler, which already implies the session
  // is gone server-side).
  async function logout({ silent = false } = {}) {
    if (state.auth && state.auth.token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.auth.token}` },
        });
      } catch (e) {
        if (!silent) toast('Server-side logout failed; local session cleared anyway', 'warn');
      }
    }
    state.auth = null; saveAuth(null);
    if (!silent) toast('Signed out', 'success');
    render();
  }
  async function login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let detail = `Login failed (${res.status})`;
      try { const j = await res.json(); detail = j.detail || detail; } catch {}
      if (res.status === 401) detail = 'Invalid credentials';
      throw new Error(detail);
    }
    const data = await res.json();
    state.auth = {
      user: data.user,
      role: data.role,
      token: data.token,
      expires_at: Date.now() + (data.expires_in || 0) * 1000,
    };
    saveAuth(state.auth);
  }

  function renderLogin() {
    const app = document.getElementById('app');
    app.replaceChildren(document.getElementById('login-tpl').content.cloneNode(true));
    const form = app.querySelector('#login-form');
    const err = app.querySelector('#login-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      const fd = new FormData(form);
      try {
        await login(fd.get('username'), fd.get('password'));
        await bootstrap();
        render();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
  }

  // ---------- Shell + routing ----------
  function renderShell() {
    const app = document.getElementById('app');
    app.replaceChildren(document.getElementById('shell-tpl').content.cloneNode(true));

    const nav = app.querySelector('#nav');
    NAV.forEach(({ id, label, icon }) => {
      const a = document.createElement('a');
      const active = state.route === id;
      a.href = `#${id}`;
      a.className = `flex items-center gap-3 rounded-lg px-3 py-2 transition ${
        active ? 'bg-sky-500/15 text-sky-300' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
      }`;
      a.innerHTML = `<span class="text-base">${icon}</span><span>${label}</span>`;
      nav.appendChild(a);
    });

    const mobile = app.querySelector('#mobile-nav');
    NAV.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = label;
      if (state.route === id) opt.selected = true;
      mobile.appendChild(opt);
    });
    mobile.addEventListener('change', (e) => { window.location.hash = e.target.value; });

    app.querySelector('#user-pill').textContent = `${state.auth.user} (${state.auth.role})`;
    app.querySelector('#version-pill').textContent = `v${state.config.version}`;
    app.querySelector('#logout').onclick = logout;

    const view = app.querySelector('#view');
    const viewFn = views[state.route] || views.dashboard;
    viewFn(view).catch((e) => {
      view.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
    });

    pingLoop();
  }

  let pingTimer = null;
  async function pingLoop() {
    if (pingTimer) clearInterval(pingTimer);
    const update = async () => {
      try {
        await api('/api/system/ping');
        const dot = document.getElementById('ping-dot');
        const txt = document.getElementById('ping-text');
        if (dot) { dot.className = 'inline-block h-2 w-2 rounded-full bg-emerald-400'; }
        if (txt) txt.textContent = 'Daemon online';
      } catch (e) {
        const dot = document.getElementById('ping-dot');
        const txt = document.getElementById('ping-text');
        if (dot) { dot.className = 'inline-block h-2 w-2 rounded-full bg-rose-400'; }
        if (txt) txt.textContent = 'Daemon offline';
      }
    };
    update();
    pingTimer = setInterval(update, 15000);
  }

  function render() {
    if (!state.auth) {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      renderLogin();
      return;
    }
    renderShell();
  }

  async function bootstrap() {
    try { state.config = await api('/api/config'); } catch {}
  }

  window.addEventListener('hashchange', () => {
    const id = window.location.hash.replace('#', '');
    if (NAV.some((n) => n.id === id)) { state.route = id; render(); }
  });

  // ---------- Reusable UI bits ----------
  function pageHeader(title, subtitle, actions = '') {
    return `
      <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="text-xl font-semibold tracking-tight">${escapeHtml(title)}</h2>
          ${subtitle ? `<p class="mt-1 text-sm text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <div class="flex flex-wrap gap-2">${actions}</div>
      </div>`;
  }

  function btn(label, { kind = 'secondary', id = '', extra = '' } = {}) {
    const kinds = {
      primary: 'bg-sky-500 hover:bg-sky-400 text-slate-950',
      danger: 'bg-rose-500/90 hover:bg-rose-500 text-white',
      ghost: 'text-slate-300 hover:text-white hover:bg-slate-800/70',
      secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700',
    };
    return `<button ${id ? `id="${id}"` : ''} class="rounded-md px-3 py-1.5 text-xs font-medium transition ${kinds[kind]} ${extra}">${label}</button>`;
  }

  function table(headers, rows) {
    return `
      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="min-w-full divide-y divide-slate-800 text-sm">
          <thead class="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-400">
            <tr>${headers.map(h => `<th class="px-4 py-2 text-left font-medium">${h}</th>`).join('')}</tr>
          </thead>
          <tbody class="divide-y divide-slate-800/70 bg-slate-950/40">
            ${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="px-4 py-8 text-center text-slate-500">No items</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  function statCard(label, value, sub = '') {
    return `
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div class="text-xs uppercase tracking-wider text-slate-400">${label}</div>
        <div class="mt-1 text-2xl font-semibold">${value}</div>
        ${sub ? `<div class="mt-1 text-xs text-slate-500">${sub}</div>` : ''}
      </div>`;
  }

  function jsonView(obj) {
    const pre = document.createElement('pre');
    pre.className = 'log-pane text-slate-300 bg-slate-950/60 rounded-lg p-3 max-h-[60vh] overflow-auto scroll-thin border border-slate-800';
    pre.textContent = JSON.stringify(obj, null, 2);
    return pre;
  }

  // ---------- Views ----------
  const views = {};

  views.dashboard = async (root) => {
    root.innerHTML = pageHeader('Dashboard', 'Overview of your Docker host');
    let info = {}, df = {}, version = {};
    try { [info, df, version] = await Promise.all([
      api('/api/system/info'), api('/api/system/df'), api('/api/system/version'),
    ]); } catch (e) {
      root.innerHTML += `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      return;
    }

    const totalImagesSize = (df.Images || []).reduce((a, i) => a + (i.Size || 0), 0);
    const totalVolumesSize = (df.Volumes || []).reduce((a, v) => a + ((v.UsageData && v.UsageData.Size) || 0), 0);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 md:grid-cols-4 gap-3';
    grid.innerHTML = [
      statCard('Containers', info.Containers ?? '—', `${info.ContainersRunning ?? 0} running, ${info.ContainersStopped ?? 0} stopped`),
      statCard('Images', info.Images ?? '—', fmtBytes(totalImagesSize)),
      statCard('CPUs / Memory', `${info.NCPU ?? '—'} / ${fmtBytes(info.MemTotal)}`, info.OperatingSystem || ''),
      statCard('Volumes', (df.Volumes || []).length, fmtBytes(totalVolumesSize)),
    ].join('');
    root.appendChild(grid);

    const meta = document.createElement('div');
    meta.className = 'mt-6 grid gap-3 md:grid-cols-2';
    meta.innerHTML = `
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 class="text-sm font-semibold">Engine</h3>
        <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-slate-400">Version</dt><dd>${escapeHtml(version.Version || '—')}</dd>
          <dt class="text-slate-400">API</dt><dd>${escapeHtml(version.ApiVersion || '—')}</dd>
          <dt class="text-slate-400">Kernel</dt><dd>${escapeHtml(info.KernelVersion || '—')}</dd>
          <dt class="text-slate-400">Arch</dt><dd>${escapeHtml(info.Architecture || '—')}</dd>
          <dt class="text-slate-400">Storage</dt><dd>${escapeHtml(info.Driver || '—')}</dd>
          <dt class="text-slate-400">Logging</dt><dd>${escapeHtml(info.LoggingDriver || '—')}</dd>
        </dl>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 class="text-sm font-semibold">Host</h3>
        <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-slate-400">Name</dt><dd>${escapeHtml(info.Name || '—')}</dd>
          <dt class="text-slate-400">OS</dt><dd>${escapeHtml(info.OperatingSystem || '—')}</dd>
          <dt class="text-slate-400">OS type</dt><dd>${escapeHtml(info.OSType || '—')}</dd>
          <dt class="text-slate-400">CGroup</dt><dd>${escapeHtml(info.CgroupVersion || '—')}</dd>
          <dt class="text-slate-400">Server time</dt><dd>${fmtDate(info.SystemTime)}</dd>
          <dt class="text-slate-400">Warnings</dt><dd>${(info.Warnings || []).length}</dd>
        </dl>
      </div>`;
    root.appendChild(meta);

    let containers = [];
    try { containers = await api('/api/containers?all=true'); } catch {}
    const recent = containers.slice().sort((a, b) => (b.created || '').localeCompare(a.created || '')).slice(0, 8);
    const recentWrap = document.createElement('div');
    recentWrap.className = 'mt-6';
    recentWrap.innerHTML = `<h3 class="mb-3 text-sm font-semibold">Recent containers</h3>` + table(
      ['Name', 'Image', 'Status', 'Created'],
      recent.map((c) => `
        <tr class="hover:bg-slate-900/60">
          <td class="px-4 py-2 font-medium"><a class="text-sky-300 hover:underline" href="#containers">${escapeHtml(c.name)}</a></td>
          <td class="px-4 py-2 text-slate-300">${escapeHtml(c.image || '—')}</td>
          <td class="px-4 py-2">${statusBadge(c.state || c.status)}</td>
          <td class="px-4 py-2 text-slate-400">${fmtDate(c.created)}</td>
        </tr>`)
    );
    root.appendChild(recentWrap);
  };

  // ---------- Containers ----------
  views.containers = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Containers',
      'Manage container lifecycle, view logs, inspect details',
      `${isAdmin ? btn('+ Run container', { kind: 'primary', id: 'new-container' }) : ''}
       ${isAdmin ? btn('Prune stopped', { kind: 'secondary', id: 'prune-containers' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );
    const list = document.createElement('div');
    root.appendChild(list);

    const filterWrap = document.createElement('div');
    filterWrap.className = 'mb-4 flex flex-wrap items-center gap-2';
    filterWrap.innerHTML = `
      <input id="search" type="search" placeholder="Search by name or image…" class="w-full sm:w-72 rounded-md border-slate-700 bg-slate-950 text-sm" />
      <label class="flex items-center gap-2 text-xs text-slate-400">
        <input id="show-all" type="checkbox" checked class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Show stopped
      </label>
      <span id="containers-count" class="text-xs text-slate-500 ml-auto"></span>`;
    root.insertBefore(filterWrap, list);

    // ---- Multi-select + bulk bar ----
    const bulkSel = createBulkSelection({ key: (c) => c.id });
    // Bulk actions defined inline so each closes over `bulkSel` + load().
    // We hide the entire bar from non-admin users (read-only role).
    const bulkBarObj = isAdmin
      ? bulkBar(bulkSel, {
          actions: [
            { label: '▶ Start',     kind: 'success',   onClick: (ids) => bulkContainerAction('start',    ids, { verb: 'Started' }) },
            { label: '↻ Restart',   kind: 'secondary', onClick: (ids) => bulkContainerAction('restart',  ids, { verb: 'Restarted' }) },
            { label: '■ Stop',      kind: 'secondary', onClick: (ids) => bulkContainerAction('stop',     ids, { verb: 'Stopped', body: { timeout: 10 } }) },
            { label: '⏸ Pause',     kind: 'secondary', onClick: (ids) => bulkContainerAction('pause',    ids, { verb: 'Paused' }) },
            { label: '▷ Unpause',   kind: 'secondary', onClick: (ids) => bulkContainerAction('unpause',  ids, { verb: 'Unpaused' }) },
            { label: '⚡ Kill',     kind: 'warn',      onClick: (ids) => bulkContainerAction('kill',     ids, { verb: 'Killed', confirm: true }) },
            { label: '✕ Remove',    kind: 'danger',    onClick: (ids) => bulkContainerRemove(ids) },
          ],
        })
      : { el: document.createElement('div'), render: () => {} };
    root.insertBefore(bulkBarObj.el, list);

    let containers = [];
    let query = '';
    let showAll = true;

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        containers = await api(`/api/containers?all=${showAll}`);
        bulkSel.pruneAgainst(containers);
        draw();
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    async function bulkContainerAction(verb, ids, { body = {}, verb: msg = 'Acted on', confirm: needConfirm = false } = {}) {
      if (needConfirm) {
        const ok = await confirmModal(
          `${msg} <strong>${ids.length}</strong> container${ids.length === 1 ? '' : 's'}?`,
          { danger: true, confirmLabel: msg },
        );
        if (!ok) return false; // keep selection
      }
      try {
        const out = await api(`/api/containers/${verb}/bulk`, {
          method: 'POST', body: JSON.stringify({ ids, ...body }),
        });
        handleBulkResponse(out, msg, (r) => containers.find((c) => c.id === r.id)?.name || r.id.slice(0, 12));
      } catch (e) { toast(`Bulk ${verb} failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    async function bulkContainerRemove(ids) {
      // Two-stage confirm: first plain confirm. If the daemon refuses
      // because any container is running (per-item 409 message in
      // results), we offer a single secondary confirm and retry the
      // failed ones with force=true + volumes=false.
      const ok = await confirmModal(
        `Remove <strong>${ids.length}</strong> container${ids.length === 1 ? '' : 's'}? Running containers will fail; you'll be offered force-remove on those.`,
        { danger: true, confirmLabel: 'Remove' },
      );
      if (!ok) return false;
      try {
        const out = await api('/api/containers/remove/bulk', {
          method: 'POST', body: JSON.stringify({ ids, force: false, volumes: false }),
        });
        const stuck = (out.results || []).filter((r) => !r.ok && /running|force/i.test(r.error || ''));
        handleBulkResponse(out, 'Removed', (r) => containers.find((c) => c.id === r.id)?.name || r.id.slice(0, 12));
        if (stuck.length) {
          const stuckIds = stuck.map((r) => r.id);
          const forceOk = await confirmModal(
            `<strong>${stuck.length}</strong> container${stuck.length === 1 ? ' is' : 's are'} still running.<br>` +
            `Force-remove will SIGKILL them mid-flight (anonymous volumes left intact). Continue?`,
            { danger: true, confirmLabel: 'Force remove' },
          );
          if (forceOk) {
            try {
              const out2 = await api('/api/containers/remove/bulk', {
                method: 'POST', body: JSON.stringify({ ids: stuckIds, force: true, volumes: false }),
              });
              handleBulkResponse(out2, 'Force-removed', (r) => containers.find((c) => c.id === r.id)?.name || r.id.slice(0, 12));
            } catch (e) { toast(`Force remove failed: ${e.message}`, 'error'); }
          }
        }
      } catch (e) { toast(`Bulk remove failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    function draw() {
      const q = query.toLowerCase();
      const items = containers.filter((c) =>
        !q || c.name.toLowerCase().includes(q) || (c.image || '').toLowerCase().includes(q)
      );
      filterWrap.querySelector('#containers-count').textContent =
        `${items.length} of ${containers.length} shown` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');

      const rows = items.map((c) => {
        const checked = bulkSel.has(c.id) ? 'checked' : '';
        return `
        <tr class="hover:bg-slate-900/60">
          <td class="px-3 py-2 w-8">
            ${isAdmin ? `<input type="checkbox" class="containers-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-id="${c.id}" ${checked}/>` : ''}
          </td>
          <td class="px-4 py-2">
            <button data-act="inspect" data-id="${c.id}" class="text-left">
              <div class="font-medium text-sky-300 hover:underline">${escapeHtml(c.name)}</div>
              <div class="text-[11px] text-slate-500 font-mono">${shortId(c.id)}</div>
            </button>
          </td>
          <td class="px-4 py-2 text-slate-300">${escapeHtml(c.image || '—')}</td>
          <td class="px-4 py-2">${statusBadge(c.state || c.status)}</td>
          <td class="px-4 py-2 text-slate-400 font-mono text-xs">${formatPorts(c.ports)}</td>
          <td class="px-4 py-2 text-slate-400">${fmtDate(c.created)}</td>
          <td class="px-4 py-2">
            <div class="flex flex-wrap justify-end gap-1">
              ${isAdmin ? actionButton(c, 'start', '▶ Start', 'primary', c.state === 'running') : ''}
              ${isAdmin ? actionButton(c, 'restart', '↻ Restart', 'secondary', false) : ''}
              ${isAdmin ? actionButton(c, 'stop', '■ Stop', 'secondary', c.state !== 'running') : ''}
              <button data-act="logs" data-id="${c.id}" class="rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Logs</button>
              ${isAdmin ? `<button data-act="exec" data-id="${c.id}" data-name="${escapeHtml(c.name)}" class="rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs" ${c.state !== 'running' ? 'disabled' : ''} ${c.state !== 'running' ? 'title="Container must be running"' : ''}>⌨ Terminal</button>` : ''}
              ${isAdmin ? `<button data-act="remove" data-id="${c.id}" class="rounded-md bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>` : ''}
            </div>
          </td>
        </tr>`;
      });
      list.innerHTML = table(
        [
          isAdmin
            ? `<input id="containers-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all visible"/>`
            : '',
          'Name', 'Image', 'Status', 'Ports', 'Created', '<span class="sr-only">Actions</span>',
        ],
        rows
      );
      // Wire the select-all checkbox state — checked only when every
      // visible row is selected; indeterminate for partial selection.
      const cb = list.querySelector('#containers-select-all');
      if (cb) {
        const onPage = items.filter((c) => bulkSel.has(c.id)).length;
        cb.checked = items.length > 0 && onPage === items.length;
        cb.indeterminate = onPage > 0 && onPage < items.length;
        cb.addEventListener('change', (e) => {
          if (e.target.checked) for (const c of items) bulkSel.add(c.id);
          else for (const c of items) bulkSel.delete(c.id);
          draw(); bulkBarObj.render();
        });
      }
    }

    function actionButton(c, act, label, kind, disabled) {
      const kinds = {
        primary: 'bg-emerald-500/80 hover:bg-emerald-500 text-white',
        secondary: 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100',
      };
      return `<button data-act="${act}" data-id="${c.id}" ${disabled ? 'disabled' : ''}
        class="${kinds[kind]} rounded-md px-2 py-1 text-xs disabled:opacity-40 disabled:cursor-not-allowed">${label}</button>`;
    }

    function formatPorts(ports) {
      if (!ports || !Object.keys(ports).length) return '—';
      const parts = [];
      for (const [containerPort, bindings] of Object.entries(ports)) {
        if (Array.isArray(bindings)) {
          for (const b of bindings) {
            parts.push(`${b.HostIp || '0.0.0.0'}:${b.HostPort}→${containerPort}`);
          }
        } else {
          parts.push(containerPort);
        }
      }
      return escapeHtml(parts.join(', '));
    }

    list.addEventListener('change', (e) => {
      // Per-row checkbox — updates the selection Set and refreshes the
      // header checkbox state + bulk bar.
      const cb = e.target.closest('input.containers-check');
      if (!cb) return;
      if (cb.checked) bulkSel.add(cb.dataset.id);
      else bulkSel.delete(cb.dataset.id);
      bulkBarObj.render();
      // Refresh the count in the filter bar + select-all checkbox without
      // a full table re-render.
      const q = query.toLowerCase();
      const items = containers.filter((c) =>
        !q || c.name.toLowerCase().includes(q) || (c.image || '').toLowerCase().includes(q)
      );
      filterWrap.querySelector('#containers-count').textContent =
        `${items.length} of ${containers.length} shown` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');
      const all = list.querySelector('#containers-select-all');
      if (all) {
        const onPage = items.filter((c) => bulkSel.has(c.id)).length;
        all.checked = items.length > 0 && onPage === items.length;
        all.indeterminate = onPage > 0 && onPage < items.length;
      }
    });

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || t.disabled) return;
      const id = t.dataset.id;
      const act = t.dataset.act;
      try {
        if (act === 'inspect') return showContainerInspect(id);
        if (act === 'logs') return showContainerLogs(id);
        if (act === 'exec') return openTerminal(id, t.dataset.name);
        if (act === 'remove') {
          const ok = await confirmModal('Remove this container? This cannot be undone.', { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
          await api(`/api/containers/${id}?force=true&volumes=false`, { method: 'DELETE' });
          toast('Container removed', 'success');
        } else {
          await api(`/api/containers/${id}/${act}`, { method: 'POST' });
          toast(`Container ${act}ed`, 'success');
        }
        await load();
      } catch (ex) { toast(ex.message, 'error'); }
    });

    filterWrap.querySelector('#search').addEventListener('input', (e) => { query = e.target.value; draw(); });
    filterWrap.querySelector('#show-all').addEventListener('change', (e) => { showAll = e.target.checked; load(); });

    document.getElementById('refresh').onclick = load;
    const pruneBtn = document.getElementById('prune-containers');
    if (pruneBtn) pruneBtn.onclick = async () => {
      const ok = await confirmModal('Remove all stopped containers?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try {
        const r = await api('/api/containers/prune', { method: 'POST' });
        toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    };
    const newBtn = document.getElementById('new-container');
    if (newBtn) newBtn.onclick = () => runContainerDialog().then((created) => { if (created) load(); });

    await load();
  };

  // ---------- Container inspect (structured + tabbed) ----------
  function _ago(iso) {
    if (!iso || iso.startsWith('0001-')) return '—';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }
  function _dur(startIso, endIso) {
    if (!startIso || startIso.startsWith('0001-')) return '—';
    const start = new Date(startIso).getTime();
    const end = endIso && !endIso.startsWith('0001-') ? new Date(endIso).getTime() : Date.now();
    let s = Math.max(0, Math.floor((end - start) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600);  s -= h * 3600;
    const m = Math.floor(s / 60);    s -= m * 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
  }
  function _healthTone(s) {
    s = (s || '').toLowerCase();
    if (s === 'healthy') return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
    if (s === 'unhealthy') return 'bg-rose-500/15 text-rose-300 border border-rose-500/30';
    if (s === 'starting') return 'bg-amber-500/15 text-amber-300 border border-amber-500/30';
    return 'bg-slate-700/40 text-slate-300 border border-slate-600/40';
  }
  function _defList(items) {
    const rows = items
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v, opts = {}]) => {
        const valHtml = opts.html ? v : `<span class="${opts.mono ? 'font-mono text-xs break-all' : ''}">${escapeHtml(String(v))}</span>`;
        return `<dt class="text-slate-400">${escapeHtml(k)}</dt><dd>${valHtml}</dd>`;
      });
    if (!rows.length) return `<p class="text-xs text-slate-500">No data.</p>`;
    return `<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">${rows.join('')}</dl>`;
  }
  function _kvTable(title, obj, { mono = false, masked = false } = {}) {
    const entries = Object.entries(obj || {});
    if (!entries.length) {
      return `<div class="rounded-lg border border-slate-800 bg-slate-900/30 p-3 text-xs text-slate-500">${escapeHtml(title)}: none</div>`;
    }
    const looksSecret = (k) => /(password|secret|token|key|auth|api[_-]?key|credential)/i.test(k);
    const rows = entries.map(([k, v]) => {
      const masked2 = masked && looksSecret(k);
      return `
        <tr class="hover:bg-slate-900/60">
          <td class="px-3 py-1 align-top font-mono text-xs text-slate-300 whitespace-nowrap">${escapeHtml(k)}</td>
          <td class="px-3 py-1 ${mono ? 'font-mono text-xs' : 'text-sm'} text-slate-200 break-all">
            ${masked2
              ? `<span class="text-slate-500 italic">•••••• <button data-reveal class="ml-2 underline text-sky-400 text-[11px]">show</button></span><span class="hidden">${escapeHtml(String(v))}</span>`
              : escapeHtml(String(v))}
          </td>
        </tr>`;
    }).join('');
    return `
      <div class="rounded-lg border border-slate-800 bg-slate-950/40 overflow-hidden">
        <div class="border-b border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(title)} (${entries.length})</div>
        <table class="w-full text-sm"><tbody class="divide-y divide-slate-800/70">${rows}</tbody></table>
      </div>`;
  }
  function _miniTable(title, headers, rows) {
    if (!rows.length) {
      return `<div class="rounded-lg border border-slate-800 bg-slate-900/30 p-3 text-xs text-slate-500">${escapeHtml(title)}: none</div>`;
    }
    return `
      <div class="rounded-lg border border-slate-800 bg-slate-950/40 overflow-hidden">
        <div class="border-b border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(title)} (${rows.length})</div>
        <table class="w-full text-sm">
          <thead class="bg-slate-900/40 text-[11px] uppercase tracking-wider text-slate-400">
            <tr>${headers.map(h => `<th class="px-3 py-1 text-left font-medium">${h}</th>`).join('')}</tr>
          </thead>
          <tbody class="divide-y divide-slate-800/70">${rows.join('')}</tbody>
        </table>
      </div>`;
  }

  function _ciOverview(d) {
    const cfg = d.Config || {}, st = d.State || {}, host = d.HostConfig || {};
    const items = [
      ['Status', `${statusBadge(st.Status)}`, { html: true }],
      ['Uptime', st.Status === 'running' ? _dur(st.StartedAt, null) : '—'],
      ['Image', `${escapeHtml(cfg.Image || '')} <span class="text-slate-500 font-mono text-xs">(${shortId(d.Image)})</span>`, { html: true }],
      ['Command', (cfg.Cmd || []).join(' '), { mono: true }],
      ['Entrypoint', (cfg.Entrypoint || []).join(' '), { mono: true }],
      ['Working dir', cfg.WorkingDir],
      ['User', cfg.User],
      ['Restart policy', host.RestartPolicy?.Name + (host.RestartPolicy?.MaximumRetryCount ? ` (max ${host.RestartPolicy.MaximumRetryCount})` : '')],
      ['Restart count', d.RestartCount ?? 0],
      ['Created', `${fmtDate(d.Created)} <span class="text-slate-500">(${_ago(d.Created)})</span>`, { html: true }],
      ['Started', `${fmtDate(st.StartedAt)} <span class="text-slate-500">(${_ago(st.StartedAt)})</span>`, { html: true }],
    ];
    if (st.FinishedAt && !st.FinishedAt.startsWith('0001-')) {
      items.push(['Finished', `${fmtDate(st.FinishedAt)} <span class="text-slate-500">(${_ago(st.FinishedAt)})</span>`, { html: true }]);
      items.push(['Exit code', st.ExitCode]);
      if (st.Error) items.push(['Error', st.Error]);
    }
    if (cfg.Hostname) items.push(['Hostname', cfg.Hostname]);
    if (cfg.Domainname) items.push(['Domain', cfg.Domainname]);
    if (cfg.MacAddress) items.push(['MAC address', cfg.MacAddress]);
    if (cfg.StopSignal) items.push(['Stop signal', cfg.StopSignal]);

    let healthHtml = '';
    if (st.Health) {
      const tone = _healthTone(st.Health.Status);
      const recent = (st.Health.Log || []).slice(-5).reverse().map((l) => `
        <li class="flex items-center gap-2 text-xs">
          <span class="${l.ExitCode === 0 ? 'text-emerald-400' : 'text-rose-400'}">${l.ExitCode === 0 ? '✓' : '✗'}</span>
          <span class="text-slate-500 font-mono">${fmtDate(l.Start).split(',')[1]?.trim() || ''}</span>
          <span class="text-slate-300 truncate flex-1">${escapeHtml((l.Output || '').slice(0, 120) || '(no output)')}</span>
        </li>`).join('');
      healthHtml = `
        <div class="mt-4 rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          <div class="mb-2 flex items-center gap-2 text-sm">
            <span class="text-slate-400">Health:</span>
            <span class="badge ${tone}">${escapeHtml(st.Health.Status)}</span>
            <span class="text-slate-500 text-xs">(${st.Health.FailingStreak || 0} failing)</span>
          </div>
          ${recent ? `<ul class="space-y-1">${recent}</ul>` : '<p class="text-xs text-slate-500">No health-check history.</p>'}
        </div>`;
    }
    return `<div>${_defList(items)}${healthHtml}</div>`;
  }

  function _ciNetworking(d) {
    const ns = d.NetworkSettings || {};
    const cfg = d.Config || {};
    const host = d.HostConfig || {};
    const networks = Object.entries(ns.Networks || {});

    const netRows = networks.map(([name, n]) => `
      <tr class="hover:bg-slate-900/60">
        <td class="px-3 py-1 font-medium text-slate-200">${escapeHtml(name)}</td>
        <td class="px-3 py-1 text-slate-300 font-mono text-xs">${escapeHtml(n.IPAddress || '')}${n.IPPrefixLen ? '/'+n.IPPrefixLen : ''}</td>
        <td class="px-3 py-1 text-slate-400 font-mono text-xs">${escapeHtml(n.Gateway || '')}</td>
        <td class="px-3 py-1 text-slate-400 font-mono text-xs">${escapeHtml(n.MacAddress || '')}</td>
        <td class="px-3 py-1 text-slate-400 text-xs">${(n.Aliases || []).map(escapeHtml).join(', ') || '—'}</td>
      </tr>`);

    const portRows = Object.entries(ns.Ports || {}).map(([cp, bindings]) => {
      const bs = (bindings || []).map(b => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ') || '<span class="text-slate-500">(unpublished)</span>';
      return `
        <tr class="hover:bg-slate-900/60">
          <td class="px-3 py-1 font-mono text-xs text-slate-200">${escapeHtml(cp)}</td>
          <td class="px-3 py-1 font-mono text-xs text-slate-300">${bs}</td>
        </tr>`;
    });

    const exposed = Object.keys(cfg.ExposedPorts || {});
    const dns = (host.Dns || []).join(', ');
    const dnsSearch = (host.DnsSearch || []).join(', ');
    const extraHosts = (host.ExtraHosts || []).reduce((acc, e) => {
      const i = e.indexOf(':'); if (i > 0) acc[e.slice(0, i)] = e.slice(i+1); return acc;
    }, {});

    return `
      <div class="space-y-3">
        ${_defList([
          ['Network mode', host.NetworkMode],
          ['Hostname', cfg.Hostname],
          ['DNS', dns],
          ['DNS search', dnsSearch],
          ['Exposed ports', exposed.join(', ')],
        ])}
        ${_miniTable('Attached networks', ['Network', 'IP', 'Gateway', 'MAC', 'Aliases'], netRows)}
        ${_miniTable('Published ports', ['Container', 'Host bindings'], portRows)}
        ${_kvTable('Extra hosts (/etc/hosts)', extraHosts, { mono: true })}
      </div>`;
  }

  function _ciStorage(d) {
    const mounts = (d.Mounts || []).map(m => `
      <tr class="hover:bg-slate-900/60">
        <td class="px-3 py-1 text-xs"><span class="badge bg-slate-700/40 text-slate-300 border border-slate-600/40">${escapeHtml(m.Type || '')}</span></td>
        <td class="px-3 py-1 font-mono text-xs text-slate-300 break-all">${escapeHtml(m.Source || m.Name || '')}</td>
        <td class="px-3 py-1 font-mono text-xs text-slate-300 break-all">${escapeHtml(m.Destination || '')}</td>
        <td class="px-3 py-1 text-xs text-slate-400">${m.Mode || ''}${m.RW === false ? ' (ro)' : ''}</td>
      </tr>`);
    const tmpfs = d.HostConfig?.Tmpfs || {};
    return `
      <div class="space-y-3">
        ${_miniTable('Mounts', ['Type', 'Source', 'Destination', 'Mode'], mounts)}
        ${_kvTable('tmpfs', tmpfs, { mono: true })}
        ${_defList([
          ['Read-only root', d.HostConfig?.ReadonlyRootfs ? 'yes' : null],
          ['SHM size', d.HostConfig?.ShmSize ? fmtBytes(d.HostConfig.ShmSize) : null],
        ])}
      </div>`;
  }

  function _ciEnv(d) {
    const env = {};
    for (const e of (d.Config?.Env || [])) {
      const i = e.indexOf('=');
      if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
      else env[e] = '';
    }
    return `
      <div class="space-y-3">
        ${_kvTable('Environment', env, { mono: true, masked: true })}
        ${_kvTable('Labels', d.Config?.Labels || {})}
      </div>`;
  }

  function _ciResources(d) {
    const h = d.HostConfig || {};
    const items = [
      ['CPUs (nano)', h.NanoCpus ? (h.NanoCpus / 1e9).toFixed(2) : null],
      ['CPU shares', h.CpuShares || null],
      ['Cpuset CPUs', h.CpusetCpus || null],
      ['CPU period / quota', (h.CpuPeriod || h.CpuQuota) ? `${h.CpuPeriod || '—'} / ${h.CpuQuota || '—'}` : null],
      ['Memory limit', h.Memory ? fmtBytes(h.Memory) : null],
      ['Memory reservation', h.MemoryReservation ? fmtBytes(h.MemoryReservation) : null],
      ['Memory + swap', h.MemorySwap > 0 ? fmtBytes(h.MemorySwap) : (h.MemorySwap === -1 ? 'unlimited' : null)],
      ['PIDs limit', h.PidsLimit || null],
      ['OOM score adj', h.OomScoreAdj || null],
      ['Privileged', h.Privileged ? 'yes' : null],
      ['Init', h.Init ? 'yes' : null],
      ['Auto-remove', h.AutoRemove ? 'yes' : null],
      ['Log driver', h.LogConfig?.Type || null],
    ];
    const ulimits = (h.Ulimits || []).map(u => `
      <tr class="hover:bg-slate-900/60">
        <td class="px-3 py-1 font-mono text-xs">${escapeHtml(u.Name)}</td>
        <td class="px-3 py-1 font-mono text-xs">${u.Soft}</td>
        <td class="px-3 py-1 font-mono text-xs">${u.Hard}</td>
      </tr>`);
    const devices = (h.Devices || []).map(dv => `
      <tr class="hover:bg-slate-900/60">
        <td class="px-3 py-1 font-mono text-xs">${escapeHtml(dv.PathOnHost || '')}</td>
        <td class="px-3 py-1 font-mono text-xs">${escapeHtml(dv.PathInContainer || '')}</td>
        <td class="px-3 py-1 font-mono text-xs text-slate-400">${escapeHtml(dv.CgroupPermissions || '')}</td>
      </tr>`);
    const sysctls = h.Sysctls || {};
    const logOpts = h.LogConfig?.Config || {};
    return `
      <div class="space-y-3">
        ${_defList(items)}
        ${_miniTable('Ulimits', ['Name', 'Soft', 'Hard'], ulimits)}
        ${_miniTable('Devices', ['Host', 'Container', 'Cgroup perms'], devices)}
        ${_kvTable('Sysctls', sysctls, { mono: true })}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Capabilities added</div>
            <div class="flex flex-wrap gap-1">${(h.CapAdd || []).map(c => `<span class="badge bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">${escapeHtml(c)}</span>`).join('') || '<span class="text-xs text-slate-500">none</span>'}</div>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Capabilities dropped</div>
            <div class="flex flex-wrap gap-1">${(h.CapDrop || []).map(c => `<span class="badge bg-rose-500/15 text-rose-300 border border-rose-500/30">${escapeHtml(c)}</span>`).join('') || '<span class="text-xs text-slate-500">none</span>'}</div>
          </div>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Security options</div>
          <div class="flex flex-wrap gap-1">${(h.SecurityOpt || []).map(c => `<span class="badge bg-slate-700/40 text-slate-300 border border-slate-600/40">${escapeHtml(c)}</span>`).join('') || '<span class="text-xs text-slate-500">none</span>'}</div>
        </div>
        ${_kvTable('Log driver options', logOpts, { mono: true })}
      </div>`;
  }

  async function showContainerInspect(id) {
    let data;
    try { data = await api(`/api/containers/${id}`); }
    catch (e) { toast(e.message, 'error'); return; }

    const TABS = [
      { id: 'overview',   label: 'Overview',     render: () => _ciOverview(data) },
      { id: 'networking', label: 'Networking',   render: () => _ciNetworking(data) },
      { id: 'storage',    label: 'Storage',      render: () => _ciStorage(data) },
      { id: 'env',        label: 'Env & labels', render: () => _ciEnv(data) },
      { id: 'resources',  label: 'Resources',    render: () => _ciResources(data) },
      { id: 'raw',        label: 'Raw JSON',     render: () => null },
    ];

    const wrap = document.createElement('div');
    const cfg = data.Config || {}, st = data.State || {};
    const titleName = (data.Name || id).replace(/^\//, '');
    wrap.innerHTML = `
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <div class="min-w-0">
          <div class="text-base font-semibold text-slate-100 truncate">${escapeHtml(titleName)}</div>
          <div class="text-[11px] text-slate-500 font-mono">${shortId(data.Id)} <span class="text-slate-600">·</span> ${escapeHtml(cfg.Image || '')}</div>
        </div>
        ${statusBadge(st.Status)}
        ${st.Health ? `<span class="badge ${_healthTone(st.Health.Status)}">${escapeHtml(st.Health.Status)}</span>` : ''}
        ${st.Status === 'running' ? `<span class="text-xs text-slate-500">up ${_dur(st.StartedAt, null)}</span>` : ''}
      </div>
      <div class="border-b border-slate-800 mb-3 flex flex-wrap gap-1 text-xs" id="ci-tabs">
        ${TABS.map((t, i) => `<button data-tab="${t.id}" class="rounded-t px-3 py-2 transition ${i===0 ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}">${escapeHtml(t.label)}</button>`).join('')}
      </div>
      <div id="ci-pane" class="min-h-[200px]"></div>`;

    function paint(tabId) {
      const tab = TABS.find(t => t.id === tabId) || TABS[0];
      const pane = wrap.querySelector('#ci-pane');
      pane.replaceChildren();
      if (tab.id === 'raw') pane.appendChild(jsonView(data));
      else pane.innerHTML = tab.render();

      pane.querySelectorAll('[data-reveal]').forEach((b) => {
        b.onclick = () => {
          const hidden = b.parentElement.nextElementSibling;
          const slot = b.parentElement;
          slot.replaceWith(Object.assign(document.createElement('span'), {
            className: 'font-mono text-xs',
            textContent: hidden.textContent,
          }));
        };
      });
      wrap.querySelectorAll('#ci-tabs button').forEach((b) => {
        const active = b.dataset.tab === tab.id;
        b.className = `rounded-t px-3 py-2 transition ${active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`;
      });
    }
    wrap.querySelector('#ci-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]'); if (b) paint(b.dataset.tab);
    });
    paint(TABS[0].id);

    await modal({
      title: `Inspect: ${titleName}`,
      body: wrap,
      size: 'xl',
      actions: [{ label: 'Close', value: null, kind: 'secondary' }],
    });
  }

  async function showContainerLogs(id) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <label class="text-xs text-slate-400">Tail
          <input id="log-tail" type="number" min="10" max="5000" value="500" class="ml-1 w-24 rounded border-slate-700 bg-slate-950 text-xs" />
        </label>
        <label class="flex items-center gap-1 text-xs text-slate-400">
          <input id="log-ts" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500" /> Timestamps
        </label>
        <button id="log-refresh" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">Refresh</button>
        <button id="log-stream" class="rounded bg-sky-500 hover:bg-sky-400 px-2 py-1 text-xs text-slate-950">Stream live</button>
      </div>
      <pre id="log-pane" class="log-pane h-[60vh] overflow-auto scroll-thin rounded border border-slate-800 bg-slate-950/70 p-3 text-slate-300"></pre>`;

    let abortCtrl = null;

    async function fetchOnce() {
      const tail = wrap.querySelector('#log-tail').value || 500;
      const ts = wrap.querySelector('#log-ts').checked;
      try {
        const data = await api(`/api/containers/${id}/logs?tail=${tail}&timestamps=${ts}`);
        const pane = wrap.querySelector('#log-pane');
        pane.textContent = data.logs || '(no output)';
        pane.scrollTop = pane.scrollHeight;
      } catch (e) { toast(e.message, 'error'); }
    }

    async function startStream() {
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; wrap.querySelector('#log-stream').textContent = 'Stream live'; return; }
      const pane = wrap.querySelector('#log-pane');
      pane.textContent = '';
      abortCtrl = new AbortController();
      wrap.querySelector('#log-stream').textContent = '⏹ Stop stream';
      try {
        const tail = wrap.querySelector('#log-tail').value || 200;
        const res = await fetch(`/api/containers/${id}/logs/stream?tail=${tail}`, {
          headers: { Authorization: authHeader() }, signal: abortCtrl.signal,
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pane.textContent += dec.decode(value, { stream: true });
          pane.scrollTop = pane.scrollHeight;
        }
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'error');
      } finally {
        abortCtrl = null;
        const btn = wrap.querySelector('#log-stream'); if (btn) btn.textContent = 'Stream live';
      }
    }

    wrap.querySelector('#log-refresh').onclick = fetchOnce;
    wrap.querySelector('#log-stream').onclick = startStream;
    fetchOnce();

    await modal({
      title: `Logs: ${id.slice(0,12)}`,
      body: wrap,
      size: 'xl',
      actions: [{ label: 'Close', value: null, kind: 'secondary' }],
    });
    if (abortCtrl) abortCtrl.abort();
  }

  function _section(title, openByDefault, html) {
    return `
      <details ${openByDefault ? 'open' : ''} class="rounded-lg border border-slate-800 bg-slate-900/40">
        <summary class="cursor-pointer select-none px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-300 hover:text-white">${escapeHtml(title)}</summary>
        <div class="grid gap-3 md:grid-cols-2 px-4 pt-2 pb-4">${html}</div>
      </details>`;
  }
  function _kvLines(text) {
    const out = {};
    for (const line of (text || '').split('\n').map(l => l.trim()).filter(Boolean)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  }
  function _list(text) {
    return (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  }
  function _parseSize(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtKMGT]?)([bB]?)$/);
    if (!m) return s;
    return s;
  }

  async function runContainerDialog() {
    const form = document.createElement('div');
    form.className = 'space-y-3';
    form.innerHTML = `
      ${_section('Basic', true, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Image *</span>
          <input name="image" required placeholder="nginx:latest" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Name</span>
          <input name="name" placeholder="(auto)" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Restart policy</span>
          <select name="restart_policy" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
            <option value="">(default)</option><option value="no">no</option>
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option><option value="on-failure">on-failure</option>
          </select></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Command (overrides image CMD)</span>
          <input name="command" placeholder='e.g. "tail -f /dev/null"' class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Entrypoint (overrides image ENTRYPOINT)</span>
          <input name="entrypoint" placeholder='e.g. "/usr/local/bin/wrapper.sh"' class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="flex items-center gap-2 text-xs text-slate-300 mt-2 md:col-span-2">
          <input name="pull" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Pull image first
        </label>
      `)}

      ${_section('Networking', false, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Port mappings (one per line: <span class="kbd">host:container/proto</span>)</span>
          <textarea name="ports" rows="3" placeholder="8080:80/tcp&#10;8443:443/tcp" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">Network (name)</span>
          <input name="network" placeholder="bridge" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Network mode</span>
          <input name="network_mode" placeholder="(empty) | host | none | container:&lt;id&gt;" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Hostname</span>
          <input name="hostname" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">MAC address</span>
          <input name="mac_address" placeholder="02:42:ac:11:00:02" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">DNS servers (one per line)</span>
          <textarea name="dns" rows="2" placeholder="1.1.1.1&#10;8.8.8.8" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">DNS search domains (one per line)</span>
          <textarea name="dns_search" rows="2" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Extra hosts (HOST=IP per line)</span>
          <textarea name="extra_hosts" rows="2" placeholder="db=10.0.0.5&#10;cache=10.0.0.6" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
      `)}

      ${_section('Storage', false, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Volumes (one per line: <span class="kbd">/host/path:/container/path[:ro]</span>)</span>
          <textarea name="volumes" rows="3" placeholder="/var/data:/data&#10;myvolume:/var/lib/data" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">tmpfs mounts (PATH=opts per line, opts optional)</span>
          <textarea name="tmpfs" rows="2" placeholder="/run=size=64m&#10;/tmp=" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="flex items-center gap-2 text-xs text-slate-300 md:col-span-2">
          <input name="read_only" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Read-only root filesystem
        </label>
      `)}

      ${_section('Environment & process', false, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Environment (KEY=VALUE per line)</span>
          <textarea name="env" rows="3" placeholder="POSTGRES_PASSWORD=secret&#10;TZ=UTC" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">User (uid[:gid] or name)</span>
          <input name="user" placeholder="1000:1000" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Working directory</span>
          <input name="working_dir" placeholder="/app" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Stop signal</span>
          <input name="stop_signal" placeholder="SIGTERM" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Stop grace period (seconds)</span>
          <input name="stop_grace_period" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input name="init" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Run an init process inside (--init)
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input name="tty" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Allocate TTY (-t)
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input name="stdin_open" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Keep STDIN open (-i)
        </label>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input name="auto_remove" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Auto-remove on exit (--rm)
        </label>
      `)}

      ${_section('Resources', false, `
        <label class="block"><span class="text-xs text-slate-400">CPUs (e.g. 1.5)</span>
          <input name="cpus" type="number" step="0.1" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">CPU shares</span>
          <input name="cpu_shares" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Cpuset CPUs</span>
          <input name="cpuset_cpus" placeholder="0,2-3" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Memory limit</span>
          <input name="mem_limit" placeholder="512m / 2g / bytes" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Memory reservation</span>
          <input name="mem_reservation" placeholder="256m" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Memswap limit</span>
          <input name="memswap_limit" placeholder="-1 to disable" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">PIDs limit</span>
          <input name="pids_limit" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">SHM size</span>
          <input name="shm_size" placeholder="64m" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">ulimits (NAME=soft[:hard] per line)</span>
          <textarea name="ulimits" rows="2" placeholder="nofile=1024:4096&#10;nproc=512" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Devices (one per line: <span class="kbd">/host/dev:/container/dev[:rwm]</span>)</span>
          <textarea name="devices" rows="2" placeholder="/dev/dri:/dev/dri" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">GPUs</span>
          <input name="gpus" placeholder='"all", "-1" or a count' class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
      `)}

      ${_section('Security', false, `
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input name="privileged" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Privileged
        </label>
        <div></div>
        <label class="block"><span class="text-xs text-slate-400">Capabilities to add (comma- or newline-separated)</span>
          <textarea name="cap_add" rows="2" placeholder="NET_ADMIN&#10;SYS_PTRACE" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">Capabilities to drop</span>
          <textarea name="cap_drop" rows="2" placeholder="ALL" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">security_opt (one per line)</span>
          <textarea name="security_opt" rows="2" placeholder="no-new-privileges:true&#10;seccomp=unconfined" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">sysctls (KEY=VALUE per line)</span>
          <textarea name="sysctls" rows="2" placeholder="net.ipv4.ip_forward=1" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
      `)}

      ${_section('Healthcheck override', false, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Test command (CMD-SHELL)</span>
          <input name="hc_test" placeholder='e.g. "curl -f http://localhost/ || exit 1"' class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Interval (seconds)</span>
          <input name="hc_interval" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Timeout (seconds)</span>
          <input name="hc_timeout" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Retries</span>
          <input name="hc_retries" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Start period (seconds)</span>
          <input name="hc_start_period" type="number" min="0" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
      `)}

      ${_section('Logging', false, `
        <label class="block"><span class="text-xs text-slate-400">Log driver</span>
          <select name="log_driver" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
            <option value="">(default)</option>
            <option>json-file</option><option>local</option><option>journald</option>
            <option>syslog</option><option>fluentd</option><option>gelf</option><option>awslogs</option>
            <option>splunk</option><option>etwlogs</option><option>none</option>
          </select></label>
        <div></div>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Log driver options (KEY=VALUE per line)</span>
          <textarea name="log_opts" rows="3" placeholder="max-size=10m&#10;max-file=3" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
      `)}

      ${_section('Labels', false, `
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Labels (KEY=VALUE per line)</span>
          <textarea name="labels" rows="3" placeholder="traefik.enable=true&#10;com.example.app=web" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
      `)}

      <div id="run-error" class="hidden rounded bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>`;

    const created = await modal({
      title: 'Run a new container',
      body: form,
      size: 'xl',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Run', kind: 'primary', value: true, onClick: async () => {
          const get = (n) => form.querySelector(`[name="${n}"]`);
          const errBox = form.querySelector('#run-error');
          errBox.classList.add('hidden');
          const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); return false; };

          const text = (n) => (get(n)?.value || '').trim();
          const num = (n) => { const v = text(n); return v === '' ? null : Number(v); };
          const bool = (n) => !!get(n)?.checked;

          const payload = { image: text('image'), pull: bool('pull') };
          if (!payload.image) return showErr('Image is required');
          for (const f of ['name','command','entrypoint','restart_policy','network','network_mode','hostname','mac_address','user','working_dir','stop_signal','cpuset_cpus','mem_limit','mem_reservation','memswap_limit','shm_size','log_driver']) {
            const v = text(f); if (v) payload[f] = v;
          }
          for (const f of ['init','tty','stdin_open','auto_remove','read_only','privileged']) {
            if (get(f) && get(f).checked) payload[f] = true;
          }
          if (text('cpus')) payload.cpus = Number(text('cpus'));
          if (text('cpu_shares')) payload.cpu_shares = Number(text('cpu_shares'));
          if (text('pids_limit')) payload.pids_limit = Number(text('pids_limit'));
          if (text('stop_grace_period')) payload.stop_grace_period = Number(text('stop_grace_period'));
          if (text('gpus')) payload.gpus = isNaN(Number(text('gpus'))) ? text('gpus') : Number(text('gpus'));

          const env = _kvLines(text('env')); if (Object.keys(env).length) payload.env = env;
          const labels = _kvLines(text('labels')); if (Object.keys(labels).length) payload.labels = labels;
          const sysctls = _kvLines(text('sysctls')); if (Object.keys(sysctls).length) payload.sysctls = sysctls;
          const log_opts = _kvLines(text('log_opts')); if (Object.keys(log_opts).length) payload.log_opts = log_opts;
          const extra_hosts = _kvLines(text('extra_hosts')); if (Object.keys(extra_hosts).length) payload.extra_hosts = extra_hosts;

          const dns = _list(text('dns')); if (dns.length) payload.dns = dns;
          const dns_search = _list(text('dns_search')); if (dns_search.length) payload.dns_search = dns_search;
          const sec_opt = _list(text('security_opt')); if (sec_opt.length) payload.security_opt = sec_opt;
          const devices = _list(text('devices')); if (devices.length) payload.devices = devices;
          const cap_add = _list(text('cap_add').replace(/,/g, '\n')); if (cap_add.length) payload.cap_add = cap_add;
          const cap_drop = _list(text('cap_drop').replace(/,/g, '\n')); if (cap_drop.length) payload.cap_drop = cap_drop;

          const ports = {};
          for (const line of _list(text('ports'))) {
            const m = line.match(/^(\d+):(\d+)(?:\/(tcp|udp|sctp))?$/);
            if (!m) return showErr(`Invalid port mapping: ${line}`);
            ports[`${m[2]}/${m[3] || 'tcp'}`] = Number(m[1]);
          }
          if (Object.keys(ports).length) payload.ports = ports;

          const vols = {};
          for (const line of _list(text('volumes'))) {
            const parts = line.split(':');
            if (parts.length < 2) return showErr(`Invalid volume: ${line}`);
            const [host, ctr, mode] = parts;
            vols[host] = { bind: ctr, mode: mode || 'rw' };
          }
          if (Object.keys(vols).length) payload.volumes = vols;

          const tmpfs = {};
          for (const line of _list(text('tmpfs'))) {
            const i = line.indexOf('=');
            if (i < 0) tmpfs[line] = '';
            else tmpfs[line.slice(0, i)] = line.slice(i + 1);
          }
          if (Object.keys(tmpfs).length) payload.tmpfs = tmpfs;

          const ulimits = [];
          for (const line of _list(text('ulimits'))) {
            const m = line.match(/^([A-Za-z_][\w-]*)=(\d+)(?::(\d+))?$/);
            if (!m) return showErr(`Invalid ulimit: ${line}`);
            const u = { name: m[1], soft: Number(m[2]) };
            if (m[3]) u.hard = Number(m[3]); else u.hard = Number(m[2]);
            ulimits.push(u);
          }
          if (ulimits.length) payload.ulimits = ulimits;

          const hcTest = text('hc_test');
          if (hcTest || text('hc_interval') || text('hc_retries')) {
            const hc = {};
            if (hcTest) hc.test = ['CMD-SHELL', hcTest];
            const sec = (n) => text(n) ? Number(text(n)) * 1_000_000_000 : null;
            const ns = sec('hc_interval'); if (ns != null) hc.interval = ns;
            const tns = sec('hc_timeout'); if (tns != null) hc.timeout = tns;
            const sps = sec('hc_start_period'); if (sps != null) hc.start_period = sps;
            if (text('hc_retries')) hc.retries = Number(text('hc_retries'));
            payload.healthcheck = hc;
          }

          try {
            await api('/api/containers', { method: 'POST', body: JSON.stringify(payload) });
            toast('Container created', 'success');
          } catch (e) {
            return showErr(e.message);
          }
        }},
      ],
    });
    return created === true;
  }

  // ---------- Images ----------
  views.images = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Images',
      'Pull, inspect, and remove container images',
      `${isAdmin ? btn('⤓ Pull image', { kind: 'primary', id: 'pull-image' }) : ''}
       ${isAdmin ? btn('Prune dangling', { kind: 'secondary', id: 'prune-images' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );

    const controls = document.createElement('div');
    controls.className = 'mb-3 flex items-center gap-3 text-xs';
    controls.innerHTML = `<span id="images-count" class="text-slate-500 ml-auto"></span>`;
    root.appendChild(controls);

    // Bulk bar — remove only (Docker doesn't have a bulk pull, and prune
    // is its own thing). Force handled via a second confirm on 409.
    const bulkSel = createBulkSelection({ key: (i) => i.id });
    const bulkBarObj = isAdmin
      ? bulkBar(bulkSel, {
          actions: [
            { label: '✕ Remove', kind: 'danger', onClick: (ids) => bulkRemoveImages(ids) },
          ],
        })
      : { el: document.createElement('div'), render: () => {} };
    root.appendChild(bulkBarObj.el);

    const list = document.createElement('div'); root.appendChild(list);
    let images = [];

    function nameOf(id) {
      const img = images.find((i) => i.id === id);
      if (!img) return id.slice(0, 12);
      return (img.tags && img.tags[0]) || img.short_id || id.slice(0, 12);
    }

    async function bulkRemoveImages(ids) {
      const ok = await confirmModal(
        `Remove <strong>${ids.length}</strong> image${ids.length === 1 ? '' : 's'}? Tags pointing at the same digest will be removed together. In-use images will fail and you'll be offered force-remove.`,
        { danger: true, confirmLabel: 'Remove' },
      );
      if (!ok) return false;
      try {
        const out = await api('/api/images/remove/bulk', {
          method: 'POST', body: JSON.stringify({ ids, force: false }),
        });
        const stuck = (out.results || []).filter((r) => !r.ok && /in use|force/i.test(r.error || ''));
        handleBulkResponse(out, 'Removed', (r) => nameOf(r.id));
        if (stuck.length) {
          const forceOk = await confirmModal(
            `<strong>${stuck.length}</strong> image${stuck.length === 1 ? ' is' : 's are'} in use by container(s).<br>` +
            `Force-removing untags them and deletes the layers — running containers keep their copy until they exit. Continue?`,
            { danger: true, confirmLabel: 'Force remove' },
          );
          if (forceOk) {
            try {
              const out2 = await api('/api/images/remove/bulk', {
                method: 'POST',
                body: JSON.stringify({ ids: stuck.map((r) => r.id), force: true }),
              });
              handleBulkResponse(out2, 'Force-removed', (r) => nameOf(r.id));
            } catch (e) { toast(`Force remove failed: ${e.message}`, 'error'); }
          }
        }
      } catch (e) { toast(`Bulk remove failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        images = await api('/api/images');
        bulkSel.pruneAgainst(images);
        draw();
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    function draw() {
      controls.querySelector('#images-count').textContent =
        `${images.length} image${images.length === 1 ? '' : 's'}` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');
      const rows = images.map((i) => {
        const checked = bulkSel.has(i.id) ? 'checked' : '';
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-3 py-2 w-8">
              ${isAdmin ? `<input type="checkbox" class="images-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-id="${i.id}" ${checked}/>` : ''}
            </td>
            <td class="px-4 py-2">
              <div class="font-medium">${(i.tags || []).map(escapeHtml).join('<br/>') || '<span class="text-slate-500">(untagged)</span>'}</div>
              <div class="text-[11px] text-slate-500 font-mono">${shortId(i.id)}</div>
            </td>
            <td class="px-4 py-2 text-slate-300">${fmtBytes(i.size)}</td>
            <td class="px-4 py-2 text-slate-400">${escapeHtml(i.architecture || '')}/${escapeHtml(i.os || '')}</td>
            <td class="px-4 py-2 text-slate-400">${fmtDate(i.created)}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                <button data-act="inspect" data-id="${i.id}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Inspect</button>
                ${isAdmin ? `<button data-act="remove" data-id="${i.id}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>` : ''}
              </div>
            </td>
          </tr>`;
      });
      list.innerHTML = table(
        [
          isAdmin
            ? `<input id="images-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all visible"/>`
            : '',
          'Tags', 'Size', 'Arch / OS', 'Created', '',
        ],
        rows,
      );
      const sa = list.querySelector('#images-select-all');
      if (sa) {
        const onPage = images.filter((i) => bulkSel.has(i.id)).length;
        sa.checked = images.length > 0 && onPage === images.length;
        sa.indeterminate = onPage > 0 && onPage < images.length;
        sa.addEventListener('change', (e) => {
          if (e.target.checked) for (const i of images) bulkSel.add(i.id);
          else for (const i of images) bulkSel.delete(i.id);
          draw(); bulkBarObj.render();
        });
      }
    }

    list.addEventListener('change', (e) => {
      const cb = e.target.closest('input.images-check');
      if (!cb) return;
      if (cb.checked) bulkSel.add(cb.dataset.id);
      else bulkSel.delete(cb.dataset.id);
      bulkBarObj.render();
      controls.querySelector('#images-count').textContent =
        `${images.length} image${images.length === 1 ? '' : 's'}` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');
      const sa = list.querySelector('#images-select-all');
      if (sa) {
        const onPage = images.filter((i) => bulkSel.has(i.id)).length;
        sa.checked = images.length > 0 && onPage === images.length;
        sa.indeterminate = onPage > 0 && onPage < images.length;
      }
    });

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id; const act = t.dataset.act;
      try {
        if (act === 'inspect') {
          const data = await api(`/api/images/${encodeURIComponent(id)}`);
          await modal({ title: `Inspect image`, body: jsonView(data), size: 'xl' });
        } else if (act === 'remove') {
          const ok = await confirmModal('Remove this image?', { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
          await api(`/api/images/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
          toast('Image removed', 'success'); load();
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    const pruneBtn = document.getElementById('prune-images');
    if (pruneBtn) pruneBtn.onclick = async () => {
      const ok = await confirmModal('Remove dangling (untagged) images?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try {
        const r = await api('/api/images/prune?dangling_only=true', { method: 'POST' });
        toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success'); load();
      } catch (e) { toast(e.message, 'error'); }
    };
    const pullBtn = document.getElementById('pull-image');
    if (pullBtn) pullBtn.onclick = () => pullImageDialog().then((ok) => ok && load());

    await load();
  };

  async function pullImageDialog() {
    let registries = [];
    try { registries = await api('/api/registries'); } catch {}

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3 md:grid-cols-3">
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Repository *</span>
          <input id="repo" required placeholder="library/nginx" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Tag</span>
          <input id="tag" placeholder="latest" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="md:col-span-3 block"><span class="text-xs text-slate-400">Registry credentials</span>
          <select id="reg" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
            <option value="">(none — public / daemon-cached login)</option>
            ${registries.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)} — ${escapeHtml(r.url)} (${escapeHtml(r.username)})</option>`).join('')}
          </select>
          <p class="mt-1 text-[11px] text-slate-500">Manage credentials under the Registries tab.</p>
        </label>
      </div>
      <pre id="progress" class="log-pane mt-3 hidden h-48 overflow-auto scroll-thin rounded border border-slate-800 bg-slate-950/70 p-3 text-slate-300"></pre>`;
    const ok = await modal({
      title: 'Pull an image',
      body: wrap,
      size: 'md',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Pull', kind: 'primary', value: true, onClick: async () => {
          const repo = wrap.querySelector('#repo').value.trim();
          const tag = wrap.querySelector('#tag').value.trim() || null;
          const registry = wrap.querySelector('#reg').value || null;
          if (!repo) return false;
          const pane = wrap.querySelector('#progress'); pane.classList.remove('hidden'); pane.textContent = '';
          try {
            const res = await fetch('/api/images/pull', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
              body: JSON.stringify({ repository: repo, tag, registry }),
            });
            if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
            const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
            const lines = {};
            while (true) {
              const { value, done } = await reader.read(); if (done) break;
              buf += dec.decode(value, { stream: true });
              const parts = buf.split('\n'); buf = parts.pop();
              for (const p of parts) {
                if (!p.trim()) continue;
                try {
                  const obj = JSON.parse(p);
                  const key = obj.id || '_';
                  lines[key] = `${obj.id ? obj.id + ': ' : ''}${obj.status || ''} ${obj.progress || ''}`.trim();
                  pane.textContent = Object.values(lines).join('\n');
                  pane.scrollTop = pane.scrollHeight;
                } catch { pane.textContent += p + '\n'; }
              }
            }
            toast('Image pulled', 'success');
          } catch (e) { toast(e.message, 'error'); return false; }
        }},
      ],
    });
    return ok === true;
  }

  // ---------- Networks ----------
  // ---------- Networks (Portainer-parity) ----------
  //
  // The list view enriches the daemon's bare `listNetworks` with stack
  // ownership, IPAM subnets/gateways, attached containers (count and
  // identity), and a `system` flag for predefined networks the user
  // can't remove. Buttons that mutate are gated by the admin role.
  views.networks = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Networks',
      'Manage docker networks',
      `${isAdmin ? btn('+ Create network', { kind: 'primary', id: 'create-net' }) : ''}
       ${isAdmin ? btn('Prune unused', { kind: 'secondary', id: 'prune-nets' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );

    // Controls bar: search + driver filter + system-toggle.
    const controls = document.createElement('div');
    controls.className = 'mb-3 flex flex-wrap items-center gap-2 text-xs';
    controls.innerHTML = `
      <input id="nets-search" type="text" placeholder="🔎 Search by name, subnet, stack, driver…"
             class="flex-1 min-w-[240px] rounded border-slate-700 bg-slate-950 text-sm"/>
      <select id="nets-driver" class="rounded border-slate-700 bg-slate-950 text-sm">
        <option value="">All drivers</option>
        <option value="bridge">bridge</option>
        <option value="overlay">overlay</option>
        <option value="macvlan">macvlan</option>
        <option value="ipvlan">ipvlan</option>
        <option value="host">host</option>
        <option value="null">null</option>
      </select>
      <label class="flex items-center gap-2 text-slate-300">
        <input id="nets-system" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900"/>
        Show system networks (bridge / host / none)
      </label>
      <span id="nets-count" class="text-slate-500 ml-auto"></span>
    `;
    root.appendChild(controls);

    const bulk = document.createElement('div');
    bulk.id = 'nets-bulk';
    bulk.className = 'mb-2 hidden items-center justify-between rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs';
    bulk.innerHTML = `
      <span><span id="nets-bulk-count" class="font-semibold text-sky-200">0</span> selected</span>
      <div class="flex items-center gap-2">
        ${isAdmin ? `<button id="nets-bulk-rm" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1">✕ Delete selected</button>` : ''}
        <button id="nets-bulk-clear" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700 text-slate-300">Clear</button>
      </div>`;
    root.appendChild(bulk);

    const listEl = document.createElement('div'); root.appendChild(listEl);

    let lastNetworks = [];
    // System networks are off by default — they're the noisy ones the
    // operator usually doesn't care about.
    let showSystem = false;
    // Selection survives filter changes. Only dropped when a network
    // actually disappears from the underlying list (e.g. after a
    // successful delete).
    const selected = new Set();

    function visibleNetworks() {
      const q = controls.querySelector('#nets-search').value.trim().toLowerCase();
      const driverFilter = controls.querySelector('#nets-driver').value;
      return lastNetworks.filter((n) => {
        if (!showSystem && n.system) return false;
        if (driverFilter && n.driver !== driverFilter) return false;
        if (q) {
          const hay = (n.name + ' ' + (n.driver || '') + ' ' + (n.stack || '') + ' ' +
                       (n.subnets || []).join(' ')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function renderBulkBar() {
      if (selected.size === 0) {
        bulk.classList.add('hidden'); bulk.classList.remove('flex'); return;
      }
      bulk.classList.remove('hidden'); bulk.classList.add('flex');
      bulk.querySelector('#nets-bulk-count').textContent = String(selected.size);
    }

    function renderRows() {
      const nets = visibleNetworks();
      controls.querySelector('#nets-count').textContent =
        `${nets.length} of ${lastNetworks.length} shown` +
        (selected.size ? ` · ${selected.size} selected` : '');

      if (lastNetworks.length === 0) {
        listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">No networks on this host.</div>`;
        return;
      }
      if (nets.length === 0) {
        listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">No networks match the current filters.</div>`;
        return;
      }

      const rows = nets.map((n) => {
        const subnetCell = n.subnets && n.subnets.length
          ? n.subnets.map((s) => `<code class="text-[11px] text-slate-300 font-mono">${escapeHtml(s)}</code>`).join('<br>')
          : '<span class="text-slate-600">—</span>';
        const stackCell = n.stack
          ? `<a href="#stacks" class="text-sky-300 hover:underline">${escapeHtml(n.stack)}</a>`
          : '<span class="text-slate-600">—</span>';
        // System-network row: greyed out + no checkbox (can't be
        // bulk-deleted) + a "system" badge so it's obvious why.
        const sysBadge = n.system
          ? `<span class="ml-1 inline-flex items-center rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">system</span>`
          : '';
        const inUseBadge = n.in_use
          ? `<span class="ml-1 inline-flex items-center rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300" title="${escapeHtml(n.used_by.map((u) => u.container_name + ' · ' + (u.ipv4 || u.ipv6 || '?')).join(', '))}">${n.containers_count} attached</span>`
          : `<span class="ml-1 inline-flex items-center rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">unused</span>`;
        const isChecked = selected.has(n.id) ? 'checked' : '';
        const canCheck = isAdmin && !n.system;
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-3 py-2 w-8">
              ${canCheck ? `<input type="checkbox" class="nets-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-id="${escapeHtml(n.id)}" ${isChecked}/>` : ''}
            </td>
            <td class="px-4 py-2">
              <div class="font-medium">${escapeHtml(n.name)}${sysBadge}${inUseBadge}</div>
              <div class="text-[11px] text-slate-500 font-mono">${escapeHtml(n.short_id)}</div>
            </td>
            <td class="px-4 py-2 text-slate-300">${escapeHtml(n.driver)} <span class="text-[10px] text-slate-500">(${escapeHtml(n.scope)})</span></td>
            <td class="px-4 py-2 text-slate-300">${stackCell}</td>
            <td class="px-4 py-2 text-slate-300 align-top">${subnetCell}</td>
            <td class="px-4 py-2 text-slate-400">${n.containers_count}</td>
            <td class="px-4 py-2 text-slate-400">${fmtDate(n.created)}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                <button data-act="inspect" data-id="${escapeHtml(n.id)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Inspect</button>
                ${isAdmin && !n.system ? `<button data-act="remove" data-id="${escapeHtml(n.id)}" data-name="${escapeHtml(n.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>` : ''}
              </div>
            </td>
          </tr>`;
      });
      listEl.innerHTML = table(
        [
          `<input id="nets-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all visible"/>`,
          'Name', 'Driver', 'Stack', 'Subnet', 'Containers', 'Created', '',
        ],
        rows,
      );

      const cb = listEl.querySelector('#nets-select-all');
      if (cb) {
        const eligible = nets.filter((n) => !n.system);
        const onPage = eligible.filter((n) => selected.has(n.id)).length;
        cb.checked = eligible.length > 0 && onPage === eligible.length;
        cb.indeterminate = onPage > 0 && onPage < eligible.length;
        cb.addEventListener('change', (e) => {
          if (e.target.checked) for (const n of eligible) selected.add(n.id);
          else for (const n of eligible) selected.delete(n.id);
          renderRows(); renderBulkBar();
        });
      }
    }

    async function load() {
      listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        lastNetworks = await api('/api/networks');
        for (const id of [...selected]) {
          if (!lastNetworks.some((n) => n.id === id)) selected.delete(id);
        }
        renderRows(); renderBulkBar();
      } catch (e) {
        listEl.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    // ---- Event wiring ----
    controls.querySelector('#nets-search').addEventListener('input', () => renderRows());
    controls.querySelector('#nets-driver').addEventListener('change', () => renderRows());
    controls.querySelector('#nets-system').addEventListener('change', (e) => {
      showSystem = e.target.checked; renderRows();
    });

    listEl.addEventListener('change', (e) => {
      const cb = e.target.closest('input.nets-check');
      if (!cb) return;
      if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
      renderBulkBar();
      controls.querySelector('#nets-count').textContent =
        `${visibleNetworks().length} of ${lastNetworks.length} shown` +
        (selected.size ? ` · ${selected.size} selected` : '');
      const all = listEl.querySelector('#nets-select-all');
      if (all) {
        const nets = visibleNetworks().filter((n) => !n.system);
        const onPage = nets.filter((n) => selected.has(n.id)).length;
        all.checked = nets.length > 0 && onPage === nets.length;
        all.indeterminate = onPage > 0 && onPage < nets.length;
      }
    });

    bulk.querySelector('#nets-bulk-clear').onclick = () => { selected.clear(); renderRows(); renderBulkBar(); };
    const bulkRmBtn = bulk.querySelector('#nets-bulk-rm');
    if (bulkRmBtn) bulkRmBtn.onclick = async () => {
      const ids = [...selected];
      if (!ids.length) return;
      const ok = await confirmModal(
        `Delete <strong>${ids.length}</strong> network${ids.length === 1 ? '' : 's'}? Containers connected to any of them will lose connectivity on the next reconnect.`,
        { danger: true, confirmLabel: 'Delete all' },
      );
      if (!ok) return;
      try {
        const out = await api('/api/networks/delete/bulk', {
          method: 'POST', body: JSON.stringify({ ids }),
        });
        for (const r of out.results || []) {
          if (!r.ok) toast(`${r.id.slice(0, 12)}: ${r.error || 'failed'}`, 'error');
        }
        if (out.succeeded) {
          toast(`Deleted ${out.succeeded}${out.failed ? ` of ${ids.length}` : ''}`, out.failed ? 'warn' : 'success');
        }
      } catch (e) { toast(`Bulk delete failed: ${e.message}`, 'error'); }
      selected.clear();
      load();
    };

    async function removeNetwork(id, name) {
      const ok = await confirmModal(
        `Remove network <code>${escapeHtml(name || id.slice(0, 12))}</code>?`,
        { danger: true, confirmLabel: 'Remove' },
      );
      if (!ok) return;
      try {
        await api(`/api/networks/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Network removed', 'success'); load();
      } catch (e) {
        // The backend translates the daemon's 403 ("in use") to 409.
        // We don't offer a force-remove for networks because Docker
        // doesn't have one — the path forward is "disconnect the
        // containers first", so we surface that as part of the error.
        toast(e.message, 'error');
      }
    }

    listEl.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id; const act = t.dataset.act;
      try {
        if (act === 'inspect') await openNetworkInspect(id, () => load());
        else if (act === 'remove') await removeNetwork(id, t.dataset.name);
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    const pruneBtn = document.getElementById('prune-nets');
    if (pruneBtn) pruneBtn.onclick = async () => {
      const ok = await confirmModal('Prune unused networks (no containers attached)?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try {
        const r = await api('/api/networks/prune', { method: 'POST' });
        const n = (r.NetworksDeleted || []).length;
        toast(`Pruned ${n} network${n === 1 ? '' : 's'}`, 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    };

    const createBtn = document.getElementById('create-net');
    if (createBtn) createBtn.onclick = async () => {
      const created = await openCreateNetworkDialog();
      // #28-style: prepend the enriched echo when we have it; otherwise
      // fall back to a list reload.
      if (created) {
        lastNetworks = [created, ...lastNetworks];
        renderRows(); renderBulkBar();
      }
    };

    await load();
  };

  /**
   * Create-network wizard. Mirrors Portainer's add-network screen:
   * basic fields + multiple IPAM configs + driver options + labels.
   * Returns the enriched NetworkSummary the backend echoed on success,
   * or null on cancel / failure.
   */
  async function openCreateNetworkDialog() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3">
        <div class="grid gap-3 md:grid-cols-2">
          <label class="md:col-span-2 block">
            <span class="text-xs uppercase tracking-wider text-slate-400">Name *</span>
            <input id="n-name" required class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"
                   placeholder="my-app-net" />
            <span class="block mt-1 text-[11px] text-slate-500">Letters / digits / <code>_</code> <code>-</code> <code>.</code>; must start with a letter or digit.</span>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">Driver</span>
            <select id="n-driver" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
              <option value="bridge">bridge (default; single-host)</option>
              <option value="overlay">overlay (swarm; multi-host)</option>
              <option value="macvlan">macvlan</option>
              <option value="ipvlan">ipvlan</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">Scope</span>
            <input value="local" disabled class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm text-slate-500" />
            <span class="block mt-1 text-[11px] text-slate-500">Scope is inferred from the driver (overlay → swarm).</span>
          </label>
        </div>

        <div class="flex flex-wrap gap-4 rounded border border-slate-800 bg-slate-900/40 p-3 text-xs">
          <label class="flex items-center gap-2 text-slate-300">
            <input id="n-attachable" type="checkbox" checked class="rounded border-slate-700 bg-slate-950 text-sky-500"/>
            Attachable
            <span class="text-slate-500">(let standalone containers connect)</span>
          </label>
          <label class="flex items-center gap-2 text-slate-300">
            <input id="n-internal" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/>
            Internal
            <span class="text-slate-500">(no external connectivity)</span>
          </label>
          <label class="flex items-center gap-2 text-slate-300">
            <input id="n-ipv6" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/>
            Enable IPv6
          </label>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs uppercase tracking-wider text-slate-400">IPAM configurations</span>
            <button type="button" id="n-add-ipam" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">+ Add subnet</button>
          </div>
          <p class="mb-2 text-[11px] text-slate-500">Optional. Leave empty to let Docker auto-assign. One row per subnet — typical use is one IPv4 row, plus one IPv6 row when "Enable IPv6" is on.</p>
          <div id="n-ipam-list" class="space-y-2"></div>
        </div>

        <label class="block">
          <span class="text-xs uppercase tracking-wider text-slate-400">Driver options</span>
          <textarea id="n-driveropts" rows="3" placeholder="parent=eth0&#10;com.docker.network.bridge.name=br-myapp"
                    class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono"></textarea>
          <span class="block mt-1 text-[11px] text-slate-500"><code>KEY=VALUE</code> per line; driver-specific.</span>
        </label>

        <label class="block">
          <span class="text-xs uppercase tracking-wider text-slate-400">Labels</span>
          <textarea id="n-labels" rows="3" placeholder="owner=team-a&#10;tier=prod"
                    class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono"></textarea>
          <span class="block mt-1 text-[11px] text-slate-500"><code>KEY=VALUE</code> per line; freely-chosen metadata.</span>
        </label>
      </div>`;

    function parseKv(text) {
      const out = {};
      for (const raw of (text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k) out[k] = v;
      }
      return out;
    }

    const ipamListEl = wrap.querySelector('#n-ipam-list');
    function addIpamRow(initial = {}) {
      const row = document.createElement('div');
      row.className = 'grid grid-cols-12 gap-2 rounded border border-slate-800 bg-slate-950/40 p-2 text-xs';
      row.innerHTML = `
        <label class="col-span-4 block">
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Subnet (CIDR)</span>
          <input data-f="subnet" placeholder="172.20.0.0/16" class="mt-0.5 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono" />
        </label>
        <label class="col-span-3 block">
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Gateway</span>
          <input data-f="gateway" placeholder="172.20.0.1" class="mt-0.5 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono" />
        </label>
        <label class="col-span-3 block">
          <span class="text-[10px] uppercase tracking-wider text-slate-500">IP range</span>
          <input data-f="ip_range" placeholder="172.20.10.0/24" class="mt-0.5 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono" />
        </label>
        <div class="col-span-2 flex items-end justify-end">
          <button type="button" data-f="rm" class="rounded bg-slate-800 hover:bg-rose-500 hover:text-white border border-slate-700 px-2 py-1 text-slate-300">Remove</button>
        </div>`;
      for (const k of ['subnet', 'gateway', 'ip_range']) {
        const inp = row.querySelector(`[data-f="${k}"]`);
        if (initial[k]) inp.value = initial[k];
      }
      row.querySelector('[data-f="rm"]').onclick = () => row.remove();
      ipamListEl.appendChild(row);
    }
    wrap.querySelector('#n-add-ipam').onclick = () => addIpamRow();

    function collectIpamConfig() {
      const rows = [...ipamListEl.querySelectorAll(':scope > div')];
      return rows
        .map((row) => ({
          subnet: row.querySelector('[data-f="subnet"]').value.trim(),
          gateway: row.querySelector('[data-f="gateway"]').value.trim(),
          ip_range: row.querySelector('[data-f="ip_range"]').value.trim(),
        }))
        .filter((c) => c.subnet || c.gateway || c.ip_range)
        .map((c) => {
          const out = {};
          if (c.subnet) out.subnet = c.subnet;
          if (c.gateway) out.gateway = c.gateway;
          if (c.ip_range) out.ip_range = c.ip_range;
          return out;
        });
    }

    let created = null;
    const ok = await modal({
      title: 'Create network', body: wrap, size: 'lg',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Create', kind: 'primary', value: true, onClick: async () => {
          const name = wrap.querySelector('#n-name').value.trim();
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name)) {
            toast('Invalid name: must start with a letter or digit and contain only [A-Za-z0-9_.-]', 'warn');
            return false;
          }
          const ipamConfig = collectIpamConfig();
          const payload = {
            name,
            driver: wrap.querySelector('#n-driver').value,
            internal: wrap.querySelector('#n-internal').checked,
            attachable: wrap.querySelector('#n-attachable').checked,
            enable_ipv6: wrap.querySelector('#n-ipv6').checked,
            driver_opts: parseKv(wrap.querySelector('#n-driveropts').value),
            labels: parseKv(wrap.querySelector('#n-labels').value),
          };
          // Only attach the `ipam` field when the user actually filled
          // something in; otherwise the daemon picks defaults.
          if (ipamConfig.length) payload.ipam = { config: ipamConfig };
          try {
            created = await api('/api/networks', {
              method: 'POST', body: JSON.stringify(payload),
            });
            toast('Network created', 'success');
          } catch (e) { toast(e.message, 'error'); return false; }
        }},
      ],
    });
    return (ok && created) ? created : null;
  }

  /**
   * Tabbed inspect modal: Overview / Containers / IPAM / Options /
   * Labels / Raw. Mirrors the volume inspect's structure so the SPA's
   * inspect UX is consistent across resource types.
   */
  async function openNetworkInspect(networkId, onChange) {
    const isAdmin = state.auth && state.auth.role === 'admin';

    let data;
    try { data = await api(`/api/networks/${encodeURIComponent(networkId)}`); }
    catch (e) { toast(e.message, 'error'); return; }

    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-3';
    wrap.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 text-xs border-b border-slate-800 pb-2">
        ${['overview','containers','ipam','options','labels','raw'].map((t, i) => `
          <button data-tab="${t}" class="ni-tab rounded px-2 py-1 ${i===0?'bg-sky-500/20 text-sky-300':'text-slate-400 hover:bg-slate-800'}">${
            {overview:'Overview', containers:`Containers (${data.containers_count})`, ipam:'IPAM', options:'Options', labels:'Labels', raw:'Raw'}[t]
          }</button>
        `).join('')}
        <span class="ml-auto flex items-center gap-1">
          ${data.system ? `<span class="rounded bg-slate-700/40 px-2 py-0.5 text-[11px] font-medium text-slate-400">system</span>` : ''}
          ${data.in_use
            ? `<span class="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-300">${data.containers_count} attached</span>`
            : `<span class="rounded bg-slate-700/40 px-2 py-0.5 text-[11px] font-medium text-slate-400">unused</span>`}
        </span>
      </div>
      <div id="ni-panel" class="min-h-[40vh]"></div>`;

    const panel = wrap.querySelector('#ni-panel');

    function fieldRow(label, value, opts = {}) {
      return `
        <div class="grid grid-cols-[10rem_1fr] gap-3 py-1.5 border-b border-slate-800/50">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 self-start mt-0.5">${escapeHtml(label)}</div>
          <div class="text-sm ${opts.mono ? 'font-mono text-slate-300' : 'text-slate-200'}">${value}</div>
        </div>`;
    }
    function copyButton(text, label = 'copy') {
      return `<button data-copy="${escapeHtml(text)}" class="ml-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">${label}</button>`;
    }
    function flagBadge(on, onText, offText) {
      return on
        ? `<span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">${onText}</span>`
        : `<span class="rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-400">${offText}</span>`;
    }

    function renderOverview() {
      const stackLink = data.stack
        ? `<a href="#stacks" class="text-sky-300 hover:underline">${escapeHtml(data.stack)}</a>`
        : '<span class="text-slate-500">—</span>';
      panel.innerHTML = `
        <div class="space-y-1">
          ${fieldRow('Name', `<code class="text-slate-100">${escapeHtml(data.name)}</code>${copyButton(data.name)}`)}
          ${fieldRow('ID', `<code class="text-slate-300 font-mono text-[11px]">${escapeHtml(data.id)}</code>${copyButton(data.id, 'copy full')}`)}
          ${fieldRow('Driver', `${escapeHtml(data.driver)} <span class="text-[11px] text-slate-500">(${escapeHtml(data.scope)})</span>`, { mono: true })}
          ${fieldRow('Stack (owner)', stackLink)}
          ${fieldRow('Created', escapeHtml(fmtDate(data.created)))}
          ${fieldRow('Flags', `
            ${flagBadge(data.internal, 'internal', 'external')}
            ${flagBadge(data.attachable, 'attachable', 'not attachable')}
            ${flagBadge(data.enable_ipv6, 'IPv6 on', 'IPv6 off')}
            ${data.system ? `<span class="rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-400">system</span>` : ''}
          `)}
          ${fieldRow('IPAM driver', `<code class="text-slate-300">${escapeHtml(data.ipam_driver)}</code>`)}
          ${fieldRow('Subnets', data.subnets.length
            ? data.subnets.map((s, i) => `<code class="text-slate-300 font-mono text-[12px]">${escapeHtml(s)}</code>${data.gateways[i] ? ` <span class="text-slate-500 text-[11px]">→ ${escapeHtml(data.gateways[i])}</span>` : ''}`).join('<br>')
            : '<span class="text-slate-500">—</span>')}
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          ${isAdmin && !data.system ? `<button id="ni-connect" class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-3 py-1.5 text-sm font-medium">+ Connect container</button>` : ''}
          ${isAdmin && !data.system ? `<button id="ni-remove" class="rounded bg-rose-500 hover:bg-rose-400 text-white px-3 py-1.5 text-sm font-medium">Remove network</button>` : ''}
          ${data.system ? `<p class="text-xs text-slate-500">Predefined daemon network — Docker does not allow removal.</p>` : ''}
        </div>`;

      const conn = panel.querySelector('#ni-connect');
      if (conn) conn.onclick = async () => {
        const ok = await openConnectContainerDialog(networkId, data.name);
        if (ok) await refresh(); // reflect the new attachment
      };
      const rm = panel.querySelector('#ni-remove');
      if (rm) rm.onclick = async () => {
        const ok = await confirmModal(
          `Remove network <code>${escapeHtml(data.name)}</code>?` +
          (data.in_use ? `<br><br><span class="text-amber-300">⚠ ${data.containers_count} container(s) are currently attached and will lose connectivity.</span>` : ''),
          { danger: true, confirmLabel: 'Remove' },
        );
        if (!ok) return;
        try {
          await api(`/api/networks/${encodeURIComponent(networkId)}`, { method: 'DELETE' });
          toast('Network removed', 'success');
          if (onChange) onChange();
          modalRef.close && modalRef.close(null);
        } catch (ex) { toast(ex.message, 'error'); }
      };
    }

    function renderContainers() {
      if (!data.used_by || !data.used_by.length) {
        panel.innerHTML = `<div class="rounded border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">No containers attached.</div>`;
        return;
      }
      const rows = data.used_by.map((u) => `
        <tr class="hover:bg-slate-900/60">
          <td class="px-4 py-2">
            <div class="font-medium"><code class="text-slate-100">${escapeHtml(u.container_name)}</code></div>
            <div class="text-[11px] text-slate-500 font-mono">${escapeHtml(u.container_id.slice(0, 12))}</div>
          </td>
          <td class="px-4 py-2 font-mono text-xs text-slate-300">${escapeHtml(u.ipv4 || '—')}</td>
          <td class="px-4 py-2 font-mono text-xs text-slate-300">${escapeHtml(u.ipv6 || '—')}</td>
          <td class="px-4 py-2 font-mono text-xs text-slate-400">${escapeHtml(u.mac || '—')}</td>
          <td class="px-4 py-2 text-xs text-slate-400">${u.aliases && u.aliases.length ? u.aliases.map((a) => `<code class="text-slate-300">${escapeHtml(a)}</code>`).join(', ') : '<span class="text-slate-600">—</span>'}</td>
          <td class="px-4 py-2 text-right">
            ${isAdmin ? `<button data-act="disconnect" data-cid="${escapeHtml(u.container_id)}" data-cname="${escapeHtml(u.container_name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Disconnect</button>` : ''}
          </td>
        </tr>`).join('');
      panel.innerHTML = `
        <p class="mb-2 text-xs text-slate-500">${data.containers_count} container${data.containers_count === 1 ? '' : 's'} attached.</p>
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-900/70 text-[10px] uppercase tracking-wider text-slate-400">
            <tr><th class="px-4 py-2">Container</th><th class="px-4 py-2">IPv4</th><th class="px-4 py-2">IPv6</th><th class="px-4 py-2">MAC</th><th class="px-4 py-2">Aliases</th><th class="px-4 py-2 text-right">Actions</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
      panel.querySelectorAll('[data-act="disconnect"]').forEach((b) => {
        b.onclick = () => disconnectContainer(b.dataset.cid, b.dataset.cname);
      });
    }

    function renderIpam() {
      const cfg = data.ipam && Array.isArray(data.ipam.config) ? data.ipam.config : [];
      const optRows = Object.entries((data.ipam && data.ipam.options) || {}).map(([k, v]) =>
        `<tr><td class="pr-3 py-0.5 text-slate-400 font-mono text-[11px]">${escapeHtml(k)}</td><td class="font-mono text-[11px] text-slate-200">${escapeHtml(String(v))}</td></tr>`,
      ).join('');
      if (!cfg.length && !optRows) {
        panel.innerHTML = `<div class="rounded border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">No IPAM configuration. Docker auto-assigned this network's subnet.</div>`;
        return;
      }
      const cfgRows = cfg.map((c) => {
        const aux = c.aux_addresses && Object.keys(c.aux_addresses).length
          ? Object.entries(c.aux_addresses).map(([k, v]) => `<code class="text-[11px] text-slate-300">${escapeHtml(k)}=${escapeHtml(v)}</code>`).join(', ')
          : '<span class="text-slate-600">—</span>';
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-4 py-2 font-mono text-xs">${escapeHtml(c.subnet || '—')}</td>
            <td class="px-4 py-2 font-mono text-xs">${escapeHtml(c.gateway || '—')}</td>
            <td class="px-4 py-2 font-mono text-xs">${escapeHtml(c.ip_range || '—')}</td>
            <td class="px-4 py-2">${aux}</td>
          </tr>`;
      }).join('');
      panel.innerHTML = `
        <div class="mb-3 text-xs text-slate-400">IPAM driver: <code class="text-slate-200">${escapeHtml(data.ipam_driver)}</code></div>
        ${cfg.length ? `
          <table class="w-full text-left text-sm mb-4">
            <thead class="bg-slate-900/70 text-[10px] uppercase tracking-wider text-slate-400">
              <tr><th class="px-4 py-2">Subnet</th><th class="px-4 py-2">Gateway</th><th class="px-4 py-2">IP range</th><th class="px-4 py-2">Auxiliary addresses</th></tr>
            </thead>
            <tbody>${cfgRows}</tbody>
          </table>` : ''}
        ${optRows ? `
          <div class="mb-1 text-[11px] uppercase tracking-wider text-slate-500">IPAM driver options</div>
          <table class="rounded border border-slate-800 bg-slate-950/40 p-2"><tbody>${optRows}</tbody></table>` : ''}`;
    }

    function renderOptions() {
      const entries = Object.entries(data.options || {});
      if (!entries.length) {
        panel.innerHTML = `<div class="rounded border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">No driver-specific options.</div>`;
        return;
      }
      const rows = entries.map(([k, v]) => `
        <tr class="border-b border-slate-800/60">
          <td class="px-3 py-1 align-top font-mono text-xs text-slate-300 break-all">${escapeHtml(k)}</td>
          <td class="px-3 py-1 align-top font-mono text-xs text-slate-200 break-all">${escapeHtml(String(v))}</td>
        </tr>`).join('');
      panel.innerHTML = `
        <p class="mb-2 text-xs text-slate-500">Driver-specific options applied at create time. These can't be changed once the network exists.</p>
        <table class="w-full text-left">
          <thead class="text-[10px] uppercase tracking-wider text-slate-400">
            <tr><th class="w-1/3 px-3 py-1">Key</th><th class="px-3 py-1">Value</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    function renderLabels() {
      const keys = Object.keys(data.labels || {}).sort();
      const rows = keys.map((k) => `
        <tr class="border-b border-slate-800/60">
          <td class="px-3 py-1 align-top font-mono text-xs text-slate-300 break-all">${escapeHtml(k)}</td>
          <td class="px-3 py-1 align-top font-mono text-xs text-slate-200 break-all">${escapeHtml(data.labels[k])}</td>
        </tr>`).join('');
      panel.innerHTML = `
        <p class="mb-2 text-xs text-slate-500">Network labels are set at create time and can only be replaced by re-creating the network.</p>
        <table class="w-full text-left">
          <thead class="text-[10px] uppercase tracking-wider text-slate-400">
            <tr><th class="w-1/3 px-3 py-1">Key</th><th class="px-3 py-1">Value</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="2" class="px-3 py-4 text-center text-xs text-slate-500">No labels</td></tr>'}</tbody>
        </table>`;
    }

    function renderRaw() {
      panel.innerHTML = '';
      panel.appendChild(jsonView(data.raw || {}));
    }

    const renderers = {
      overview: renderOverview, containers: renderContainers, ipam: renderIpam,
      options: renderOptions, labels: renderLabels, raw: renderRaw,
    };
    function activate(tab) {
      wrap.querySelectorAll('.ni-tab').forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle('bg-sky-500/20', active);
        b.classList.toggle('text-sky-300', active);
        b.classList.toggle('text-slate-400', !active);
      });
      (renderers[tab] || renderOverview)();
    }
    wrap.addEventListener('click', (e) => {
      const t = e.target.closest('.ni-tab');
      if (t) activate(t.dataset.tab);
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        try { navigator.clipboard.writeText(copy.dataset.copy); toast('Copied', 'success'); }
        catch { /* ignore */ }
      }
    });

    async function disconnectContainer(cid, cname) {
      const ok = await confirmModal(
        `Disconnect <code>${escapeHtml(cname || cid.slice(0, 12))}</code> from <code>${escapeHtml(data.name)}</code>?`,
        { danger: true, confirmLabel: 'Disconnect' },
      );
      if (!ok) return;
      try {
        await api(`/api/networks/${encodeURIComponent(networkId)}/disconnect`, {
          method: 'POST', body: JSON.stringify({ container: cid, force: false }),
        });
        toast('Disconnected', 'success');
        await refresh();
      } catch (e) {
        // 409 = stuck endpoint; offer the force path.
        if (e.status === 409) {
          const forceOk = await confirmModal(
            `Disconnect failed: <code>${escapeHtml(e.message)}</code>.<br><br>` +
            `Force-disconnect drops the endpoint without asking the container — the container will see a network error on its next packet. Continue with <strong>force=true</strong>?`,
            { danger: true, confirmLabel: 'Force disconnect' },
          );
          if (!forceOk) return;
          try {
            await api(`/api/networks/${encodeURIComponent(networkId)}/disconnect`, {
              method: 'POST', body: JSON.stringify({ container: cid, force: true }),
            });
            toast('Force-disconnected', 'warn');
            await refresh();
          } catch (ex) { toast(ex.message, 'error'); }
        } else {
          toast(e.message, 'error');
        }
      }
    }

    async function refresh() {
      try {
        const fresh = await api(`/api/networks/${encodeURIComponent(networkId)}`);
        Object.assign(data, fresh);
        // Rebuild the Containers tab counter on the tab button itself.
        const cBtn = wrap.querySelector('.ni-tab[data-tab="containers"]');
        if (cBtn) cBtn.textContent = `Containers (${data.containers_count})`;
        // Re-render whichever tab is active.
        const active = wrap.querySelector('.ni-tab.bg-sky-500\\/20');
        activate((active && active.dataset.tab) || 'overview');
        if (onChange) onChange();
      } catch (e) { toast(e.message, 'error'); }
    }

    const modalRef = {};
    activate('overview');
    await modal({ title: `Network: ${data.name}`, body: wrap, size: 'xl', ref: modalRef });
  }

  /**
   * "Connect container" dialog. The container picker is populated from
   * /api/containers so the admin doesn't have to remember IDs; manual
   * entry is still allowed for cases like "container created by an
   * external tool I didn't list".
   */
  async function openConnectContainerDialog(networkId, networkName) {
    let containers = [];
    try { containers = await api('/api/containers?all=true'); }
    catch { /* fall back to manual entry only */ }

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3">
        <label class="block">
          <span class="text-xs uppercase tracking-wider text-slate-400">Container *</span>
          <select id="cn-pick" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
            <option value="">— pick a container or type below —</option>
          </select>
          <input id="cn-manual" placeholder="…or enter a container ID/name"
                 class="mt-2 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
        </label>
        <div class="grid md:grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">IPv4 address (optional)</span>
            <input id="cn-ipv4" placeholder="172.20.0.10"
                   class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">IPv6 address (optional)</span>
            <input id="cn-ipv6" placeholder="2001:db8::10"
                   class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
          </label>
          <label class="md:col-span-2 block">
            <span class="text-xs uppercase tracking-wider text-slate-400">MAC address (optional)</span>
            <input id="cn-mac" placeholder="02:42:ac:11:00:02"
                   class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
            <span class="block mt-1 text-[11px] text-slate-500">Six octets separated by <code>:</code> or <code>-</code>.</span>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">Aliases (comma-separated)</span>
            <input id="cn-aliases" placeholder="db, primary"
                   class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
          </label>
          <label class="block">
            <span class="text-xs uppercase tracking-wider text-slate-400">Links (comma-separated)</span>
            <input id="cn-links" placeholder="cache:redis"
                   class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
            <span class="block mt-1 text-[11px] text-slate-500">Legacy bridge-only feature; usually leave blank.</span>
          </label>
        </div>
      </div>`;

    // Populate the picker. Skip containers already on this network so
    // the user can't pick something that'll instantly 409.
    const sel = wrap.querySelector('#cn-pick');
    const sorted = [...containers].sort((a, b) => {
      const an = ((a.Names && a.Names[0]) || '').replace(/^\//, '');
      const bn = ((b.Names && b.Names[0]) || '').replace(/^\//, '');
      return an.localeCompare(bn);
    });
    for (const c of sorted) {
      const attached = c.NetworkSettings && c.NetworkSettings.Networks
        && Object.values(c.NetworkSettings.Networks).some((n) => n.NetworkID === networkId);
      if (attached) continue;
      const nm = ((c.Names && c.Names[0]) || c.Id).replace(/^\//, '');
      const opt = document.createElement('option');
      opt.value = c.Id;
      opt.textContent = `${nm} · ${c.Image || ''} · ${c.State || c.Status || ''}`;
      sel.appendChild(opt);
    }

    let ok = false;
    await modal({
      title: `Connect container to: ${networkName}`, body: wrap, size: 'md',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Connect', kind: 'primary', value: true, onClick: async () => {
          const picked = sel.value || wrap.querySelector('#cn-manual').value.trim();
          if (!picked) { toast('Container is required', 'warn'); return false; }
          const payload = { container: picked };
          const ipv4 = wrap.querySelector('#cn-ipv4').value.trim();
          const ipv6 = wrap.querySelector('#cn-ipv6').value.trim();
          const mac  = wrap.querySelector('#cn-mac').value.trim();
          const aliases = wrap.querySelector('#cn-aliases').value.split(',').map((s) => s.trim()).filter(Boolean);
          const links   = wrap.querySelector('#cn-links').value.split(',').map((s) => s.trim()).filter(Boolean);
          if (ipv4) payload.ipv4_address = ipv4;
          if (ipv6) payload.ipv6_address = ipv6;
          if (mac)  payload.mac_address  = mac;
          if (aliases.length) payload.aliases = aliases;
          if (links.length)   payload.links = links;
          try {
            await api(`/api/networks/${encodeURIComponent(networkId)}/connect`, {
              method: 'POST', body: JSON.stringify(payload),
            });
            toast('Connected', 'success'); ok = true;
          } catch (e) { toast(e.message, 'error'); return false; }
        }},
      ],
    });
    return ok;
  }

  // ---------- Volumes ----------
  views.volumes = async (root) => {
    // #23: viewers can't create / prune / delete / browse-write. We hide
    // the Create / Prune / Remove / Browse buttons rather than letting
    // them click into a 403. Inspect stays available (it's read-only).
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Volumes',
      'Manage persistent storage volumes',
      `${isAdmin ? btn('+ Create volume', { kind: 'primary', id: 'create-vol' }) : ''}
       ${isAdmin ? btn('Prune unused', { kind: 'secondary', id: 'prune-vols' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}
       ${btn('Sizes', { kind: 'ghost', id: 'load-sizes' })}`
    );

    // Filter / search controls live above the table so they're visible
    // without scrolling on long volume lists.
    const controls = document.createElement('div');
    controls.className = 'mb-3 flex flex-wrap items-center gap-2 text-xs';
    controls.innerHTML = `
      <input id="vols-search" type="text" placeholder="🔎 Search by name, mountpoint, stack…"
             class="flex-1 min-w-[240px] rounded border-slate-700 bg-slate-950 text-sm"/>
      <label class="flex items-center gap-2 text-slate-300">
        <input id="vols-unused" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900"/>
        Unused only
      </label>
      <span id="vols-count" class="text-slate-500 ml-auto"></span>
    `;
    root.appendChild(controls);

    const bulk = document.createElement('div');
    bulk.id = 'vols-bulk';
    bulk.className = 'mb-2 hidden items-center justify-between rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs';
    bulk.innerHTML = `
      <span><span id="vols-bulk-count" class="font-semibold text-sky-200">0</span> selected</span>
      <div class="flex items-center gap-2">
        ${isAdmin ? `<button id="vols-bulk-rm" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1">✕ Delete selected</button>` : ''}
        <button id="vols-bulk-clear" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700 text-slate-300">Clear</button>
      </div>`;
    root.appendChild(bulk);

    const listEl = document.createElement('div'); root.appendChild(listEl);

    // ---- State for filters + selection ----
    let lastVolumes = [];
    // #14: sizes are opt-in to avoid the slow /system/df call on every
    // page visit. Refresh triggers a re-load without sizes; the
    // dedicated "Sizes" button reloads with sizes.
    let loadSizesNext = true; // first load wants sizes
    const selected = new Set();

    function visibleVolumes() {
      const q = controls.querySelector('#vols-search').value.trim().toLowerCase();
      const unusedOnly = controls.querySelector('#vols-unused').checked;
      return lastVolumes.filter((v) => {
        if (unusedOnly && v.in_use) return false;
        if (q) {
          const hay = (v.name + ' ' + (v.mountpoint || '') + ' ' + (v.stack || '')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function renderBulkBar() {
      if (selected.size === 0) {
        bulk.classList.add('hidden'); bulk.classList.remove('flex'); return;
      }
      bulk.classList.remove('hidden'); bulk.classList.add('flex');
      bulk.querySelector('#vols-bulk-count').textContent = String(selected.size);
    }

    function renderRows() {
      const vols = visibleVolumes();
      controls.querySelector('#vols-count').textContent =
        `${vols.length} of ${lastVolumes.length} shown` +
        (selected.size ? ` · ${selected.size} selected` : '');

      if (lastVolumes.length === 0) {
        listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">No volumes on this host.</div>`;
        return;
      }
      if (vols.length === 0) {
        listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">No volumes match the current filters.</div>`;
        return;
      }

      const rows = vols.map((v) => {
        const rwCount = v.used_by.filter((u) => u.rw).length;
        const roCount = v.used_by.length - rwCount;
        // Split the "in use" badge into rw / ro pills so an admin can
        // see at a glance whether the volume is actively being WRITTEN
        // by something — important when deciding if it's safe to delete
        // or edit through the file manager.
        const inUseBadge = v.in_use
          ? `<span class="ml-1 inline-flex items-center gap-1 text-[10px]" title="${v.used_by.map((u)=>escapeHtml(u.container_name)+': '+escapeHtml(u.mount_path)+(u.rw?' (rw)':' (ro)')).join(', ')}">
              ${rwCount > 0 ? `<span class="rounded bg-emerald-500/20 px-1.5 py-0.5 font-medium text-emerald-300">rw × ${rwCount}</span>` : ''}
              ${roCount > 0 ? `<span class="rounded bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-300">ro × ${roCount}</span>` : ''}
            </span>`
          : `<span class="ml-1 inline-flex items-center rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">unused</span>`;
        const sizeCell = v.size_bytes == null || v.size_bytes < 0
          ? `<span class="text-slate-600">—</span>`
          : `<span class="font-mono">${escapeHtml(fmtBytes(v.size_bytes))}</span>`;
        const stackCell = v.stack
          ? `<a href="#stacks" class="text-sky-300 hover:underline">${escapeHtml(v.stack)}</a>`
          : `<span class="text-slate-600">—</span>`;
        const isChecked = selected.has(v.name) ? 'checked' : '';
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-3 py-2 w-8">
              ${isAdmin ? `<input type="checkbox" class="vols-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-name="${escapeHtml(v.name)}" ${isChecked}/>` : ''}
            </td>
            <td class="px-4 py-2">
              <div class="font-medium">${escapeHtml(v.name)}${inUseBadge}</div>
              <div class="text-[11px] text-slate-500 font-mono">${escapeHtml(v.driver || '')} · ${escapeHtml(v.mountpoint || '')}</div>
            </td>
            <td class="px-4 py-2 text-slate-300">${stackCell}</td>
            <td class="px-4 py-2 text-slate-400">${sizeCell}</td>
            <td class="px-4 py-2 text-slate-400">${fmtDate(v.created_at)}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                ${isAdmin ? `<button data-act="browse" data-id="${escapeHtml(v.name)}" class="rounded bg-sky-500/80 hover:bg-sky-500 text-white px-2 py-1 text-xs">📁 Browse</button>` : ''}
                <button data-act="inspect" data-id="${escapeHtml(v.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Inspect</button>
                ${isAdmin ? `<button data-act="remove" data-id="${escapeHtml(v.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>` : ''}
              </div>
            </td>
          </tr>`;
      });
      listEl.innerHTML = table(
        [
          `<input id="vols-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all visible"/>`,
          'Name', 'Stack', 'Size', 'Created', '',
        ],
        rows,
      );

      // Sync select-all checkbox state
      const cb = listEl.querySelector('#vols-select-all');
      if (cb) {
        const onPage = vols.filter((v) => selected.has(v.name)).length;
        cb.checked = onPage === vols.length;
        cb.indeterminate = onPage > 0 && onPage < vols.length;
        cb.addEventListener('change', (e) => {
          if (e.target.checked) for (const v of vols) selected.add(v.name);
          else for (const v of vols) selected.delete(v.name);
          renderRows(); renderBulkBar();
        });
      }
    }

    async function load() {
      listEl.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        // #14: pass sizes=false for background refresh to skip the slow
        // /system/df call. Sizes are loaded once on first open and again
        // when the user explicitly clicks "Sizes".
        const qs = loadSizesNext ? '?sizes=true' : '?sizes=false';
        const incoming = await api('/api/volumes' + qs);
        // If we're refreshing without sizes, preserve the previously
        // loaded size_bytes per-row so the column doesn't blank out.
        if (!loadSizesNext) {
          const prev = new Map(lastVolumes.map((v) => [v.name, v.size_bytes]));
          for (const v of incoming) {
            if (v.size_bytes == null && prev.has(v.name)) v.size_bytes = prev.get(v.name);
          }
        }
        lastVolumes = incoming;
        loadSizesNext = false;
        // Drop selections for volumes that no longer exist after the refresh.
        // (#26: selections survive filter changes — they're a Set keyed
        // by name, only dropped when the volume actually disappears.)
        for (const n of [...selected]) {
          if (!lastVolumes.some((v) => v.name === n)) selected.delete(n);
        }
        renderRows();
        renderBulkBar();
      } catch (e) {
        listEl.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    // ---- Event wiring ----
    controls.querySelector('#vols-search').addEventListener('input', () => { renderRows(); });
    controls.querySelector('#vols-unused').addEventListener('change', () => { renderRows(); });

    listEl.addEventListener('change', (e) => {
      const cb = e.target.closest('input.vols-check');
      if (!cb) return;
      if (cb.checked) selected.add(cb.dataset.name);
      else selected.delete(cb.dataset.name);
      renderBulkBar();
      // Refresh just the select-all + count, cheap to re-render
      controls.querySelector('#vols-count').textContent =
        `${visibleVolumes().length} of ${lastVolumes.length} shown` +
        (selected.size ? ` · ${selected.size} selected` : '');
      const all = listEl.querySelector('#vols-select-all');
      if (all) {
        const vols = visibleVolumes();
        const onPage = vols.filter((v) => selected.has(v.name)).length;
        all.checked = onPage === vols.length;
        all.indeterminate = onPage > 0 && onPage < vols.length;
      }
    });

    bulk.querySelector('#vols-bulk-clear').onclick = () => { selected.clear(); renderRows(); renderBulkBar(); };
    const bulkRmBtn = bulk.querySelector('#vols-bulk-rm');
    if (bulkRmBtn) bulkRmBtn.onclick = async () => {
      const names = [...selected];
      if (!names.length) return;
      const ok = await confirmModal(
        `Delete <strong>${names.length}</strong> volume${names.length === 1 ? '' : 's'}? <em>This is permanent — data will be lost.</em><br><br>In-use volumes will be reported as failures; use <em>Force remove</em> from the per-row Remove dialog to override on a case-by-case basis.`,
        { danger: true, confirmLabel: 'Delete all' },
      );
      if (!ok) return;
      try {
        // #1: bulk always sends force:false. If a user wants to
        // force-remove an in-use volume they go through the per-row
        // Remove flow, which has its own secondary confirm.
        const out = await api('/api/volumes/delete/bulk', {
          method: 'POST', body: JSON.stringify({ names, force: false }),
        });
        for (const r of out.results || []) {
          if (!r.ok) toast(`${r.name}: ${r.error || 'failed'}`, 'error');
        }
        if (out.succeeded) {
          toast(`Deleted ${out.succeeded}${out.failed ? ` of ${names.length}` : ''}`, out.failed ? 'warn' : 'success');
        }
      } catch (e) { toast(`Bulk delete failed: ${e.message}`, 'error'); }
      selected.clear();
      load();
    };

    // #1: per-row Remove starts safe (force=false). If the daemon
    // refuses with 409 (volume in use), we surface a SECOND confirm
    // that's explicit about the risk before retrying with force=true.
    async function removeVolume(id) {
      const v = lastVolumes.find((x) => x.name === id);
      const warn = v && v.in_use
        ? `<p class="mt-2 text-amber-300 text-xs">⚠ This volume is in use by ${v.used_by.length} container(s). The daemon will refuse to delete it unless you also force-remove.</p>`
        : '';
      const proceed = await confirmModal(
        `Remove volume <code>${escapeHtml(id)}</code>? Data will be lost.${warn}`,
        { danger: true, confirmLabel: 'Remove' },
      );
      if (!proceed) return;
      try {
        await api(`/api/volumes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Volume removed', 'success'); load();
      } catch (e) {
        // 409 — in use. Offer the force path with extra friction.
        if (e.status === 409) {
          const forceOk = await confirmModal(
            `<strong>Volume <code>${escapeHtml(id)}</code> is in use.</strong> ` +
            `Force-removing will detach it from running containers — they will fail their next read/write to this volume.<br><br>` +
            `Continue with <strong>force=true</strong>?`,
            { danger: true, confirmLabel: 'Force remove' },
          );
          if (!forceOk) return;
          try {
            await api(`/api/volumes/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
            toast('Volume force-removed', 'warn'); load();
          } catch (ex) { toast(ex.message, 'error'); }
        } else {
          toast(e.message, 'error');
        }
      }
    }

    listEl.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id; const act = t.dataset.act;
      try {
        if (act === 'browse') await openVolumeBrowser(id);
        else if (act === 'inspect') await openVolumeInspect(id, () => load());
        else if (act === 'remove') await removeVolume(id);
      } catch (ex) { toast(ex.message, 'error'); }
    });

    // #14: 'Refresh' polls without sizes (fast); 'Sizes' explicitly
    // re-fetches WITH /system/df so admins can see current disk usage
    // when they care.
    document.getElementById('refresh').onclick = () => { loadSizesNext = false; load(); };
    document.getElementById('load-sizes').onclick = () => { loadSizesNext = true; load(); };
    const pruneBtn = document.getElementById('prune-vols');
    if (pruneBtn) pruneBtn.onclick = async () => {
      const ok = await confirmModal('Prune unused volumes? Data will be lost.', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try { const r = await api('/api/volumes/prune', { method: 'POST' }); toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success'); load(); }
      catch (e) { toast(e.message, 'error'); }
    };
    const createBtn = document.getElementById('create-vol');
    if (createBtn) createBtn.onclick = async () => {
      // Discover the daemon's actually-installed volume drivers so we
      // can render a useful dropdown instead of a free-text input.
      // `docker info` always reports `Plugins.Volume = ["local", ...]`
      // (built-in `local` plus any plugin-installed volume drivers).
      // We deduplicate, sort, and fall back to `["local"]` if the
      // call fails or the daemon returns an empty list — `local` is
      // always available because it's compiled into the daemon.
      let drivers = ['local'];
      try {
        const info = await api('/api/system/info');
        const reported = (info && info.Plugins && Array.isArray(info.Plugins.Volume))
          ? info.Plugins.Volume.filter(Boolean)
          : [];
        const merged = new Set(['local', ...reported]);
        drivers = [...merged].sort((a, b) => {
          // Always show the built-in `local` first; other plugins
          // sorted alphabetically below.
          if (a === 'local') return -1;
          if (b === 'local') return 1;
          return a.localeCompare(b);
        });
      } catch { /* fall back to ['local'] */ }

      const wrap = document.createElement('div');
      const driverOptions = drivers.map((d) =>
        `<option value="${escapeHtml(d)}">${escapeHtml(d)}${d === 'local' ? ' (built-in)' : ''}</option>`
      ).join('');
      wrap.innerHTML = `
        <div class="grid gap-3 md:grid-cols-2">
          <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Name *</span>
            <input id="v-name" required class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
          <label class="block">
            <span class="text-xs text-slate-400">Driver</span>
            <select id="v-driver" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
              ${driverOptions}
              <option value="__custom__">Other (specify…)</option>
            </select>
            <input id="v-driver-custom" placeholder="my-custom-driver"
                   class="mt-2 hidden w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/>
            <span class="block mt-1 text-[11px] text-slate-500">
              Loaded from <code>docker info</code> · <code>Plugins.Volume</code>.
              Install a volume plugin (<code>docker plugin install &lt;name&gt;</code>) to see it here.
            </span>
          </label>
          <label class="block"><span class="text-xs text-slate-400">Driver options (KEY=VALUE per line)</span>
            <textarea id="v-driveropts" rows="3" placeholder="type=nfs&#10;o=addr=1.2.3.4,rw&#10;device=:/exports/data"
                      class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono"></textarea></label>
          <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Labels (KEY=VALUE per line)</span>
            <textarea id="v-labels" rows="3" placeholder="owner=team-a&#10;tier=prod"
                      class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono"></textarea></label>
        </div>`;

      // Toggle the custom-driver text field based on the dropdown:
      // hidden whenever a known driver is picked, revealed and focused
      // when the user picks "Other (specify…)".
      const driverSelect = wrap.querySelector('#v-driver');
      const driverCustom = wrap.querySelector('#v-driver-custom');
      driverSelect.addEventListener('change', () => {
        const custom = driverSelect.value === '__custom__';
        driverCustom.classList.toggle('hidden', !custom);
        if (custom) setTimeout(() => driverCustom.focus(), 0);
      });

      function parseKv(text) {
        const out = {};
        for (const raw of (text || '').split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const k = line.slice(0, eq).trim();
          const v = line.slice(eq + 1).trim();
          if (k) out[k] = v;
        }
        return out;
      }

      let created = null;
      const ok = await modal({
        title: 'Create volume', body: wrap, size: 'md',
        actions: [
          { label: 'Cancel', value: false, kind: 'secondary' },
          { label: 'Create', kind: 'primary', value: true, onClick: async () => {
            const driverChoice = driverSelect.value === '__custom__'
              ? driverCustom.value.trim()
              : driverSelect.value;
            const payload = {
              name: wrap.querySelector('#v-name').value.trim(),
              driver: driverChoice || 'local',
              labels: parseKv(wrap.querySelector('#v-labels').value),
              driver_opts: parseKv(wrap.querySelector('#v-driveropts').value),
            };
            // Mirror the server's name regex client-side so users get an
            // inline error instead of a generic API failure (#13 in the
            // review). Stays loose — server is the source of truth.
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(payload.name)) {
              toast('Invalid name: must start with a letter or digit and contain only [A-Za-z0-9_.-]', 'warn');
              return false;
            }
            // If "Other" was picked but left blank, refuse with an
            // inline error instead of silently falling back to `local`.
            if (driverSelect.value === '__custom__' && !payload.driver) {
              toast('Custom driver name is required when "Other" is selected', 'warn');
              return false;
            }
            try {
              created = await api('/api/volumes', { method: 'POST', body: JSON.stringify(payload) });
              toast('Volume created', 'success');
            } catch (e) { toast(e.message, 'error'); return false; }
          }},
        ],
      });
      // #28: prepend the enriched row from the server instead of
      // re-fetching the whole list.
      if (ok && created) {
        lastVolumes = [created, ...lastVolumes];
        renderRows(); renderBulkBar();
      } else if (ok) {
        load();
      }
    };

    await load();
  };

  // ---------- Terminal (container exec) ----------
  function openTerminal(containerId, containerName) {
    if (typeof Terminal === 'undefined') {
      toast('Terminal library failed to load', 'error');
      return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <label class="text-xs text-slate-400">Command
          <input id="term-cmd" value="${escapeHtml(state.config.exec_default_shell || '/bin/sh')}" class="ml-1 w-56 rounded border-slate-700 bg-slate-950 text-xs font-mono"/>
        </label>
        <button id="term-reconnect" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">Reconnect</button>
        <span id="term-status" class="ml-2 text-xs text-slate-400">Idle</span>
      </div>
      <div id="term-host" class="rounded border border-slate-800 bg-black" style="height: 60vh; padding: 6px;"></div>`;

    let term, fit, ws, resizeObs;

    function setStatus(text, kind = 'info') {
      const el = wrap.querySelector('#term-status');
      if (!el) return;
      const tones = { info: 'text-slate-400', ok: 'text-emerald-400', err: 'text-rose-400' };
      el.className = `ml-2 text-xs ${tones[kind] || tones.info}`;
      el.textContent = text;
    }

    async function connect() {
      if (ws && ws.readyState !== WebSocket.CLOSED) { try { ws.close(); } catch {} }
      let ticket;
      try {
        const r = await api('/api/exec/ticket', { method: 'POST' });
        ticket = r.ticket;
      } catch (e) { setStatus(e.message, 'err'); return; }
      const cmd = wrap.querySelector('#term-cmd').value || '/bin/sh';
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const cols = term.cols, rows = term.rows;
      const url = `${proto}://${location.host}/api/containers/${encodeURIComponent(containerId)}/exec`
        + `?ticket=${encodeURIComponent(ticket)}&cmd=${encodeURIComponent(cmd)}&cols=${cols}&rows=${rows}`;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      setStatus('Connecting…');
      ws.onopen = () => { setStatus('Connected', 'ok'); term.focus(); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') term.write(ev.data);
        else term.write(new Uint8Array(ev.data));
      };
      ws.onclose = (ev) => setStatus(`Disconnected (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`, ev.code === 1000 ? 'info' : 'err');
      ws.onerror = () => setStatus('Connection error', 'err');
    }

    // Open the modal first (without awaiting) so the host element is in the DOM,
    // then bootstrap xterm.js into it.
    const promise = modal({
      title: `Terminal: ${containerName || containerId.slice(0,12)}`,
      body: wrap, size: 'xl',
      actions: [{ label: 'Close', value: null, kind: 'secondary' }],
    });

    // Defer to next tick so DOM is mounted.
    setTimeout(() => {
      try {
        term = new Terminal({
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: 13,
          cursorBlink: true,
          theme: { background: '#000000', foreground: '#e2e8f0' },
          convertEol: true,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(wrap.querySelector('#term-host'));
        try { fit.fit(); } catch {}
        term.onData((data) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); });
        term.onResize(({ cols, rows }) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        });
        resizeObs = new ResizeObserver(() => { try { fit.fit(); } catch {} });
        resizeObs.observe(wrap.querySelector('#term-host'));
        wrap.querySelector('#term-reconnect').onclick = connect;
        wrap.querySelector('#term-cmd').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); connect(); }
        });
        connect();
      } catch (e) {
        setStatus('Init failed: ' + e.message, 'err');
      }
    }, 0);

    promise.then(() => {
      try { ws && ws.close(); } catch {}
      try { resizeObs && resizeObs.disconnect(); } catch {}
      try { term && term.dispose(); } catch {}
    });
  };

  // ---------- Stacks ----------
  views.stacks = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';
    const composeAvail = state.config.compose_available;
    const warning = composeAvail ? '' : `
      <div class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        <strong>docker-compose binary not found</strong> on the manager host. You can still browse stacks discovered from running containers, but creating or deploying stacks is disabled. Install the compose plugin or set <code>COMPOSE_BIN</code>.
      </div>`;
    root.innerHTML = pageHeader(
      'Stacks',
      'Manage docker-compose projects',
      `${isAdmin && composeAvail ? btn('+ New stack', { kind: 'primary', id: 'new-stack' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    ) + warning;

    const controls = document.createElement('div');
    controls.className = 'mb-3 flex items-center gap-3 text-xs';
    controls.innerHTML = `<span id="stacks-count" class="text-slate-500 ml-auto"></span>`;
    root.appendChild(controls);

    // Bulk bar — managed-only stacks (the ones with stored compose files
    // we can drive via the CLI). Discovered-only stacks have no compose
    // file on disk; bulk operations on them would be no-ops, so they're
    // not selectable.
    const bulkSel = createBulkSelection({
      key: (s) => s.name,
      isEligible: (s) => !!s.managed,
    });
    const bulkBarObj = (isAdmin && composeAvail)
      ? bulkBar(bulkSel, {
          actions: [
            { label: '▲ Up',      kind: 'success',   onClick: (names) => bulkStackAction('up',      names, { verb: 'Started' }) },
            { label: '▼ Down',    kind: 'secondary', onClick: (names) => bulkStackAction('down',    names, { verb: 'Stopped', askVolumes: true }) },
            { label: '↻ Restart', kind: 'secondary', onClick: (names) => bulkStackAction('restart', names, { verb: 'Restarted' }) },
            { label: '✕ Remove',  kind: 'danger',    onClick: (names) => bulkStackRemove(names) },
          ],
        })
      : { el: document.createElement('div'), render: () => {} };
    root.appendChild(bulkBarObj.el);

    const list = document.createElement('div'); root.appendChild(list);
    let stacks = [];

    async function bulkStackAction(verb, names, { verb: msg, askVolumes = false } = {}) {
      let body = { names };
      if (askVolumes) {
        // For `down`, ask whether to also drop the stacks' volumes.
        // Defaults to "no" because losing a database volume on a click
        // would be a very bad day.
        const choice = await modal({
          title: `Down ${names.length} stack${names.length === 1 ? '' : 's'}`, size: 'sm',
          body: `<p class="text-sm text-slate-300">Tear down ${names.length} stack${names.length === 1 ? '' : 's'} with <code>docker compose down</code>. Containers + networks defined by the compose file go away; the file itself stays on disk so you can <code>Up</code> again later.</p>
            <label class="mt-3 flex items-center gap-2 text-xs text-slate-300">
              <input id="down-vols" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-rose-500"/>
              Also remove anonymous volumes (<code>-v</code>) — <strong class="text-rose-300">data loss</strong>
            </label>`,
          actions: [
            { label: 'Cancel', value: null, kind: 'secondary' },
            { label: 'Down',   value: 'go', kind: 'danger' },
          ],
        });
        if (choice !== 'go') return false;
        body.volumes = !!document.querySelector('#down-vols')?.checked;
      } else if (msg !== 'Started') {
        // Restart confirms; Up doesn't (already explicit on click).
        const ok = await confirmModal(
          `${msg} <strong>${names.length}</strong> stack${names.length === 1 ? '' : 's'}? Output is shown per-stack in the toast log; for full live output, drill into an individual stack.`,
          { danger: false, confirmLabel: msg },
        );
        if (!ok) return false;
      }
      try {
        const out = await api(`/api/stacks/${verb}/bulk`, {
          method: 'POST', body: JSON.stringify(body),
        });
        handleBulkResponse(out, msg, (r) => r.name);
      } catch (e) { toast(`Bulk ${verb} failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    async function bulkStackRemove(names) {
      const choice = await modal({
        title: `Delete ${names.length} stack${names.length === 1 ? '' : 's'}`, size: 'sm',
        body: `<p class="text-sm text-slate-300"><strong class="text-rose-300">Tear down and delete</strong> ${names.length} stack${names.length === 1 ? '' : 's'}: containers + networks defined by the compose file are removed, then the compose file and .env are deleted from the manager host.</p>
          <label class="mt-3 flex items-center gap-2 text-xs text-slate-300">
            <input id="rm-vols" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-rose-500"/>
            Also remove anonymous volumes (<code>-v</code>) — <strong class="text-rose-300">data loss</strong>
          </label>`,
        actions: [
          { label: 'Cancel', value: null, kind: 'secondary' },
          { label: 'Delete', value: 'go', kind: 'danger' },
        ],
      });
      if (choice !== 'go') return false;
      const body = { names, volumes: !!document.querySelector('#rm-vols')?.checked };
      try {
        const out = await api('/api/stacks/remove/bulk', {
          method: 'POST', body: JSON.stringify(body),
        });
        handleBulkResponse(out, 'Removed', (r) => r.name);
      } catch (e) { toast(`Bulk remove failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        stacks = await api('/api/stacks');
        bulkSel.pruneAgainst(stacks);
        draw();
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    function draw() {
      controls.querySelector('#stacks-count').textContent =
        `${stacks.length} stack${stacks.length === 1 ? '' : 's'}` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');
      const rows = stacks.map((s) => {
        const eligible = isAdmin && composeAvail && s.managed;
        const checked = bulkSel.has(s.name) ? 'checked' : '';
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-3 py-2 w-8">
              ${eligible ? `<input type="checkbox" class="stacks-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-name="${escapeHtml(s.name)}" ${checked}/>` : ''}
            </td>
            <td class="px-4 py-2">
              <button data-act="open" data-name="${escapeHtml(s.name)}" class="text-left">
                <div class="font-medium text-sky-300 hover:underline">${escapeHtml(s.name)}</div>
                <div class="text-[11px] text-slate-500">${s.managed ? 'Managed' : 'External (no stored compose file)'}</div>
              </button>
            </td>
            <td class="px-4 py-2 text-slate-300">${s.services.map(escapeHtml).join(', ') || '<span class="text-slate-500">—</span>'}</td>
            <td class="px-4 py-2 text-slate-400">${s.running}/${s.containers}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                ${isAdmin && s.managed && composeAvail ? `<button data-act="up" data-name="${escapeHtml(s.name)}" class="rounded bg-emerald-500/80 hover:bg-emerald-500 text-white px-2 py-1 text-xs">▲ Up</button>` : ''}
                ${isAdmin && s.managed && composeAvail ? `<button data-act="down" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">▼ Down</button>` : ''}
                ${isAdmin && s.managed && composeAvail ? `<button data-act="restart" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">↻ Restart</button>` : ''}
                ${isAdmin && s.managed && composeAvail ? `<button data-act="pull" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">⤓ Pull</button>` : ''}
                ${isAdmin && s.managed ? `<button data-act="delete" data-name="${escapeHtml(s.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Delete</button>` : ''}
              </div>
            </td>
          </tr>`;
      });
      list.innerHTML = table(
        [
          (isAdmin && composeAvail)
            ? `<input id="stacks-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all managed stacks"/>`
            : '',
          'Name', 'Services', 'Running', '',
        ],
        rows,
      );
      const sa = list.querySelector('#stacks-select-all');
      if (sa) {
        const eligible = stacks.filter((s) => s.managed);
        const onPage = eligible.filter((s) => bulkSel.has(s.name)).length;
        sa.checked = eligible.length > 0 && onPage === eligible.length;
        sa.indeterminate = onPage > 0 && onPage < eligible.length;
        sa.addEventListener('change', (e) => {
          if (e.target.checked) for (const s of eligible) bulkSel.add(s.name);
          else for (const s of eligible) bulkSel.delete(s.name);
          draw(); bulkBarObj.render();
        });
      }
    }

    list.addEventListener('change', (e) => {
      const cb = e.target.closest('input.stacks-check');
      if (!cb) return;
      if (cb.checked) bulkSel.add(cb.dataset.name);
      else bulkSel.delete(cb.dataset.name);
      bulkBarObj.render();
      controls.querySelector('#stacks-count').textContent =
        `${stacks.length} stack${stacks.length === 1 ? '' : 's'}` +
        (bulkSel.size ? ` · ${bulkSel.size} selected` : '');
      const sa = list.querySelector('#stacks-select-all');
      if (sa) {
        const eligible = stacks.filter((s) => s.managed);
        const onPage = eligible.filter((s) => bulkSel.has(s.name)).length;
        sa.checked = eligible.length > 0 && onPage === eligible.length;
        sa.indeterminate = onPage > 0 && onPage < eligible.length;
      }
    });

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const name = t.dataset.name; const act = t.dataset.act;
      try {
        if (act === 'open') return openStackDialog(name).then((changed) => { if (changed) load(); });
        if (act === 'delete') {
          const ok = await confirmModal(`Tear down and delete stack "${name}"?`, { danger: true, confirmLabel: 'Delete' });
          if (!ok) return;
          await api(`/api/stacks/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast('Stack deleted', 'success'); load(); return;
        }
        // up/down/restart/pull stream output
        const path = `/api/stacks/${encodeURIComponent(name)}/${act}`;
        await streamComposeModal(`${name}: ${act}`, path);
        load();
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    if (isAdmin && composeAvail) {
      const btnNew = document.getElementById('new-stack');
      if (btnNew) btnNew.onclick = () => newStackDialog().then((created) => { if (created) load(); });
    }
    await load();
  };

  async function streamComposeModal(title, path, opts = {}) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<pre id="out" class="log-pane h-[55vh] overflow-auto scroll-thin rounded border border-slate-800 bg-slate-950/70 p-3 text-slate-300"></pre>`;
    const pane = wrap.querySelector('#out');
    let abort = new AbortController();
    const promise = modal({
      title, body: wrap, size: 'xl',
      actions: [{ label: 'Close', value: null, kind: 'secondary' }],
    });
    try {
      const res = await fetch(path, {
        method: opts.method || 'POST',
        headers: {
          Authorization: authHeader(),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body || null,
        signal: abort.signal,
      });
      if (!res.ok && !res.body) {
        let det = res.statusText; try { const j = await res.json(); det = j.detail || det; } catch {}
        pane.textContent += `ERROR ${res.status}: ${det}\n`;
      } else {
        const reader = res.body.getReader(); const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          pane.textContent += dec.decode(value, { stream: true });
          pane.scrollTop = pane.scrollHeight;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') pane.textContent += `\n[stream error: ${e.message}]\n`;
    }
    promise.then(() => abort.abort());
    await promise;
  }

  async function newStackDialog() {
    const sample = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    restart: unless-stopped
`;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3">
        <label class="block"><span class="text-xs text-slate-400">Stack name *</span>
          <input id="s-name" required placeholder="my-app" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">docker-compose.yml *</span>
          <textarea id="s-compose" rows="14" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono">${escapeHtml(sample)}</textarea></label>
        <details>
          <summary class="text-xs text-slate-400 cursor-pointer">Optional .env file</summary>
          <textarea id="s-env" rows="4" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-xs font-mono" placeholder="KEY=value"></textarea>
        </details>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input id="s-deploy" type="checkbox" checked class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Deploy immediately (docker-compose up -d)
        </label>
      </div>`;
    let success = false;
    await modal({
      title: 'New stack',
      body: wrap, size: 'xl',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Create', kind: 'primary', value: true, onClick: async () => {
          const payload = {
            name: wrap.querySelector('#s-name').value.trim(),
            compose: wrap.querySelector('#s-compose').value,
            env: wrap.querySelector('#s-env').value || null,
            deploy: wrap.querySelector('#s-deploy').checked,
          };
          if (!payload.name) return false;
          try {
            const res = await fetch('/api/stacks', {
              method: 'POST',
              headers: {
                Authorization: authHeader(),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            });
            if (!res.ok) {
              let det = res.statusText; try { const j = await res.json(); det = j.detail || det; } catch {}
              throw new Error(det);
            }
            success = true;
            if (payload.deploy) {
              const reader = res.body.getReader(); const dec = new TextDecoder();
              const pane = document.createElement('pre');
              pane.className = 'log-pane mt-3 h-48 overflow-auto scroll-thin rounded border border-slate-800 bg-slate-950/70 p-3 text-slate-300';
              wrap.appendChild(pane);
              while (true) {
                const { value, done } = await reader.read(); if (done) break;
                pane.textContent += dec.decode(value, { stream: true });
                pane.scrollTop = pane.scrollHeight;
              }
            }
            toast('Stack created', 'success');
          } catch (e) {
            toast(e.message, 'error'); return false;
          }
        }},
      ],
    });
    return success;
  }

  async function openStackDialog(name) {
    let stack;
    try { stack = await api(`/api/stacks/${encodeURIComponent(name)}`); }
    catch (e) { toast(e.message, 'error'); return false; }

    const composeAvail = state.config.compose_available;
    const services = (stack.services && stack.services.length) ? stack.services :
      Array.from(new Set((stack.containers_detail || []).map(c => c.service).filter(Boolean)));
    const byService = {};
    for (const s of services) byService[s] = [];
    for (const c of (stack.containers_detail || [])) {
      if (c.service) (byService[c.service] = byService[c.service] || []).push(c);
    }

    function serviceRow(svc) {
      const cs = byService[svc] || [];
      const running = cs.filter(c => c.status === 'running').length;
      const tone = !cs.length ? 'bg-slate-700/40 text-slate-300 border border-slate-600/40'
        : (running === cs.length ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : (running === 0 ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'));
      const containers = cs.map(c => `
        <div class="flex items-center justify-between gap-2 border-t border-slate-800/50 px-3 py-1.5 text-xs">
          <div class="min-w-0">
            <div class="font-medium text-slate-200 truncate">${escapeHtml(c.name)}</div>
            <div class="text-[10px] text-slate-500 font-mono truncate">${escapeHtml(c.image || '')} · ${shortId(c.id)}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            ${statusBadge(c.status)}
            <button data-svc-cact="inspect" data-cid="${c.id}" title="Inspect" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-[10px]">⌕</button>
            ${c.status === 'running' ? `<button data-svc-cact="exec" data-cid="${c.id}" data-cname="${escapeHtml(c.name)}" title="Terminal" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-[10px]">⌨</button>` : ''}
            <button data-svc-cact="logs" data-cid="${c.id}" title="Logs" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-[10px]">📜</button>
          </div>
        </div>`).join('');
      return `
        <div class="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div class="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900/70">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-medium text-slate-100 truncate">${escapeHtml(svc)}</span>
              <span class="badge ${tone}">${running}/${cs.length}</span>
            </div>
            ${stack.managed && composeAvail ? `
              <div class="flex gap-1 shrink-0">
                <button data-svc-act="up" data-svc="${escapeHtml(svc)}" title="docker compose up -d ${escapeHtml(svc)}" class="rounded bg-emerald-500/80 hover:bg-emerald-500 text-white px-2 py-0.5 text-[11px]">▲</button>
                <button data-svc-act="restart" data-svc="${escapeHtml(svc)}" title="restart" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 text-[11px]">↻</button>
                <button data-svc-act="stop" data-svc="${escapeHtml(svc)}" title="stop" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 text-[11px]">■</button>
                <button data-svc-act="logs" data-svc="${escapeHtml(svc)}" title="logs" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-0.5 text-[11px]">📜</button>
                <button data-svc-act="rm" data-svc="${escapeHtml(svc)}" title="rm -sf" class="rounded bg-rose-500/70 hover:bg-rose-500 text-white px-2 py-0.5 text-[11px]">✕</button>
              </div>` : ''}
          </div>
          ${containers || '<div class="px-3 py-2 text-xs text-slate-500">No containers</div>'}
        </div>`;
    }

    const wrap = document.createElement('div');
    const stackTone = stack.containers === 0 ? 'bg-slate-700/40 text-slate-300 border border-slate-600/40'
      : (stack.running === stack.containers ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
      : (stack.running === 0 ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'));

    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span class="badge ${stack.managed ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30' : 'bg-slate-700/40 text-slate-300 border border-slate-600/40'}">${stack.managed ? 'Managed' : 'External'}</span>
        <span class="badge ${stackTone}">${stack.running}/${stack.containers} running</span>
        <span class="text-slate-400">${services.length} service${services.length === 1 ? '' : 's'}</span>
        ${stack.managed && composeAvail ? `<button id="s-validate" class="ml-auto rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-[11px]">Validate compose</button>` : ''}
      </div>

      <div class="grid gap-4 ${stack.managed ? 'lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]' : ''}">
        ${stack.managed ? `
          <div class="space-y-3">
            <div>
              <div class="mb-1 flex items-center justify-between">
                <h4 class="text-xs uppercase tracking-wider text-slate-400">docker-compose.yml</h4>
                <span id="s-validate-status" class="text-[11px] text-slate-500"></span>
              </div>
              <textarea id="s-compose" spellcheck="false" rows="20" class="w-full rounded border-slate-700 bg-slate-950 text-xs font-mono leading-relaxed" style="tab-size:2">${escapeHtml(stack.compose || '')}</textarea>
            </div>
            <div>
              <h4 class="mb-1 text-xs uppercase tracking-wider text-slate-400">.env</h4>
              <textarea id="s-env" spellcheck="false" rows="5" class="w-full rounded border-slate-700 bg-slate-950 text-xs font-mono">${escapeHtml(stack.env || '')}</textarea>
            </div>
          </div>` : ''}
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-slate-400">Services</h4>
          <div class="space-y-2">
            ${services.length ? services.map(serviceRow).join('') : '<div class="text-xs text-slate-500">No services</div>'}
          </div>
          ${stack.managed && composeAvail ? `
            <div class="mt-4 grid grid-cols-2 gap-2">
              <button data-stack-act="up" class="rounded bg-emerald-500/80 hover:bg-emerald-500 text-white px-2 py-1.5 text-xs">▲ Up -d (all)</button>
              <button data-stack-act="down" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">▼ Down</button>
              <button data-stack-act="restart" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">↻ Restart all</button>
              <button data-stack-act="pull" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">⤓ Pull all</button>
              <button data-stack-act="logs" class="col-span-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">📜 Tail logs (all)</button>
            </div>` : ''}
        </div>
      </div>`;

    // Tab inserts a real tab character in the YAML editor. Compose forbids tabs, but
    // some users prefer them to indent — we just keep the editor predictable.
    const ta = wrap.querySelector('#s-compose');
    if (ta) {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart, eend = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(eend);
          ta.selectionStart = ta.selectionEnd = s + 2;
        }
      });
    }

    wrap.addEventListener('click', async (e) => {
      const stackBtn = e.target.closest('[data-stack-act]');
      if (stackBtn) {
        const act = stackBtn.dataset.stackAct;
        if (act === 'logs') {
          return streamComposeModal(`${name}: logs`, `/api/stacks/${encodeURIComponent(name)}/logs?tail=300`, { method: 'GET' });
        }
        return streamComposeModal(`${name}: ${act}`, `/api/stacks/${encodeURIComponent(name)}/${act}`);
      }
      const svcBtn = e.target.closest('[data-svc-act]');
      if (svcBtn) {
        const act = svcBtn.dataset.svcAct;
        const svc = svcBtn.dataset.svc;
        if (act === 'rm') {
          const ok = await confirmModal(`Remove containers for service "${svc}"?`, { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
        }
        if (act === 'logs') {
          return streamComposeModal(`${name}/${svc}: logs`, `/api/stacks/${encodeURIComponent(name)}/services/${encodeURIComponent(svc)}/logs?tail=300`, { method: 'GET' });
        }
        return streamComposeModal(`${name}/${svc}: ${act}`, `/api/stacks/${encodeURIComponent(name)}/services/${encodeURIComponent(svc)}/${act}`);
      }
      const cBtn = e.target.closest('[data-svc-cact]');
      if (cBtn) {
        const act = cBtn.dataset.svcCact;
        const cid = cBtn.dataset.cid;
        if (act === 'inspect') return showContainerInspect(cid);
        if (act === 'exec') return openTerminal(cid, cBtn.dataset.cname);
        if (act === 'logs') return showContainerLogs(cid);
      }
    });

    if (stack.managed && composeAvail) {
      const vbtn = wrap.querySelector('#s-validate');
      const vstatus = wrap.querySelector('#s-validate-status');
      vbtn.onclick = async () => {
        vstatus.textContent = 'Validating…'; vstatus.className = 'text-[11px] text-slate-400';
        try {
          // First save the current text to disk so the validator sees it.
          await api(`/api/stacks/${encodeURIComponent(name)}`, {
            method: 'PUT',
            body: JSON.stringify({ compose: ta.value, env: wrap.querySelector('#s-env').value }),
          });
          const r = await api(`/api/stacks/${encodeURIComponent(name)}/validate`, { method: 'POST' });
          if (r.ok) {
            vstatus.textContent = '✓ valid'; vstatus.className = 'text-[11px] text-emerald-400';
          } else {
            vstatus.textContent = '✗ invalid (see toast)'; vstatus.className = 'text-[11px] text-rose-400';
            toast(r.stderr.trim().split('\n').slice(-3).join('\n') || 'compose config failed', 'error');
          }
        } catch (ex) {
          vstatus.textContent = '✗ error'; vstatus.className = 'text-[11px] text-rose-400';
          toast(ex.message, 'error');
        }
      };
    }

    const actions = [{ label: 'Close', value: false, kind: 'secondary' }];
    if (stack.managed) {
      actions.push({ label: 'Save changes', kind: 'primary', value: true, onClick: async () => {
        const payload = {
          compose: ta.value,
          env: wrap.querySelector('#s-env').value,
        };
        try {
          await api(`/api/stacks/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(payload) });
          toast('Saved (run "Up" to apply)', 'success');
        } catch (e) { toast(e.message, 'error'); return false; }
      }});
    }
    return await modal({ title: `Stack: ${name}`, body: wrap, size: 'xl', actions }) === true;
  }

  // ---------- Volume file manager (Portainer-style) ----------
  //
  // Layout:
  //   [breadcrumb] [+ New folder] [⤒ Upload] [Stop sidecar]   [Sort: ▼]
  //   ┌─────────────────────────────────────────────────────────────┐
  //   │ NAME            SIZE   OWNER     MODIFIED       PERMS  ⋯  │
  //   │ 📁 ..                                                       │
  //   │ 📁 logs         —      root:root Apr 21 12:34   drwxr-xr-x  │
  //   │ 📄 nginx.conf   2.1KB  root:root Apr 21 12:34   -rw-r--r--  │
  //   │ 🔗 link → /etc  —      root:root Apr 21         lrwxrwxrwx  │
  //   └─────────────────────────────────────────────────────────────┘
  function _fileIcon(entry) {
    if (entry.is_link) return '🔗';
    if (entry.is_dir) return '📁';
    // Cheap extension heuristic — purely cosmetic.
    const ext = (entry.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    if (['txt','md','log','yaml','yml','json','xml','toml','ini','conf'].includes(ext)) return '📝';
    if (['png','jpg','jpeg','gif','svg','webp','ico','bmp'].includes(ext)) return '🖼️';
    if (['zip','tar','gz','bz2','xz','7z','rar'].includes(ext)) return '📦';
    if (['sh','bash','zsh','py','js','ts','rb','go','rs','c','h','cpp'].includes(ext)) return '⚙️';
    if (['pdf'].includes(ext)) return '📕';
    return '📄';
  }

  function _fmtDateShort(epoch) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return sameYear
      ? d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  }

  /**
   * Portainer-style tabbed inspect modal.
   *
   * Tabs:
   *   Overview   metadata + Browse / Delete actions
   *   Mounted by list of containers using it (container -> mount path + rw/ro)
   *   Labels     display-only — Docker labels are immutable after
   *              volume creation, so we show them but never edit
   *   Browse     embeds the file manager
   *   Raw        the full dockerode inspect payload (jsonView)
   *
   * `onChange` is called after a delete so the caller can refresh
   * its list.
   */
  async function openVolumeInspect(name, onChange) {
    const isAdmin = state.auth && state.auth.role === 'admin';

    let data;
    try { data = await api(`/api/volumes/${encodeURIComponent(name)}`); }
    catch (e) { toast(e.message, 'error'); return; }

    // VolumeDetail (#10): the inspect endpoint now returns the same
    // normalised snake_case shape as the list, plus a `raw` field
    // carrying the verbatim Docker inspect payload for the Raw tab.
    const labels = { ...(data.labels || {}) };
    const usedBy = data.used_by || [];
    const inUse = !!data.in_use;
    const stack = data.stack || null;

    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-3';
    // #25: rename the placeholder tab so it's not misleading. The label
    // now matches the button.
    wrap.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 text-xs border-b border-slate-800 pb-2">
        ${['overview','mounted','labels','browse','raw'].map((t, i) => `
          <button data-tab="${t}" class="vi-tab rounded px-2 py-1 ${i===0?'bg-sky-500/20 text-sky-300':'text-slate-400 hover:bg-slate-800'}">${
            {overview:'Overview', mounted:'Mounted by', labels:'Labels', browse:'Open file manager', raw:'Raw'}[t]
          }</button>
        `).join('')}
        <span class="ml-auto flex items-center gap-1">
          ${inUse ? (() => {
            const rwN = usedBy.filter((u) => u.rw).length;
            const roN = usedBy.length - rwN;
            return `${rwN > 0 ? `<span class="inline-flex items-center rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-300">rw × ${rwN}</span>` : ''}
                    ${roN > 0 ? `<span class="inline-flex items-center rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300">ro × ${roN}</span>` : ''}`;
          })() : `<span class="inline-flex items-center rounded bg-slate-700/40 px-2 py-0.5 text-[11px] font-medium text-slate-400">unused</span>`}
        </span>
      </div>
      <div id="vi-panel" class="min-h-[40vh]"></div>`;

    const panel = wrap.querySelector('#vi-panel');

    function fieldRow(label, value, opts = {}) {
      return `
        <div class="grid grid-cols-[10rem_1fr] gap-3 py-1.5 border-b border-slate-800/50">
          <div class="text-[11px] uppercase tracking-wider text-slate-500 self-start mt-0.5">${escapeHtml(label)}</div>
          <div class="text-sm ${opts.mono ? 'font-mono text-slate-300' : 'text-slate-200'}">${value}</div>
        </div>`;
    }

    function copyButton(text, label = 'copy') {
      const id = `c-${Math.random().toString(36).slice(2, 8)}`;
      return `<button id="${id}" data-copy="${escapeHtml(text)}" class="ml-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">${label}</button>`;
    }

    function renderOverview() {
      const stackLink = stack
        ? `<a href="#stacks" class="text-sky-300 hover:underline">${escapeHtml(stack)}</a>`
        : '<span class="text-slate-500">—</span>';
      const optsRows = Object.entries(data.options || {}).map(([k, v]) =>
        `<tr><td class="pr-3 py-0.5 text-slate-400 font-mono text-[11px]">${escapeHtml(k)}</td><td class="font-mono text-[11px] text-slate-200">${escapeHtml(String(v))}</td></tr>`,
      ).join('');
      panel.innerHTML = `
        <div class="space-y-1">
          ${fieldRow('Name', `<code class="text-slate-100">${escapeHtml(data.name)}</code>${copyButton(data.name)}`)}
          ${fieldRow('Driver', escapeHtml(data.driver), { mono: true })}
          ${fieldRow('Scope', escapeHtml(data.scope || ''))}
          ${fieldRow('Mountpoint', `<span class="font-mono">${escapeHtml(data.mountpoint || '')}</span>${copyButton(data.mountpoint || '')}`)}
          ${fieldRow('Stack (owner)', stackLink)}
          ${fieldRow('Created', escapeHtml(data.created_at || ''))}
          ${fieldRow('Driver options', optsRows ? `<table>${optsRows}</table>` : '<span class="text-slate-500">none</span>')}
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          ${isAdmin ? `<button id="vi-browse" class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-3 py-1.5 text-sm font-medium">📁 Browse files</button>` : ''}
          ${isAdmin ? `<button id="vi-delete" class="rounded bg-rose-500 hover:bg-rose-400 text-white px-3 py-1.5 text-sm font-medium">Remove volume</button>` : ''}
        </div>`;

      const browseBtn = panel.querySelector('#vi-browse');
      if (browseBtn) browseBtn.onclick = async () => activate('browse');

      const deleteBtn = panel.querySelector('#vi-delete');
      if (deleteBtn) deleteBtn.onclick = async () => {
        // #1: force-false-with-409-fallback. The first request is
        // safe; if the daemon says "in use", we offer the force path
        // with extra friction.
        const warn = inUse
          ? `<p class="mt-2 text-amber-300 text-xs">⚠ This volume is in use by ${usedBy.length} container(s). The daemon will refuse to delete it unless you also force-remove.</p>`
          : '';
        const ok = await confirmModal(
          `Remove volume <code>${escapeHtml(name)}</code>? Data will be lost.${warn}`,
          { danger: true, confirmLabel: 'Remove' },
        );
        if (!ok) return;
        try {
          await api(`/api/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast('Volume removed', 'success');
          if (onChange) onChange();
          modalRef.close && modalRef.close(null);
        } catch (ex) {
          if (ex.status === 409) {
            const forceOk = await confirmModal(
              `<strong>Volume <code>${escapeHtml(name)}</code> is in use.</strong> ` +
              `Force-removing will detach it from running containers — they will fail their next read/write to this volume.<br><br>` +
              `Continue with <strong>force=true</strong>?`,
              { danger: true, confirmLabel: 'Force remove' },
            );
            if (!forceOk) return;
            try {
              await api(`/api/volumes/${encodeURIComponent(name)}?force=true`, { method: 'DELETE' });
              toast('Volume force-removed', 'warn');
              if (onChange) onChange();
              modalRef.close && modalRef.close(null);
            } catch (e2) { toast(e2.message, 'error'); }
          } else { toast(ex.message, 'error'); }
        }
      };
    }

    function renderMounted() {
      if (!inUse) {
        panel.innerHTML = `<div class="rounded border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">Not mounted by any container.</div>`;
        return;
      }
      const rows = usedBy.map((u) => `
        <tr class="hover:bg-slate-900/60">
          <td class="px-4 py-2"><code class="text-slate-100">${escapeHtml(u.container_name)}</code><div class="text-[11px] text-slate-500 font-mono">${escapeHtml(u.container_id.slice(0, 12))}</div></td>
          <td class="px-4 py-2 font-mono text-xs text-slate-300">${escapeHtml(u.mount_path)}</td>
          <td class="px-4 py-2">${u.rw
            ? `<span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">rw</span>`
            : `<span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">ro</span>`}</td>
        </tr>`).join('');
      panel.innerHTML = `
        <p class="mb-2 text-xs text-slate-500">${usedBy.length} container${usedBy.length === 1 ? '' : 's'} currently mount${usedBy.length === 1 ? 's' : ''} this volume.</p>
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-900/70 text-[10px] uppercase tracking-wider text-slate-400">
            <tr><th class="px-4 py-2">Container</th><th class="px-4 py-2">Mount path</th><th class="px-4 py-2">Mode</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    function renderLabels() {
      const keys = Object.keys(labels).sort();
      const rows = keys.map((k) => `
        <tr class="border-b border-slate-800/60">
          <td class="px-2 py-1 align-top font-mono text-xs text-slate-300 break-all">${escapeHtml(k)}</td>
          <td class="px-2 py-1 align-top font-mono text-xs text-slate-200 break-all">${escapeHtml(labels[k])}</td>
        </tr>
      `).join('');
      panel.innerHTML = `
        <p class="mb-2 text-xs text-slate-500">
          Volume labels are set at create time and are <strong>immutable</strong> — Docker's Engine API has no
          <code class="text-[11px]">PATCH /volumes/{name}</code> endpoint. To add or change labels (e.g.
          <code class="text-[11px]">com.docker.compose.project</code>), delete the volume and recreate it with the
          new label set.
        </p>
        <table class="w-full text-left">
          <thead class="text-[10px] uppercase tracking-wider text-slate-400">
            <tr><th class="w-1/3 px-2 py-1">Key</th><th class="px-2 py-1">Value</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="2" class="px-2 py-4 text-center text-xs text-slate-500">No labels</td></tr>'}</tbody>
        </table>`;
    }

    function renderBrowse() {
      // #25: the file manager renders in its own dedicated modal — we
      // intentionally don't embed it here (it expects to be the only
      // modal in the stack and uses the full-screen toggle), so the
      // Browse tab is a launcher. Tab label matches the action.
      panel.innerHTML = `
        <div class="rounded border border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-300">
          <p class="mb-3">The volume file manager opens as its own modal.</p>
          <button id="vi-browse-open" class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-3 py-2 font-medium">📁 Open file manager</button>
        </div>`;
      panel.querySelector('#vi-browse-open').onclick = async () => {
        modalRef.close && modalRef.close(null);
        await openVolumeBrowser(name);
      };
    }

    function renderRaw() {
      panel.innerHTML = '';
      // #10: the inspect endpoint carries the verbatim Docker payload
      // under `raw`, so we just display that — no need to strip our
      // enrichment fields one by one.
      panel.appendChild(jsonView(data.raw || {}));
    }

    const renderers = {
      overview: renderOverview,
      mounted: renderMounted,
      labels: renderLabels,
      browse: renderBrowse,
      raw: renderRaw,
    };

    function activate(t) {
      for (const b of wrap.querySelectorAll('.vi-tab')) {
        const on = b.dataset.tab === t;
        b.className = 'vi-tab rounded px-2 py-1 ' + (on ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:bg-slate-800');
      }
      renderers[t]();
    }

    wrap.addEventListener('click', (e) => {
      const t = e.target.closest('.vi-tab'); if (t) activate(t.dataset.tab);
      // Copy buttons
      const c = e.target.closest('button[data-copy]');
      if (c) {
        const txt = c.dataset.copy;
        navigator.clipboard?.writeText(txt).then(() => {
          c.textContent = 'copied'; setTimeout(() => { c.textContent = 'copy'; }, 1200);
        }).catch(() => toast('Copy failed (clipboard unavailable)', 'warn'));
      }
    });

    activate('overview');

    const modalRef = {};
    await modal({
      title: `Inspect: ${name}`, body: wrap, size: 'xl', ref: modalRef,
    });
  }

  async function openVolumeBrowser(volumeName) {
    // Grid template kept in one place so header + rows can't drift apart.
    const GRID_COLS = 'grid-cols-[1.75rem_1fr_5.5rem_8rem_8rem_6.25rem_6.75rem]';
    const PAGE_SIZES = [50, 100, 250, 500, 1000];

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div id="vb-crumbs" class="flex flex-1 min-w-[280px] flex-wrap items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs"></div>
        <button id="vb-mkdir" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700" title="New folder">+ Folder</button>
        <label class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-2 py-1 text-xs cursor-pointer" title="Upload file(s)">⤒ Upload
          <input id="vb-upload" type="file" class="hidden" multiple/>
        </label>
        <button id="vb-dl-folder" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700" title="Download current folder as tar">⤓ tar</button>
        <select id="vb-sort" class="rounded border-slate-700 bg-slate-950 px-1 py-1 text-xs" title="Sort order">
          <option value="name">Sort: Name</option>
          <option value="size">Sort: Size</option>
          <option value="mtime">Sort: Modified</option>
        </select>
        <button id="vb-refresh" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700" title="Reload current directory">⟳</button>
      </div>

      <div id="vb-bulk" class="mb-2 hidden items-center justify-between rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs">
        <span><span id="vb-bulk-count" class="font-semibold text-sky-200">0</span> selected</span>
        <div class="flex items-center gap-2">
          <button id="vb-bulk-chmod" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700 text-slate-200" title="Change mode and/or ownership">🔒 Permissions…</button>
          <button id="vb-bulk-rm" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1">✕ Delete selected</button>
          <button id="vb-bulk-clear" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700 text-slate-300">Clear</button>
        </div>
      </div>

      <div id="vb-status" class="mb-2 hidden rounded px-3 py-2 text-xs"></div>

      <div id="vb-table" class="relative rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
        <div class="grid ${GRID_COLS} gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-400">
          <div><input id="vb-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all on this page"/></div>
          <div>Name</div>
          <div class="text-right">Size</div>
          <div>Owner</div>
          <div>Modified</div>
          <div class="font-mono">Perms</div>
          <div class="text-right">Actions</div>
        </div>
        <div id="vb-list" class="max-h-[55vh] overflow-auto scroll-thin"></div>
        <div id="vb-drop" class="pointer-events-none absolute inset-0 hidden items-center justify-center bg-sky-500/15 backdrop-blur-sm">
          <div class="rounded-lg border-2 border-dashed border-sky-300 bg-slate-950/70 px-6 py-4 text-sm text-sky-200">
            Drop file(s) to upload to <code class="text-sky-100" id="vb-drop-path">/</code>
          </div>
        </div>
      </div>

      <div id="vb-foot" class="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span id="vb-count">0 items</span>
        <div id="vb-pager" class="flex items-center gap-1">
          <label class="text-slate-400">Per page
            <select id="vb-pagesize" class="ml-1 rounded border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px]">
              ${PAGE_SIZES.map((n) => `<option value="${n}">${n}</option>`).join('')}
            </select>
          </label>
          <button id="vb-first" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-slate-300" title="First page">«</button>
          <button id="vb-prev"  class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-slate-300" title="Previous page">‹</button>
          <span id="vb-page-info" class="px-2 text-slate-400">—</span>
          <button id="vb-next"  class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-slate-300" title="Next page">›</button>
          <button id="vb-last"  class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5 py-0.5 text-slate-300" title="Last page">»</button>
        </div>
        <span>Volume: <code class="text-slate-400">${escapeHtml(volumeName)}</code></span>
      </div>`;

    // ---------- State ----------
    let cur = '/';
    let lastEntries = [];        // page entries from the latest /list call
    let total = 0;               // server-reported full directory count
    let offset = 0;              // current page offset (entries-aligned)
    let pageSize = 100;          // entries-per-page, see PAGE_SIZES
    let sortMode = 'name';
    const selected = new Set();  // names selected on the current page

    // ---------- Helpers ----------
    function setStatus(msg, kind = 'info') {
      const el = wrap.querySelector('#vb-status');
      if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
      el.classList.remove('hidden');
      el.textContent = msg;
      el.className = 'mb-2 rounded px-3 py-2 text-xs ' + (
        kind === 'err' ? 'bg-rose-500/15 text-rose-200'
        : kind === 'ok' ? 'bg-emerald-500/15 text-emerald-200'
        : 'bg-slate-800/60 text-slate-300');
    }

    function renderCrumbs(path) {
      const host = wrap.querySelector('#vb-crumbs');
      host.innerHTML = '';
      const segments = path.split('/').filter(Boolean);
      const root = document.createElement('button');
      root.textContent = '🏠 /';
      root.dataset.path = '/';
      root.className = 'rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-800';
      host.appendChild(root);
      let acc = '';
      for (let i = 0; i < segments.length; i++) {
        acc = acc + '/' + segments[i];
        const sep = document.createElement('span'); sep.textContent = '›'; sep.className = 'text-slate-600'; host.appendChild(sep);
        const b = document.createElement('button');
        b.textContent = segments[i];
        b.dataset.path = acc;
        b.className = 'rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-800';
        host.appendChild(b);
      }
      host.onclick = (e) => {
        const b = e.target.closest('button[data-path]');
        if (b) { offset = 0; selected.clear(); load(b.dataset.path); }
      };
    }

    function sortEntries(entries) {
      // Local sort within the current page only. The page itself is whatever
      // the server returned at (offset, offset+limit); sorting across pages
      // would require asking the API for a stable ordering, which it doesn't
      // currently support.
      const cmp = {
        name: (a, b) => a.name.localeCompare(b.name),
        size: (a, b) => (a.size || 0) - (b.size || 0),
        mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      }[sortMode] || (() => 0);
      return entries.slice().sort((a, b) => {
        const w = (e) => e.is_dir ? 0 : (e.is_link ? 1 : 2);
        return (w(a) - w(b)) || cmp(a, b);
      });
    }

    function rowFor(entry) {
      const owner = `${escapeHtml(entry.user || entry.uid)}:${escapeHtml(entry.group || entry.gid)}`;
      const sizeCol = entry.is_dir ? '—' : fmtBytes(entry.size);
      const date = _fmtDateShort(entry.mtime);
      const perms = entry.mode_str || '';
      const nameCell = entry.is_link && entry.link_target
        ? `${escapeHtml(entry.name)} <span class="text-slate-500">→ ${escapeHtml(entry.link_target)}</span>`
        : escapeHtml(entry.name);
      const nameCls = entry.is_dir
        ? 'text-sky-300 cursor-pointer'
        : (entry.is_link ? 'text-violet-300' : 'text-slate-200');
      // #29: explain why symlink names aren't clickable. Hovering tells
      // the admin what a click would do (or wouldn't); the per-row
      // Download/Rename/Permissions/Delete actions still work.
      const nameTitle = entry.is_link
        ? `Symlink → ${entry.link_target || '?'} — not followed in the UI to avoid escaping the volume; use Download to fetch the link's target contents`
        : (entry.is_dir ? 'Open folder' : 'View / edit file');

      const isText = !entry.is_dir && !entry.is_link;
      const isChecked = selected.has(entry.name) ? 'checked' : '';
      return `
        <div data-name="${escapeHtml(entry.name)}" data-kind="${entry.is_dir ? 'dir' : (entry.is_link ? 'link' : 'file')}"
             class="vb-row grid ${GRID_COLS} gap-2 items-center border-b border-slate-800/70 px-3 py-1.5 text-xs hover:bg-slate-900/60">
          <div><input type="checkbox" class="vb-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-act="select" ${isChecked}/></div>
          <div class="flex items-center gap-2 min-w-0">
            <span>${_fileIcon(entry)}</span>
            <span class="${nameCls} truncate" data-act="navigate" title="${escapeHtml(nameTitle)}">${nameCell}</span>
          </div>
          <div class="text-right text-slate-400 font-mono">${sizeCol}</div>
          <div class="text-slate-400 truncate" title="${escapeHtml(entry.user)}:${escapeHtml(entry.group)}">${owner}</div>
          <div class="text-slate-500">${date}</div>
          <div class="text-slate-400 font-mono text-[11px]">${escapeHtml(perms)}</div>
          <div class="flex justify-end gap-1">
            ${isText ? `<button data-act="view"   title="View"    class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5">👁</button>` : ''}
            <button data-act="dl"     title="Download"     class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5">⤓</button>
            <button data-act="rename" title="Rename"       class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5">✎</button>
            <button data-act="chmod"  title="Permissions (mode + owner)" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-1.5">🔒</button>
            <button data-act="rm"     title="Delete"       class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-1.5">✕</button>
          </div>
        </div>`;
    }

    function renderPager() {
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const cur1 = Math.floor(offset / pageSize) + 1;
      const start = total === 0 ? 0 : offset + 1;
      const end = Math.min(offset + lastEntries.length, total);
      wrap.querySelector('#vb-page-info').textContent =
        `${start}–${end} of ${total} (page ${cur1}/${pages})`;
      wrap.querySelector('#vb-first').disabled = offset === 0;
      wrap.querySelector('#vb-prev').disabled  = offset === 0;
      wrap.querySelector('#vb-next').disabled  = end >= total;
      wrap.querySelector('#vb-last').disabled  = end >= total;
      // Disabled state styling
      for (const id of ['vb-first', 'vb-prev', 'vb-next', 'vb-last']) {
        const b = wrap.querySelector('#' + id);
        b.classList.toggle('opacity-40', b.disabled);
        b.classList.toggle('cursor-not-allowed', b.disabled);
      }
      wrap.querySelector('#vb-pagesize').value = String(pageSize);
    }

    function renderBulkToolbar() {
      const bar = wrap.querySelector('#vb-bulk');
      if (selected.size === 0) { bar.classList.add('hidden'); bar.classList.remove('flex'); return; }
      bar.classList.remove('hidden'); bar.classList.add('flex');
      wrap.querySelector('#vb-bulk-count').textContent = String(selected.size);
    }

    function syncSelectAllCheckbox() {
      const cb = wrap.querySelector('#vb-select-all');
      const total = lastEntries.length;
      if (total === 0) { cb.checked = false; cb.indeterminate = false; return; }
      const onPage = lastEntries.filter((e) => selected.has(e.name)).length;
      cb.checked = onPage === total;
      cb.indeterminate = onPage > 0 && onPage < total;
    }

    function render() {
      const sorted = sortEntries(lastEntries);
      const host = wrap.querySelector('#vb-list');
      if (!sorted.length) {
        host.innerHTML = '<div class="px-3 py-10 text-center text-xs text-slate-500">Empty directory</div>';
      } else {
        host.innerHTML = sorted.map(rowFor).join('');
      }
      const itemWord = `${sorted.length} item${sorted.length === 1 ? '' : 's'}`;
      wrap.querySelector('#vb-count').textContent =
        total > sorted.length ? `${itemWord} (of ${total})` : itemWord;
      renderPager();
      syncSelectAllCheckbox();
      renderBulkToolbar();
    }

    async function load(path) {
      cur = path || cur || '/';
      renderCrumbs(cur);
      const host = wrap.querySelector('#vb-list');
      host.innerHTML = '<div class="px-3 py-3 text-xs text-slate-400">Loading…</div>';
      setStatus('');
      try {
        const qs = new URLSearchParams({ path: cur, limit: String(pageSize), offset: String(offset) });
        const data = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/list?${qs.toString()}`);
        cur = data.path || cur;
        renderCrumbs(cur);
        lastEntries = data.entries || [];
        total = typeof data.total === 'number' ? data.total : lastEntries.length;
        // Server clamps an out-of-range offset (e.g. user changes pageSize on
        // page 7 of a small dir). If we asked beyond the end, rewind and reload.
        if (offset >= total && total > 0) {
          offset = Math.floor((total - 1) / pageSize) * pageSize;
          return load(cur);
        }
        // Drop selections that aren't on this page anymore (we don't track
        // selections across pages — each page selection is independent).
        for (const n of [...selected]) {
          if (!lastEntries.some((e) => e.name === n)) selected.delete(n);
        }
        render();
      } catch (e) {
        host.innerHTML = '';
        setStatus(e.message, 'err');
      }
    }

    function childPath(name) {
      return (cur === '/' ? '/' : cur + '/') + name;
    }

    async function downloadUrl(p, endpoint = 'file') {
      // Routes through api() (#21) so 401 triggers auto-logout and
      // server-side error details surface uniformly.
      return api(
        `/api/volumes/${encodeURIComponent(volumeName)}/browse/${endpoint}?path=${encodeURIComponent(p)}`,
        { responseType: 'blob' },
      );
    }

    function triggerDownload(blob, filename) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /**
     * Inline file editor backed by CodeMirror 6.
     *
     * Read pass:
     *   GET /browse/view  →  JSON envelope (text + encoding + mtime/size)
     *   We capture the mtime from the directory listing entry (lastEntries)
     *   and send it back on save as `if_mtime` for optimistic concurrency.
     *
     * Save pass:
     *   PUT /browse/file  →  body { content, if_mtime } → 200 / 409 / 400
     *   On 409 the server returns the current mtime; we show a conflict
     *   dialog with [Reload] / [Overwrite anyway] / [Cancel].
     *
     * Binary files and 1 MB-truncated files are read-only.
     */
    async function openEditor(name, p, entry) {
      let payload;
      try {
        payload = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/view?path=${encodeURIComponent(p)}`);
      } catch (e) { toast(e.message, 'error'); return; }

      // Binary preview — unchanged from the old viewer.
      if (payload.is_binary) {
        const v = document.createElement('div');
        v.innerHTML = `
          <div class="rounded border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
            <p>This file looks binary (contains null bytes in the first 8 KB) — inline editing unavailable.</p>
            <p class="mt-2">Size: <span class="font-mono">${fmtBytes(payload.size)}</span></p>
          </div>`;
        const action = await modal({
          title: `View: ${name}`, body: v, size: 'md',
          actions: [
            { label: 'Download', kind: 'secondary', value: 'dl' },
            { label: 'Close', value: null, kind: 'secondary' },
          ],
        });
        if (action === 'dl') {
          try { triggerDownload(await downloadUrl(p), name); }
          catch (e) { toast(e.message, 'error'); }
        }
        return;
      }

      const canEdit = !payload.truncated;
      const original = payload.content || '';
      let mtimeCursor = entry ? entry.mtime : null;
      let dirty = false;
      let isFullScreen = false;
      let editor = null;

      const view = document.createElement('div');
      view.className = 'flex flex-col gap-2';
      view.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span id="ed-meta">${fmtBytes(payload.size)} · ${escapeHtml(payload.encoding || 'utf-8')}${
            payload.truncated ? ' · <span class="text-amber-400">truncated to 1 MB — read-only</span>' : ''
          }</span>
          <div class="flex items-center gap-1">
            <button id="ed-reload" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700" title="Reload from disk (discards unsaved changes)">⟳ Reload</button>
            <button id="ed-diff"   class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700 ${canEdit?'':'hidden'}" title="Preview the diff between original and current buffer">≷ Diff</button>
            <button id="ed-fs"     class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 border border-slate-700" title="Toggle full-screen">⛶ Full-screen</button>
          </div>
        </div>
        <div id="ed-host" class="rounded border border-slate-800 bg-slate-950/70 overflow-hidden" style="height:60vh"></div>`;

      const ref = {};
      const modalRef = ref;

      function updateTitle() {
        if (!ref.titleEl) return;
        // Build the title via DOM so the file name (attacker-controlled
        // text inside a volume) can NEVER reach innerHTML. The dirty
        // bullet is a separate span element.
        ref.titleEl.replaceChildren();
        if (dirty) {
          const bullet = document.createElement('span');
          bullet.className = 'text-amber-400';
          bullet.textContent = '● ';
          ref.titleEl.appendChild(bullet);
        }
        ref.titleEl.appendChild(document.createTextNode(`Edit: ${name}`));
      }

      async function reload() {
        if (dirty && !(await confirmModal('Discard unsaved changes and reload from disk?', { danger: true, confirmLabel: 'Reload' }))) return;
        let fresh;
        try {
          fresh = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/view?path=${encodeURIComponent(p)}`);
        } catch (e) { toast(e.message, 'error'); return; }
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: fresh.content || '' },
        });
        // Capture the new mtime so subsequent saves use it.
        const newEntry = (lastEntries.find((x) => x.name === name)) || entry;
        mtimeCursor = newEntry ? newEntry.mtime : mtimeCursor;
        dirty = false; updateTitle();
        toast('Reloaded from disk', 'success');
      }

      async function showDiff() {
        const current = editor.state.doc.toString();
        if (current === original) { toast('No changes yet', 'info'); return; }
        const cmModule = await import(/* webpackChunkName: "editor" */ './editor.js');
        const host = document.createElement('div');
        host.style.height = '70vh';
        host.className = 'overflow-hidden rounded border border-slate-800';
        const mv = cmModule.mountDiff(host, original, current, { filename: name });
        await modal({
          title: `Diff: ${name}`, body: host, size: 'xl',
          actions: [{ label: 'Close', value: null, kind: 'secondary' }],
        });
        mv.destroy();
      }

      // The actual save call. Returns true if we should close the modal.
      // #21: routes through api() so 401 triggers auto-logout.
      async function save({ overrideConflict = false } = {}) {
        if (!canEdit) return false;
        const content = editor.state.doc.toString();
        const body = { content };
        if (mtimeCursor != null && !overrideConflict) body.if_mtime = mtimeCursor;
        try {
          const out = await api(
            `/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(p)}`,
            { method: 'PUT', body: JSON.stringify(body) },
          );
          mtimeCursor = out.mtime;
          dirty = false; updateTitle();
          toast('Saved', 'success');
          load(cur); // refresh the listing so size/mtime update
          return true;
        } catch (e) {
          // 409 → optimistic-concurrency conflict. The server returns
          // the current mtime so we can offer Reload / Overwrite paths.
          if (e.status === 409) {
            const serverMtime = e.body && e.body.server_mtime;
            const wrapEl = document.createElement('div');
            wrapEl.innerHTML = `
              <p class="text-sm text-slate-300"></p>
              <p class="mt-2 text-xs text-slate-500">Server mtime: <code></code> — your edit was based on <code></code>.</p>
              <p class="mt-2 text-xs text-slate-400">Reload discards your edits and re-reads the file. Overwrite forces your version onto the new one.</p>`;
            wrapEl.querySelector('p:nth-child(1)').textContent = (e.body && e.body.detail) || 'Conflict';
            wrapEl.querySelector('code:nth-of-type(1)').textContent = String(serverMtime);
            wrapEl.querySelector('code:nth-of-type(2)').textContent = String(mtimeCursor);
            const action = await modal({
              title: 'File changed on disk', size: 'md', body: wrapEl,
              actions: [
                { label: 'Reload',   kind: 'secondary', value: 'reload' },
                { label: 'Overwrite anyway', kind: 'danger', value: 'force' },
                { label: 'Cancel',   kind: 'secondary', value: null },
              ],
            });
            if (action === 'reload') { await reload(); return false; }
            if (action === 'force')  { return save({ overrideConflict: true }); }
            return false;
          }
          toast(e.message, 'error');
          return false;
        }
      }

      // ---- Wire up controls ----
      view.querySelector('#ed-reload').onclick = reload;
      view.querySelector('#ed-diff').onclick = showDiff;
      view.querySelector('#ed-fs').onclick = () => {
        isFullScreen = !isFullScreen;
        if (modalRef.resize) modalRef.resize(isFullScreen ? 'full' : 'xl');
        view.querySelector('#ed-host').style.height = isFullScreen ? 'calc(96vh - 12rem)' : '60vh';
      };

      // Lazy-load CodeMirror — webpack splits this into its own chunk
      // so the editor cost is paid only when a user opens a file.
      const cmModule = await import(/* webpackChunkName: "editor" */ './editor.js');
      editor = cmModule.mountEditor(view.querySelector('#ed-host'), original, {
        filename: name,
        readOnly: !canEdit,
        onChange: (text) => {
          const wasDirty = dirty;
          dirty = text !== original;
          if (wasDirty !== dirty) updateTitle();
        },
        onSave: () => { if (canEdit) save(); },
      });

      // Save and Download stay in the modal (return false from onClick) —
      // matches every desktop editor: Ctrl+S / clicking Save updates the
      // file on disk but leaves the editor open. Closing is its own action.
      const actions = canEdit
        ? [
            { label: 'Save', kind: 'primary', value: 'save',
              onClick: async () => { await save(); return false; } },
            { label: 'Download', kind: 'secondary', value: 'dl',
              onClick: async () => { try { triggerDownload(await downloadUrl(p), name); } catch (e) { toast(e.message, 'error'); } return false; } },
            { label: 'Close', value: null, kind: 'secondary', confirmBeforeClose: true },
          ]
        : [
            { label: 'Download', kind: 'secondary', value: 'dl',
              onClick: async () => { try { triggerDownload(await downloadUrl(p), name); } catch (e) { toast(e.message, 'error'); } return false; } },
            { label: 'Close', value: null, kind: 'secondary' },
          ];

      const opening = modal({
        title: `Edit: ${name}`, body: view, size: 'xl',
        actions, ref,
        onBeforeClose: async () => {
          if (!dirty) return true;
          return await confirmModal(
            'Discard unsaved changes? Your edits to <code>' + escapeHtml(name) + '</code> will be lost.',
            { danger: true, confirmLabel: 'Discard' },
          );
        },
      });
      updateTitle();
      await opening;
      try { editor.destroy(); } catch {}
    }


    // #24: replace window.prompt with a real modal — gives us validation,
    // proper keyboard handling, consistent styling, and works in browsers
    // that block prompts.
    async function renameAt(oldName) {
      const next = await inputModal({
        title: `Rename`,
        label: `Rename "${oldName}" to:`,
        initial: oldName,
        okLabel: 'Rename',
        validate: (v) => {
          const t = (v || '').trim();
          if (!t) return 'Name is required';
          if (t.includes('/')) return 'Name cannot contain "/"';
          if (t === '.' || t === '..') return 'Reserved name';
          if (t === oldName) return 'New name must be different';
          return null;
        },
      });
      if (next == null || next.trim() === oldName) return;
      const from = childPath(oldName);
      const to = childPath(next.trim());
      try {
        await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/rename`, {
          method: 'POST',
          body: JSON.stringify({ from, to }),
        });
        toast('Renamed', 'success'); load(cur);
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---------- Permissions modal (chmod + chown) ----------
    // Combined editor: octal mode kept in sync with rwx triplets, plus an
    // optional owner section that sets numeric UID / GID. Either piece can
    // be edited independently; on Apply we issue /chmod and/or /chown
    // depending on which side actually changed.
    async function openPermissionsEditor(names, { hasDir = false, entries = [] } = {}) {
      // Pre-populate from the first entry's existing mode/uid/gid when we
      // know them (single-row case, or bulk-select where all entries
      // happen to match). Falls back to 0644 / 0:0 if we don't.
      const seed = entries.find(Boolean);
      const seedModeOctal = seed && seed.mode != null
        ? '0' + ((seed.mode & 0o777).toString(8)).padStart(3, '0')
        : '0644';
      const seedUid = seed && seed.uid != null ? seed.uid : 0;
      const seedGid = seed && seed.gid != null ? seed.gid : 0;
      const seedUser = seed ? seed.user : '';
      const seedGroup = seed ? seed.group : '';

      const view = document.createElement('div');
      const targetsLabel = names.length === 1
        ? `<code class="text-slate-200">${escapeHtml(names[0])}</code>`
        : `${names.length} items`;
      view.innerHTML = `
        <div class="space-y-4 text-xs text-slate-300">
          <div>Target: ${targetsLabel}</div>

          <!-- Mode -->
          <fieldset class="rounded border border-slate-800 p-3 space-y-2">
            <legend class="px-1 text-[10px] uppercase tracking-wider text-slate-500">Mode (chmod)</legend>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1">
                <input id="perm-mode-enabled" type="checkbox" class="h-3.5 w-3.5" checked/>
                Change mode
              </label>
              <input id="perm-mode" type="text" value="${seedModeOctal}" maxlength="4"
                     class="ml-2 w-24 rounded border-slate-700 bg-slate-950 px-2 py-1 font-mono text-sm uppercase tracking-wider"/>
              <span class="text-slate-500" id="perm-symbol">-rw-r--r--</span>
            </div>
            <table class="text-[11px]">
              <thead><tr class="text-slate-500"><th></th><th class="px-2">read</th><th class="px-2">write</th><th class="px-2">exec</th></tr></thead>
              <tbody>
                ${['Owner','Group','Other'].map((label, i) => `
                  <tr><td class="pr-2 text-slate-400">${label}</td>
                    ${['r','w','x'].map((perm) => `
                      <td class="px-2 text-center"><input type="checkbox" class="perm-bit h-3.5 w-3.5" data-who="${i}" data-perm="${perm}"/></td>
                    `).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </fieldset>

          <!-- Owner -->
          <fieldset class="rounded border border-slate-800 p-3 space-y-2">
            <legend class="px-1 text-[10px] uppercase tracking-wider text-slate-500">Owner (chown)</legend>
            <label class="flex items-center gap-1">
              <input id="perm-own-enabled" type="checkbox" class="h-3.5 w-3.5"/>
              Change ownership
            </label>
            <div class="grid grid-cols-2 gap-3 mt-1">
              <label class="block">
                <span class="text-slate-400">UID${seedUser ? ` <span class="text-slate-500">(was: ${escapeHtml(String(seedUid))} / ${escapeHtml(seedUser)})</span>` : ''}</span>
                <input id="perm-uid" type="number" min="-1" value="${seedUid}" disabled
                       class="mt-1 w-full rounded border-slate-700 bg-slate-950 px-2 py-1 font-mono"/>
              </label>
              <label class="block">
                <span class="text-slate-400">GID${seedGroup ? ` <span class="text-slate-500">(was: ${escapeHtml(String(seedGid))} / ${escapeHtml(seedGroup)})</span>` : ''}</span>
                <input id="perm-gid" type="number" min="-1" value="${seedGid}" disabled
                       class="mt-1 w-full rounded border-slate-700 bg-slate-950 px-2 py-1 font-mono"/>
              </label>
            </div>
            <p class="text-[11px] text-slate-500">Use <code>-1</code> in a field to leave that side unchanged. Numeric IDs only — name lookup inside the helper container doesn't match the volume's user database.</p>
          </fieldset>

          ${hasDir ? `
            <label class="flex items-center gap-2 text-slate-300">
              <input id="perm-recursive" type="checkbox" class="h-3.5 w-3.5"/>
              Apply recursively (<code>-R</code>) — required to descend into folders.
            </label>` : ''}
        </div>`;

      const PERM_BIT = { r: 4, w: 2, x: 1 };
      const modeInput = view.querySelector('#perm-mode');
      const symbol = view.querySelector('#perm-symbol');
      const bits = view.querySelectorAll('.perm-bit');
      const modeEnabled = view.querySelector('#perm-mode-enabled');
      const ownEnabled = view.querySelector('#perm-own-enabled');
      const uidInput = view.querySelector('#perm-uid');
      const gidInput = view.querySelector('#perm-gid');

      function modeToTriplets(octal) {
        const digits = octal.padStart(4, '0').slice(-3);
        return [...digits].map((d) => parseInt(d, 10) & 7);
      }
      function tripletsToSymbol(trips) {
        const t = (d) => ((d & 4) ? 'r' : '-') + ((d & 2) ? 'w' : '-') + ((d & 1) ? 'x' : '-');
        return '-' + trips.map(t).join('');
      }
      function syncFromMode() {
        const raw = modeInput.value.trim();
        if (!/^0?[0-7]{3,4}$/.test(raw)) { symbol.textContent = 'invalid'; symbol.className = 'text-rose-300'; return; }
        symbol.className = 'text-slate-500';
        const trips = modeToTriplets(raw);
        for (const cb of bits) {
          const w = +cb.dataset.who, p = cb.dataset.perm;
          cb.checked = !!(trips[w] & PERM_BIT[p]);
        }
        symbol.textContent = tripletsToSymbol(trips);
      }
      function syncFromBits() {
        const trips = [0, 0, 0];
        for (const cb of bits) {
          const w = +cb.dataset.who, p = cb.dataset.perm;
          if (cb.checked) trips[w] |= PERM_BIT[p];
        }
        modeInput.value = '0' + trips.join('');
        symbol.textContent = tripletsToSymbol(trips);
      }
      modeInput.addEventListener('input', syncFromMode);
      for (const cb of bits) cb.addEventListener('change', syncFromBits);
      syncFromMode();

      // Enable/disable the input groups based on the checkboxes.
      function refreshEnabled() {
        modeInput.disabled = !modeEnabled.checked;
        for (const b of bits) b.disabled = !modeEnabled.checked;
        uidInput.disabled = !ownEnabled.checked;
        gidInput.disabled = !ownEnabled.checked;
      }
      modeEnabled.addEventListener('change', refreshEnabled);
      ownEnabled.addEventListener('change', refreshEnabled);
      refreshEnabled();

      const action = await modal({
        title: names.length === 1 ? `Permissions: ${names[0]}` : `Permissions (${names.length} items)`,
        body: view, size: 'md',
        actions: [
          { label: 'Apply', kind: 'primary', value: 'ok' },
          { label: 'Cancel', kind: 'secondary', value: null },
        ],
      });
      if (action !== 'ok') return false;

      const doMode = modeEnabled.checked;
      const doOwn = ownEnabled.checked;
      if (!doMode && !doOwn) { toast('Nothing to apply', 'info'); return false; }

      const mode = modeInput.value.trim();
      if (doMode && !/^0?[0-7]{3,4}$/.test(mode)) { toast('Invalid mode', 'warn'); return false; }
      const uid = parseInt(uidInput.value, 10);
      const gid = parseInt(gidInput.value, 10);
      if (doOwn && (Number.isNaN(uid) || Number.isNaN(gid))) {
        toast('UID/GID must be numeric (use -1 to leave unchanged)', 'warn');
        return false;
      }
      if (doOwn && uid === -1 && gid === -1) {
        toast('chown: at least one of UID / GID must be set (use -1 only for the side you want unchanged)', 'warn');
        return false;
      }

      const recursive = !!(view.querySelector('#perm-recursive') && view.querySelector('#perm-recursive').checked);
      const paths = names.map(childPath);
      const single = names.length === 1;

      // #20: single atomic endpoint. The server applies mode and/or
      // owner in one container — no more "chmod succeeded but chown
      // failed and now the file is in a half-applied state".
      const body = { recursive };
      if (doMode) body.mode = mode;
      if (doOwn)  { body.uid = uid; body.gid = gid; }

      let okAll = true;
      try {
        if (single) {
          await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/permissions`, {
            method: 'POST', body: JSON.stringify({ path: paths[0], ...body }),
          });
        } else {
          const out = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/permissions/bulk`, {
            method: 'POST', body: JSON.stringify({ paths, ...body }),
          });
          okAll = (out.failed === 0);
          for (const r of out.results || []) {
            if (!r.ok) toast(`${r.path}: ${r.error || 'failed'}`, 'error');
          }
        }
      } catch (e) {
        toast(`Permissions failed: ${e.message}`, 'error');
        return false;
      }

      const what = [doMode && 'mode', doOwn && 'owner'].filter(Boolean).join(' + ');
      toast(
        `${what} applied to ${names.length} item${names.length === 1 ? '' : 's'}${okAll ? '' : ' (partial)'}`,
        okAll ? 'success' : 'warn',
      );
      await load(cur);
      return okAll;
    }

    // ---------- Upload ----------
    async function uploadFiles(files) {
      if (!files || !files.length) return;
      let ok = 0, fail = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setStatus(`Uploading ${file.name} (${i + 1}/${files.length})…`);
        const fd = new FormData(); fd.append('file', file);
        try {
          // #21: route through api() so 401 triggers auto-logout and
          // server-side validation errors surface consistently.
          await api(
            `/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(cur)}`,
            { method: 'POST', body: fd },
          );
          ok += 1;
        } catch (ex) { fail += 1; toast(`${file.name}: ${ex.message}`, 'error'); }
      }
      setStatus('');
      if (ok) toast(`Uploaded ${ok} file${ok === 1 ? '' : 's'}${fail ? ` (${fail} failed)` : ''}`, fail ? 'warn' : 'success');
      await load(cur);
    }

    // ---------- Row interactions ----------
    wrap.querySelector('#vb-list').addEventListener('click', async (e) => {
      const row = e.target.closest('.vb-row');
      if (!row) return;
      const name = row.dataset.name;
      const kind = row.dataset.kind;
      const child = childPath(name);
      const actEl = e.target.closest('[data-act]');
      const act = actEl?.dataset.act;
      try {
        if (act === 'select') {
          // Checkbox handles its own state via the change event; intercept the
          // click so it doesn't bubble up and trigger navigate.
          e.stopPropagation();
          return;
        }
        if (act === 'rm') {
          const ok = await confirmModal(`Delete <code>${escapeHtml(name)}</code>? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' });
          if (!ok) return;
          await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(child)}`, { method: 'DELETE' });
          toast('Deleted', 'success'); return load(cur);
        }
        if (act === 'dl') {
          const endpoint = kind === 'dir' ? 'archive' : 'file';
          const blob = await downloadUrl(child, endpoint);
          triggerDownload(blob, kind === 'dir' ? `${name}.tar` : name);
          return;
        }
        const entry = lastEntries.find((x) => x.name === name);
        if (act === 'view') return openEditor(name, child, entry);
        if (act === 'rename') return renameAt(name);
        if (act === 'chmod') return openPermissionsEditor([name], { hasDir: kind === 'dir', entries: [entry].filter(Boolean) });
        if (act === 'navigate' || !act) {
          if (kind === 'dir') { offset = 0; selected.clear(); return load(child); }
          if (kind === 'file') return openEditor(name, child, entry);
          // Symlinks: stay put; user has to click an action explicitly.
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    // Selection: per-row checkbox change updates the set + bulk toolbar.
    wrap.querySelector('#vb-list').addEventListener('change', (e) => {
      const cb = e.target.closest('input.vb-check');
      if (!cb) return;
      const row = cb.closest('.vb-row');
      if (!row) return;
      const name = row.dataset.name;
      if (cb.checked) selected.add(name); else selected.delete(name);
      syncSelectAllCheckbox();
      renderBulkToolbar();
    });

    wrap.querySelector('#vb-select-all').addEventListener('change', (e) => {
      if (e.target.checked) {
        for (const ent of lastEntries) selected.add(ent.name);
      } else {
        for (const ent of lastEntries) selected.delete(ent.name);
      }
      // Re-render rows so their checkbox states match (cheaper than per-row).
      render();
    });

    // ---------- Bulk actions ----------
    wrap.querySelector('#vb-bulk-clear').onclick = () => { selected.clear(); render(); };

    wrap.querySelector('#vb-bulk-rm').onclick = async () => {
      const names = [...selected];
      if (!names.length) return;
      const ok = await confirmModal(
        `Delete <strong>${names.length}</strong> selected item${names.length === 1 ? '' : 's'}? This cannot be undone.`,
        { danger: true, confirmLabel: 'Delete all' },
      );
      if (!ok) return;
      // One bulk request = one container round-trip on the server, instead
      // of N. Per-entry failures come back in `results` and are surfaced
      // as individual toasts so the user knows which ones didn't go.
      try {
        const out = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/delete/bulk`, {
          method: 'POST',
          body: JSON.stringify({ paths: names.map(childPath) }),
        });
        for (const r of out.results || []) {
          if (!r.ok) toast(`${r.path}: ${r.error || 'delete failed'}`, 'error');
        }
        if (out.succeeded) {
          toast(`Deleted ${out.succeeded}${out.failed ? ` of ${names.length}` : ''}`, out.failed ? 'warn' : 'success');
        }
      } catch (e) {
        toast(`Bulk delete failed: ${e.message}`, 'error');
      }
      selected.clear();
      load(cur);
    };

    wrap.querySelector('#vb-bulk-chmod').onclick = async () => {
      const names = [...selected];
      if (!names.length) return;
      const hasDir = lastEntries.some((e) => names.includes(e.name) && e.is_dir);
      const entries = names.map((n) => lastEntries.find((x) => x.name === n)).filter(Boolean);
      await openPermissionsEditor(names, { hasDir, entries });
    };

    // ---------- Toolbar / sort / refresh ----------
    wrap.querySelector('#vb-sort').addEventListener('change', (e) => {
      sortMode = e.target.value; render();
    });

    wrap.querySelector('#vb-refresh').onclick = () => load(cur);

    wrap.querySelector('#vb-mkdir').onclick = async () => {
      // #24: modal prompt with inline validation.
      const name = await inputModal({
        title: 'New folder',
        label: `New folder name (under ${cur})`,
        placeholder: 'subdir',
        okLabel: 'Create',
        validate: (v) => {
          const t = (v || '').trim();
          if (!t) return 'Name is required';
          if (t.includes('/')) return 'Name cannot contain "/"';
          if (t === '.' || t === '..') return 'Reserved name';
          return null;
        },
      });
      if (name == null) return;
      try {
        await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/mkdir?path=${encodeURIComponent(childPath(name.trim()))}`, { method: 'POST' });
        toast('Folder created', 'success'); load(cur);
      } catch (ex) { toast(ex.message, 'error'); }
    };

    wrap.querySelector('#vb-upload').addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      if (files.length) await uploadFiles(files);
      e.target.value = '';
    });

    wrap.querySelector('#vb-dl-folder').onclick = async () => {
      try {
        const blob = await downloadUrl(cur === '/' ? '/' : cur, 'archive');
        const fname = (cur === '/' ? volumeName : (cur.split('/').pop() || volumeName));
        triggerDownload(blob, `${fname}.tar`);
      } catch (e) { toast(e.message, 'error'); }
    };

    // ---------- Pagination ----------
    wrap.querySelector('#vb-pagesize').addEventListener('change', (e) => {
      pageSize = parseInt(e.target.value, 10) || 100;
      offset = 0;
      selected.clear();
      load(cur);
    });
    wrap.querySelector('#vb-first').onclick = () => {
      if (offset === 0) return;
      offset = 0; selected.clear(); load(cur);
    };
    wrap.querySelector('#vb-prev').onclick = () => {
      const next = Math.max(0, offset - pageSize);
      if (next === offset) return;
      offset = next; selected.clear(); load(cur);
    };
    wrap.querySelector('#vb-next').onclick = () => {
      const next = offset + pageSize;
      if (next >= total) return;
      offset = next; selected.clear(); load(cur);
    };
    wrap.querySelector('#vb-last').onclick = () => {
      const lastPage = Math.max(0, Math.floor((total - 1) / pageSize)) * pageSize;
      if (lastPage === offset) return;
      offset = lastPage; selected.clear(); load(cur);
    };

    // ---------- Drag-and-drop upload ----------
    // Highlights the table overlay during drag, and triggers a multi-file
    // upload on drop. Uses a depth counter so child-element dragenter/leave
    // pairs don't flicker the overlay.
    {
      const table = wrap.querySelector('#vb-table');
      const drop  = wrap.querySelector('#vb-drop');
      const dropPath = wrap.querySelector('#vb-drop-path');
      let depth = 0;
      const showOverlay = () => {
        dropPath.textContent = cur;
        drop.classList.remove('hidden');
        drop.classList.add('flex');
      };
      const hideOverlay = () => {
        drop.classList.add('hidden');
        drop.classList.remove('flex');
      };
      table.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        depth += 1; if (depth === 1) showOverlay();
      });
      table.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      table.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) hideOverlay();
      });
      table.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        const files = [...(e.dataTransfer.files || [])];
        if (!files.length) return;
        e.preventDefault();
        depth = 0; hideOverlay();
        await uploadFiles(files);
      });
    }

    // ---------- Boot ----------
    // #27: show the "how it works" banner only the first time. Once
    // the admin has seen it, they don't need the wall-of-text on every
    // browse. They can re-show it via localStorage if they ever want.
    const BANNER_KEY = 'docker-manager.vb-helper-banner-seen';
    let bannerSeen = false;
    try { bannerSeen = localStorage.getItem(BANNER_KEY) === '1'; } catch {}
    if (!bannerSeen) {
      setStatus(`Each operation runs in a short-lived "${state.config.browser_image}" container with this volume mounted read-only / read-write at /target.`, 'info');
      try { localStorage.setItem(BANNER_KEY, '1'); } catch {}
    }
    load('/');

    await modal({ title: `Browse: ${volumeName}`, body: wrap, size: 'xl' });
  }

  // ---------- Registries ----------
  views.registries = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Registries',
      'Stored credentials used by the image-pull dialog',
      `${isAdmin ? btn('+ Add registry', { kind: 'primary', id: 'add-reg' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );

    const bulkSel = createBulkSelection({ key: (r) => r.name });
    const bulkBarObj = isAdmin
      ? bulkBar(bulkSel, {
          actions: [
            { label: '✕ Remove', kind: 'danger', onClick: (names) => bulkRemoveRegistries(names) },
          ],
        })
      : { el: document.createElement('div'), render: () => {} };
    root.appendChild(bulkBarObj.el);

    const list = document.createElement('div'); root.appendChild(list);
    let registries = [];

    async function bulkRemoveRegistries(names) {
      const ok = await confirmModal(
        `Remove <strong>${names.length}</strong> registry credential set${names.length === 1 ? '' : 's'}? Image pulls that referenced them will fall back to the daemon's cached login (or fail if there isn't one).`,
        { danger: true, confirmLabel: 'Remove' },
      );
      if (!ok) return false;
      try {
        const out = await api('/api/registries/delete/bulk', {
          method: 'POST', body: JSON.stringify({ names }),
        });
        handleBulkResponse(out, 'Removed', (r) => r.name);
      } catch (e) { toast(`Bulk remove failed: ${e.message}`, 'error'); return false; }
      await load();
      return true;
    }

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        registries = await api('/api/registries');
        bulkSel.pruneAgainst(registries);
        draw();
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    function draw() {
      const rows = registries.map((r) => {
        const checked = bulkSel.has(r.name) ? 'checked' : '';
        return `
          <tr class="hover:bg-slate-900/60">
            <td class="px-3 py-2 w-8">
              ${isAdmin ? `<input type="checkbox" class="registries-check h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" data-name="${escapeHtml(r.name)}" ${checked}/>` : ''}
            </td>
            <td class="px-4 py-2 font-medium">${escapeHtml(r.name)}</td>
            <td class="px-4 py-2 text-slate-300 font-mono text-xs">${escapeHtml(r.url)}</td>
            <td class="px-4 py-2 text-slate-300">${escapeHtml(r.username)}</td>
            <td class="px-4 py-2 text-slate-400">${escapeHtml(r.email || '')}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                ${isAdmin ? `<button data-act="test" data-name="${escapeHtml(r.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Test login</button>` : ''}
                ${isAdmin ? `<button data-act="edit" data-name="${escapeHtml(r.name)}" data-url="${escapeHtml(r.url)}" data-user="${escapeHtml(r.username)}" data-email="${escapeHtml(r.email || '')}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Edit</button>` : ''}
                ${isAdmin ? `<button data-act="rm" data-name="${escapeHtml(r.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>` : ''}
              </div>
            </td>
          </tr>`;
      });
      list.innerHTML = `
        <p class="mb-3 text-xs text-slate-500">${registries.length} registry${registries.length === 1 ? '' : ' entries'}${bulkSel.size ? ` · ${bulkSel.size} selected` : ''}. Passwords are stored on the manager host in <code>${escapeHtml(state.config.registries_file || '/data/registries.json')}</code> with mode 0600. Always front this UI with TLS.</p>
      ` + table(
        [
          isAdmin
            ? `<input id="registries-select-all" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" title="Select all"/>`
            : '',
          'Name', 'URL', 'Username', 'Email', '',
        ],
        rows,
      );
      const sa = list.querySelector('#registries-select-all');
      if (sa) {
        const onPage = registries.filter((r) => bulkSel.has(r.name)).length;
        sa.checked = registries.length > 0 && onPage === registries.length;
        sa.indeterminate = onPage > 0 && onPage < registries.length;
        sa.addEventListener('change', (e) => {
          if (e.target.checked) for (const r of registries) bulkSel.add(r.name);
          else for (const r of registries) bulkSel.delete(r.name);
          draw(); bulkBarObj.render();
        });
      }
    }

    list.addEventListener('change', (e) => {
      const cb = e.target.closest('input.registries-check');
      if (!cb) return;
      if (cb.checked) bulkSel.add(cb.dataset.name);
      else bulkSel.delete(cb.dataset.name);
      bulkBarObj.render();
      draw();
    });

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const name = t.dataset.name; const act = t.dataset.act;
      try {
        if (act === 'rm') {
          const ok = await confirmModal(`Remove credentials for "${name}"?`, { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
          await api(`/api/registries/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast('Removed', 'success'); load();
        } else if (act === 'test') {
          const r = await api(`/api/registries/${encodeURIComponent(name)}/test`, { method: 'POST' });
          await modal({ title: 'Login result', body: jsonView(r), size: 'md' });
        } else if (act === 'edit') {
          await registryDialog({ name, url: t.dataset.url, username: t.dataset.user, email: t.dataset.email });
          load();
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    const addBtn = document.getElementById('add-reg');
    if (addBtn) addBtn.onclick = () => registryDialog().then((ok) => { if (ok) load(); });

    await load();
  };

  async function registryDialog(initial = null) {
    const editing = !!initial;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3 md:grid-cols-2">
        <label class="block"><span class="text-xs text-slate-400">Name *</span>
          <input id="r-name" required value="${escapeHtml(initial?.name || '')}" ${editing ? 'readonly' : ''} placeholder="ghcr-personal" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm ${editing ? 'opacity-70' : ''}"/></label>
        <label class="block"><span class="text-xs text-slate-400">URL</span>
          <input id="r-url" value="${escapeHtml(initial?.url || 'https://index.docker.io/v1/')}" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block"><span class="text-xs text-slate-400">Username *</span>
          <input id="r-user" required value="${escapeHtml(initial?.username || '')}" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Password / token *</span>
          <input id="r-pass" required type="password" placeholder="${editing ? 'Leave blank to keep, set to change' : ''}" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Email (optional)</span>
          <input id="r-email" value="${escapeHtml(initial?.email || '')}" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
      </div>`;
    let success = false;
    await modal({
      title: editing ? `Edit registry: ${initial.name}` : 'Add registry',
      body: wrap, size: 'lg',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: editing ? 'Save' : 'Add', kind: 'primary', value: true, onClick: async () => {
          const payload = {
            name: wrap.querySelector('#r-name').value.trim(),
            url: wrap.querySelector('#r-url').value.trim() || 'https://index.docker.io/v1/',
            username: wrap.querySelector('#r-user').value.trim(),
            password: wrap.querySelector('#r-pass').value,
            email: wrap.querySelector('#r-email').value.trim() || null,
          };
          if (!payload.name || !payload.username) { toast('Name and username are required', 'warn'); return false; }
          if (!payload.password && !editing) { toast('Password is required for new entries', 'warn'); return false; }
          try {
            if (editing) {
              await api(`/api/registries/${encodeURIComponent(payload.name)}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
              await api(`/api/registries`, { method: 'POST', body: JSON.stringify(payload) });
            }
            success = true;
            toast(editing ? 'Saved' : 'Added', 'success');
          } catch (e) { toast(e.message, 'error'); return false; }
        }},
      ],
    });
    return success;
  }

  // ---------- Sessions ----------
  //
  // Every viewer / admin gets a "your sessions" pane: list of devices
  // currently signed in as you, with a per-row [Revoke] and a
  // "Sign out everywhere" button.
  //
  // Admins additionally get an "All active sessions" table — every
  // logged-in user across the system, with per-row [Revoke] and the
  // big-red-button "Sign out everyone" for incident response.
  //
  // The current session is highlighted; revoking it logs the caller
  // out (server-side already gone, SPA just clears local state).
  views.sessions = async (root) => {
    const isAdmin = state.auth && state.auth.role === 'admin';

    root.innerHTML = pageHeader(
      'Sessions',
      'Server-side session store — sign out a single device or everywhere',
      `${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`,
    );

    // Our own sessions
    const mineWrap = document.createElement('section');
    mineWrap.className = 'mb-8';
    mineWrap.innerHTML = `
      <div class="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 class="text-sm font-semibold text-slate-100">Your sessions</h3>
          <p class="text-xs text-slate-500">Devices currently signed in as <code>${escapeHtml(state.auth.user)}</code>.</p>
        </div>
        <div class="flex gap-2">
          <button id="mine-logout-others" class="rounded bg-amber-500/80 hover:bg-amber-500 text-slate-950 px-3 py-1.5 text-xs font-medium">Sign out other devices</button>
          <button id="mine-logout-all" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-3 py-1.5 text-xs font-medium">Sign out everywhere</button>
        </div>
      </div>
      <div id="mine-list"></div>`;
    root.appendChild(mineWrap);

    // Admin: everyone else's sessions
    let adminWrap = null;
    if (isAdmin) {
      adminWrap = document.createElement('section');
      adminWrap.innerHTML = `
        <div class="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-semibold text-slate-100">All active sessions</h3>
            <p class="text-xs text-slate-500">Every logged-in user across the system. Revoke individually or wipe them all for incident response.</p>
          </div>
          <button id="admin-revoke-all" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-3 py-1.5 text-xs font-medium">Sign out everyone</button>
        </div>
        <div id="all-list"></div>`;
      root.appendChild(adminWrap);
    }

    function fmtRow(s) {
      const curBadge = s.current
        ? `<span class="ml-2 inline-flex items-center rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">this session</span>`
        : '';
      const issued = fmtDate(s.issued_at);
      const seen = fmtDate(s.last_seen);
      const expires = fmtDate(s.expires_at);
      const ua = s.user_agent
        ? `<span class="font-mono text-[11px] text-slate-400 break-all">${escapeHtml(s.user_agent)}</span>`
        : '<span class="text-slate-600">—</span>';
      const ip = s.source_ip
        ? `<code class="text-slate-300 font-mono text-xs">${escapeHtml(s.source_ip)}</code>`
        : '<span class="text-slate-600">—</span>';
      const roleBadge = s.role === 'admin'
        ? `<span class="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">admin</span>`
        : `<span class="rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-300">viewer</span>`;
      return `
        <tr class="hover:bg-slate-900/60 ${s.current ? 'bg-emerald-500/5' : ''}">
          <td class="px-4 py-2">
            <div class="font-medium">${escapeHtml(s.user)} ${roleBadge}${curBadge}</div>
            <div class="text-[11px] text-slate-500 font-mono">${escapeHtml(s.id)}</div>
          </td>
          <td class="px-4 py-2 text-slate-300">${ip}</td>
          <td class="px-4 py-2">${ua}</td>
          <td class="px-4 py-2 text-slate-400 text-xs">
            <div>signed in: ${escapeHtml(issued)}</div>
            <div>last seen: ${escapeHtml(seen)}</div>
            <div>expires: ${escapeHtml(expires)}</div>
          </td>
          <td class="px-4 py-2 text-right">
            <button data-act="revoke" data-id="${escapeHtml(s.id)}" data-current="${s.current ? '1' : '0'}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">${s.current ? 'Sign out' : 'Revoke'}</button>
          </td>
        </tr>`;
    }

    async function loadMine() {
      const host = mineWrap.querySelector('#mine-list');
      host.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const rows = await api('/api/auth/sessions');
        host.innerHTML = rows.length
          ? table(['User', 'IP', 'User agent', 'Timeline', ''], rows.map(fmtRow))
          : `<div class="rounded border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">No active sessions.</div>`;
      } catch (e) {
        host.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    async function loadAll() {
      if (!adminWrap) return;
      const host = adminWrap.querySelector('#all-list');
      host.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const rows = await api('/api/auth/sessions/all');
        host.innerHTML = rows.length
          ? table(['User', 'IP', 'User agent', 'Timeline', ''], rows.map(fmtRow))
          : `<div class="rounded border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">No active sessions.</div>`;
      } catch (e) {
        host.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    async function reload() {
      await Promise.all([loadMine(), loadAll()]);
    }

    // Wire row-level [Revoke] across both tables. We rebind after each
    // reload because the rows are re-rendered.
    function wireRowActions() {
      const handler = async (e) => {
        const t = e.target.closest('[data-act="revoke"]');
        if (!t) return;
        const id = t.dataset.id;
        const isCurrent = t.dataset.current === '1';
        const ok = await confirmModal(
          isCurrent
            ? 'Sign out this session? You\'ll be returned to the login page.'
            : 'Revoke this session?',
          { danger: true, confirmLabel: isCurrent ? 'Sign out' : 'Revoke' },
        );
        if (!ok) return;
        try {
          await api(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
          if (isCurrent) {
            // Server-side already revoked our token; clear local
            // state without an extra round-trip.
            state.auth = null; saveAuth(null); toast('Signed out', 'success');
            render();
          } else {
            toast('Session revoked', 'success');
            await reload();
          }
        } catch (ex) { toast(ex.message, 'error'); }
      };
      mineWrap.addEventListener('click', handler);
      if (adminWrap) adminWrap.addEventListener('click', handler);
    }
    wireRowActions();

    mineWrap.querySelector('#mine-logout-others').onclick = async () => {
      const ok = await confirmModal(
        'Sign out every other device but keep <strong>this</strong> session signed in?',
        { danger: false, confirmLabel: 'Sign out others' },
      );
      if (!ok) return;
      try {
        const out = await api('/api/auth/logout-all?keep_current=true', { method: 'POST' });
        toast(`Signed out ${out.revoked} other session${out.revoked === 1 ? '' : 's'}`, 'success');
        await reload();
      } catch (e) { toast(e.message, 'error'); }
    };

    mineWrap.querySelector('#mine-logout-all').onclick = async () => {
      const ok = await confirmModal(
        'Sign out of <strong>every</strong> device, including this one? You\'ll be returned to the login page.',
        { danger: true, confirmLabel: 'Sign out everywhere' },
      );
      if (!ok) return;
      try {
        await api('/api/auth/logout-all', { method: 'POST' });
        state.auth = null; saveAuth(null); toast('Signed out everywhere', 'success'); render();
      } catch (e) { toast(e.message, 'error'); }
    };

    if (adminWrap) {
      adminWrap.querySelector('#admin-revoke-all').onclick = async () => {
        // Two-stage confirm because this is the kind of button an
        // admin only clicks in an incident.
        const choice = await modal({
          title: 'Sign out every user',
          size: 'sm',
          body: `<p class="text-sm text-slate-300">This revokes <strong>every active session</strong> across the system. Every operator currently signed in (including over the API with a long-lived token) will be forced through re-login.</p>
            <p class="mt-2 text-xs text-slate-500">Use case: a credential leak, JWT secret rotation, or post-incident lockout.</p>
            <label class="mt-3 flex items-center gap-2 text-xs text-slate-300">
              <input id="incl-self" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-rose-500"/>
              Also include my own current session (I\'ll be logged out too)
            </label>`,
          actions: [
            { label: 'Cancel', value: null, kind: 'secondary' },
            { label: 'Sign out everyone', value: 'go', kind: 'danger' },
          ],
        });
        if (choice !== 'go') return;
        const includeSelf = !!document.querySelector('#incl-self')?.checked;
        try {
          const out = await api(`/api/auth/sessions/revoke-all?include_self=${includeSelf}`, { method: 'POST' });
          if (includeSelf) {
            state.auth = null; saveAuth(null); toast(`Revoked ${out.revoked} sessions (including yours)`, 'warn'); render();
          } else {
            toast(`Revoked ${out.revoked} sessions (yours kept)`, 'warn');
            await reload();
          }
        } catch (e) { toast(e.message, 'error'); }
      };
    }

    document.getElementById('refresh').onclick = reload;
    await reload();
  };

  // ---------- Activity (live events + per-container live stats) ----------
  views.activity = async (root) => {
    root.innerHTML = pageHeader('Activity', 'Live docker events and per-container stats');
    const wrap = document.createElement('div');
    wrap.className = 'grid gap-4 lg:grid-cols-2';
    wrap.innerHTML = `
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-semibold">Live events</h3>
          <button id="ev-toggle" class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-2 py-1 text-xs">▶ Stream</button>
        </div>
        <div id="ev-feed" class="log-pane h-[60vh] overflow-auto scroll-thin rounded border border-slate-800 bg-slate-950/60 p-3 text-slate-300"></div>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="text-sm font-semibold">Live stats</h3>
          <select id="stat-pick" class="ml-auto rounded border-slate-700 bg-slate-950 text-xs">
            <option value="">Select container…</option>
          </select>
          <button id="stat-toggle" class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-2 py-1 text-xs" disabled>▶ Stream</button>
        </div>
        <div class="grid grid-cols-2 gap-3" id="stat-cards"></div>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div class="mb-1 text-[11px] text-slate-400">CPU %</div>
            <canvas id="cpu-spark" width="320" height="80" class="w-full rounded border border-slate-800 bg-slate-950"></canvas>
          </div>
          <div>
            <div class="mb-1 text-[11px] text-slate-400">Memory %</div>
            <canvas id="mem-spark" width="320" height="80" class="w-full rounded border border-slate-800 bg-slate-950"></canvas>
          </div>
        </div>
      </div>`;
    root.appendChild(wrap);

    let containers = [];
    try { containers = await api('/api/containers?all=true'); } catch {}
    const sel = wrap.querySelector('#stat-pick');
    containers.filter(c => c.state === 'running').forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = `${c.name} (${shortId(c.id)})`;
      sel.appendChild(o);
    });

    // Events streaming
    let evCtrl = null;
    const feed = wrap.querySelector('#ev-feed');
    function fmtEv(ev) {
      const t = ev.time ? new Date(ev.time * 1000).toLocaleTimeString() : '';
      const actor = (ev.Actor && ev.Actor.Attributes && (ev.Actor.Attributes.name || ev.Actor.ID)) || ev.id || '';
      return `${t} ${ev.Type || ''} ${ev.Action || ev.status || ''} ${actor}`;
    }
    async function startEvents() {
      if (evCtrl) { evCtrl.abort(); evCtrl = null; wrap.querySelector('#ev-toggle').textContent = '▶ Stream'; return; }
      evCtrl = new AbortController();
      wrap.querySelector('#ev-toggle').textContent = '⏹ Stop';
      try {
        const res = await fetch('/api/system/events/stream', {
          headers: { Authorization: authHeader() }, signal: evCtrl.signal,
        });
        if (!res.ok) throw new Error(`Events stream failed (${res.status})`);
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line);
              const div = document.createElement('div');
              div.textContent = fmtEv(ev);
              feed.insertBefore(div, feed.firstChild);
              while (feed.children.length > 500) feed.removeChild(feed.lastChild);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          const div = document.createElement('div');
          div.textContent = `[error] ${e.message}`; div.className = 'text-rose-300';
          feed.insertBefore(div, feed.firstChild);
        }
      } finally {
        evCtrl = null;
        const btn = wrap.querySelector('#ev-toggle'); if (btn) btn.textContent = '▶ Stream';
      }
    }
    wrap.querySelector('#ev-toggle').onclick = startEvents;

    // Stats streaming
    let statCtrl = null; let statHistory = { cpu: [], mem: [] };
    function drawSpark(canvas, data, max) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (!data.length) return;
      const M = max || Math.max(...data, 1);
      ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 1.5; ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / Math.max(1, data.length - 1)) * w;
        const y = h - (v / M) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = 'rgba(14, 165, 233, 0.15)';
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
    }
    function statCards(s) {
      function cpuPct(s) {
        const cd = s.cpu_stats?.cpu_usage?.total_usage - (s.precpu_stats?.cpu_usage?.total_usage || 0);
        const sd = s.cpu_stats?.system_cpu_usage - (s.precpu_stats?.system_cpu_usage || 0);
        const n = s.cpu_stats?.online_cpus || (s.cpu_stats?.cpu_usage?.percpu_usage || []).length || 1;
        return (sd > 0 && cd > 0) ? (cd / sd) * n * 100 : 0;
      }
      const cpu = cpuPct(s);
      const memUsage = (s.memory_stats?.usage || 0) - (s.memory_stats?.stats?.cache || 0);
      const memLimit = s.memory_stats?.limit || 0;
      const memPct = memLimit ? (memUsage / memLimit) * 100 : 0;
      let netRx = 0, netTx = 0;
      for (const v of Object.values(s.networks || {})) { netRx += v.rx_bytes || 0; netTx += v.tx_bytes || 0; }
      let blkR = 0, blkW = 0;
      for (const e of (s.blkio_stats?.io_service_bytes_recursive || [])) {
        if (e.op === 'Read' || e.op === 'read') blkR += e.value || 0;
        if (e.op === 'Write' || e.op === 'write') blkW += e.value || 0;
      }
      return { cpu, memUsage, memLimit, memPct, netRx, netTx, blkR, blkW };
    }
    function renderCards(c) {
      wrap.querySelector('#stat-cards').innerHTML = [
        statCard('CPU', `${c.cpu.toFixed(1)} %`),
        statCard('Memory', `${fmtBytes(c.memUsage)} / ${fmtBytes(c.memLimit)}`, `${c.memPct.toFixed(1)} %`),
        statCard('Network', `↓ ${fmtBytes(c.netRx)}`, `↑ ${fmtBytes(c.netTx)}`),
        statCard('Block IO', `R ${fmtBytes(c.blkR)}`, `W ${fmtBytes(c.blkW)}`),
      ].join('');
    }
    async function startStats() {
      const id = sel.value; if (!id) return;
      if (statCtrl) { statCtrl.abort(); statCtrl = null; wrap.querySelector('#stat-toggle').textContent = '▶ Stream'; return; }
      statCtrl = new AbortController();
      wrap.querySelector('#stat-toggle').textContent = '⏹ Stop';
      statHistory = { cpu: [], mem: [] };
      try {
        const res = await fetch(`/api/containers/${encodeURIComponent(id)}/stats/stream`, {
          headers: { Authorization: authHeader() }, signal: statCtrl.signal,
        });
        if (!res.ok) throw new Error(`Stats stream failed (${res.status})`);
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const sample = JSON.parse(line);
              const c = statCards(sample);
              renderCards(c);
              statHistory.cpu.push(c.cpu); statHistory.mem.push(c.memPct);
              if (statHistory.cpu.length > 120) statHistory.cpu.shift();
              if (statHistory.mem.length > 120) statHistory.mem.shift();
              drawSpark(wrap.querySelector('#cpu-spark'), statHistory.cpu, 100);
              drawSpark(wrap.querySelector('#mem-spark'), statHistory.mem, 100);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'error');
      } finally {
        statCtrl = null;
        const b = wrap.querySelector('#stat-toggle'); if (b) b.textContent = '▶ Stream';
      }
    }
    sel.addEventListener('change', () => {
      wrap.querySelector('#stat-toggle').disabled = !sel.value;
      if (statCtrl) { statCtrl.abort(); statCtrl = null; }
    });
    wrap.querySelector('#stat-toggle').onclick = startStats;

    const cleanup = () => {
      if (evCtrl) evCtrl.abort();
      if (statCtrl) statCtrl.abort();
    };
    window.addEventListener('hashchange', cleanup, { once: true });
  };

  // ---------- System ----------
  views.system = async (root) => {
    root.innerHTML = pageHeader('System', 'Engine information and disk usage');
    try {
      const [info, version, df] = await Promise.all([
        api('/api/system/info'), api('/api/system/version'), api('/api/system/df'),
      ]);
      const wrap = document.createElement('div');
      wrap.className = 'grid gap-4 md:grid-cols-2';
      wrap.appendChild(panel('Engine version', jsonView(version)));
      wrap.appendChild(panel('Disk usage summary', dfSummary(df)));
      wrap.appendChild(panel('Engine info', jsonView(info)));
      wrap.appendChild(panel('Disk usage detail', jsonView(df)));
      root.appendChild(wrap);
    } catch (e) {
      root.innerHTML += `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
    }
  };

  function panel(title, child) {
    const w = document.createElement('div');
    w.className = 'rounded-xl border border-slate-800 bg-slate-900/40 p-4';
    w.innerHTML = `<h3 class="mb-3 text-sm font-semibold">${escapeHtml(title)}</h3>`;
    w.appendChild(child);
    return w;
  }
  function dfSummary(df) {
    const totals = {
      images: (df.Images || []).reduce((a, i) => a + (i.Size || 0), 0),
      containers: (df.Containers || []).reduce((a, c) => a + (c.SizeRw || 0), 0),
      volumes: (df.Volumes || []).reduce((a, v) => a + ((v.UsageData && v.UsageData.Size) || 0), 0),
    };
    const wrap = document.createElement('div');
    wrap.className = 'grid grid-cols-3 gap-3';
    wrap.innerHTML = [
      statCard('Images', fmtBytes(totals.images), `${(df.Images || []).length} total`),
      statCard('Containers (rw)', fmtBytes(totals.containers), `${(df.Containers || []).length} total`),
      statCard('Volumes', fmtBytes(totals.volumes), `${(df.Volumes || []).length} total`),
    ].join('');
    return wrap;
  }

  // ---------- Boot ----------
  state.auth = loadAuth();
  const initial = window.location.hash.replace('#', '');
  if (initial && NAV.some((n) => n.id === initial)) state.route = initial;

  (async () => {
    if (state.auth) {
      try {
        const me = await api('/api/auth/me');
        // Refresh role/user just in case the server-side configuration changed.
        state.auth.user = me.user;
        state.auth.role = me.role;
        saveAuth(state.auth);
      } catch {
        state.auth = null;
        saveAuth(null);
      }
      await bootstrap();
    }
    render();
  })();
})();
