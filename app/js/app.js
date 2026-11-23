/* UI layer. */
(function () {
  'use strict';
  const { analyse, fmtINR, futureValue, FEE_CATS, isSpend } = Analysis;
  const IS_WIN = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const $ = s => document.querySelector(s);
  document.querySelectorAll('i[data-icon]').forEach(i => { const t = document.createElement('template'); t.innerHTML = Icon(i.dataset.icon, i.className); i.replaceWith(t.content.firstChild); });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v, d = 0) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const inr = v => fmtINR(v);
  const inrC = v => fmtINR(v, { compact: true });
  const monthLabel = m => { const [y, mo] = m.split('-'); return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };
  const dateLabel = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

  /* ---------- storage ----------
   * Statements, category edits and settings live in the local SQLite database (via serve.py).
   * localStorage only remembers per-browser view preferences (tab, theme). */
  const KEY = 'ccsi.v1';
  const store = {
    get(k, def) { try { const v = localStorage.getItem(KEY + '.' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem(KEY + '.' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(KEY + '.' + k); } catch { } },
  };
  const DEFAULT_SETTINGS = () => ({ pointValue: {}, income: 0, smallLimit: 250, cuts: {}, years: 10, rate: 10 });

  async function api(method, path, body) {
    const res = await fetch('/api/' + path, {
      method, headers: Object.assign({ 'X-CSI': '1' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { msg = (await res.json()).error || msg; } catch { }
      throw new Error(msg);
    }
    return (res.headers.get('Content-Type') || '').includes('json') ? res.json() : res.blob();
  }

  const state = {
    statements: [],
    overrides: {},
    settings: DEFAULT_SETTINGS(),
    folders: [],
    dbPath: '',
    pending: null, // last scan result
    filter: { cards: null, from: null, to: null },
    tab: (location.hash.slice(1) || store.get('tab', 'overview')),
    charts: {},
  };

  let settingsTimer;
  const saveSettings = () => { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => api('PUT', 'kv?key=settings', state.settings).catch(showError), 400); };
  const saveOverrides = () => api('PUT', 'kv?key=overrides', state.overrides).catch(showError);
  function showError(e) { console.error(e); setProgress('⚠ ' + (e.message || e)); }

  async function reload() {
    const d = await api('GET', 'data');
    state.statements = d.statements;
    state.overrides = d.overrides || {};
    state.settings = Object.assign(DEFAULT_SETTINGS(), d.settings || {});
    state.folders = d.folders;
    state.dbPath = d.dbPath;
    memo.ver++;
  }
  const memo = { ver: 0 };

  /* ---------- theme ---------- */
  const savedTheme = store.get('theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#themeToggle').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', document.documentElement.dataset.theme);
    render();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const seriesColor = i => css('--s' + ((i % 8) + 1));

  /* ---------- importing ---------- */
  const progress = $('#progress');
  function setProgress(msg) { progress.textContent = msg || ''; progress.classList.toggle('show', !!msg); }

  function askPassword(card, fileName, errorMsg, canRename) {
    return new Promise(resolve => {
      const dlg = $('#pwDialog');
      $('#pwTitle').innerHTML = Icon('lock') + 'Unlock ' + esc(card);
      $('#pwInfo').textContent = `Password-protected statement: ${fileName}. The password is used in this tab only and is never stored.`;
      $('#pwCard').value = card;
      $('#pwCardRow').style.display = canRename ? '' : 'none';
      $('#pwInput').value = '';
      $('#pwError').textContent = errorMsg || '';
      const done = val => { dlg.close(); $('#pwForm').onsubmit = null; $('#pwSkip').onclick = null; dlg.oncancel = null; resolve(val); };
      $('#pwForm').onsubmit = e => { e.preventDefault(); done({ password: $('#pwInput').value, card: $('#pwCard').value.trim() || card }); };
      $('#pwSkip').onclick = () => done(null);
      dlg.oncancel = () => done(null);
      dlg.showModal();
      setTimeout(() => $('#pwInput').focus(), 30);
    });
  }

  // Passwords that opened a file in this tab, per card. Memory only: gone when the tab closes.
  const sessionPasswords = new Map();

  /* items: [{ card, name, size, getFile: async () => File, folderId?, relPath?, replaces? }] */
  async function importItems(items) {
    const groups = new Map();
    for (const it of items) { if (!groups.has(it.card)) groups.set(it.card, []); groups.get(it.card).push(it); }
    let added = 0, txns = 0; const failed = [];
    for (let [card, list] of groups) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      const canRename = !list[0].folderId;
      const passwords = sessionPasswords.get(card) || [''];
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        setProgress(`Reading ${card}: ${it.name} (${i + 1}/${list.length})`);
        let f;
        try { f = await it.getFile(); } catch (e) { failed.push(`${it.name}: ${e.message}`); continue; }
        let pw = null;
        for (const cand of passwords) { if (!(await StatementParser.needsPassword(f, cand).catch(() => true))) { pw = cand; break; } }
        let err = '';
        while (pw === null) {
          const ans = await askPassword(card, it.name, err, canRename);
          if (!ans) break;
          if (canRename && ans.card !== card) card = ans.card;
          if (!(await StatementParser.needsPassword(f, ans.password).catch(() => true))) { pw = ans.password; passwords.unshift(pw); }
          else err = 'That password did not open this file. Try again.';
        }
        if (pw === null) { failed.push(`${card}: ${list.length - i} file(s) skipped`); break; }
        try {
          const st = await StatementParser.parseStatement(f, card, pw);
          if (it.folderId) {
            st.id = `f${it.folderId}:${it.relPath}:${it.size}`;
            st.txns.forEach((t, j) => { t.id = `${st.id}#${j}`; t.statementId = st.id; });
          }
          await api('POST', 'statements', Object.assign(st, { folderId: it.folderId || null, relPath: it.relPath || null, replaces: it.replaces || null }));
          added++; txns += st.txns.length;
        } catch (e) { console.error(e); failed.push(`${it.name}: ${e.message}`); }
      }
      sessionPasswords.set(card, passwords);
    }
    await reload();
    setProgress(added ? `Imported ${added} statement${added > 1 ? 's' : ''} (${txns} transactions).${failed.length ? ' Problems: ' + failed.join('; ') : ''}` : (failed.length ? 'Nothing imported. ' + failed.join('; ') : 'Nothing new to import.'));
    setTimeout(() => setProgress(''), 12000);
    render();
  }

  async function scan(opts) {
    opts = opts || {};
    try { state.pending = await api('GET', 'scan'); } catch (e) { showError(e); return; }
    updateScanButton();
    if (!opts.import) { render(); return; }
    const items = [];
    for (const f of state.pending.folders) for (const x of [...f.new, ...f.changed]) {
      items.push({ card: x.card, name: x.name, size: x.size, folderId: f.id, relPath: x.rel, replaces: x.replaces,
        getFile: async () => new File([await api('GET', `file?folder=${f.id}&rel=${encodeURIComponent(x.rel)}`)], x.name, { type: 'application/pdf' }) });
    }
    if (!items.length) { setProgress('No new statements found in your folders.'); setTimeout(() => setProgress(''), 6000); render(); return; }
    await importItems(items);
    state.pending = await api('GET', 'scan').catch(() => null);
    updateScanButton();
    render();
  }

  function pendingCount() {
    if (!state.pending) return 0;
    return state.pending.folders.reduce((s, f) => s + f.new.length + f.changed.length, 0);
  }
  function updateScanButton() {
    const n = pendingCount();
    $('#scanBtn').innerHTML = Icon(n ? 'download' : 'scan') + (n ? `Import ${n} new statement${n > 1 ? 's' : ''}` : 'Scan folders');
    $('#scanBtn').classList.toggle('primary', n > 0);
  }
  $('#scanBtn').addEventListener('click', () => { if (state.folders.length) scan({ import: true }); else { state.tab = 'folders'; render(); } });

  ['#pickFiles', '#pickFiles2'].forEach(id => $(id).addEventListener('change', e => {
    const files = [...e.target.files].filter(f => /\.pdf$/i.test(f.name));
    e.target.value = '';
    const known = new Set(state.statements.map(s => s.fileName + '::' + s.size));
    const items = files.filter(f => !known.has(f.name + '::' + f.size)).map(f => {
      const m = f.name.match(/^(\d{4})X+(\d{2})/i);
      return { card: m ? `Card ${m[1]}…${m[2]}` : 'Card', name: f.name, size: f.size, getFile: async () => f };
    });
    if (!items.length) { setProgress(files.length ? 'Those statements are already imported.' : 'No PDF files selected.'); return; }
    importItems(items);
  }));

  $('#clearData').addEventListener('click', () => $('#clearDialog').showModal());
  $('#clearCancel').onclick = () => $('#clearDialog').close();
  async function wipe(everything) {
    $('#clearDialog').close();
    try {
      await api('DELETE', everything ? 'all?folders=1' : 'all');
      sessionPasswords.clear();
      if (everything) { store.del('tab'); state.tab = 'folders'; }
      await reload(); state.pending = await api('GET', 'scan'); updateScanButton(); render();
      setProgress(everything ? 'Everything was deleted.' : 'Imported data was deleted. Your folders are still listed.');
      setTimeout(() => setProgress(''), 4000);
    } catch (e) { showError(e); }
  }
  $('#clearKeep').onclick = () => wipe(false);
  $('#clearAll').onclick = () => wipe(true);

  /* ---------- folders view ---------- */
  function viewFolders() {
    const el = $('#tab-folders');
    const P = state.pending;
    const scanFor = id => P && P.folders.find(f => f.id === id);
    const counts = new Map();
    for (const s of state.statements) if (s.folderId) counts.set(s.folderId, (counts.get(s.folderId) || 0) + 1);
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Statement folders</h2><span class="small muted">The dashboard scans these folders for new PDFs</span></div>
        ${state.folders.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Folder</th><th>Card name</th><th class="r">Imported</th><th>On disk now</th><th></th></tr></thead>
          <tbody>${state.folders.map(f => {
            const sc = scanFor(f.id);
            const status = !f.exists ? '<span class="bad">Folder not found</span>'
              : !sc ? '<span class="muted">Not scanned yet</span>'
              : [sc.new.length ? `<span class="ok">${sc.new.length} new</span>` : '', sc.changed.length ? `<span class="ok">${sc.changed.length} changed</span>` : '', sc.missing.length ? `<span class="bad">${sc.missing.length} missing</span>` : ''].filter(Boolean).join(' · ') || '<span class="muted">Up to date</span>';
            const cardCell = f.kind === 'parent'
              ? `<span class="tag">one card per sub-folder</span><div class="small muted">${[...new Set(state.statements.filter(s => s.folderId === f.id).map(s => s.card))].map(esc).join(', ')}</div>`
              : `<input type="text" value="${esc(f.card)}" data-rename="${f.id}" style="width:100%;max-width:260px">`;
            return `<tr><td class="small" style="word-break:break-all">${esc(f.path)}</td><td>${cardCell}</td><td class="r">${counts.get(f.id) || 0}</td><td>${status}</td>
              <td style="white-space:nowrap">${sc && sc.missing.length ? `<button class="btn" data-dropmissing="${f.id}">Remove missing</button> ` : ''}<button class="btn ghost" data-remove="${f.id}">Remove folder</button></td></tr>`;
          }).join('')}</tbody></table></div>`
        : '<p class="ink2">No folders yet. Add the folder where you keep your statements below.</p>'}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn" id="rescan">Check for new statements</button>
          ${pendingCount() ? `<button class="btn primary" id="importNow">Import ${pendingCount()} new</button>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Add a folder</h2></div>
        <form id="addFolder" style="display:grid;gap:10px;max-width:760px">
          <label class="small ink2">Folder path <span class="muted">${IS_WIN ? '(in File Explorer: right-click the folder → Copy as path)' : '(full path, ~ works too)'}</span><br>
            <input type="text" id="fPath" placeholder="e.g. ${IS_WIN ? 'D:\\Statements' : '~/Statements'}" style="width:100%" required></label>
          <label class="chip" style="width:fit-content"><input type="checkbox" id="fParent" checked> This folder has one sub-folder per card (each sub-folder name becomes the card name)</label>
          <label class="small ink2" id="fCardRow" style="display:none">Card name<br><input type="text" id="fCard" placeholder="defaults to the folder name" style="width:100%;max-width:360px"></label>
          <div class="error" id="fErr"></div>
          <div><button class="btn primary" type="submit">Add folder</button></div>
        </form>
        <p class="note">Only folders you add here are read, and the server only answers requests from this computer. PDFs stay where they are. They're sent to this tab still encrypted, and the tab decrypts them.</p>
      </div>
      <div class="card">
        <div class="head"><h2>Database</h2></div>
        <p class="small ink2">Imported data is saved in a SQLite file: <code>${esc(state.dbPath)}</code>. It holds transactions and statement summaries, never passwords or PDF files. <b>Clear data</b> (top right) empties it.</p>
      </div>`;
    $('#fParent').onchange = e => { $('#fCardRow').style.display = e.target.checked ? 'none' : ''; };
    $('#addFolder').onsubmit = async e => {
      e.preventDefault();
      $('#fErr').textContent = '';
      try {
        await api('POST', 'folders', { path: $('#fPath').value, parent: $('#fParent').checked, card: $('#fCard').value });
        await reload();
        await scan();
      } catch (err) { $('#fErr').textContent = err.message; }
    };
    $('#rescan').onclick = () => scan();
    if ($('#importNow')) $('#importNow').onclick = () => scan({ import: true });
    el.querySelectorAll('[data-rename]').forEach(inp => inp.onchange = async () => {
      try { await api('PATCH', `folders?id=${inp.dataset.rename}`, { card: inp.value }); await reload(); render(); } catch (e) { showError(e); }
    });
    el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => removeFolder(+b.dataset.remove, counts.get(+b.dataset.remove) || 0));
    el.querySelectorAll('[data-dropmissing]').forEach(b => b.onclick = async () => {
      const sc = scanFor(+b.dataset.dropmissing);
      if (!confirm(`Delete ${sc.missing.length} statement(s) whose PDF is no longer in this folder from the database?`)) return;
      for (const m of sc.missing) await api('DELETE', `statements?id=${encodeURIComponent(m.id)}`).catch(showError);
      await reload(); await scan();
    });
  }

  function removeFolder(id, n) {
    const dlg = $('#rmDialog');
    $('#rmInfo').textContent = n ? `This folder has ${n} imported statement(s). Keep them in the dashboard, or delete them from the database too? The PDFs on disk are never touched.` : 'Stop scanning this folder? The PDFs on disk are not touched.';
    $('#rmKeep').textContent = n ? 'Remove folder, keep data' : 'Remove folder';
    $('#rmPurge').style.display = n ? '' : 'none';
    const go = async purge => {
      dlg.close();
      try { await api('DELETE', `folders?id=${id}${purge ? '&purge=1' : ''}`); await reload(); await scan(); } catch (e) { showError(e); }
    };
    $('#rmKeep').onclick = () => go(false);
    $('#rmPurge').onclick = () => go(true);
    $('#rmCancel').onclick = () => dlg.close();
    dlg.showModal();
  }

  /* ---------- data prep ---------- */
  function allTxns() {
    const S = state.settings, natures = S.natures || {}, aliases = S.merchantAliases || {}, perTxn = S.txnMerchants || {};
    Categoriser.setNatures(natures);
    const key = memo.ver + '|' + JSON.stringify([state.overrides, natures, aliases, perTxn]);
    if (memo.txKey === key) return memo.txns;
    const out = [];
    for (const s of state.statements) for (const raw of s.txns) {
      const t = Categoriser.normaliseTxn(raw);
      const c = Categoriser.categorise(t, state.overrides);
      const r = Object.assign({}, t, c, { card: s.card, statementId: s.id, origMerchant: c.merchant });
      const renamed = perTxn[t.id] || aliases[c.merchant];
      if (renamed && renamed !== c.merchant) {
        r.merchant = renamed;
        r.renamed = perTxn[t.id] ? 'one' : 'all';
        if (t.type === 'debit') {
          if (state.overrides[renamed]) { r.category = state.overrides[renamed]; r.overridden = true; } else r.inherit = true;
        }
      }
      out.push(r);
    }
    const votes = new Map();
    for (const r of out) if (!r.renamed && r.type === 'debit') {
      const m = votes.get(r.merchant) || new Map();
      m.set(r.category, (m.get(r.category) || 0) + 1);
      votes.set(r.merchant, m);
    }
    for (const r of out) {
      if (r.inherit) { const m = votes.get(r.merchant); if (m) r.category = [...m].sort((x, y) => y[1] - x[1])[0][0]; delete r.inherit; }
      r.nature = Categoriser.natureOf(r.category);
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    memo.bySt = new Map();
    for (const r of out) { if (!memo.bySt.has(r.statementId)) memo.bySt.set(r.statementId, []); memo.bySt.get(r.statementId).push(r); }
    memo.txKey = key; memo.txns = out;
    return out;
  }

  function cardOrder() { return [...new Set(state.statements.map(s => s.card))].sort(); }
  function cardColor(card) { return seriesColor(cardOrder().indexOf(card)); }

  function filtered() {
    const txns = allTxns();
    const key = memo.txKey + '|' + JSON.stringify(state.filter);
    if (memo.fKey === key) return memo.F;
    const f = state.filter;
    const okCard = c => !f.cards || f.cards.includes(c);
    const okDate = d => (!f.from || d.slice(0, 7) >= f.from) && (!f.to || d.slice(0, 7) <= f.to);
    memo.fKey = key;
    return memo.F = {
      txns: txns.filter(t => okCard(t.card) && okDate(t.date)),
      statements: state.statements.filter(s => okCard(s.card)).map(s => Object.assign({}, s, {
        txns: memo.bySt.get(s.id) || [],
      })),
      all: txns,
    };
  }

  /* ---------- tabs & filters ---------- */
  const TABS = [['overview', 'Overview'], ['spending', 'Spending'], ['merchants', 'Merchants'], ['cards', 'Cards'], ['leakage', 'Fees & subscriptions'], ['behaviour', 'Habits'], ['savings', 'Savings'], ['transactions', 'Transactions'], ['parser', 'Parser check'], ['folders', 'Folders']];
  const GROUPS = [['Analysis', ['overview', 'spending', 'merchants', 'cards', 'leakage', 'behaviour', 'savings']], ['Data', ['transactions', 'parser', 'folders']]];
  function renderTabs(hasData, tab) {
    const nav = $('#tabs');
    const label = Object.fromEntries(TABS);
    nav.innerHTML = GROUPS.map(([g, keys]) => {
      const ks = hasData ? keys : keys.filter(k => k === 'folders');
      return ks.length ? `<div class="group">${g}</div>` + ks.map(k => `<button data-tab="${k}" aria-selected="${tab === k}"${tab === k ? ' aria-current="page"' : ''}>${Icon(k)}${label[k]}</button>`).join('') : '';
    }).join('');
    nav.querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; store.set('tab', state.tab); render(); window.scrollTo(0, 0); });
    document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
    $('#pageTitle').textContent = hasData ? label[tab] : 'Card Spend Intelligence';
  }

  function renderFilters(all) {
    const el = $('#filters');
    if (!all.length) { el.innerHTML = ''; return; }
    const cards = cardOrder();
    const months = Analysis.monthRange(all[0].date.slice(0, 7), all[all.length - 1].date.slice(0, 7));
    const f = state.filter;
    const opt = (m, sel) => `<option value="${m}" ${sel === m ? 'selected' : ''}>${monthLabel(m)}</option>`;
    el.innerHTML = `
      ${cards.map(c => `<label class="chip"><input type="checkbox" data-card="${esc(c)}" ${!f.cards || f.cards.includes(c) ? 'checked' : ''}><span class="swatch" style="background:${cardColor(c)}"></span>${esc(c)}</label>`).join('')}
      <span class="sep"></span>
      <label class="small ink2">From <select id="fFrom"><option value="">Start</option>${months.map(m => opt(m, f.from)).join('')}</select></label>
      <label class="small ink2">To <select id="fTo"><option value="">Latest</option>${months.map(m => opt(m, f.to)).join('')}</select></label>
      <select id="fPreset"><option value="">Quick range…</option><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="all">All time</option></select>`;
    el.querySelectorAll('input[data-card]').forEach(cb => cb.onchange = () => {
      const sel = [...el.querySelectorAll('input[data-card]:checked')].map(x => x.dataset.card);
      state.filter.cards = sel.length === cards.length ? null : sel; render();
    });
    $('#fFrom').onchange = e => { state.filter.from = e.target.value || null; render(); };
    $('#fTo').onchange = e => { state.filter.to = e.target.value || null; render(); };
    $('#fPreset').onchange = e => {
      const v = e.target.value; if (!v) return;
      if (v === 'all') { state.filter.from = state.filter.to = null; }
      else { state.filter.to = null; state.filter.from = months[Math.max(0, months.length - +v)]; }
      render();
    };
  }

  /* ---------- charts ---------- */
  const tipEl = document.getElementById('tip');
  function showTip(html, x, y) {
    tipEl.innerHTML = html;
    tipEl.classList.add('on');
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    tipEl.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }
  function hideTip() { tipEl.classList.remove('on'); }
  const tipRow = (color, value, name) => `<div class="r"><i style="background:${color}"></i><b>${value}</b><span>${esc(name)}</span></div>`;

  function externalTip(fmt, axisKey, footer) {
    return ({ chart: c, tooltip }) => {
      if (!tooltip.opacity || !tooltip.dataPoints || !tooltip.dataPoints.length) { hideTip(); return; }
      let pts = tooltip.dataPoints.filter(p => p.raw != null);
      if (pts.length > 1) pts = pts.filter(p => p.raw !== 0);
      if (!pts.length) { hideTip(); return; }
      const title = (tooltip.title && tooltip.title[0]) || '';
      let html = `<div class="t">${esc(title)}</div>` + pts.slice().reverse().map(p => tipRow(p.dataset._color || p.dataset.borderColor, fmt(p.parsed[axisKey], p), p.dataset.label || '')).join('');
      if (footer) html += `<div class="f">${footer(pts)}</div>`;
      const r = c.canvas.getBoundingClientRect();
      showTip(html, r.left + tooltip.caretX, r.top + tooltip.caretY);
    };
  }

  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(c) {
      if (c.config.type !== 'line') return;
      const a = c.tooltip && c.tooltip.getActiveElements();
      if (!a || !a.length) return;
      const x = Math.round(a[0].element.x) + 0.5, { top, bottom } = c.chartArea, ctx = c.ctx;
      ctx.save(); ctx.strokeStyle = css('--axis'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
    },
  };
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(c, _args, o) {
      if (!o || !o.fmt) return;
      const ctx = c.ctx, horiz = c.options.indexAxis === 'y';
      ctx.save();
      ctx.font = '600 11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = css('--ink-2');
      c.getDatasetMeta(0).data.forEach((el, i) => {
        const v = c.data.datasets[0].data[i];
        if (!v || (o.only && !o.only(i))) return;
        if (horiz) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(o.fmt(v), el.x + 6, el.y); }
        else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(o.fmt(v), el.x, el.y - 5); }
      });
      ctx.restore();
    },
  };
  Chart.register(crosshair, valueLabels);

  const merge1 = (a, b) => { const o = Object.assign({}, a); for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? Object.assign({}, a[k], b[k]) : b[k]; return o; };

  function chart(id, config) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    const el = document.getElementById(id);
    if (!el) return;
    const muted = css('--muted'), grid = css('--grid'), axis = css('--axis');
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = muted;
    const axisKey = config._axis || 'y';
    const fmt = config._fmt || (v => inr(v));
    const opts = config.options || {};
    const scales = {};
    for (const k of Object.keys(opts.scales || { x: {}, y: {} })) {
      const isValue = k === axisKey;
      const base = {
        grid: isValue ? { color: grid, drawTicks: false, lineWidth: 1 } : { display: false },
        border: { display: !isValue, color: axis },
        ticks: { color: muted, padding: 8, maxRotation: 0, autoSkipPadding: 14 },
      };
      scales[k] = merge1(base, (opts.scales || {})[k] || {});
    }
    const merged = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false } }, opts, {
      scales,
      plugins: Object.assign({ legend: { display: false } }, opts.plugins || {}, { tooltip: { enabled: false, external: externalTip(fmt, axisKey, config._footer) } }),
    });
    state.charts[id] = new Chart(el, { type: config.type, data: config.data, options: merged });
    el.onmouseleave = hideTip;
  }
  const barDs = (label, data, color, extra) => Object.assign({
    label, data, _color: color, backgroundColor: color, hoverBackgroundColor: color + 'cc', borderColor: css('--surface'), borderWidth: 0,
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.72, barPercentage: 0.92,
  }, extra || {});
  function stacked(datasets) {
    const n = datasets.length ? datasets[0].data.length : 0;
    const top = Array.from({ length: n }, (_, i) => { for (let d = datasets.length - 1; d >= 0; d--) if (datasets[d].data[i] > 0) return d; return -1; });
    datasets.forEach((ds, d) => {
      ds.stack = 's';
      ds.borderWidth = ctx => top[ctx.dataIndex] === d ? 0 : { top: 2 };
      ds.borderRadius = ctx => top[ctx.dataIndex] === d ? { topLeft: 4, topRight: 4 } : 0;
    });
    return datasets;
  }
  const lineDs = (label, data, color, extra) => Object.assign({
    label, data, _color: color, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5,
    pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'), borderCapStyle: 'round', borderJoinStyle: 'round', tension: 0,
  }, extra || {});

  function legendHtml(items, kind) { return `<div class="legend">${items.map(([l, c]) => `<span><i class="${kind === 'line' ? 'line' : 'swatch'}" style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`; }

  function spark(values) {
    const w = 84, h = 34, n = values.length;
    if (n < 2) return '';
    const max = Math.max(...values), min = Math.min(0, ...values);
    const x = i => 2 + (i / (n - 1)) * (w - 6), y = v => h - 3 - ((v - min) / (max - min || 1)) * (h - 8);
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}L${x(n - 1).toFixed(1)} ${h}L${x(0).toFixed(1)} ${h}Z" fill="var(--accent)" opacity=".08"/><path d="${d}" fill="none" stroke="var(--muted)" stroke-opacity=".6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n - 1).toFixed(1)}" cy="${y(values[n - 1]).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
  }

  function kpi(label, value, sub, o) {
    o = o || {};
    let d = '';
    if (o.delta != null && isFinite(o.delta)) {
      const up = o.delta > 0, flat = Math.abs(o.delta) < 0.005;
      const cls = flat ? '' : (up === !!o.upIsGood ? 'good' : 'bad');
      d = `<span class="delta ${cls}">${flat ? '' : up ? '▲ ' : '▼ '}${pct(Math.abs(o.delta), 1)}<span style="font-weight:400;color:var(--muted)">&nbsp;${o.deltaLabel || ''}</span></span>`;
    }
    return `<div class="card kpi${o.hero ? ' hero' : ''}"><div class="label">${label}</div><div class="row"><div><div class="value">${value}</div>${d}</div>${o.spark ? spark(o.spark) : ''}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  function barList(rows, color) {
    const max = Math.max(...rows.map(r => r.value), 1);
    return `<div class="bars">${rows.map(r => `<div class="b"><span class="n" title="${esc(r.name)}">${esc(r.name)}</span><span class="v">${inr(r.value)}${r.note ? `<small>${r.note}</small>` : ''}</span><div class="track"><div class="fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color || color || 'var(--s1)'}"></div></div></div>`).join('')}</div>`;
  }

  function calendar(txns) {
    if (!txns.length) return '';
    const day = 86400000;
    const last = new Date(txns[txns.length - 1].date + 'T00:00:00Z');
    const start = new Date(last.getTime() - 364 * day);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const totals = new Map();
    for (const t of txns) if (t.date >= start.toISOString().slice(0, 10)) totals.set(t.date, (totals.get(t.date) || 0) + t.amount);
    const vals = [...totals.values()].sort((a, b) => a - b);
    const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
    const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
    const level = v => !v ? 0 : 1 + cuts.filter(c => v > c).length;
    const cell = 12, gap = 3, left = 28, topPad = 18;
    const weeks = Math.ceil(((last - start) / day + 1) / 7);
    let rects = '', months = '';
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start.getTime() + (w * 7 + d) * day);
        if (dt > last) break;
        const key = dt.toISOString().slice(0, 10), v = totals.get(key) || 0, lv = level(v);
        rects += `<rect x="${left + w * (cell + gap)}" y="${topPad + d * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${lv ? `var(--q${lv})` : 'var(--surface-2)'}" data-d="${key}" data-v="${v}"/>`;
        if (d === 0 && dt.getUTCMonth() !== lastMonth && dt.getUTCDate() <= 7) {
          lastMonth = dt.getUTCMonth();
          months += `<text x="${left + w * (cell + gap)}" y="11">${dt.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}</text>`;
        }
      }
    }
    const days = ['Mon', 'Wed', 'Fri'].map((n, i) => `<text x="0" y="${topPad + (1 + i * 2) * (cell + gap) + 10}">${n}</text>`).join('');
    const W = left + weeks * (cell + gap), H = topPad + 7 * (cell + gap);
    return `<div class="cal-wrap"><svg class="cal" id="calSvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily card spend over the last 12 months">${months}${days}${rects}</svg></div>
      <div class="cal-legend">Less ${[0, 1, 2, 3, 4, 5].map(l => `<i style="background:${l ? `var(--q${l})` : 'var(--surface-2)'}"></i>`).join('')} More</div>`;
  }
  function wireCalendar() {
    const svg = document.getElementById('calSvg');
    if (!svg) return;
    svg.addEventListener('pointermove', e => {
      const r = e.target.closest('rect');
      if (!r) { hideTip(); return; }
      const v = +r.dataset.v;
      showTip(`<div class="t">${dateLabel(r.dataset.d)}</div><div class="r"><i style="background:var(--q4)"></i><b>${inr(v)}</b><span>${v ? 'spent' : 'no purchases'}</span></div>`, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', hideTip);
  }

  /* ---------- insight generation ---------- */
  function insights(A) {
    const out = [];
    const add = (sev, html) => out.push({ sev, html });
    const B = A.behaviour;
    const interest = A.feeGroups.find(g => g.name === 'Interest & finance charges');
    const late = A.feeGroups.find(g => g.name === 'Late payment fees');
    if (interest) add('critical', `<b>${inr(interest.total)} paid in interest</b>, about ${inr(interest.annual)} a year at this rate. Banks only charge interest when a bill isn't paid in full, so paying the total due every month takes this to zero.`);
    if (late) add('critical', `<b>${late.count} late payment fee${late.count > 1 ? 's' : ''}, ${inr(late.total)} in total.</b> An auto-debit for the full amount on each card stops this from happening again and keeps your credit score safe.`);
    if (A.cashAdv.length) add('critical', `<b>${A.cashAdv.length} cash withdrawal${A.cashAdv.length > 1 ? 's' : ''} on a credit card, ${inr(A.cashAdv.reduce((s, t) => s + t.amount, 0))}.</b> Cash from a credit card is charged interest from the same day, plus a fee.`);
    const shortfalls = A.cardStats.flatMap(c => c.shortfalls.map(s => ({ ...s, card: c.card })));
    if (shortfalls.length) add('serious', `<b>${shortfalls.length} statement${shortfalls.length > 1 ? 's were' : ' was'} not paid in full</b> before the next one. The details are on the Cards tab. If you paid it some other way the statements don't show, you can ignore this.`);
    const otherFees = A.feeGroups.filter(g => !['Interest & finance charges', 'Late payment fees'].includes(g.name));
    const otherFeeTotal = otherFees.reduce((s, g) => s + g.total, 0);
    if (otherFeeTotal > 0) add('serious', `<b>${inr(otherFeeTotal)} in other card charges:</b> ${otherFees.map(g => `${g.name.toLowerCase().replace('gst', 'GST')} ${inr(g.total)}`).join(', ')}. Most banks drop the annual fee if you ask, or once you spend above a set amount in the year.`);
    const subs = A.recurring.filter(r => r.active);
    if (subs.length) add('warning', `<b>${subs.length} recurring payment${subs.length > 1 ? 's' : ''}, about ${inr(subs.reduce((s, r) => s + r.monthly, 0))} a month</b> (${inr(subs.reduce((s, r) => s + r.annual, 0))} a year). The biggest are ${subs.slice(0, 4).map(r => esc(r.name)).join(', ')}. The full list is on the Fees & subscriptions tab.`);
    if (A.duplicates.length) add('warning', `<b>${A.duplicates.length} possible duplicate charge${A.duplicates.length > 1 ? 's' : ''}</b> with the same merchant and amount on the same day. Worth checking against your receipts.`);
    if (A.missedSwiggy && A.missedSwiggy.total > 0) add('warning', `<b>${inr(A.missedSwiggy.total)} of Swiggy orders went on other cards.</b> The Swiggy card gives its best cashback on Swiggy itself. At 10% that's about ${inr(A.missedSwiggy.total * 0.1)} you could have got back.`);
    if (B.foodShare > 0.15) add('info', `<b>Food delivery is ${pct(B.foodShare)} of card spend</b>, ${inr(B.foodDelivery / A.nMonths)} and about ${B.foodOrdersPerMonth.toFixed(0)} orders a month. Ordering a quarter less would save about ${inr(B.foodDelivery / A.nMonths * 0.25)} a month.`);
    if (B.slopePct > 0.02 && A.nMonths >= 6) add('warning', `<b>Spending is going up about ${pct(B.slopePct, 1)} a month.</b> The last 3 months averaged ${inr(B.last3)}, against ${inr(B.first3)} in the first 3.`);
    if (B.smallPerMonth > 15) add('info', `<b>${B.smallPerMonth.toFixed(0)} purchases under ₹${A.smallLimit} a month</b>, ${inr(A.small.reduce((s, t) => s + t.amount, 0) / A.nMonths)} a month in total.`);
    const util = A.cardStats.filter(c => c.maxUtil != null && c.maxUtil > 0.3);
    if (util.length) add('warning', `<b>Balance went above 30% of the limit</b> on ${util.map(c => `${esc(c.card)} (up to ${pct(c.maxUtil)})`).join(', ')}. Keeping it lower on statement day helps your credit score.`);
    if (!interest && !late && !shortfalls.length) add('good', `<b>No interest or late fees</b> in this period. Every bill looks paid in full.`);
    return out;
  }

  const badge = sev => `<span class="badge ${sev}" title="${sev}">${Icon({ critical: 'alert', serious: 'alert', warning: 'warn', info: 'info', good: 'check' }[sev])}</span>`;

  /* ---------- views ---------- */
  function viewOverview(A) {
    const el = $('#tab-overview');
    const cards = A.cards;
    const ins = insights(A);
    const totals = A.monthly.map(r => r.total);
    const avg3 = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const last3 = avg3(totals.slice(-3)), prev3 = avg3(totals.slice(-6, -3));
    const ess = A.essential, dis = A.discretionary, essDis = ess + dis || 1;
    const topCats = A.categories.slice(0, 8);
    const topMerch = A.merchants.slice(0, 6);
    el.innerHTML = `
      <div class="grid g4">
        ${kpi('Total card spend', inr(A.totalSpend), `${A.nMonths} months · ${A.txnCount} purchases`, { hero: true, spark: totals })}
        ${kpi('Average per month', inr(A.avgMonthly), `Last 3 months ${inr(last3)} a month`, { delta: prev3 ? (last3 - prev3) / prev3 : null, deltaLabel: 'vs the 3 before', upIsGood: false })}
        ${kpi('Fees, interest & taxes', inr(A.totalFees), A.totalFees ? `${inr(A.totalFees * 12 / A.nMonths)} a year at this rate` : 'No avoidable charges found', { spark: A.monthly.map(r => r.fees) })}
        ${kpi('Refunds & cashback', inr(A.totalRefunds + A.totalCashback), `Cashback ${inr(A.totalCashback)} · refunds ${inr(A.totalRefunds)}`, { spark: A.monthly.map(r => r.refunds) })}
      </div>
      <div class="grid g21">
        <div class="card">
          <div class="head"><h2>Monthly spend by card</h2>${cards.length > 1 ? legendHtml(cards.map(c => [c, cardColor(c)])) : ''}</div>
          <div class="chart-box tall"><canvas id="cMonthly"></canvas></div>
          <p class="note">Purchases only. Bill payments, refunds and fees are left out.</p>
        </div>
        <div class="card">
          <div class="head"><h2>Where the money goes</h2><span class="sub">${A.paretoCats} categor${A.paretoCats === 1 ? 'y makes' : 'ies make'} up 80%</span></div>
          ${barList(topCats.map(c => ({ name: c.name, value: c.total, note: pct(c.share) })))}
        </div>
      </div>
      <div class="grid g21">
        <div class="card">
          <div class="head"><h2>What stands out</h2><span class="sub">From the statements selected above</span></div>
          <ul class="insights">${ins.map(i => `<li>${badge(i.sev)}<div>${i.html}</div></li>`).join('')}</ul>
        </div>
        <div>
          <div class="card">
            <div class="head"><h2>Needs and wants</h2><span class="sub">${inr(A.totalPayments)} paid towards card bills</span></div>
            <div class="seg" role="img" aria-label="Essential ${pct(ess / essDis)}, discretionary ${pct(dis / essDis)}">
              ${ess ? `<i style="flex:${ess};background:${seriesColor(0)}">${ess / essDis > 0.12 ? pct(ess / essDis) : ''}</i>` : ''}
              ${dis ? `<i style="flex:${dis};background:${seriesColor(1)}">${dis / essDis > 0.12 ? pct(dis / essDis) : ''}</i>` : ''}
            </div>
            ${legendHtml([[`Essential, ${inr(ess / A.nMonths)} a month`, seriesColor(0)], [`Discretionary, ${inr(dis / A.nMonths)} a month`, seriesColor(1)]])}
          </div>
          <div class="card">
            <div class="head"><h2>Top merchants</h2><span class="sub">${A.merchantsA} of ${A.merchants.length} take 80% of spend</span></div>
            ${barList(topMerch.map(m => ({ name: m.name, value: m.total })), seriesColor(2))}
          </div>
        </div>
      </div>`;
    chart('cMonthly', {
      type: 'bar',
      _footer: pts => 'Total ' + inr(pts.reduce((s, p) => s + p.parsed.y, 0)),
      data: { labels: A.months.map(monthLabel), datasets: stacked(cards.map(c => barDs(c, A.monthly.map(r => r.byCard[c] || 0), cardColor(c)))) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => inrC(v) } } } },
    });
  }

  function viewSpending(A, F) {
    const el = $('#tab-spending');
    const maxShare = Math.max(...A.categories.map(c => c.share), 0.0001);
    const spendTx = F.txns.filter(isSpend);
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Daily spending</h2><span class="sub">The last 12 months in the selection. Darker days cost more.</span></div>
        ${calendar(spendTx)}
      </div>
      <div class="card">
        <div class="head"><h2>Category breakdown</h2><span class="small muted">Change the type to move a category between essential and discretionary. Change compares the second half of the period with the first half.</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Category</th><th>Type</th><th class="r">Total</th><th class="r">Per month</th><th>Share</th><th class="r">Txns</th><th class="r">Avg ticket</th><th class="r">Change</th></tr></thead>
          <tbody>${A.categories.map(c => `<tr><td>${esc(c.name)}</td><td><select class="nature" data-cat="${esc(c.name)}" title="Saved in the database">${['essential', 'discretionary'].map(n => `<option ${n === c.nature ? 'selected' : ''}>${n}</option>`).join('')}</select></td><td class="r">${inr(c.total)}</td><td class="r">${inr(c.monthlyAvg)}</td>
            <td class="bar-cell"><div><i class="bar" style="width:${(c.share / maxShare * 70).toFixed(1)}%"></i><span>${pct(c.share, 1)}</span></div></td>
            <td class="r">${c.count}</td><td class="r">${inr(c.avgTicket)}</td><td class="r ${c.change > 0.15 ? 'bad' : c.change < -0.15 ? 'ok' : ''}">${c.change == null ? '—' : (c.change > 0 ? '▲ ' : '▼ ') + pct(Math.abs(c.change))}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="head"><h2>Monthly trend of the top categories</h2>${legendHtml(A.categories.slice(0, 6).map((c, i) => [c.name, seriesColor(i)]), 'line')}</div>
        <div class="chart-box"><canvas id="cCatTrend"></canvas></div>
      </div>
      <div class="grid g2">
        <div class="card"><div class="head"><h2>Spend per day, by weekday</h2><span class="small muted">Weekend ${inr(A.weekendPerDay)}/day vs weekday ${inr(A.weekdayPerDay)}/day</span></div><div class="chart-box short"><canvas id="cDow"></canvas></div></div>
        <div class="card"><div class="head"><h2>Spend by day of month</h2><span class="small muted">Look for spikes just after payday</span></div><div class="chart-box short"><canvas id="cDom"></canvas></div></div>
      </div>
      ${A.timedCount ? `<div class="card"><div class="head"><h2>Spend by hour of day</h2><span class="small muted">${A.timedCount} transactions have a timestamp · ${pct(A.behaviour.lateNightShare)} between 11pm and 5am</span></div><div class="chart-box short"><canvas id="cHour"></canvas></div></div>` : ''}`;
    chart('cCatTrend', {
      type: 'line',
      data: { labels: A.months.map(monthLabel), datasets: A.categories.slice(0, 6).map((c, i) => lineDs(c.name, c.byMonth, seriesColor(i))) },
      options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } },
    });
    chart('cDow', { type: 'bar', data: { labels: A.dow.map(d => d.name), datasets: [barDs('Avg spend per day', A.dow.map(d => d.perDay), seriesColor(0))] }, options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } } });
    chart('cDom', { type: 'bar', data: { labels: A.dom.map(d => d.day), datasets: [barDs('Total spend', A.dom.map(d => d.total), seriesColor(0), { maxBarThickness: 14 })] }, options: { scales: { x: { ticks: { maxRotation: 0, autoSkipPadding: 6 } }, y: { ticks: { callback: v => inrC(v) } } } } });
    wireCalendar();
    el.querySelectorAll('select.nature').forEach(sel => sel.onchange = () => {
      const cat = sel.dataset.cat, def = (Categoriser.CATEGORIES[cat] || {}).nature;
      state.settings.natures = Object.assign({}, state.settings.natures);
      if (sel.value === def) delete state.settings.natures[cat]; else state.settings.natures[cat] = sel.value;
      saveSettings();
      render();
    });
    if (A.timedCount) chart('cHour', { type: 'bar', _fmt: v => v + ' txns', data: { labels: A.hours.map(h => String(h.hour).padStart(2, '0')), datasets: [barDs('Transactions', A.hours.map(h => h.count), seriesColor(0), { maxBarThickness: 18 })] }, options: { scales: { x: {}, y: {} } } });
  }

  const AUTO = 'Automatic';
  function catButton(merchant, category) {
    const edited = !!state.overrides[merchant];
    return `<button class="catbtn${edited ? ' edited' : ''}" data-merchant="${esc(merchant)}" data-cat="${esc(category)}" title="${edited ? 'Set by you. Click to change.' : 'Click to change the category for this merchant'}">${esc(category)}${edited ? ' ✎' : ''}</button>`;
  }
  function wireCatButtons(root) {
    const cats = Object.keys(Categoriser.CATEGORIES);
    root.addEventListener('click', e => {
      const b = e.target.closest('.catbtn');
      if (!b) return;
      const sel = document.createElement('select');
      sel.style.maxWidth = '200px';
      const merchant = b.dataset.merchant, cur = state.overrides[merchant] || b.dataset.cat;
      for (const c of [AUTO, ...cats]) {
        const o = document.createElement('option');
        o.value = c; o.textContent = c === AUTO ? 'Automatic (from the rules)' : c;
        o.selected = state.overrides[merchant] ? c === cur : c === AUTO;
        sel.appendChild(o);
      }
      b.replaceWith(sel);
      sel.focus();
      sel.onchange = () => {
        if (sel.value === AUTO) delete state.overrides[merchant]; else state.overrides[merchant] = sel.value;
        saveOverrides();
        render();
      };
      sel.onblur = () => { if (sel.isConnected) sel.replaceWith(b); };
    });
  }

  function wireMerchantEdit(root, F) {
    const byId = new Map(F.txns.map(t => [t.id, t]));
    root.addEventListener('click', e => {
      const b = e.target.closest('.mbtn');
      if (!b) return;
      const t = byId.get(b.dataset.id);
      if (!t) return;
      const all = allTxns();
      const sameOrig = all.filter(x => x.origMerchant === t.origMerchant).length;
      const names = [...new Set(all.map(x => x.merchant))].sort((x, y) => x.localeCompare(y));
      const S = state.settings;
      const aliasActive = (S.merchantAliases || {})[t.origMerchant];
      const cell = b.parentElement;
      cell.innerHTML = `<form class="medit">
          <input type="text" list="merchList" value="${esc(t.merchant)}" required aria-label="Merchant name">
          <datalist id="merchList">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          <label class="small ink2"><input type="checkbox" ${t.renamed !== 'one' ? 'checked' : ''}> All ${sameOrig} transaction${sameOrig > 1 ? 's' : ''} from ${esc(t.origMerchant)}</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn primary" type="submit">Save</button>
            <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
            ${t.renamed || aliasActive ? `<button class="btn ghost" type="button" data-act="reset">Use ${esc(t.origMerchant)}</button>` : ''}
          </div>
        </form>`;
      const form = cell.querySelector('form'), input = form.querySelector('input[type=text]'), allBox = form.querySelector('input[type=checkbox]');
      input.focus(); input.select();
      const commit = name => {
        S.merchantAliases = Object.assign({}, S.merchantAliases);
        S.txnMerchants = Object.assign({}, S.txnMerchants);
        const orig = t.origMerchant;
        if (allBox.checked) {
          if (name === orig) delete S.merchantAliases[orig]; else S.merchantAliases[orig] = name;
          for (const x of all) if (x.origMerchant === orig) delete S.txnMerchants[x.id];
        } else if (name === orig && !S.merchantAliases[orig]) delete S.txnMerchants[t.id];
        else S.txnMerchants[t.id] = name;
        saveSettings();
        render();
      };
      form.onsubmit = ev => { ev.preventDefault(); const name = input.value.trim().replace(/\s+/g, ' '); if (name) commit(name); };
      form.querySelector('[data-act=cancel]').onclick = () => render();
      const reset = form.querySelector('[data-act=reset]');
      if (reset) reset.onclick = () => commit(t.origMerchant);
    });
  }

  let merchQuery = '';
  function viewMerchants(A) {
    const el = $('#tab-merchants');
    const colorOf = Object.fromEntries(cardOrder().map(c => [c, cardColor(c)]));
    el.innerHTML = `
      <div class="grid g3">
        ${kpi('Unique merchants', A.merchants.length, `${A.merchantsA} "A" merchants make up 80% of spend`)}
        ${kpi('Top 5 merchants', pct(A.behaviour.top5Share), 'share of total spend')}
        ${kpi('Paid with more than one card', A.multiCardMerchants.length, 'Merchants you split across cards')}
      </div>
      <div class="card">
        <div class="head"><h2>Merchants</h2>
          <input type="search" id="mq" placeholder="Search merchants" value="${esc(merchQuery)}" style="min-width:220px">
        </div>
        <p class="small muted" style="margin:-4px 0 10px">Click a category to change it. The change applies to every transaction from that merchant, including future statements, and is saved in the database. Class A is the top 80% of spend, B the next 15%, C the rest.</p>
        <div class="table-wrap" style="max-height:640px"><table>
          <thead><tr><th>#</th><th>Merchant</th><th>Class</th><th>Category</th><th class="r">Total</th><th class="r">Share</th><th class="r">Txns</th><th class="r">Avg</th><th class="r">Months</th><th>Cards</th></tr></thead>
          <tbody>${A.merchants.map((m, i) => `<tr data-name="${esc(m.name.toLowerCase())}"><td class="muted">${i + 1}</td><td>${esc(m.name)}</td><td><span class="tag ${m.abc}">${m.abc}</span></td><td>${catButton(m.name, m.category)}</td><td class="r">${inr(m.total)}</td><td class="r">${pct(m.share, 1)}</td><td class="r">${m.count}</td><td class="r">${inr(m.avg)}</td><td class="r">${m.months}</td><td>${m.cards.map(c => `<i class="swatch" title="${esc(c)}" style="background:${colorOf[c]}"></i>`).join(' ')}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="note">Merchant names are cleaned up, so every SWIGGY* variant counts as Swiggy, with Instamart kept separate.</p>
      </div>`;
    wireCatButtons(el.querySelector('tbody'));
    const filterRows = () => { const q = merchQuery.toLowerCase(); el.querySelectorAll('tbody tr').forEach(r => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; }); };
    $('#mq').oninput = e => { merchQuery = e.target.value; filterRows(); };
    filterRows();
  }


  function viewCards(A) {
    const el = $('#tab-cards');
    const rows = A.cardStats;
    const utilColor = u => u == null ? 'var(--axis)' : u > 0.5 ? 'var(--critical)' : u > 0.3 ? 'var(--warning)' : 'var(--good-mark)';
    el.innerHTML = `
      <div class="grid ${rows.length >= 4 ? 'g4' : rows.length === 3 ? 'g3' : 'g2'}">
        ${rows.map(c => `<div class="card cardtile" style="--c:${cardColor(c.card)}">
          <div class="nm">${esc(c.card)}</div>
          <div class="small muted">${c.statements} statements · ${pct(c.share)} of spend</div>
          <dl>
            <dt>Spent</dt><dd>${inr(c.spend)}</dd>
            <dt>Cashback and points</dt><dd>${inr(c.cashback + c.points * c.pointValue)}</dd>
            <dt>Fees and interest</dt><dd class="${c.otherFees + c.late + c.interest ? 'bad' : ''}">${inr(c.otherFees + c.late + c.interest)}</dd>
            <dt>Net benefit</dt><dd class="${c.netBenefit >= 0 ? 'ok' : 'bad'}">${inr(c.netBenefit)}</dd>
            <dt>Latest bill</dt><dd>${inr(c.latest?.totalDue)}<div class="small muted" style="font-weight:400">${c.latest?.dueDate ? 'due ' + dateLabel(c.latest.dueDate) : ''}</div></dd>
          </dl>
          <div class="small ink2" style="margin-top:12px;display:flex;justify-content:space-between"><span>Peak use of limit</span><span>${c.maxUtil == null ? 'limit not found' : pct(c.maxUtil)}</span></div>
          <div class="meter"><i style="width:${c.maxUtil == null ? 0 : Math.min(100, c.maxUtil * 100).toFixed(1)}%;background:${utilColor(c.maxUtil)}"></i></div>
        </div>`).join('')}
      </div>
      <div class="card">
        <div class="head"><h2>Card comparison</h2><span class="small muted">Net benefit = cashback + points × point value − fees − interest</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Card</th><th class="r">Spend</th><th class="r">Share</th><th class="r">Txns</th><th class="r">Avg ticket</th><th class="r">Cashback</th><th class="r">Points</th><th class="r">₹/point</th><th class="r">Fees</th><th class="r">Interest</th><th class="r">Net benefit</th><th class="r">Effective return</th></tr></thead>
          <tbody>${rows.map(c => `<tr><td><i class="swatch" style="background:${cardColor(c.card)}"></i> ${esc(c.card)}<div class="small muted">${c.statements} statements · top: ${c.topCategories.map(t => esc(t.name)).join(', ')}</div></td>
            <td class="r">${inr(c.spend)}</td><td class="r">${pct(c.share)}</td><td class="r">${c.count}</td><td class="r">${inr(c.avgTicket)}</td><td class="r">${inr(c.cashback)}</td>
            <td class="r">${c.points ? c.points.toLocaleString('en-IN') : '—'}</td><td class="r"><input type="number" step="0.05" min="0" style="width:70px" data-pv="${esc(c.card)}" value="${c.pointValue}"></td>
            <td class="r">${inr(c.otherFees + c.late)}</td><td class="r ${c.interest ? 'bad' : ''}">${inr(c.interest)}</td><td class="r ${c.netBenefit >= 0 ? 'ok' : 'bad'}">${inr(c.netBenefit)}</td><td class="r">${pct(c.effectiveReturn, 2)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="note">Points are counted only where the statement prints them as "+N" next to a transaction. Cashback is counted from credits labelled cashback/reward. Set ₹/point to what you actually get when you redeem.</p>
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Credit utilization per statement</h2>${rows.length > 1 ? legendHtml(rows.map(c => [c.card, cardColor(c.card)]), 'line') : ''}</div>
          <div class="chart-box short"><canvas id="cUtil"></canvas></div>
          <p class="note">Statement total due ÷ credit limit, as read from each statement. Below 30% is healthy. Gaps mean a value could not be found in that PDF.</p>
        </div>
        <div class="card">
          <div class="head"><h2>Latest statement & upcoming dues</h2></div>
          <table><thead><tr><th>Card</th><th class="r">Total due</th><th class="r">Min due</th><th>Due date</th><th class="r">Limit</th><th class="r">Peak util.</th></tr></thead>
          <tbody>${rows.map(c => `<tr><td>${esc(c.card)}</td><td class="r">${inr(c.latest?.totalDue)}</td><td class="r">${inr(c.latest?.minDue)}</td><td>${dateLabel(c.latest?.dueDate)}</td><td class="r">${inr(c.latestLimit)}</td><td class="r">${pct(c.maxUtil)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Were bills paid in full?</h2><span class="small muted">The payment in the next statement compared with the total due of this one</span></div>
        ${rows.some(c => c.shortfalls.length) ? `<table><thead><tr><th>Card</th><th>Statement</th><th class="r">Total due</th><th class="r">Paid in next cycle</th><th class="r">Shortfall</th></tr></thead><tbody>
          ${rows.flatMap(c => c.shortfalls.map(s => `<tr><td>${esc(c.card)}</td><td>${dateLabel(s.statementDate)}</td><td class="r">${inr(s.due)}</td><td class="r">${inr(s.paid)}</td><td class="r bad">${inr(s.due - s.paid)}</td></tr>`)).join('')}</tbody></table>`
        : `<p class="ok">✓ Every statement with a readable total due was fully paid in the next cycle.</p>`}
      </div>
      <div class="card">
        <div class="head"><h2>Which card to use where</h2></div>
        <ul class="insights">
          ${A.missedSwiggy ? `<li>${badge('warning')}<div>${inr(A.missedSwiggy.total)} of Swiggy/Instamart spend (${A.missedSwiggy.count} txns) was paid with other cards. Send it through <b>${esc(A.missedSwiggy.card)}</b>.</div></li>` : ''}
          ${A.multiCardMerchants.slice(0, 8).map(m => `<li>${badge('info')}<div><b>${esc(m.name)}</b> (${inr(m.total)}) was paid with ${m.cards.length} cards: ${m.cards.map(esc).join(', ')}. Pick the card that earns the most for ${esc(m.category.toLowerCase())}.</div></li>`).join('')}
          ${!A.missedSwiggy && !A.multiCardMerchants.length ? `<li>${badge('good')}<div>Each merchant is mostly paid with a single card.</div></li>` : ''}
        </ul>
      </div>`;
    el.querySelectorAll('input[data-pv]').forEach(inp => inp.onchange = () => { state.settings.pointValue[inp.dataset.pv] = parseFloat(inp.value) || 0; saveSettings(); render(); });
    const labels = [...new Set(rows.flatMap(c => c.util.map(u => u.statementDate)).filter(Boolean))].sort();
    chart('cUtil', {
      type: 'line', _fmt: v => pct(v),
      data: { labels: labels.map(d => dateLabel(d)), datasets: rows.map(c => lineDs(c.card, labels.map(d => { const u = c.util.find(x => x.statementDate === d); return u && u.ratio != null ? u.ratio : null; }), cardColor(c.card), { pointRadius: 3, pointBorderColor: css('--surface'), pointBorderWidth: 1.5, spanGaps: true })) },
      options: { scales: { x: {}, y: { min: 0, ticks: { callback: v => { const p = Math.round(v * 1000) / 10; return (Number.isInteger(p) ? p : p.toFixed(1)) + '%'; } } } } },
    });
  }

  function viewLeakage(A) {
    const el = $('#tab-leakage');
    const subsAnnual = A.recurring.filter(r => r.active).reduce((s, r) => s + r.annual, 0);
    const forexTotal = A.forexSpend.reduce((s, t) => s + t.amount, 0);
    const leak = [
      ['Interest & finance charges', 'Avoidable', A.feeGroups.find(g => g.name === 'Interest & finance charges')],
      ['Late payment fees', 'Avoidable', A.feeGroups.find(g => g.name === 'Late payment fees')],
      ['Card fees', 'Worth a look', A.feeGroups.find(g => g.name === 'Card fees')],
      ['Taxes (GST)', 'Tax on fees', A.feeGroups.find(g => g.name === 'Taxes (GST)')],
      ['Forex markup', 'Worth a look', A.feeGroups.find(g => g.name === 'Forex markup')],
      ['Fuel surcharge', 'Worth a look', A.feeGroups.find(g => g.name === 'Fuel surcharge')],
    ];
    el.innerHTML = `
      <div class="grid g4">
        ${kpi('Avoidable charges paid', inr(A.totalFees), `${inr(A.totalFees * 12 / A.nMonths)} a year at this rate`)}
        ${kpi('Active recurring payments', inr(subsAnnual), 'per year (estimated)')}
        ${kpi('EMI payments', inr(A.emi.reduce((s, t) => s + t.amount, 0)), `${A.emi.length} instalments in this period`)}
        ${kpi('Foreign-currency spend', inr(forexTotal), `${A.forexSpend.length} txns · a markup of about 3.5% is common`)}
      </div>
      <div class="card">
        <div class="head"><h2>Fees and charges</h2></div>
        <table><thead><tr><th>Charge</th><th></th><th class="r">Occurrences</th><th class="r">Paid</th><th class="r">Per year</th></tr></thead>
        <tbody>${leak.map(([n, p, g]) => `<tr><td>${n}</td><td><span class="tag">${p}</span></td><td class="r">${g ? g.count : 0}</td><td class="r ${g ? 'bad' : 'ok'}">${g ? inr(g.total) : '₹0'}</td><td class="r">${g ? inr(g.annual) : '—'}</td></tr>`).join('')}
          <tr><td>Recurring / subscriptions</td><td><span class="tag">Worth a look</span></td><td class="r">${A.recurring.filter(r => r.active).length}</td><td class="r">—</td><td class="r">${inr(subsAnnual)}</td></tr>
          ${A.feeGroups.find(g => g.name === 'Forex markup') ? '' : `<tr><td>Forex markup (estimated at 3.5%)</td><td><span class="tag">Worth a look</span></td><td class="r">${A.forexSpend.length}</td><td class="r">${inr(forexTotal * 0.035)}</td><td class="r">${inr(forexTotal * 0.035 * 12 / A.nMonths)}</td></tr>`}
        </tbody></table>
        ${A.feeGroups.length ? `<details style="margin-top:12px"><summary class="small">Show every fee line (${A.feeGroups.reduce((s, g) => s + g.count, 0)})</summary>${txnTable(A.feeGroups.flatMap(g => g.items))}</details>` : ''}
      </div>
      <div class="card">
        <div class="head"><h2>Recurring payments & subscriptions</h2><span class="small muted">Same merchant, a similar amount, in 3+ months</span></div>
        ${A.recurring.length ? `<div class="table-wrap"><table><thead><tr><th>Merchant</th><th>Category</th><th class="r">Monthly</th><th class="r">Annual</th><th class="r">Months seen</th><th>Last charged</th><th>Status</th></tr></thead>
        <tbody>${A.recurring.map(r => `<tr><td>${esc(r.name)}${r.priceChanged ? ' <span class="tag" title="Amount changed over time">price changed</span>' : ''}</td><td class="ink2">${esc(r.category)}</td><td class="r">${inr(r.monthly)}</td><td class="r">${inr(r.annual)}</td><td class="r">${r.months}/${A.nMonths}</td><td>${dateLabel(r.last)}</td><td>${r.active ? '<span class="tag A">active</span>' : '<span class="tag">stopped</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No recurring patterns detected.</p>'}
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Possible duplicate charges</h2></div>
          ${A.duplicates.length ? `<table><thead><tr><th>Merchant</th><th class="r">Amount</th><th>Dates</th><th>Card</th></tr></thead><tbody>${A.duplicates.map(([a, b]) => `<tr><td>${esc(a.merchant)}</td><td class="r">${inr(a.amount)}</td><td>${dateLabel(a.date)} / ${dateLabel(b.date)}</td><td class="small">${esc(a.card)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">✓ None found.</p>'}
        </div>
        <div class="card">
          <div class="head"><h2>Unusual transactions</h2><span class="small muted">Much bigger than usual for their category</span></div>
          ${A.anomalies.length ? `<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Why</th></tr></thead><tbody>${A.anomalies.map(a => `<tr><td>${dateLabel(a.txn.date)}</td><td>${esc(a.txn.merchant)}</td><td class="r">${inr(a.txn.amount)}</td><td class="small ink2">${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ok">✓ Nothing unusual.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Checklist</h2></div>
        <table><tbody>
          ${riskRow('Revolving balance (interest charged)', !A.feeGroups.find(g => g.name === 'Interest & finance charges'), 'Interest seen. A balance was carried over.')}
          ${riskRow('On-time payments (no late fees)', !A.feeGroups.find(g => g.name === 'Late payment fees'), 'Late fees found')}
          ${riskRow('Payments cover the full statement balance', !A.cardStats.some(c => c.shortfalls.length), 'Partial payments detected')}
          ${riskRow('No cash withdrawals on credit card', !A.cashAdv.length, `${A.cashAdv.length} cash advances`)}
          ${riskRow('Utilization below 30%', !A.cardStats.some(c => c.maxUtil > 0.3), 'One or more cards above 30% at some point')}
          ${riskRow('No EMI build-up', A.emi.length < 3, `${A.emi.length} EMI instalments. Some future income is already committed.`)}
          ${riskRow('Spending stable or falling', A.behaviour.slopePct <= 0.02, `Trending up ${pct(A.behaviour.slopePct, 1)}/month`)}
        </tbody></table>
      </div>`;
  }
  const riskRow = (label, ok, bad) => `<tr><td>${label}</td><td>${ok ? '<span class="ok">✓ OK</span>' : `<span class="bad">! ${esc(bad)}</span>`}</td></tr>`;

  function txnTable(list) {
    return `<div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Date</th><th>Description</th><th>Card</th><th class="r">Amount</th></tr></thead><tbody>${list.sort((a, b) => a.date.localeCompare(b.date)).map(t => `<tr><td>${dateLabel(t.date)}</td><td class="small">${esc(t.description)}</td><td class="small">${esc(t.card)}</td><td class="r">${inr(t.amount)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function viewBehaviour(A) {
    const el = $('#tab-behaviour');
    const B = A.behaviour;
    const rows = [
      ['Food delivery', pct(B.foodShare), `${inr(B.foodDelivery / A.nMonths)}/month · ${B.foodOrdersPerMonth.toFixed(1)} orders/month`, B.foodShare > 0.15 ? 'High' : B.foodShare > 0.07 ? 'Moderate' : 'Low'],
      ['Delivery and cabs', pct(B.convenienceShare), 'Food delivery, quick commerce and cabs, as a share of spend', B.convenienceShare > 0.3 ? 'High' : B.convenienceShare > 0.15 ? 'Moderate' : 'Low'],
      ['Wants vs needs', pct(B.discretionaryShare), 'Share of spend on things you could cut back', B.discretionaryShare > 0.6 ? 'High' : B.discretionaryShare > 0.4 ? 'Moderate' : 'Low'],
      ['Small purchases', `${B.smallPerMonth.toFixed(1)}/mo`, `${pct(B.smallShareCount)} of purchases are under ₹${A.smallLimit}`, B.smallPerMonth > 20 ? 'High' : B.smallPerMonth > 8 ? 'Moderate' : 'Low'],
      ['Weekend spending', B.weekendRatio == null ? '—' : B.weekendRatio.toFixed(2) + '×', 'Weekend spend per day ÷ weekday spend per day', B.weekendRatio > 1.4 ? 'High' : B.weekendRatio > 1.1 ? 'Moderate' : 'Low'],
      ['Late-night purchases', B.lateNightShare == null ? '—' : pct(B.lateNightShare), B.lateNightShare == null ? 'Your statements have no timestamps' : 'Between 11pm and 5am', B.lateNightShare == null ? '—' : B.lateNightShare > 0.15 ? 'High' : B.lateNightShare > 0.07 ? 'Moderate' : 'Low'],
      ['Month to month swings', B.cv.toFixed(2), 'How much monthly spend varies (lower is steadier)', B.cv > 0.5 ? 'Volatile' : B.cv > 0.25 ? 'Moderate' : 'Steady'],
      ['Spending trend', (B.slopePct >= 0 ? '+' : '') + pct(B.slopePct, 1) + '/mo', `Average of the last 3 months ${inr(B.last3)} vs the first 3 months ${inr(B.first3)}`, B.slopePct > 0.02 ? 'Rising' : B.slopePct < -0.02 ? 'Falling' : 'Flat'],
      ['Top 5 merchants', pct(B.top5Share), 'Share of spend at your 5 biggest merchants', B.top5Share > 0.5 ? 'Concentrated' : 'Spread out'],
    ];
    const rising = A.categories.filter(c => c.change != null && c.change > 0.2 && c.h2 - c.h1 > 1000).sort((a, b) => (b.h2 - b.h1) - (a.h2 - a.h1));
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Spending habits</h2><span class="small muted">Worked out from your transactions</span></div>
        <table><thead><tr><th></th><th class="r">Value</th><th>What it means</th><th>Level</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="ink2 small">${r[2]}</td><td><span class="tag">${r[3]}</span></td></tr>`).join('')}</tbody></table>
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Categories growing fastest</h2><span class="small muted">Second half vs first half of the period</span></div>
          ${rising.length ? `<table><thead><tr><th>Category</th><th class="r">Before</th><th class="r">After</th><th class="r">Change</th></tr></thead><tbody>${rising.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${inr(c.h1)}</td><td class="r">${inr(c.h2)}</td><td class="r bad">▲ ${pct(c.change)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">✓ No category grew more than 20%.</p>'}
        </div>
        <div class="card">
          <div class="head"><h2>Unusual months</h2><span class="small muted">Months where a category was more than double its usual amount</span></div>
          ${A.spikes.length ? `<table><thead><tr><th>Month</th><th>Category</th><th class="r">Spent</th><th class="r">Typical</th></tr></thead><tbody>${A.spikes.slice(0, 15).map(s => `<tr><td>${monthLabel(s.month)}</td><td>${esc(s.category)}</td><td class="r">${inr(s.amount)}</td><td class="r muted">${inr(s.typical)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">✓ No spikes.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Essential vs discretionary, by month</h2>${legendHtml([['Essential', seriesColor(0)], ['Discretionary', seriesColor(1)]])}</div>
        <div class="chart-box short"><canvas id="cNature"></canvas></div>
      </div>`;
    const ess = A.months.map((m, i) => A.categories.filter(c => c.nature === 'essential').reduce((s, c) => s + c.byMonth[i], 0));
    const dis = A.months.map((m, i) => A.categories.filter(c => c.nature === 'discretionary').reduce((s, c) => s + c.byMonth[i], 0));
    chart('cNature', { type: 'bar', data: { labels: A.months.map(monthLabel), datasets: stacked([barDs('Essential', ess, seriesColor(0)), barDs('Discretionary', dis, seriesColor(1))]) }, options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => inrC(v) } } } } });
  }

  function viewSavings(A) {
    const el = $('#tab-savings');
    const S = state.settings;
    const disc = A.categories.filter(c => c.nature === 'discretionary' && c.monthlyAvg >= 100);
    const defaults = { 'Food delivery': 30, 'Dining out': 20, 'Shopping': 25, 'Entertainment & OTT': 30, 'Software & digital': 20, 'Travel': 10 };
    const cutOf = c => S.cuts[c.name] != null ? S.cuts[c.name] : (defaults[c.name] != null ? defaults[c.name] : 15);
    const feesMonthly = A.totalFees / A.nMonths;
    const compute = () => {
      const fromCats = disc.reduce((s, c) => s + c.monthlyAvg * cutOf(c) / 100, 0);
      const monthly = fromCats + (S.dropFees !== false ? feesMonthly : 0);
      return { fromCats, monthly };
    };
    el.innerHTML = `
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Cut back on</h2><span class="small muted">Drag to set how much less you'd spend in each category</span></div>
          <div id="sliders">${disc.map(c => `<div class="slider-row"><span>${esc(c.name)}<div class="small muted">${inr(c.monthlyAvg)}/mo</div></span><input type="range" min="0" max="100" step="5" value="${cutOf(c)}" data-cut="${esc(c.name)}"><span class="num" data-cutlbl="${esc(c.name)}">${cutOf(c)}%</span><span class="num r" data-cutamt="${esc(c.name)}">${inr(c.monthlyAvg * cutOf(c) / 100)}</span></div>`).join('')}</div>
          <label class="chip" style="margin-top:10px"><input type="checkbox" id="dropFees" ${S.dropFees !== false ? 'checked' : ''}> Stop paying fees and interest (${inr(feesMonthly)}/mo)</label>
          <div class="grid g3" style="margin-top:14px">
            <label class="small ink2">Monthly take-home income (optional)<br><input type="number" id="income" min="0" step="1000" value="${S.income || ''}" placeholder="e.g. 120000" style="width:100%"></label>
            <label class="small ink2">Expected annual return %<br><input type="number" id="rate" min="0" max="30" step="0.5" value="${S.rate}" style="width:100%"></label>
            <label class="small ink2">Years invested<br><input type="number" id="years" min="1" max="40" step="1" value="${S.years}" style="width:100%"></label>
          </div>
        </div>
        <div class="card" id="savingsOut"></div>
      </div>
      <div class="card">
        <div class="head"><h2>If you invested the savings</h2>${legendHtml([['Value if invested', seriesColor(0)], ['Amount invested', seriesColor(1)]], 'line')}</div>
        <div class="chart-box short"><canvas id="cFV"></canvas></div>
        <p class="note">Assumes the monthly saving is invested at the start of each month and grows at the chosen annual rate, compounded monthly. Taxes and costs are left out, and real returns go up and down, so treat this as a rough guide.</p>
      </div>
      <div class="card">
        <div class="head"><h2>A 12 month plan</h2></div>
        <ol class="ink2" style="margin:0;padding-left:20px;display:grid;gap:6px">${roadmap(A).map(x => `<li>${x}</li>`).join('')}</ol>
      </div>`;
    const update = () => {
      const { monthly } = compute();
      const fv = futureValue(monthly, (S.rate || 0) / 100, S.years || 10);
      const income = S.income || 0;
      $('#savingsOut').innerHTML = `
        <div class="head"><h2>What you'd save</h2></div>
        <div class="grid g2">
          <div class="kpi"><div class="label">Monthly saving</div><div class="value">${inr(monthly)}</div><div class="sub">${inr(monthly * 12)} per year</div></div>
          <div class="kpi"><div class="label">Value after ${S.years} years</div><div class="value">${inrC(fv.value)}</div><div class="sub">invested ${inrC(fv.invested)} · growth ${inrC(fv.value - fv.invested)}</div></div>
        </div>
        ${income ? `<table style="margin-top:12px"><tbody>
          <tr><td>Card spend as a share of income</td><td class="r ${A.avgMonthly / income > 0.5 ? 'bad' : ''}">${pct(A.avgMonthly / income)}</td></tr>
          <tr><td>Savings rate from these changes alone</td><td class="r ok">${pct(monthly / income, 1)}</td></tr>
          <tr><td>Income left after card spend</td><td class="r">${inr(income - A.avgMonthly)}/mo</td></tr></tbody></table>
          <p class="note">This covers card spend only. Rent, EMIs and investments paid from your bank account aren't included.</p>` : '<p class="note">Add your monthly income to see spend-to-income ratios.</p>'}`;
      chart('cFV', { type: 'line', data: { labels: fv.series.map(p => 'Yr ' + p.year), datasets: [
        lineDs('Value if invested', fv.series.map(p => p.value), seriesColor(0), { fill: 'origin', backgroundColor: seriesColor(0) + '1a', pointRadius: ctx => ctx.dataIndex === fv.series.length - 1 ? 4 : 0, pointBackgroundColor: seriesColor(0), pointBorderColor: css('--surface'), pointBorderWidth: 2 }),
        lineDs('Amount invested', fv.series.map(p => p.invested), seriesColor(1), { borderDash: [5, 4] })] },
        options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } } });
    };
    el.querySelectorAll('input[data-cut]').forEach(r => r.oninput = () => {
      S.cuts[r.dataset.cut] = +r.value; saveSettings();
      const c = disc.find(x => x.name === r.dataset.cut);
      el.querySelector(`[data-cutlbl="${CSS.escape(r.dataset.cut)}"]`).textContent = r.value + '%';
      el.querySelector(`[data-cutamt="${CSS.escape(r.dataset.cut)}"]`).textContent = inr(c.monthlyAvg * r.value / 100);
      update();
    });
    $('#dropFees').onchange = e => { S.dropFees = e.target.checked; saveSettings(); update(); };
    [['income', 'income'], ['rate', 'rate'], ['years', 'years']].forEach(([id, k]) => $('#' + id).oninput = e => { S[k] = parseFloat(e.target.value) || 0; saveSettings(); update(); });
    update();
  }

  function roadmap(A) {
    const r = [];
    const interest = A.feeGroups.find(g => g.name === 'Interest & finance charges');
    if (interest || A.cardStats.some(c => c.shortfalls.length)) r.push('<b>Month 1:</b> Stop the interest. Pay every card in full. If you can\'t, clear the card that charges interest first and set auto-debit for the full amount.');
    r.push('<b>Month 1:</b> Set up auto-pay for the total amount due on all ' + A.cards.length + ' cards so a late fee can\'t happen.');
    if (A.recurring.some(r => r.active)) r.push(`<b>Month 1–2:</b> Go through the ${A.recurring.filter(x => x.active).length} recurring charges. Cancel what you don't use and switch the rest to annual plans where that's cheaper.`);
    if (A.missedSwiggy) r.push(`<b>Month 2:</b> Send all Swiggy/Instamart spend through ${esc(A.missedSwiggy.card)}.${A.upiCards.length ? ` Use ${esc(A.upiCards[0])} for UPI merchant payments so they earn rewards too.` : ''}`);
    const fees = A.feeGroups.find(g => g.name === 'Card fees');
    if (fees) r.push('<b>Month 2:</b> Call the banks and ask for annual/renewal-fee waivers, or check if you\'ve met the spend threshold for an automatic waiver.');
    const top = A.categories.filter(c => c.nature === 'discretionary')[0];
    if (top) r.push(`<b>Month 3:</b> Set a monthly cap for ${esc(top.name.toLowerCase())} (currently ${inr(top.monthlyAvg)}/mo). Try a 20% lower cap and check it against this dashboard every month.`);
    r.push('<b>Month 3:</b> Start a monthly SIP for the amount you\'re saving, dated the day after your salary comes in, so it\'s invested before it gets spent.');
    r.push('<b>Month 4–6:</b> Build an emergency fund of 6 months of expenses (about ' + inr(A.avgMonthly * 6) + ' based on card spend alone) so a surprise bill doesn\'t end up on a card you can\'t clear.');
    r.push('<b>Month 6:</b> Load new statements here and compare with this baseline: monthly spend, discretionary share, fees, and subscriptions.');
    r.push('<b>Month 9–12:</b> Review whether each card is worth keeping (Net benefit on the Cards tab). Close or downgrade any card that costs more than it returns. Raise your SIP with every income increase.');
    return r;
  }

  let txnQuery = '', txnCat = '', txnSort = 'date-desc', txnLimit = 300;
  function viewTransactions(F) {
    const el = $('#tab-transactions');
    const cats = Object.keys(Categoriser.CATEGORIES);
    const q = txnQuery.toLowerCase();
    let list = F.txns.filter(t => (!q || (t.description + ' ' + t.merchant).toLowerCase().includes(q)) && (!txnCat || t.category === txnCat));
    const [k, dir] = txnSort.split('-');
    list.sort((a, b) => (k === 'amount' ? a.amount - b.amount : a.date.localeCompare(b.date)) * (dir === 'desc' ? -1 : 1));
    const shown = list.slice(0, txnLimit);
    const colorOf = Object.fromEntries(cardOrder().map(c => [c, cardColor(c)]));
    const tot = list.reduce((s, t) => s + (t.type === 'debit' ? t.amount : -t.amount), 0);
    el.innerHTML = `
      <div class="card">
        <div class="head">
          <h2>All transactions</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input type="search" id="tq" placeholder="Search description or merchant" value="${esc(txnQuery)}" style="min-width:240px">
            <select id="tc"><option value="">All categories</option>${cats.map(c => `<option ${c === txnCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
            <select id="ts"><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest first</option><option value="amount-asc">Smallest first</option></select>
          </div>
        </div>
        <p class="small muted" style="margin-bottom:8px">${list.length} transactions · net ${inr(tot)}${list.length > shown.length ? ` · showing ${shown.length}` : ''}. Click a merchant to rename it or move the transaction to another merchant. Categories are changed on the Merchants tab.</p>
        <div class="table-wrap" style="max-height:640px"><table>
          <thead><tr><th>Date</th><th>Description</th><th>Merchant</th><th>Category</th><th>Card</th><th class="r">Amount</th></tr></thead>
          <tbody>${shown.map(t => `<tr><td class="num">${dateLabel(t.date)}${t.time ? `<div class="small muted">${t.time}</div>` : ''}</td><td class="small">${esc(t.description)}</td><td><button class="mbtn${t.renamed ? ' edited' : ''}" data-id="${esc(t.id)}" title="${t.renamed ? `Changed from ${esc(t.origMerchant)}. Click to edit.` : 'Click to change the merchant'}">${esc(t.merchant)}${t.renamed ? ' ✎' : ''}</button></td>
            <td><span class="tag">${esc(t.category)}</span></td>
            <td><i class="swatch" style="background:${colorOf[t.card]}" title="${esc(t.card)}"></i></td>
            <td class="r ${t.type === 'credit' ? 'ok' : ''}">${t.type === 'credit' ? '+' : ''}${fmtINR(t.amount, { decimals: true })}</td></tr>`).join('')}</tbody>
        </table></div>
        ${list.length > shown.length ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="txMore">Show ${Math.min(500, list.length - shown.length)} more</button></div>` : ''}
      </div>`;
    $('#ts').value = txnSort;
    wireMerchantEdit(el.querySelector('tbody'), F);
    if ($('#txMore')) $('#txMore').onclick = () => { txnLimit += 500; viewTransactions(filtered()); };
    let deb; $('#tq').oninput = e => { clearTimeout(deb); deb = setTimeout(() => { txnQuery = e.target.value; txnLimit = 300; viewTransactions(filtered()); const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200); };
    $('#tc').onchange = e => { txnCat = e.target.value; viewTransactions(filtered()); };
    $('#ts').onchange = e => { txnSort = e.target.value; viewTransactions(filtered()); };

  }

  const KEEP_WORDS = new Set('date dates transaction transactions description details amount amounts total due minimum payment statement credit debit limit available cash balance opening closing previous purchases reward rewards points cr dr rs inr reference ref no merchant category domestic international emi interest finance charges charge fee fees gst igst cgst sgst tax card number name page of time pi upi'.split(' '));
  function anonymise(lines) {
    return lines.map(l => l.replace(/[A-Za-z]+/g, w => KEEP_WORDS.has(w.toLowerCase()) ? w : w.replace(/[a-z]/g, 'x').replace(/[A-Z]/g, 'X')).replace(/\d/g, '9')).join('\n');
  }

  const rawCache = new Map();
  async function rawOf(s) {
    if (!rawCache.has(s.id)) rawCache.set(s.id, await api('GET', `raw?id=${encodeURIComponent(s.id)}`));
    return rawCache.get(s.id);
  }

  function viewParser() {
    const el = $('#tab-parser');
    const sts = [...state.statements].sort((a, b) => a.card.localeCompare(b.card) || (a.meta.statementDate || '').localeCompare(b.meta.statementDate || ''));
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Parser check</h2><span class="small muted">Check that each statement was read completely</span></div>
        <p class="small ink2" style="margin-bottom:10px">Reconciliation: <i>opening balance + debits − credits</i> should equal the statement's <i>total due</i>. ✓ means every transaction was captured. ⚠ means some rows were missed or misread. Open the raw text to see which lines were picked up (highlighted). If a bank format isn't read correctly, use <b>Copy anonymised layout</b>. It swaps letters for x and digits for 9, so the structure can be shared to improve the parser without exposing your data.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Card</th><th>File</th><th>Statement</th><th class="r">Txns</th><th class="r">Debits</th><th class="r">Credits</th><th class="r">Opening</th><th class="r">Total due</th><th>Reconciles</th><th></th></tr></thead>
          <tbody>${sts.map((s, i) => {
            const deb = s.txns.filter(t => t.type === 'debit').reduce((a, t) => a + t.amount, 0);
            const cre = s.txns.filter(t => t.type === 'credit').reduce((a, t) => a + t.amount, 0);
            const m = s.meta; let rec = '—';
            if (m.totalDue != null && m.openingBalance != null) { const diff = m.openingBalance + deb - cre - m.totalDue; rec = Math.abs(diff) < 2 ? '<span class="ok">✓</span>' : `<span class="bad" title="Difference ${inr(diff)}">⚠ off by ${inr(diff)}</span>`; }
            return `<tr><td class="small">${esc(s.card)}</td><td class="small">${esc(s.fileName)}</td><td>${dateLabel(m.statementDate)}</td><td class="r ${s.txns.length ? '' : 'bad'}">${s.txns.length}</td><td class="r">${inr(deb)}</td><td class="r">${inr(cre)}</td><td class="r">${inr(m.openingBalance)}</td><td class="r">${inr(m.totalDue)}</td><td>${rec}</td>
              <td style="white-space:nowrap"><button class="btn" data-raw="${i}">${Icon('text')}Raw text</button> <button class="btn" data-anon="${i}">${Icon('copy')}Copy anonymised layout</button> <button class="btn ghost icon-only" data-del="${i}" title="Remove this statement" aria-label="Remove this statement">${Icon('x')}</button></td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
      <div class="card" id="rawBox" style="display:none"></div>`;
    el.querySelectorAll('[data-raw]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.raw];
      const box = $('#rawBox'); box.style.display = '';
      box.innerHTML = '<p class="muted">Loading…</p>';
      const raw = await rawOf(s);
      box.innerHTML = `<div class="head"><h3>${esc(s.fileName)}</h3><span class="small muted">${raw.rawLines.length} lines · highlighted = read as a transaction</span></div>
        ${raw.rawLines.length ? `<pre class="raw">${raw.rawLines.map((l, j) => `<span class="${raw.lineFlags[j] ? 'hit' : ''}">${esc(l) || ' '}</span>`).join('')}</pre>` : '<p class="muted">No raw text was saved for this statement. Delete it here and import it again to see it.</p>'}`;
      box.scrollIntoView({ behavior: 'smooth' });
    });
    el.querySelectorAll('[data-anon]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.anon];
      const raw = await rawOf(s);
      const txt = `# ${s.card} (${raw.rawLines.length} lines, ${s.txns.length} parsed)\n` + anonymise(raw.rawLines.map((l, j) => (raw.lineFlags[j] ? '[T] ' : '    ') + l));
      try { await navigator.clipboard.writeText(txt); b.textContent = 'Copied ✓'; } catch { const box = $('#rawBox'); box.style.display = ''; box.innerHTML = `<pre class="raw">${esc(txt)}</pre>`; }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.del];
      if (!confirm(`Delete ${s.fileName} from the database?${s.folderId ? '\nIt will show up as new on the next folder scan.' : ''}`)) return;
      try { await api('DELETE', `statements?id=${encodeURIComponent(s.id)}`); await reload(); state.pending = await api('GET', 'scan'); updateScanButton(); render(); } catch (e) { showError(e); }
    });
  }

  /* ---------- export ---------- */
  $('#exportCsv').addEventListener('click', () => {
    const F = filtered();
    const rows = [['date', 'time', 'card', 'description', 'merchant', 'category', 'nature', 'type', 'amount', 'reward_points']]
      .concat(F.txns.map(t => [t.date, t.time || '', t.card, t.description, t.merchant, t.category, t.nature, t.type, t.amount.toFixed(2), t.points || 0]));
    const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'card-transactions.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ---------- main render ---------- */
  function render() {
    const has = state.statements.length > 0;
    const tab = has ? state.tab : 'folders';
    $('#exportCsv').disabled = !has;
    renderTabs(has, tab);
    Object.keys(state.charts).forEach(k => { state.charts[k].destroy(); delete state.charts[k]; });
    if (tab === 'folders') {
      $('#filters').innerHTML = '';
      $('#intro').style.display = has || state.folders.length ? 'none' : '';
      if (!has) $('#subtitle').textContent = 'Runs locally. Statements are decrypted in this browser only.';
      viewFolders();
      return;
    }
    $('#intro').style.display = 'none';
    const F = filtered();
    renderFilters(F.all);
    const nSt = state.statements.length, nC = cardOrder().length;
    $('#subtitle').textContent = `${nSt} statements · ${nC} card${nC > 1 ? 's' : ''} · ${F.all.length} transactions · processed locally`;
    const aKey = memo.fKey + '|' + JSON.stringify([state.settings.pointValue, state.settings.smallLimit]);
    if (memo.aKey !== aKey) { memo.A = analyse(F.txns, F.statements, { pointValue: state.settings.pointValue, smallLimit: state.settings.smallLimit }); memo.aKey = aKey; }
    const A = memo.A;
    if (A.empty && state.tab !== 'parser') {
      document.querySelectorAll('section.tab.active').forEach(s => s.innerHTML = '<div class="card"><p>No transactions in the selected filters. If statements are loaded but show 0 transactions, open <b>Parser check</b>.</p></div>');
      return;
    }
    const views = { overview: () => viewOverview(A), spending: () => viewSpending(A, F), merchants: () => viewMerchants(A), cards: () => viewCards(A), leakage: () => viewLeakage(A), behaviour: () => viewBehaviour(A), savings: () => viewSavings(A), transactions: () => viewTransactions(F), parser: viewParser };
    (views[state.tab] || views.overview)();
  }

  /* ---------- start-up ---------- */
  async function migrateBrowserCache() {
    // Earlier versions kept data in this browser's localStorage. Move it into the database once.
    const old = store.get('statements', null);
    if (!old || !old.length) return;
    const have = new Set(state.statements.map(s => s.id));
    for (const st of old) if (!have.has(st.id)) await api('POST', 'statements', Object.assign({}, st, { folderId: null, relPath: null }));
    const ov = store.get('overrides', null), se = store.get('settings', null);
    if (ov && !Object.keys(state.overrides).length) await api('PUT', 'kv?key=overrides', ov);
    if (se) await api('PUT', 'kv?key=settings', Object.assign(DEFAULT_SETTINGS(), se));
    ['statements', 'overrides', 'settings'].forEach(store.del);
    await reload();
    setProgress(`Moved ${old.length} statement(s) from browser storage into the database.`);
  }

  (async () => {
    try {
      await reload();
      await migrateBrowserCache().catch(showError);
      render();
      if (state.folders.length) await scan();
    } catch (e) {
      console.error(e);
      document.querySelector('main').innerHTML = `<div class="card" style="max-width:640px;margin:48px auto"><h2>Can't reach the local server</h2>
        <p class="ink2" style="margin-top:8px">Start the dashboard with <b>Start Dashboard.bat</b> (or <code>python app/serve.py</code>) and open <code>http://127.0.0.1:8765</code>. Opening <code>index.html</code> directly from disk won't work.</p>
        <p class="small muted" style="margin-top:8px">${esc(e.message)}</p></div>`;
    }
  })();
})();
