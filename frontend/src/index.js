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

  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const ah = authHeader();
    if (ah) headers.set('Authorization', ah);
    if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      logout();
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = j.detail || JSON.stringify(j); } catch {}
      throw new Error(`${res.status}: ${detail}`);
    }
    if (res.status === 204) return null;
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
  function modal({ title, body, actions, size = 'lg' }) {
    return new Promise((resolve) => {
      const host = document.getElementById('modal-host');
      const wrap = document.createElement('div');
      wrap.className = 'fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 fade-in';
      const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
      wrap.innerHTML = `
        <div class="w-full ${widths[size] || widths.lg} max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
          <div class="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <h3 class="text-sm font-semibold">${title}</h3>
            <button class="text-slate-400 hover:text-white" data-act="close">✕</button>
          </div>
          <div class="flex-1 overflow-auto scroll-thin p-5" data-role="body"></div>
          <div class="flex justify-end gap-2 border-t border-slate-800 bg-slate-900/50 px-5 py-3" data-role="actions"></div>
        </div>`;
      const bodyEl = wrap.querySelector('[data-role="body"]');
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body instanceof Node) bodyEl.appendChild(body);

      const actionsEl = wrap.querySelector('[data-role="actions"]');
      const close = (val) => { wrap.remove(); resolve(val); };
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
          close(a.value);
        };
        actionsEl.appendChild(b);
      });
      wrap.querySelector('[data-act="close"]').onclick = () => close(null);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
      host.appendChild(wrap);
    });
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
  function logout() {
    state.auth = null; saveAuth(null); render();
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
    root.innerHTML = pageHeader(
      'Containers',
      'Manage container lifecycle, view logs, inspect details',
      `${btn('+ Run container', { kind: 'primary', id: 'new-container' })}
       ${btn('Prune stopped', { kind: 'secondary', id: 'prune-containers' })}
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
      </label>`;
    root.insertBefore(filterWrap, list);

    let containers = [];
    let query = '';
    let showAll = true;

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        containers = await api(`/api/containers?all=${showAll}`);
        draw();
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    function draw() {
      const q = query.toLowerCase();
      const items = containers.filter((c) =>
        !q || c.name.toLowerCase().includes(q) || (c.image || '').toLowerCase().includes(q)
      );
      const rows = items.map((c) => `
        <tr class="hover:bg-slate-900/60">
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
              ${actionButton(c, 'start', '▶ Start', 'primary', c.state === 'running')}
              ${actionButton(c, 'restart', '↻ Restart', 'secondary', false)}
              ${actionButton(c, 'stop', '■ Stop', 'secondary', c.state !== 'running')}
              <button data-act="logs" data-id="${c.id}" class="rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Logs</button>
              <button data-act="exec" data-id="${c.id}" data-name="${escapeHtml(c.name)}" class="rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs" ${c.state !== 'running' ? 'disabled' : ''} ${c.state !== 'running' ? 'title="Container must be running"' : ''}>⌨ Terminal</button>
              <button data-act="remove" data-id="${c.id}" class="rounded-md bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>
            </div>
          </td>
        </tr>`);
      list.innerHTML = table(
        ['Name', 'Image', 'Status', 'Ports', 'Created', '<span class="sr-only">Actions</span>'],
        rows
      );
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
    document.getElementById('prune-containers').onclick = async () => {
      const ok = await confirmModal('Remove all stopped containers?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try {
        const r = await api('/api/containers/prune', { method: 'POST' });
        toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('new-container').onclick = () => runContainerDialog().then((created) => { if (created) load(); });

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
    root.innerHTML = pageHeader(
      'Images',
      'Pull, inspect, and remove container images',
      `${btn('⤓ Pull image', { kind: 'primary', id: 'pull-image' })}
       ${btn('Prune dangling', { kind: 'secondary', id: 'prune-images' })}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );
    const list = document.createElement('div'); root.appendChild(list);

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const items = await api('/api/images');
        const rows = items.map((i) => `
          <tr class="hover:bg-slate-900/60">
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
                <button data-act="remove" data-id="${i.id}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>
              </div>
            </td>
          </tr>`);
        list.innerHTML = table(['Tags', 'Size', 'Arch / OS', 'Created', ''], rows);
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

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
    document.getElementById('prune-images').onclick = async () => {
      const ok = await confirmModal('Remove dangling (untagged) images?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try {
        const r = await api('/api/images/prune?dangling_only=true', { method: 'POST' });
        toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success'); load();
      } catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('pull-image').onclick = () => pullImageDialog().then((ok) => ok && load());

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
  views.networks = async (root) => {
    root.innerHTML = pageHeader(
      'Networks',
      'Manage docker networks',
      `${btn('+ Create network', { kind: 'primary', id: 'create-net' })}
       ${btn('Prune unused', { kind: 'secondary', id: 'prune-nets' })}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );
    const list = document.createElement('div'); root.appendChild(list);

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const items = await api('/api/networks');
        const rows = items.map((n) => `
          <tr class="hover:bg-slate-900/60">
            <td class="px-4 py-2">
              <div class="font-medium">${escapeHtml(n.name)}</div>
              <div class="text-[11px] text-slate-500 font-mono">${shortId(n.id)}</div>
            </td>
            <td class="px-4 py-2 text-slate-300">${escapeHtml(n.driver || '')}</td>
            <td class="px-4 py-2 text-slate-300">${escapeHtml(n.scope || '')}</td>
            <td class="px-4 py-2 text-slate-400">${n.containers.length}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                <button data-act="inspect" data-id="${n.id}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Inspect</button>
                <button data-act="remove" data-id="${n.id}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>
              </div>
            </td>
          </tr>`);
        list.innerHTML = table(['Name', 'Driver', 'Scope', 'Containers', ''], rows);
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id; const act = t.dataset.act;
      try {
        if (act === 'inspect') {
          await openNetworkDialog(id);
          load();
        } else if (act === 'remove') {
          const ok = await confirmModal('Remove this network?', { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
          await api(`/api/networks/${id}`, { method: 'DELETE' });
          toast('Network removed', 'success'); load();
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    document.getElementById('prune-nets').onclick = async () => {
      const ok = await confirmModal('Prune unused networks?', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try { await api('/api/networks/prune', { method: 'POST' }); toast('Pruned', 'success'); load(); }
      catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('create-net').onclick = async () => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="grid gap-3 md:grid-cols-2">
          <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Name *</span>
            <input id="n-name" required class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
          <label class="block"><span class="text-xs text-slate-400">Driver</span>
            <select id="n-driver" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
              <option value="bridge">bridge</option><option value="overlay">overlay</option>
              <option value="macvlan">macvlan</option><option value="ipvlan">ipvlan</option><option value="host">host</option>
            </select></label>
          <label class="flex items-center gap-2 text-xs text-slate-300 mt-6">
            <input id="n-internal" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Internal
          </label>
        </div>`;
      const ok = await modal({
        title: 'Create network',
        body: wrap, size: 'md',
        actions: [
          { label: 'Cancel', value: false, kind: 'secondary' },
          { label: 'Create', kind: 'primary', value: true, onClick: async () => {
            const payload = {
              name: wrap.querySelector('#n-name').value.trim(),
              driver: wrap.querySelector('#n-driver').value,
              internal: wrap.querySelector('#n-internal').checked,
            };
            if (!payload.name) return false;
            try { await api('/api/networks', { method: 'POST', body: JSON.stringify(payload) }); toast('Network created', 'success'); }
            catch (e) { toast(e.message, 'error'); return false; }
          }},
        ],
      });
      if (ok) load();
    };

    await load();
  };

  async function openNetworkDialog(networkId) {
    let data;
    try { data = await api(`/api/networks/${networkId}`); }
    catch (e) { toast(e.message, 'error'); return; }

    const containers = Object.entries(data.Containers || {});
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-slate-400">Connected containers</h4>
          <div id="conn-list" class="space-y-2"></div>
          <div class="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <h5 class="mb-2 text-xs font-semibold text-slate-300">Connect a container</h5>
            <div class="grid gap-2">
              <label class="block"><span class="text-[11px] text-slate-400">Container ID or name</span>
                <input id="cn-cont" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
              <label class="block"><span class="text-[11px] text-slate-400">Aliases (comma-separated, optional)</span>
                <input id="cn-aliases" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
              <label class="block"><span class="text-[11px] text-slate-400">IPv4 address (optional)</span>
                <input id="cn-ipv4" placeholder="172.20.0.10" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
              <button id="cn-go" class="mt-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-3 py-1.5 text-xs font-medium">Connect</button>
            </div>
          </div>
        </div>
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-slate-400">Inspect</h4>
          <div id="inspect-host"></div>
        </div>
      </div>`;

    function renderConns(d) {
      const host = wrap.querySelector('#conn-list');
      const conns = Object.entries(d.Containers || {});
      if (!conns.length) { host.innerHTML = '<div class="text-xs text-slate-500">No containers attached</div>'; return; }
      host.innerHTML = conns.map(([cid, info]) => `
        <div class="rounded border border-slate-800 bg-slate-900/50 p-2 text-xs flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-medium text-slate-200 truncate">${escapeHtml(info.Name || cid.slice(0,12))}</div>
            <div class="text-[10px] text-slate-500 font-mono truncate">${escapeHtml(info.IPv4Address || info.IPv6Address || '')}</div>
          </div>
          <button data-disc="${cid}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-[11px]">Disconnect</button>
        </div>`).join('');
      host.querySelectorAll('[data-disc]').forEach((b) => {
        b.onclick = async () => {
          const cid = b.dataset.disc;
          const ok = await confirmModal(`Disconnect ${cid.slice(0,12)} from this network?`, { danger: true, confirmLabel: 'Disconnect' });
          if (!ok) return;
          try {
            await api(`/api/networks/${networkId}/disconnect`, {
              method: 'POST', body: JSON.stringify({ container: cid, force: false }),
            });
            toast('Disconnected', 'success');
            const fresh = await api(`/api/networks/${networkId}`);
            renderConns(fresh);
            wrap.querySelector('#inspect-host').replaceChildren(jsonView(fresh));
          } catch (e) { toast(e.message, 'error'); }
        };
      });
    }
    renderConns(data);
    wrap.querySelector('#inspect-host').appendChild(jsonView(data));

    wrap.querySelector('#cn-go').onclick = async () => {
      const payload = { container: wrap.querySelector('#cn-cont').value.trim() };
      const aliases = wrap.querySelector('#cn-aliases').value.split(',').map(s => s.trim()).filter(Boolean);
      const ipv4 = wrap.querySelector('#cn-ipv4').value.trim();
      if (aliases.length) payload.aliases = aliases;
      if (ipv4) payload.ipv4_address = ipv4;
      if (!payload.container) { toast('Container is required', 'warn'); return; }
      try {
        await api(`/api/networks/${networkId}/connect`, { method: 'POST', body: JSON.stringify(payload) });
        toast('Connected', 'success');
        wrap.querySelector('#cn-cont').value = '';
        wrap.querySelector('#cn-aliases').value = '';
        wrap.querySelector('#cn-ipv4').value = '';
        const fresh = await api(`/api/networks/${networkId}`);
        renderConns(fresh);
        wrap.querySelector('#inspect-host').replaceChildren(jsonView(fresh));
      } catch (e) { toast(e.message, 'error'); }
    };

    await modal({ title: `Network: ${data.Name}`, body: wrap, size: 'xl' });
  }

  // ---------- Volumes ----------
  views.volumes = async (root) => {
    root.innerHTML = pageHeader(
      'Volumes',
      'Manage persistent storage volumes',
      `${btn('+ Create volume', { kind: 'primary', id: 'create-vol' })}
       ${btn('Prune unused', { kind: 'secondary', id: 'prune-vols' })}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );
    const list = document.createElement('div'); root.appendChild(list);

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const items = await api('/api/volumes');
        const rows = items.map((v) => `
          <tr class="hover:bg-slate-900/60">
            <td class="px-4 py-2">
              <div class="font-medium">${escapeHtml(v.name)}</div>
              <div class="text-[11px] text-slate-500 font-mono">${escapeHtml(v.driver || '')}</div>
            </td>
            <td class="px-4 py-2 text-slate-300 font-mono text-xs">${escapeHtml(v.mountpoint || '')}</td>
            <td class="px-4 py-2 text-slate-400">${fmtDate(v.created_at)}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                <button data-act="browse" data-id="${v.name}" class="rounded bg-sky-500/80 hover:bg-sky-500 text-white px-2 py-1 text-xs">📁 Browse</button>
                <button data-act="inspect" data-id="${v.name}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Inspect</button>
                <button data-act="remove" data-id="${v.name}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>
              </div>
            </td>
          </tr>`);
        list.innerHTML = table(['Name', 'Mountpoint', 'Created', ''], rows);
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

    list.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id; const act = t.dataset.act;
      try {
        if (act === 'browse') {
          await openVolumeBrowser(id);
        } else if (act === 'inspect') {
          const data = await api(`/api/volumes/${encodeURIComponent(id)}`);
          await modal({ title: `Inspect volume`, body: jsonView(data), size: 'xl' });
        } else if (act === 'remove') {
          const ok = await confirmModal('Remove this volume? Data will be lost.', { danger: true, confirmLabel: 'Remove' });
          if (!ok) return;
          await api(`/api/volumes/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
          toast('Volume removed', 'success'); load();
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    document.getElementById('refresh').onclick = load;
    document.getElementById('prune-vols').onclick = async () => {
      const ok = await confirmModal('Prune unused volumes? Data will be lost.', { danger: true, confirmLabel: 'Prune' });
      if (!ok) return;
      try { const r = await api('/api/volumes/prune', { method: 'POST' }); toast(`Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`, 'success'); load(); }
      catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('create-vol').onclick = async () => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="grid gap-3 md:grid-cols-2">
          <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Name *</span>
            <input id="v-name" required class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
          <label class="block"><span class="text-xs text-slate-400">Driver</span>
            <input id="v-driver" value="local" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        </div>`;
      const ok = await modal({
        title: 'Create volume', body: wrap, size: 'md',
        actions: [
          { label: 'Cancel', value: false, kind: 'secondary' },
          { label: 'Create', kind: 'primary', value: true, onClick: async () => {
            const payload = {
              name: wrap.querySelector('#v-name').value.trim(),
              driver: wrap.querySelector('#v-driver').value.trim() || 'local',
            };
            if (!payload.name) return false;
            try { await api('/api/volumes', { method: 'POST', body: JSON.stringify(payload) }); toast('Volume created', 'success'); }
            catch (e) { toast(e.message, 'error'); return false; }
          }},
        ],
      });
      if (ok) load();
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
    const composeAvail = state.config.compose_available;
    const warning = composeAvail ? '' : `
      <div class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        <strong>docker-compose binary not found</strong> on the manager host. You can still browse stacks discovered from running containers, but creating or deploying stacks is disabled. Install the compose plugin or set <code>COMPOSE_BIN</code>.
      </div>`;
    root.innerHTML = pageHeader(
      'Stacks',
      'Manage docker-compose projects',
      `${composeAvail ? btn('+ New stack', { kind: 'primary', id: 'new-stack' }) : ''}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    ) + warning;
    const list = document.createElement('div'); root.appendChild(list);

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const items = await api('/api/stacks');
        const rows = items.map((s) => `
          <tr class="hover:bg-slate-900/60">
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
                ${s.managed && composeAvail ? `<button data-act="up" data-name="${escapeHtml(s.name)}" class="rounded bg-emerald-500/80 hover:bg-emerald-500 text-white px-2 py-1 text-xs">▲ Up</button>` : ''}
                ${s.managed && composeAvail ? `<button data-act="down" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">▼ Down</button>` : ''}
                ${s.managed && composeAvail ? `<button data-act="restart" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">↻ Restart</button>` : ''}
                ${s.managed && composeAvail ? `<button data-act="pull" data-name="${escapeHtml(s.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">⤓ Pull</button>` : ''}
                ${s.managed ? `<button data-act="delete" data-name="${escapeHtml(s.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Delete</button>` : ''}
              </div>
            </td>
          </tr>`);
        list.innerHTML = table(['Name', 'Services', 'Running', ''], rows);
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

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
    if (composeAvail) {
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

  // ---------- Volume browser ----------
  async function openVolumeBrowser(volumeName) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button id="vb-up" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">↑ Up</button>
        <input id="vb-path" value="/" class="flex-1 min-w-[200px] rounded border-slate-700 bg-slate-950 text-xs font-mono"/>
        <button id="vb-go" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">Go</button>
        <button id="vb-mkdir" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">+ New folder</button>
        <label class="rounded bg-sky-500 hover:bg-sky-400 text-slate-950 px-2 py-1 text-xs cursor-pointer">⤒ Upload
          <input id="vb-upload" type="file" class="hidden"/>
        </label>
        <button id="vb-stop" class="ml-auto rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs border border-slate-700">Stop sidecar</button>
      </div>
      <div id="vb-status" class="mb-2 hidden rounded bg-slate-800/60 px-3 py-2 text-xs text-slate-300"></div>
      <div id="vb-list" class="rounded border border-slate-800 bg-slate-950/60 max-h-[55vh] overflow-auto scroll-thin"></div>`;

    let cur = '/';

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

    function rowFor(entry) {
      const icon = entry.is_dir ? '📁' : (entry.is_link ? '🔗' : '📄');
      const sizeCol = entry.is_dir ? '' : fmtBytes(entry.size);
      const date = entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : '';
      return `
        <div data-name="${escapeHtml(entry.name)}" data-dir="${entry.is_dir ? '1' : ''}" class="vb-row flex items-center gap-3 border-b border-slate-800/70 px-3 py-1.5 text-xs hover:bg-slate-900/60">
          <span>${icon}</span>
          <span class="flex-1 ${entry.is_dir ? 'text-sky-300 cursor-pointer' : 'text-slate-200'} truncate">${escapeHtml(entry.name)}</span>
          <span class="w-24 text-right text-slate-400 font-mono">${sizeCol}</span>
          <span class="w-44 text-right text-slate-500">${date}</span>
          <span class="flex gap-1">
            ${entry.is_dir ? '' : `<button data-act="dl" class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 border border-slate-700">Download</button>`}
            <button data-act="rm" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-0.5">Delete</button>
          </span>
        </div>`;
    }

    async function load(path) {
      cur = path || '/';
      wrap.querySelector('#vb-path').value = cur;
      const host = wrap.querySelector('#vb-list');
      host.innerHTML = '<div class="px-3 py-3 text-xs text-slate-400">Loading…</div>';
      setStatus('');
      try {
        const data = await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/list?path=${encodeURIComponent(cur)}`);
        cur = data.path || cur;
        wrap.querySelector('#vb-path').value = cur;
        const entries = data.entries || [];
        if (!entries.length) {
          host.innerHTML = '<div class="px-3 py-6 text-center text-xs text-slate-500">Empty</div>';
        } else {
          host.innerHTML = entries.map(rowFor).join('');
        }
      } catch (e) {
        host.innerHTML = '';
        setStatus(e.message, 'err');
      }
    }

    wrap.querySelector('#vb-list').addEventListener('click', async (e) => {
      const row = e.target.closest('.vb-row');
      if (!row) return;
      const name = row.dataset.name;
      const isDir = row.dataset.dir === '1';
      const child = (cur === '/' ? '/' : cur + '/') + name;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'rm') {
        const ok = await confirmModal(`Delete ${name}?`, { danger: true, confirmLabel: 'Delete' });
        if (!ok) return;
        try {
          await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(child)}`, { method: 'DELETE' });
          toast('Deleted', 'success'); load(cur);
        } catch (ex) { toast(ex.message, 'error'); }
        return;
      }
      if (act === 'dl') {
        try {
          const res = await fetch(`/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(child)}`, {
            headers: { Authorization: authHeader() },
          });
          if (!res.ok) throw new Error(`Download failed (${res.status})`);
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch (ex) { toast(ex.message, 'error'); }
        return;
      }
      if (isDir) load(child);
    });

    wrap.querySelector('#vb-up').onclick = () => {
      if (cur === '/' || cur === '') return;
      const idx = cur.replace(/\/+$/, '').lastIndexOf('/');
      load(idx <= 0 ? '/' : cur.slice(0, idx));
    };
    wrap.querySelector('#vb-go').onclick = () => load(wrap.querySelector('#vb-path').value || '/');
    wrap.querySelector('#vb-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); load(wrap.querySelector('#vb-path').value || '/'); }
    });

    wrap.querySelector('#vb-mkdir').onclick = async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      const child = (cur === '/' ? '/' : cur + '/') + name;
      try {
        await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/mkdir?path=${encodeURIComponent(child)}`, { method: 'POST' });
        toast('Folder created', 'success'); load(cur);
      } catch (ex) { toast(ex.message, 'error'); }
    };

    wrap.querySelector('#vb-upload').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      setStatus(`Uploading ${file.name}…`);
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(`/api/volumes/${encodeURIComponent(volumeName)}/browse/file?path=${encodeURIComponent(cur)}`, {
          method: 'POST',
          headers: { Authorization: authHeader() },
          body: fd,
        });
        if (!res.ok) { let det = res.statusText; try { det = (await res.json()).detail || det; } catch {} throw new Error(det); }
        toast('Uploaded', 'success'); setStatus('');
        load(cur);
      } catch (ex) { setStatus(ex.message, 'err'); }
      e.target.value = '';
    });

    wrap.querySelector('#vb-stop').onclick = async () => {
      try {
        await api(`/api/volumes/${encodeURIComponent(volumeName)}/browse/stop`, { method: 'POST' });
        toast('Sidecar stopped', 'success');
      } catch (ex) { toast(ex.message, 'error'); }
    };

    setStatus(`A small "${state.config.browser_image}" sidecar will be started with this volume mounted at /target. Click "Stop sidecar" when done.`, 'info');
    load('/');

    await modal({ title: `Browse: ${volumeName}`, body: wrap, size: 'xl' });
  }

  // ---------- Registries ----------
  views.registries = async (root) => {
    root.innerHTML = pageHeader(
      'Registries',
      'Stored credentials used by the image-pull dialog',
      `${btn('+ Add registry', { kind: 'primary', id: 'add-reg' })}
       ${btn('Refresh', { kind: 'ghost', id: 'refresh' })}`
    );
    const list = document.createElement('div'); root.appendChild(list);

    async function load() {
      list.innerHTML = `<div class="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-400">Loading…</div>`;
      try {
        const items = await api('/api/registries');
        const rows = items.map((r) => `
          <tr class="hover:bg-slate-900/60">
            <td class="px-4 py-2 font-medium">${escapeHtml(r.name)}</td>
            <td class="px-4 py-2 text-slate-300 font-mono text-xs">${escapeHtml(r.url)}</td>
            <td class="px-4 py-2 text-slate-300">${escapeHtml(r.username)}</td>
            <td class="px-4 py-2 text-slate-400">${escapeHtml(r.email || '')}</td>
            <td class="px-4 py-2 text-right">
              <div class="flex justify-end gap-1">
                <button data-act="test" data-name="${escapeHtml(r.name)}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Test login</button>
                <button data-act="edit" data-name="${escapeHtml(r.name)}" data-url="${escapeHtml(r.url)}" data-user="${escapeHtml(r.username)}" data-email="${escapeHtml(r.email || '')}" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 text-xs">Edit</button>
                <button data-act="rm" data-name="${escapeHtml(r.name)}" class="rounded bg-rose-500/80 hover:bg-rose-500 text-white px-2 py-1 text-xs">Remove</button>
              </div>
            </td>
          </tr>`);
        list.innerHTML = `
          <p class="mb-3 text-xs text-slate-500">Passwords are stored on the manager host in <code>${escapeHtml(state.config.registries_file || '/data/registries.json')}</code> with mode 0600. Always front this UI with TLS.</p>
        ` + table(['Name', 'URL', 'Username', 'Email', ''], rows);
      } catch (e) {
        list.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">${escapeHtml(e.message)}</div>`;
      }
    }

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
    document.getElementById('add-reg').onclick = () => registryDialog().then((ok) => { if (ok) load(); });

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
