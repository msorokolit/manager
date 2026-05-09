/* Docker Manager UI — single-page application */
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
  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (state.auth) headers.set('Authorization', `Basic ${state.auth.basic}`);
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
    const basic = btoa(`${username}:${password}`);
    const res = await fetch('/api/system/ping', { headers: { Authorization: `Basic ${basic}` } });
    if (!res.ok) throw new Error(res.status === 401 ? 'Invalid credentials' : `Login failed (${res.status})`);
    const data = await res.json();
    state.auth = { user: data.user, role: data.role, basic };
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

  async function showContainerInspect(id) {
    try {
      const data = await api(`/api/containers/${id}`);
      await modal({ title: `Inspect: ${data.Name?.replace(/^\//, '') || id}`, body: jsonView(data), size: 'xl' });
    } catch (e) { toast(e.message, 'error'); }
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
          headers: { Authorization: `Basic ${state.auth.basic}` }, signal: abortCtrl.signal,
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

  async function runContainerDialog() {
    const form = document.createElement('div');
    form.innerHTML = `
      <div class="grid gap-3 md:grid-cols-2">
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">Image *</span>
          <input name="image" required placeholder="nginx:latest" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Name</span>
          <input name="name" placeholder="(auto)" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Restart policy</span>
          <select name="restart_policy" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm">
            <option value="">(default)</option><option value="no">no</option>
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option><option value="on-failure">on-failure</option>
          </select></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">Command (optional)</span>
          <input name="command" placeholder='e.g. "tail -f /dev/null"' class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"/></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">Port mappings (one per line: <span class="kbd">host:container/proto</span>)</span>
          <textarea name="ports" rows="3" placeholder="8080:80/tcp&#10;8443:443/tcp" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">Environment (KEY=VALUE per line)</span>
          <textarea name="env" rows="3" placeholder="POSTGRES_PASSWORD=secret&#10;TZ=UTC" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">Volumes (one per line: <span class="kbd">/host/path:/container/path[:ro]</span>)</span>
          <textarea name="volumes" rows="2" placeholder="/var/data:/data&#10;myvolume:/var/lib/data" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm font-mono"></textarea></label>
        <label class="block"><span class="text-xs text-slate-400">Network</span>
          <input name="network" placeholder="bridge" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="flex items-center gap-2 text-xs text-slate-300 mt-6">
          <input name="pull" type="checkbox" class="rounded border-slate-700 bg-slate-950 text-sky-500"/> Pull image first
        </label>
      </div>
      <div id="run-error" class="hidden mt-3 rounded bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>`;

    const created = await modal({
      title: 'Run a new container',
      body: form,
      size: 'lg',
      actions: [
        { label: 'Cancel', value: false, kind: 'secondary' },
        { label: 'Run', kind: 'primary', value: true, onClick: async () => {
          const get = (n) => form.querySelector(`[name="${n}"]`);
          const errBox = form.querySelector('#run-error');
          errBox.classList.add('hidden');
          const payload = {
            image: get('image').value.trim(),
            name: get('name').value.trim() || null,
            command: get('command').value.trim() || null,
            restart_policy: get('restart_policy').value || null,
            network: get('network').value.trim() || null,
            pull: get('pull').checked,
          };
          if (!payload.image) { errBox.textContent = 'Image is required'; errBox.classList.remove('hidden'); return false; }

          const env = {};
          for (const line of get('env').value.split('\n').map(l => l.trim()).filter(Boolean)) {
            const idx = line.indexOf('=');
            if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
          }
          if (Object.keys(env).length) payload.env = env;

          const ports = {};
          for (const line of get('ports').value.split('\n').map(l => l.trim()).filter(Boolean)) {
            const m = line.match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/);
            if (!m) { errBox.textContent = `Invalid port mapping: ${line}`; errBox.classList.remove('hidden'); return false; }
            const [, host, ctr, proto] = m;
            ports[`${ctr}/${proto || 'tcp'}`] = Number(host);
          }
          if (Object.keys(ports).length) payload.ports = ports;

          const vols = {};
          for (const line of get('volumes').value.split('\n').map(l => l.trim()).filter(Boolean)) {
            const parts = line.split(':');
            if (parts.length < 2) { errBox.textContent = `Invalid volume: ${line}`; errBox.classList.remove('hidden'); return false; }
            const [host, ctr, mode] = parts;
            vols[host] = { bind: ctr, mode: mode || 'rw' };
          }
          if (Object.keys(vols).length) payload.volumes = vols;

          try {
            await api('/api/containers', { method: 'POST', body: JSON.stringify(payload) });
            toast('Container created', 'success');
          } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
            return false;
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
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="grid gap-3 md:grid-cols-3">
        <label class="md:col-span-2 block"><span class="text-xs text-slate-400">Repository *</span>
          <input id="repo" required placeholder="library/nginx" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
        <label class="block"><span class="text-xs text-slate-400">Tag</span>
          <input id="tag" placeholder="latest" class="mt-1 w-full rounded border-slate-700 bg-slate-950 text-sm"/></label>
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
          if (!repo) return false;
          const pane = wrap.querySelector('#progress'); pane.classList.remove('hidden'); pane.textContent = '';
          try {
            const res = await fetch('/api/images/pull', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${state.auth.basic}` },
              body: JSON.stringify({ repository: repo, tag }),
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
          const data = await api(`/api/networks/${id}`);
          await modal({ title: `Inspect network`, body: jsonView(data), size: 'xl' });
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
        if (act === 'inspect') {
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
        fit = new FitAddon.FitAddon();
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
          Authorization: `Basic ${state.auth.basic}`,
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
                Authorization: `Basic ${state.auth.basic}`,
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

    const wrap = document.createElement('div');
    const composeAvail = state.config.compose_available;
    wrap.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span class="badge ${stack.managed ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30' : 'bg-slate-700/40 text-slate-300 border border-slate-600/40'}">${stack.managed ? 'Managed' : 'External'}</span>
        <span class="text-slate-400">${stack.running}/${stack.containers} running · ${stack.services.length} service${stack.services.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid gap-4 ${stack.managed ? 'md:grid-cols-2' : ''}">
        ${stack.managed ? `
          <div>
            <h4 class="mb-1 text-xs uppercase tracking-wider text-slate-400">docker-compose.yml</h4>
            <textarea id="s-compose" rows="20" class="w-full rounded border-slate-700 bg-slate-950 text-xs font-mono">${escapeHtml(stack.compose || '')}</textarea>
            <h4 class="mt-3 mb-1 text-xs uppercase tracking-wider text-slate-400">.env</h4>
            <textarea id="s-env" rows="6" class="w-full rounded border-slate-700 bg-slate-950 text-xs font-mono">${escapeHtml(stack.env || '')}</textarea>
          </div>` : ''}
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-slate-400">Containers</h4>
          <div class="space-y-2">
            ${(stack.containers_detail || []).map(c => `
              <div class="rounded border border-slate-800 bg-slate-900/50 p-2 text-xs flex items-center justify-between">
                <div>
                  <div class="font-medium text-slate-200">${escapeHtml(c.service || '')} <span class="text-slate-500">·</span> ${escapeHtml(c.name)}</div>
                  <div class="text-[10px] text-slate-500 font-mono">${escapeHtml(c.image || '')}</div>
                </div>
                <span>${statusBadge(c.status)}</span>
              </div>`).join('') || '<div class="text-xs text-slate-500">No running containers</div>'}
          </div>
          ${stack.managed && composeAvail ? `
            <div class="mt-4 grid grid-cols-2 gap-2">
              <button data-act="up" class="rounded bg-emerald-500/80 hover:bg-emerald-500 text-white px-2 py-1.5 text-xs">▲ Up -d</button>
              <button data-act="down" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">▼ Down</button>
              <button data-act="restart" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">↻ Restart</button>
              <button data-act="pull" class="rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">⤓ Pull</button>
              <button data-act="logs" class="col-span-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1.5 text-xs">📜 Tail logs</button>
            </div>` : ''}
        </div>
      </div>`;

    wrap.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const act = t.dataset.act;
      try {
        if (act === 'logs') {
          await streamComposeModal(`${name}: logs`, `/api/stacks/${encodeURIComponent(name)}/logs?tail=300`, { method: 'GET' });
        } else {
          await streamComposeModal(`${name}: ${act}`, `/api/stacks/${encodeURIComponent(name)}/${act}`);
        }
      } catch (ex) { toast(ex.message, 'error'); }
    });

    const actions = [{ label: 'Close', value: false, kind: 'secondary' }];
    if (stack.managed) {
      actions.push({ label: 'Save changes', kind: 'primary', value: true, onClick: async () => {
        const payload = {
          compose: wrap.querySelector('#s-compose').value,
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
      try { await api('/api/system/ping'); }
      catch { state.auth = null; saveAuth(null); }
      await bootstrap();
    }
    render();
  })();
})();
