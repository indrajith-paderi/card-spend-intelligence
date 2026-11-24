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
  const dateLabel = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/ /g, ' ') : '—';

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
    // New statements waiting is the one moment Scan outranks Add PDFs.
    $('#scanBtn').classList.toggle('primary', n > 0);
    $('#scanBtn').classList.toggle('ghost', !n);
    $('#addPdfs').classList.toggle('primary', !n);
  }

  /* ---------- popovers (header menu, date range) ---------- */
  function setPop(btn, open) {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) return;
    btn.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }
  function closePops(except) {
    document.querySelectorAll('[aria-controls][aria-expanded="true"]').forEach(b => { if (b !== except) setPop(b, false); });
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[aria-controls][aria-expanded]');
    if (btn) { closePops(btn); setPop(btn, btn.getAttribute('aria-expanded') !== 'true'); return; }
    if (!e.target.closest('.pop')) closePops();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('[aria-controls][aria-expanded="true"]');
    if (open) { setPop(open, false); open.focus(); }
  });
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

  $('#clearData').addEventListener('click', () => { closePops(); $('#clearDialog').showModal(); });
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
    const first = months[0], last = months[months.length - 1];
    const presets = [['3', '3M', 'Last 3 months'], ['6', '6M', 'Last 6 months'], ['12', '12M', 'Last 12 months'], ['all', 'All', 'All time']];
    const fromOf = v => v === 'all' ? null : months[Math.max(0, months.length - +v)];
    const active = f.to ? null : !f.from ? 'all' : (presets.find(([v]) => v !== 'all' && fromOf(v) === f.from) || [])[0];
    const span = `${monthLabel(f.from || first)} – ${monthLabel(f.to || last)}`;
    const opt = (m, sel) => `<option value="${m}" ${sel === m ? 'selected' : ''}>${monthLabel(m)}</option>`;
    el.innerHTML = `
      <div class="chips">${cards.map(c => `<label class="chip" title="${esc(c)}"><input type="checkbox" data-card="${esc(c)}" ${!f.cards || f.cards.includes(c) ? 'checked' : ''}><span class="swatch" style="background:${cardColor(c)}"></span><span class="chip-name">${esc(shortCard(c))}</span></label>`).join('')}</div>
      <div class="range">
        <button type="button" class="btn range-btn" id="rangeBtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="rangePop">${Icon('calendar')}<span>${active ? `<b>${presets.find(p => p[0] === active)[2]}</b> · ` : ''}${span}</span>${Icon('chevron')}</button>
        <div class="pop range-pop" id="rangePop" role="dialog" aria-label="Date range" hidden>
          <div class="presets" role="group" aria-label="Quick ranges">${presets.map(([v, l, t]) => `<button type="button" data-preset="${v}" aria-pressed="${active === v}" title="${t}">${l}</button>`).join('')}</div>
          <div class="range-custom">
            <label>From<select id="fFrom">${months.map(m => opt(m, f.from || first)).join('')}</select></label>
            <label>To<select id="fTo">${months.map(m => opt(m, f.to || last)).join('')}</select></label>
          </div>
        </div>
      </div>`;
    el.querySelectorAll('input[data-card]').forEach(cb => cb.onchange = () => {
      const sel = [...el.querySelectorAll('input[data-card]:checked')].map(x => x.dataset.card);
      state.filter.cards = sel.length === cards.length ? null : sel; render();
    });
    el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      state.filter.from = fromOf(b.dataset.preset); state.filter.to = null;
      render(); $('#rangeBtn').focus();
    });
    const setRange = (which, v) => {
      state.filter[which] = v === (which === 'from' ? first : last) ? null : v;
      const a = state.filter.from || first, b = state.filter.to || last;
      if (a > b) { state.filter.from = b === first ? null : b; state.filter.to = a === last ? null : a; }
      render();
      setPop($('#rangeBtn'), true); // keep the picker open while adjusting a custom range
      $(which === 'from' ? '#fFrom' : '#fTo').focus();
    };
    $('#fFrom').onchange = e => setRange('from', e.target.value);
    $('#fTo').onchange = e => setRange('to', e.target.value);
  }

  // "CRED IndusInd Bank RuPay Credit Card" -> "CRED IndusInd". The full name stays in tooltips.
  const shortCard = name => name.replace(/\b(bank|rupay|master ?card|visa|amex|credit|debit|card)\b/gi, '').replace(/\s+/g, ' ').trim() || name;

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
  // Plain-text tooltips for [data-tip] (info icons) and [data-tip-trunc] (shown only when the text is cut off).
  const tipTarget = e => {
    const el = e.target.closest && e.target.closest('[data-tip],[data-tip-trunc]');
    if (!el) return null;
    if (el.hasAttribute('data-tip-trunc') && el.scrollWidth <= el.clientWidth) return null;
    return el;
  };
  const showTextTip = el => {
    const r = el.getBoundingClientRect();
    showTip(`<div class="tt">${esc(el.dataset.tip || el.dataset.tipTrunc)}</div>`, r.left, r.bottom - 6);
  };
  document.addEventListener('pointerover', e => { const el = tipTarget(e); if (el) showTextTip(el); });
  document.addEventListener('pointerout', e => { if (tipTarget(e)) hideTip(); });
  document.addEventListener('focusin', e => { const el = tipTarget(e); if (el) showTextTip(el); });
  document.addEventListener('focusout', e => { if (tipTarget(e)) hideTip(); });
  new ResizeObserver(([e]) => document.documentElement.style.setProperty('--hdr-h', e.target.offsetHeight + 'px')).observe($('header.top'));

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

  function legendHtml(items, kind) { return `<div class="legend">${items.map(([l, c, full]) => `<span${full && full !== l ? ` data-tip="${esc(full)}"` : ''}><i class="${kind === 'line' ? 'line' : 'swatch'}" style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`; }

  function spark(values) {
    const w = 240, h = 32, n = values.length;
    if (n < 2) return '';
    const max = Math.max(...values), min = Math.min(0, ...values);
    const x = i => (i / (n - 1)) * w, y = v => h - 2 - ((v - min) / (max - min || 1)) * (h - 6);
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w} ${h}L0 ${h}Z" fill="var(--bar)" opacity=".1"/><path d="${d}" fill="none" stroke="var(--bar)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function kpi(label, value, sub, o) {
    o = o || {};
    let d = '';
    if (o.delta != null && isFinite(o.delta)) {
      const up = o.delta > 0, flat = Math.abs(o.delta) < 0.005;
      const cls = flat ? '' : (up === !!o.upIsGood ? 'good' : 'bad');
      d = `<div class="delta-text ${cls}">${flat ? `About the same as ${o.deltaLabel}` : `${pct(Math.abs(o.delta), 1)} ${up ? 'higher' : 'lower'} than ${o.deltaLabel}`}</div>`;
    }
    return `<div class="card kpi${o.hero ? ' hero' : ''}"><div class="label">${label}</div><div class="value">${value}</div>${d}${o.spark ? spark(o.spark) : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  function barList(rows, color) {
    const max = Math.max(...rows.map(r => r.value), 1);
    return `<div class="bars">${rows.map(r => `<div class="b"><span class="n" data-tip-trunc="${esc(r.name)}">${esc(r.name)}</span><span class="v">${inr(r.value)}${r.note ? `<small>${r.note}</small>` : ''}</span><div class="track"><div class="fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color || color || 'var(--bar)'}"></div></div></div>`).join('')}</div>`;
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
    svg.parentElement.scrollLeft = svg.parentElement.scrollWidth; // narrow screens open on the latest weeks
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
    const add = (sev, html, link) => out.push({ sev, html, link });
    const B = A.behaviour;
    const interest = A.feeGroups.find(g => g.name === 'Interest & finance charges');
    const late = A.feeGroups.find(g => g.name === 'Late payment fees');
    if (interest) add('critical', `<b>${inr(interest.total)} paid in interest</b>, about ${inr(interest.annual)} a year at this rate. Banks only charge interest when a bill isn't paid in full, so paying the total due every month takes this to zero.`, ['View fees', { tab: 'leakage' }]);
    if (late) add('critical', `<b>${late.count} late payment fee${late.count > 1 ? 's' : ''}, ${inr(late.total)} in total.</b> An auto-debit for the full amount on each card stops this from happening again and keeps your credit score safe.`, ['View fees', { tab: 'leakage' }]);
    if (A.cashAdv.length) add('critical', `<b>${A.cashAdv.length} cash withdrawal${A.cashAdv.length > 1 ? 's' : ''} on a credit card, ${inr(A.cashAdv.reduce((s, t) => s + t.amount, 0))}.</b> Cash from a credit card is charged interest from the same day, plus a fee.`);
    const shortfalls = A.cardStats.flatMap(c => c.shortfalls.map(s => ({ ...s, card: c.card })));
    if (shortfalls.length) add('serious', `<b>${shortfalls.length} statement${shortfalls.length > 1 ? 's were' : ' was'} not paid in full</b> before the next one. If you paid it some other way the statements don't show, you can ignore this.`, ['View on Cards', { tab: 'cards' }]);
    const otherFees = A.feeGroups.filter(g => !['Interest & finance charges', 'Late payment fees'].includes(g.name));
    const otherFeeTotal = otherFees.reduce((s, g) => s + g.total, 0);
    if (otherFeeTotal > 0) add('serious', `<b>${inr(otherFeeTotal)} in other card charges:</b> ${otherFees.map(g => `${g.name.toLowerCase().replace('gst', 'GST')} ${inr(g.total)}`).join(', ')}. Most banks drop the annual fee if you ask, or once you spend above a set amount in the year.`, ['View fees', { tab: 'leakage' }]);
    const subs = A.recurring.filter(r => r.active);
    if (subs.length) add('warning', `<b>${subs.length} recurring payment${subs.length > 1 ? 's' : ''}, about ${inr(subs.reduce((s, r) => s + r.monthly, 0))} a month</b> (${inr(subs.reduce((s, r) => s + r.annual, 0))} a year). The biggest are ${subs.slice(0, 4).map(r => esc(r.name)).join(', ')}.`, ['View subscriptions', { tab: 'leakage' }]);
    if (A.duplicates.length) add('warning', `<b>${A.duplicates.length} possible duplicate charge${A.duplicates.length > 1 ? 's' : ''}</b> with the same merchant and amount on the same day. Worth checking against your receipts.`, ['View duplicates', { tab: 'leakage' }]);
    if (A.missedSwiggy && A.missedSwiggy.total > 0) add('warning', `<b>${inr(A.missedSwiggy.total)} of Swiggy orders went on other cards.</b> The Swiggy card gives its best cashback on Swiggy itself. At 10% that's about ${inr(A.missedSwiggy.total * 0.1)} you could have got back.`, ['See Swiggy orders', { tab: 'transactions', q: 'Swiggy' }]);
    if (B.foodShare > 0.15) add('info', `<b>Food delivery is ${pct(B.foodShare)} of card spend</b>, ${inr(B.foodDelivery / A.nMonths)} and about ${B.foodOrdersPerMonth.toFixed(0)} orders a month. Ordering a quarter less would save about ${inr(B.foodDelivery / A.nMonths * 0.25)} a month.`, ['See food delivery orders', { tab: 'transactions', cat: 'Food delivery' }]);
    if (B.slopePct > 0.02 && A.nMonths >= 6) add('warning', `<b>Spending is going up about ${pct(B.slopePct, 1)} a month.</b> The last 3 months averaged ${inr(B.last3)}, against ${inr(B.first3)} in the first 3.`, ['View on Spending', { tab: 'spending' }]);
    if (B.smallPerMonth > 15) add('info', `<b>${B.smallPerMonth.toFixed(0)} purchases under ₹${A.smallLimit} a month</b>, ${inr(A.small.reduce((s, t) => s + t.amount, 0) / A.nMonths)} a month in total.`);
    const util = A.cardStats.filter(c => c.maxUtil != null && c.maxUtil > 0.3);
    if (util.length) add('warning', `<b>Balance went above 30% of the limit</b> on ${util.map(c => `${esc(c.card)} (up to ${pct(c.maxUtil)})`).join(', ')}. Keeping it lower on statement day helps your credit score.`, ['View on Cards', { tab: 'cards' }]);
    if (!interest && !late && !shortfalls.length) add('good', `<b>No interest or late fees</b> in this period. Every bill looks paid in full.`);
    const rank = { critical: 0, serious: 1, warning: 2, info: 3, good: 4 };
    return out.map((x, i) => ({ ...x, i })).sort((a, b) => rank[a.sev] - rank[b.sev] || a.i - b.i);
  }

  const badge = sev => `<span class="badge ${sev}" title="${sev}">${Icon({ critical: 'alert', serious: 'alert', warning: 'warn', info: 'info', good: 'check' }[sev])}</span>`;

  /* ---------- views ---------- */
  const FEE_SHORT = { 'Interest & finance charges': 'Interest', 'Late payment fees': 'Late fees', 'Card fees': 'Fees', 'Taxes (GST)': 'GST', 'Forex markup': 'Forex', 'Fuel surcharge': 'Fuel surcharge' };
  const infoTip = text => `<button type="button" class="info-tip" data-tip="${esc(text)}" aria-label="${esc(text)}">${Icon('info')}</button>`;
  function goTo(go) {
    if (go.tab === 'transactions') { txnQuery = go.q || ''; txnCat = go.cat || ''; txnLimit = 300; }
    state.tab = go.tab; store.set('tab', state.tab);
    render(); window.scrollTo(0, 0);
  }

  function viewOverview(A) {
    const el = $('#tab-overview');
    const cards = A.cards;
    const ins = insights(A);
    const totals = A.monthly.map(r => r.total);
    const avg3 = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const last3 = avg3(totals.slice(-3)), prev3 = avg3(totals.slice(-6, -3));
    const ess = A.essential, dis = A.discretionary, essDis = ess + dis || 1;
    const topCats = A.categories.slice(0, 8);
    // Roughly match the height of the insights list beside it.
    const topMerch = A.merchants.slice(0, Math.max(4, Math.min(8, ins.length - 1)));
    const feeParts = A.feeGroups.slice(0, 3).map(g => `${FEE_SHORT[g.name] || g.name} ${inr(g.total)}`).join(' · ');
    const nw = [[ess, 'Essential', 'needs'], [dis, 'Discretionary', 'wants']].filter(([v]) => v > 0);
    el.innerHTML = `
      <div class="grid g4">
        ${kpi('Total card spend', inr(A.totalSpend), `${A.nMonths} months · ${A.txnCount} purchases`, { hero: true, spark: totals })}
        ${kpi('Average per month', inr(A.avgMonthly), `Last 3 months ${inr(last3)} a month`, { delta: prev3 ? (last3 - prev3) / prev3 : null, deltaLabel: 'previous 3 months', upIsGood: false })}
        ${kpi('Fees, interest & taxes', inr(A.totalFees), A.totalFees ? feeParts : 'No avoidable charges found', { spark: A.monthly.map(r => r.fees) })}
        ${kpi('Refunds & cashback', inr(A.totalRefunds + A.totalCashback), `Cashback ${inr(A.totalCashback)} · refunds ${inr(A.totalRefunds)}`, { spark: A.monthly.map(r => r.refunds) })}
      </div>
      <div class="grid g21">
        <div class="card">
          <div class="head"><h2>What stands out</h2><span class="sub">From the statements selected above</span></div>
          <ul class="insights">${ins.map(i => `<li>${badge(i.sev)}<div>${i.html}${i.link ? ` <button type="button" class="link-btn" data-go="${esc(JSON.stringify(i.link[1]))}">${i.link[0]}&nbsp;→</button>` : ''}</div></li>`).join('')}</ul>
        </div>
        <div class="stack">
          <div class="card">
            <div class="head"><h2>Needs and wants</h2><span class="sub">${inr(A.totalPayments)} paid towards card bills</span></div>
            <div class="nw" style="grid-template-columns:${nw.map(([v]) => `minmax(104px, ${(v / essDis).toFixed(3)}fr)`).join(' ')}" role="img" aria-label="${nw.map(([v, l]) => `${l} ${pct(v / essDis)}, ${inr(v / A.nMonths)} a month`).join('; ')}">
              ${nw.map(([v, , k]) => `<i class="nw-bar ${k}">${pct(v / essDis)}</i>`).join('')}
              ${nw.map(([v, l]) => `<div class="nw-label"><span>${l}</span><b>${inr(v / A.nMonths)}<small>/mo</small></b></div>`).join('')}
            </div>
          </div>
          <div class="card">
            <div class="head"><h2>Top merchants</h2><span class="sub">${A.merchantsA} of ${A.merchants.length} take 80% of spend</span></div>
            ${barList(topMerch.map(m => ({ name: m.name, value: m.total, note: pct(m.share) })))}
          </div>
        </div>
      </div>
      <div class="grid g21">
        <div class="card chart-card">
          <div class="head"><h2 class="with-info">Monthly spend by card${infoTip('Purchases only. Bill payments, refunds and fees are left out.')}</h2>${cards.length > 1 ? legendHtml(cards.map(c => [shortCard(c), cardColor(c), c])) : ''}</div>
          <div class="chart-box fill"><canvas id="cMonthly" role="img" aria-label="Monthly card spend, stacked by card"></canvas></div>
        </div>
        <div class="card">
          <div class="head"><h2>Where the money goes</h2><span class="sub">${A.paretoCats} categor${A.paretoCats === 1 ? 'y makes' : 'ies make'} up 80%</span></div>
          ${barList(topCats.map(c => ({ name: c.name, value: c.total, note: pct(c.share) })))}
        </div>
      </div>`;
    el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goTo(JSON.parse(b.dataset.go)));
    const labelAll = A.months.length <= 18 && innerWidth >= 720;
    chart('cMonthly', {
      type: 'bar',
      _footer: pts => 'Total ' + inr(pts.reduce((s, p) => s + p.parsed.y, 0)),
      data: { labels: A.months.map(monthLabel), datasets: stacked(cards.map(c => barDs(c, A.monthly.map(r => r.byCard[c] || 0), cardColor(c)))) },
      options: { scales: { x: { stacked: true, ticks: { autoSkip: !labelAll } }, y: { stacked: true, ticks: { callback: v => inrC(v) } } } },
    });
  }

  // A name that opens the Transactions tab filtered to it, keeping the card and date filters.
  const cellLink = (label, go, tip) => `<button type="button" class="cell-link" data-go="${esc(JSON.stringify(go))}" title="${esc(tip)}">${esc(label)}</button>`;
  const wireGo = root => root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goTo(JSON.parse(b.dataset.go)));
  // Neutral bars, with a darker neutral picking out the bars the caption talks about.
  const emphasis = (n, pick) => Array.from({ length: n }, (_, i) => pick(i) ? css('--ink-2') : css('--bar'));

  function viewSpending(A, F) {
    const el = $('#tab-spending');
    const maxShare = Math.max(...A.categories.map(c => c.share), 0.0001);
    const spendTx = F.txns.filter(isSpend);
    const trend = A.categories.slice(0, 6);
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Daily spending</h2><span class="sub">The last 12 months in the selection</span></div>
        ${calendar(spendTx)}
      </div>
      <div class="card">
        <div class="head"><h2 class="with-info">Category breakdown${infoTip('Change compares the second half of the selected period with the first half. Click a category to see its transactions.')}</h2><span class="sub">Change the type to move a category between essential and discretionary</span></div>
        <div class="table-wrap"><table class="cat-table">
          <thead><tr><th>Category</th><th>Type</th><th class="r">Total</th><th class="r">Per month</th><th>Share</th><th class="r">Txns</th><th class="r">Avg ticket</th><th class="r">Change</th></tr></thead>
          <tbody>${A.categories.map(c => `<tr><td>${cellLink(c.name, { tab: 'transactions', cat: c.name }, `See ${c.name} transactions`)}</td><td><select class="nature" data-cat="${esc(c.name)}" aria-label="Type of ${esc(c.name)}" title="Saved in the database">${['essential', 'discretionary'].map(n => `<option ${n === c.nature ? 'selected' : ''}>${n}</option>`).join('')}</select></td><td class="r">${inr(c.total)}</td><td class="r">${inr(c.monthlyAvg)}</td>
            <td class="bar-cell"><div><i class="bar" style="width:${(c.share / maxShare * 70).toFixed(1)}%"></i><span>${pct(c.share, 1)}</span></div></td>
            <td class="r">${c.count}</td><td class="r">${inr(c.avgTicket)}</td><td class="r ${c.change > 0.15 ? 'bad' : c.change < -0.15 ? 'ok' : ''}">${c.change == null ? '—' : (c.change > 0 ? '▲ ' : '▼ ') + pct(Math.abs(c.change))}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="head"><h2 class="with-info">Monthly trend of the top categories${infoTip('Each chart has its own scale, so compare shapes, not heights.')}</h2><span class="sub">Average per month on the right</span></div>
        <div class="multiples">${trend.map((c, i) => `<div class="mini">
          <div class="mini-head">${cellLink(c.name, { tab: 'transactions', cat: c.name }, `See ${c.name} transactions`)}<b>${inr(c.monthlyAvg)}</b></div>
          <div class="chart-box mini-chart"><canvas id="cTrend${i}" role="img" aria-label="${esc(c.name)} spend by month"></canvas></div>
        </div>`).join('')}</div>
      </div>
      <div class="grid g2">
        <div class="card"><div class="head"><h2>Spend per day, by weekday</h2><span class="sub">Weekend (highlighted) ${inr(A.weekendPerDay)}/day vs weekday ${inr(A.weekdayPerDay)}/day</span></div><div class="chart-box short"><canvas id="cDow"></canvas></div></div>
        <div class="card"><div class="head"><h2>Spend by day of month</h2><span class="sub">Look for spikes just after payday</span></div><div class="chart-box short"><canvas id="cDom"></canvas></div></div>
      </div>
      ${A.timedCount ? `<div class="card"><div class="head"><h2 class="with-info">Spend by hour of day${infoTip(`${A.timedCount} transactions have a timestamp. The rest are left out.`)}</h2><span class="sub">${pct(A.behaviour.lateNightShare)} of timed purchases between 11pm and 5am, highlighted</span></div><div class="chart-box short"><canvas id="cHour"></canvas></div></div>` : ''}`;
    wireGo(el);
    const bar = css('--bar'), moneyY = { ticks: { callback: v => inrC(v), maxTicksLimit: 4 } };
    trend.forEach((c, i) => chart('cTrend' + i, {
      type: 'line',
      data: { labels: A.months.map(monthLabel), datasets: [lineDs(c.name, c.byMonth, bar, { fill: 'origin', backgroundColor: bar + '1f', borderWidth: 1.75 })] },
      options: { scales: { x: { ticks: { maxTicksLimit: 4 } }, y: moneyY } },
    }));
    const weekend = d => d.name === 'Sat' || d.name === 'Sun';
    chart('cDow', { type: 'bar', data: { labels: A.dow.map(d => d.name), datasets: [barDs('Avg spend per day', A.dow.map(d => d.perDay), bar, { backgroundColor: emphasis(A.dow.length, i => weekend(A.dow[i])), _color: bar })] }, options: { scales: { x: {}, y: moneyY } } });
    chart('cDom', { type: 'bar', data: { labels: A.dom.map(d => d.day), datasets: [barDs('Total spend', A.dom.map(d => d.total), bar, { maxBarThickness: 14 })] }, options: { scales: { x: { ticks: { maxRotation: 0, autoSkipPadding: 6 } }, y: moneyY } } });
    wireCalendar();
    el.querySelectorAll('select.nature').forEach(sel => sel.onchange = () => {
      const cat = sel.dataset.cat, def = (Categoriser.CATEGORIES[cat] || {}).nature;
      state.settings.natures = Object.assign({}, state.settings.natures);
      if (sel.value === def) delete state.settings.natures[cat]; else state.settings.natures[cat] = sel.value;
      saveSettings();
      render();
    });
    const late = h => h >= 23 || h < 5;
    if (A.timedCount) chart('cHour', { type: 'bar', _fmt: v => v + ' txns', data: { labels: A.hours.map(h => String(h.hour).padStart(2, '0')), datasets: [barDs('Transactions', A.hours.map(h => h.count), bar, { maxBarThickness: 18, backgroundColor: emphasis(A.hours.length, i => late(A.hours[i].hour)) })] }, options: { scales: { x: {}, y: { ticks: { maxTicksLimit: 4 } } } } });
  }

  const AUTO = 'Automatic';
  function catButton(merchant, category) {
    const edited = !!state.overrides[merchant];
    return `<button class="catbtn${edited ? ' edited' : ''}" data-merchant="${esc(merchant)}" data-cat="${esc(category)}" title="${edited ? 'Set by you. Click to change.' : 'Click to change the category for this merchant'}">${esc(category)}${edited ? Icon('pencil') : ''}</button>`;
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
    const maxShare = Math.max(...A.merchants.map(m => m.share), 0.0001);
    el.innerHTML = `
      <div class="card">
        <div class="head">
          <h2 class="with-info">Merchants${infoTip('Class A merchants make up the top 80% of spend, B the next 15%, C the rest. Names are cleaned up, so every SWIGGY* variant counts as Swiggy, with Instamart kept separate.')}</h2>
          <input type="search" id="mq" placeholder="Search merchants" aria-label="Search merchants" value="${esc(merchQuery)}">
        </div>
        <p class="small muted m-help">Click a merchant to see its transactions. Click a category to change it for every transaction from that merchant, including future statements.</p>
        <div class="table-wrap m-wrap"><table class="m-table">
          <thead><tr><th class="m-rank">#</th><th>Merchant</th><th>Class</th><th>Category</th><th class="r">Total</th><th>Share</th><th class="r">Txns</th><th class="r m-avg">Avg</th><th class="r m-months">Months</th><th>Cards</th></tr></thead>
          <tbody>${A.merchants.map((m, i) => `<tr data-name="${esc(m.name.toLowerCase())}"><td class="muted m-rank">${i + 1}</td><td>${cellLink(m.name, { tab: 'transactions', q: m.name }, `See ${m.name} transactions`)}</td><td><span class="tag cls ${m.abc}">${m.abc}</span></td><td>${catButton(m.name, m.category)}</td><td class="r">${inr(m.total)}</td>
            <td class="bar-cell"><div><i class="bar" style="width:${(m.share / maxShare * 70).toFixed(1)}%"></i><span>${pct(m.share, 1)}</span></div></td>
            <td class="r">${m.count}</td><td class="r m-avg">${inr(m.avg)}</td><td class="r m-months">${m.months}</td><td class="m-cards">${m.cards.map(c => `<i class="swatch" role="img" aria-label="${esc(c)}" data-tip="${esc(c)}" style="background:${colorOf[c]}"></i>`).join('')}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="tx-empty" id="mEmpty" hidden><p id="mEmptyText"></p><button class="btn" id="mReset">Clear search</button></div>
      </div>`;
    wireCatButtons(el.querySelector('tbody'));
    wireGo(el);
    const filterRows = () => {
      const q = merchQuery.toLowerCase();
      let n = 0;
      el.querySelectorAll('tbody tr').forEach(r => { const on = !q || r.dataset.name.includes(q); r.style.display = on ? '' : 'none'; n += on; });
      el.querySelector('.m-wrap').hidden = !n;
      $('#mEmpty').hidden = !!n;
      $('#mEmptyText').textContent = `No merchant matches “${merchQuery}”.`;
    };
    $('#mq').oninput = e => { merchQuery = e.target.value; filterRows(); };
    $('#mReset').onclick = () => { merchQuery = ''; $('#mq').value = ''; filterRows(); $('#mq').focus(); };
    filterRows();
  }

  // Swatch + short card name; the full name shows on hover.
  const cardLabel = c => `<span class="card-label" data-tip="${esc(c)}"><i class="swatch" style="background:${cardColor(c)}"></i>${esc(shortCard(c))}</span>`;

  function viewCards(A) {
    const el = $('#tab-cards');
    const rows = A.cardStats;
    const utilColor = u => u == null ? 'var(--axis)' : u > 0.5 ? 'var(--critical)' : u > 0.3 ? 'var(--warning)' : 'var(--good-mark)';
    const rewards = c => c.cashback + c.points * c.pointValue;
    const anyPoints = rows.some(c => c.points);
    el.innerHTML = `
      <div class="grid ${rows.length >= 4 ? 'g4' : rows.length === 3 ? 'g3' : 'g2'}">
        ${rows.map(c => `<div class="card cardtile">
          <div class="nm" data-tip="${esc(c.card)}"><i class="swatch" style="background:${cardColor(c.card)}"></i>${esc(shortCard(c.card))}</div>
          <div class="small muted">${c.statements} statements · ${pct(c.share)} of spend</div>
          <div class="bill">
            <span class="label">Latest bill</span>
            <span class="value">${inr(c.latest?.totalDue)}</span>
            <span class="small muted">${c.latest?.dueDate ? 'Due ' + dateLabel(c.latest.dueDate) : 'Due date not found'}</span>
          </div>
          <dl>
            <dt>Minimum due</dt><dd>${inr(c.latest?.minDue)}</dd>
            <dt>Credit limit</dt><dd>${inr(c.latestLimit)}</dd>
            <dt data-tip="The payment in the next statement compared with the total due of this one">Bills paid in full</dt><dd>${c.shortfalls.length ? `<span class="bad" data-tip="${esc(c.shortfalls.map(s => `${dateLabel(s.statementDate)}: ${inr(s.due)} due, ${inr(s.paid)} paid`).join(' · '))}">${c.shortfalls.length} short by ${inr(c.shortfalls.reduce((a, s) => a + s.due - s.paid, 0))}</span>` : 'Yes'}</dd>
          </dl>
          <div class="small ink2 util-row"><span>Peak use of limit</span><span>${c.maxUtil == null ? 'limit not found' : pct(c.maxUtil)}</span></div>
          <div class="meter"><i style="width:${c.maxUtil == null ? 0 : Math.min(100, c.maxUtil * 100).toFixed(1)}%;background:${utilColor(c.maxUtil)}"></i></div>
        </div>`).join('')}
      </div>
      <div class="card">
        <div class="head"><h2 class="with-info">Card comparison${infoTip('Net benefit = cashback + points × point value − fees − interest. Points count only where the statement prints them as "+N" next to a transaction. Cashback counts credits labelled cashback or reward.')}</h2><span class="sub">Over the selected period</span></div>
        <div class="table-wrap"><table class="cmp">
          <thead><tr><th>Card</th><th class="r">Spend</th><th class="r">Share</th><th class="r">Avg purchase</th><th class="r">Rewards</th><th class="r">Fees & interest</th><th class="r">Net benefit</th><th class="r">Return</th></tr></thead>
          <tbody>${rows.map(c => `<tr><td>${cardLabel(c.card)}</td>
            <td class="r">${inr(c.spend)}</td><td class="r">${pct(c.share)}</td><td class="r">${inr(c.avgTicket)}</td>
            <td class="r">${inr(rewards(c))}${c.points ? `<div class="small muted">${c.points.toLocaleString('en-IN')} points</div>` : ''}</td>
            <td class="r ${c.otherFees + c.late + c.interest ? 'bad' : ''}">${inr(c.otherFees + c.late + c.interest)}</td>
            <td class="r ${c.netBenefit >= 0 ? 'ok' : 'bad'}">${inr(c.netBenefit)}</td><td class="r">${pct(c.effectiveReturn, 2)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${anyPoints ? `<div class="pv-row"><span class="small ink2">Value of one point when you redeem</span>${rows.filter(c => c.points).map(c => `<label class="pv">${cardLabel(c.card)}<span class="pv-input">₹<input type="number" step="0.05" min="0" data-pv="${esc(c.card)}" value="${c.pointValue}" aria-label="Rupees per point for ${esc(c.card)}"></span></label>`).join('')}</div>` : ''}
      </div>
      <div class="card chart-card">
          <div class="head"><h2 class="with-info">Credit use per statement${infoTip('Statement total due ÷ credit limit, as read from each statement. Gaps mean a value could not be found in that PDF.')}</h2>${rows.length > 1 ? legendHtml(rows.map(c => [shortCard(c.card), cardColor(c.card), c.card]), 'line') : ''}</div>
          <div class="chart-box"><canvas id="cUtil" role="img" aria-label="Credit use per statement, by card"></canvas></div>
          <p class="note">Below 30% of the limit is healthy for your credit score.</p>
        </div>
      <div class="card">
        <div class="head"><h2>Which card to use where</h2></div>
        <ul class="insights">
          ${A.missedSwiggy ? `<li>${badge('warning')}<div>${inr(A.missedSwiggy.total)} of Swiggy and Instamart spend (${A.missedSwiggy.count} purchases) went on other cards. Use <b data-tip="${esc(A.missedSwiggy.card)}">${esc(shortCard(A.missedSwiggy.card))}</b> for these. <button type="button" class="link-btn" data-go="${esc(JSON.stringify({ tab: 'transactions', q: 'Swiggy' }))}">See Swiggy orders&nbsp;→</button></div></li>` : ''}
          ${A.multiCardMerchants.slice(0, 8).map(m => `<li>${badge('info')}<div><b>${esc(m.name)}</b> (${inr(m.total)}) was paid with ${m.cards.length} cards: ${m.cards.map(c => esc(shortCard(c))).join(', ')}. Pick the card that earns the most for ${esc(m.category.toLowerCase())}.</div></li>`).join('')}
          ${!A.missedSwiggy && !A.multiCardMerchants.length ? `<li>${badge('good')}<div>Each merchant is mostly paid with a single card.</div></li>` : ''}
        </ul>
      </div>`;
    wireGo(el);
    el.querySelectorAll('input[data-pv]').forEach(inp => inp.onchange = () => { state.settings.pointValue[inp.dataset.pv] = parseFloat(inp.value) || 0; saveSettings(); render(); });
    const labels = [...new Set(rows.flatMap(c => c.util.map(u => u.statementDate)).filter(Boolean))].sort();
    chart('cUtil', {
      type: 'line', _fmt: v => pct(v),
      data: { labels: labels.map(d => dateLabel(d)), datasets: rows.map(c => lineDs(c.card, labels.map(d => { const u = c.util.find(x => x.statementDate === d); return u && u.ratio != null ? u.ratio : null; }), cardColor(c.card), { pointRadius: 3, pointBorderColor: css('--surface'), pointBorderWidth: 1.5, spanGaps: true })) },
      options: { scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { min: 0, ticks: { maxTicksLimit: 5, callback: v => { const p = Math.round(v * 1000) / 10; return (Number.isInteger(p) ? p : p.toFixed(1)) + '%'; } } } } },
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
        <table><thead><tr><th>Charge</th><th>Type</th><th class="r">Occurrences</th><th class="r">Paid</th><th class="r">Per year</th></tr></thead>
        <tbody>${leak.map(([n, p, g]) => `<tr><td>${n}</td><td><span class="tag${p === 'Avoidable' ? ' bad' : ''}">${p}</span></td><td class="r">${g ? g.count : 0}</td><td class="r ${g ? 'bad' : 'ok'}">${g ? inr(g.total) : '₹0'}</td><td class="r">${g ? inr(g.annual) : '—'}</td></tr>`).join('')}
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
          ${A.duplicates.length ? `<table><thead><tr><th>Merchant</th><th class="r">Amount</th><th>Dates</th><th>Card</th></tr></thead><tbody>${A.duplicates.map(([a, b]) => `<tr><td>${esc(a.merchant)}</td><td class="r">${inr(a.amount)}</td><td>${dateLabel(a.date)} / ${dateLabel(b.date)}</td><td class="small">${esc(a.card)}</td></tr>`).join('')}</tbody></table>` : `<p>${okMark('None found.')}</p>`}
        </div>
        <div class="card">
          <div class="head"><h2>Unusual transactions</h2><span class="small muted">Much bigger than usual for their category</span></div>
          ${A.anomalies.length ? `<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Why</th></tr></thead><tbody>${A.anomalies.map(a => `<tr><td>${dateLabel(a.txn.date)}</td><td>${esc(a.txn.merchant)}</td><td class="r">${inr(a.txn.amount)}</td><td class="small ink2">${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>` : `<p>${okMark('Nothing unusual.')}</p>`}
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
  const okMark = text => `<span class="ok mark">${Icon('tick')}${text}</span>`;
  const badMark = text => `<span class="bad mark">${Icon('alert')}${text}</span>`;
  const riskRow = (label, ok, bad) => `<tr><td>${label}</td><td>${ok ? okMark('OK') : badMark(esc(bad))}</td></tr>`;

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
        <table><thead><tr><th>Measure</th><th class="r">Value</th><th>What it means</th><th>Level</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="ink2 small">${r[2]}</td><td><span class="tag${/^(High|Rising|Volatile|Concentrated)$/.test(r[3]) ? ' warn' : ''}">${r[3]}</span></td></tr>`).join('')}</tbody></table>
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Categories growing fastest</h2><span class="small muted">Second half vs first half of the period</span></div>
          ${rising.length ? `<table><thead><tr><th>Category</th><th class="r">Before</th><th class="r">After</th><th class="r">Change</th></tr></thead><tbody>${rising.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${inr(c.h1)}</td><td class="r">${inr(c.h2)}</td><td class="r bad">▲ ${pct(c.change)}</td></tr>`).join('')}</tbody></table>` : `<p>${okMark('No category grew more than 20%.')}</p>`}
        </div>
        <div class="card">
          <div class="head"><h2>Unusual months</h2><span class="small muted">Months where a category was more than double its usual amount</span></div>
          ${A.spikes.length ? `<table><thead><tr><th>Month</th><th>Category</th><th class="r">Spent</th><th class="r">Typical</th></tr></thead><tbody>${A.spikes.slice(0, 15).map(s => `<tr><td>${monthLabel(s.month)}</td><td>${esc(s.category)}</td><td class="r">${inr(s.amount)}</td><td class="r muted">${inr(s.typical)}</td></tr>`).join('')}</tbody></table>` : `<p>${okMark('No spikes.')}</p>`}
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
    const tot = list.reduce((s, t) => s + (t.type === 'debit' ? t.amount : -t.amount), 0);
    const narrowed = !!(txnQuery || txnCat);
    const multi = cardOrder().length > 1;
    const rows = shown.map(t => `<tr>
            <td class="tx-date num">${dateLabel(t.date)}${t.time ? `<span class="small muted">${t.time}</span>` : ''}</td>
            <td class="tx-merch"><button class="mbtn${t.renamed ? ' edited' : ''}" data-id="${esc(t.id)}" title="${t.renamed ? `Changed from ${esc(t.origMerchant)}. Click to edit.` : 'Click to change the merchant'}">${esc(t.merchant)}${t.renamed ? Icon('pencil') : ''}</button>
              <span class="tx-sub small muted" data-tip-trunc="${esc(t.description)}">${esc(t.description)}</span>
              <span class="tx-meta"><span class="tag">${esc(t.category)}</span>${multi ? cardLabel(t.card) : ''}</span></td>
            <td class="tx-cat"><span class="tag">${esc(t.category)}</span></td>
            ${multi ? `<td class="tx-card small ink2">${cardLabel(t.card)}</td>` : ''}
            <td class="r tx-amt${t.type === 'credit' ? ' ok' : ''}">${t.type === 'credit' ? '+' : ''}${fmtINR(t.amount, { decimals: true })}</td></tr>`).join('');
    el.innerHTML = `
      <div class="card">
        <div class="head">
          <h2 class="with-info">Transactions${infoTip('Click a merchant to rename it or move the transaction to another merchant. Categories are changed on the Merchants tab.')}</h2>
          <div class="tx-controls">
            <input type="search" id="tq" placeholder="Search description or merchant" aria-label="Search description or merchant" value="${esc(txnQuery)}">
            <select id="tc" aria-label="Category"><option value="">All categories</option>${cats.map(c => `<option ${c === txnCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
            <select id="ts" aria-label="Sort order"><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest first</option><option value="amount-asc">Smallest first</option></select>
          </div>
        </div>
        <p class="tx-summary small" aria-live="polite"><b>${list.length} transaction${list.length === 1 ? '' : 's'}</b> · net ${inr(tot)}${list.length > shown.length ? ` · showing the first ${shown.length}` : ''}</p>
        ${list.length ? `<div class="table-wrap tx-wrap"><table class="tx-table">
          <thead><tr><th>Date</th><th>Merchant</th><th class="tx-cat">Category</th>${multi ? '<th class="tx-card">Card</th>' : ''}<th class="r">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : `<div class="tx-empty"><p>No transactions match${txnQuery ? ` “${esc(txnQuery)}”` : ''}${txnCat ? ` in ${esc(txnCat)}` : ''}.</p>${narrowed ? '<button class="btn" id="txReset">Clear search and category</button>' : ''}</div>`}
        ${list.length > shown.length ? `<div class="tx-more"><button class="btn" id="txMore">Show ${Math.min(500, list.length - shown.length)} more</button></div>` : ''}
      </div>`;
    $('#ts').value = txnSort;
    if (list.length) wireMerchantEdit(el.querySelector('tbody'), F);
    if ($('#txMore')) $('#txMore').onclick = () => { txnLimit += 500; viewTransactions(filtered()); };
    if ($('#txReset')) $('#txReset').onclick = () => { txnQuery = ''; txnCat = ''; txnLimit = 300; viewTransactions(filtered()); $('#tq').focus(); };
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

  let parserProblemsOnly = false;
  function viewParser() {
    const el = $('#tab-parser');
    const sts = [...state.statements].sort((a, b) => a.card.localeCompare(b.card) || (a.meta.statementDate || '').localeCompare(b.meta.statementDate || ''));
    const info = sts.map(s => {
      const deb = s.txns.filter(t => t.type === 'debit').reduce((a, t) => a + t.amount, 0);
      const cre = s.txns.filter(t => t.type === 'credit').reduce((a, t) => a + t.amount, 0);
      const m = s.meta;
      const diff = m.totalDue != null && m.openingBalance != null ? m.openingBalance + deb - cre - m.totalDue : null;
      return { s, deb, cre, diff, ok: diff != null && Math.abs(diff) < 2, problem: (diff != null && Math.abs(diff) >= 2) || !s.txns.length };
    });
    const nProb = info.filter(x => x.problem).length, nOk = info.filter(x => x.ok).length;
    if (!nProb) parserProblemsOnly = false;
    const visible = info.map((x, i) => ({ ...x, i })).filter(x => !parserProblemsOnly || x.problem);
    const groups = [...new Set(visible.map(x => x.s.card))].map(card => ({ card, items: visible.filter(x => x.s.card === card) }));
    const check = x => x.diff == null ? '<span class="muted">Can’t tell</span>' : x.ok ? okMark('Yes') : `<span data-tip="Opening + debits − credits is ${inr(x.diff)} away from the total due">${badMark('Off by ' + inr(x.diff))}</span>`;
    el.innerHTML = `
      <div class="card">
        <div class="head">
          <h2 class="with-info">Statements${infoTip('Opening balance + debits − credits should equal the statement’s total due. If it does, every transaction was read. If not, some rows were missed or misread: open the raw text to see which lines were picked up.')}</h2>
          ${nProb ? `<div class="seg-toggle" role="group" aria-label="Which statements to show"><button type="button" data-only="0" aria-pressed="${!parserProblemsOnly}">All ${sts.length}</button><button type="button" data-only="1" aria-pressed="${parserProblemsOnly}">Needs a look ${nProb}</button></div>` : ''}
        </div>
        <p class="tx-summary small"><b>${nOk} of ${sts.length}</b> statements reconcile${nProb ? ` · <span class="bad">${nProb} need${nProb === 1 ? 's' : ''} a look</span>` : ' · every statement was read completely'}</p>
        <div class="table-wrap p-wrap"><table class="p-table">
          <thead><tr><th>Statement</th><th class="r">Txns</th><th class="r p-num">Debits</th><th class="r p-num">Credits</th><th class="r p-num">Opening</th><th class="r p-num">Total due</th><th>Reconciles</th><th class="p-act"><span class="sr-only">Actions</span></th></tr></thead>
          ${groups.map(g => `<tbody>
            <tr class="p-group"><th colspan="8">${cardLabel(g.card)}<span class="small muted">${g.items.length} statement${g.items.length === 1 ? '' : 's'}</span></th></tr>
            ${g.items.map(x => `<tr class="${x.problem ? 'p-bad' : ''}">
              <td><span class="num">${dateLabel(x.s.meta.statementDate)}</span><span class="p-file small muted" data-tip-trunc="${esc(x.s.fileName)}">${esc(x.s.fileName)}</span></td>
              <td class="r ${x.s.txns.length ? '' : 'bad'}">${x.s.txns.length}</td><td class="r p-num">${inr(x.deb)}</td><td class="r p-num">${inr(x.cre)}</td><td class="r p-num">${inr(x.s.meta.openingBalance)}</td><td class="r p-num">${inr(x.s.meta.totalDue)}</td>
              <td class="p-check">${check(x)}</td>
              <td class="p-act"><button class="btn ghost icon-only" data-raw="${x.i}" data-tip="Show raw text" aria-label="Show raw text of ${esc(x.s.fileName)}">${Icon('text')}</button><button class="btn ghost icon-only" data-anon="${x.i}" data-tip="Copy anonymised layout: letters become x and digits 9, so the structure can be shared to improve the parser" aria-label="Copy anonymised layout of ${esc(x.s.fileName)}">${Icon('copy')}</button><button class="btn ghost icon-only p-del" data-del="${x.i}" data-tip="Remove this statement" aria-label="Remove ${esc(x.s.fileName)}">${Icon('trash')}</button></td></tr>`).join('')}
          </tbody>`).join('')}
        </table></div>
      </div>
      <div class="card" id="rawBox" hidden></div>`;
    el.querySelectorAll('[data-only]').forEach(b => b.onclick = () => { parserProblemsOnly = b.dataset.only === '1'; viewParser(); });
    el.querySelectorAll('[data-raw]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.raw];
      const box = $('#rawBox'); box.hidden = false;
      box.innerHTML = '<p class="muted">Loading…</p>';
      const raw = await rawOf(s);
      box.innerHTML = `<div class="head"><h2>${esc(s.fileName)}</h2><span class="sub">${raw.rawLines.length} lines · highlighted = read as a transaction</span><button type="button" class="btn ghost icon-only" id="rawClose" aria-label="Close raw text" data-tip="Close">${Icon('x')}</button></div>
        ${raw.rawLines.length ? `<pre class="raw">${raw.rawLines.map((l, j) => `<span class="${raw.lineFlags[j] ? 'hit' : ''}">${esc(l) || ' '}</span>`).join('')}</pre>` : '<p class="muted">No raw text was saved for this statement. Remove it here and import it again to see it.</p>'}`;
      $('#rawClose').onclick = () => { box.hidden = true; b.focus(); };
      box.scrollIntoView({ behavior: 'smooth' });
    });
    el.querySelectorAll('[data-anon]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.anon];
      const raw = await rawOf(s);
      const txt = `# ${s.card} (${raw.rawLines.length} lines, ${s.txns.length} parsed)\n` + anonymise(raw.rawLines.map((l, j) => (raw.lineFlags[j] ? '[T] ' : '    ') + l));
      try { await navigator.clipboard.writeText(txt); setProgress(`Copied the anonymised layout of ${s.fileName}.`); setTimeout(() => setProgress(''), 3000); }
      catch { const box = $('#rawBox'); box.hidden = false; box.innerHTML = `<pre class="raw">${esc(txt)}</pre>`; }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.del];
      if (!confirm(`Remove ${s.fileName} from the database?${s.folderId ? '\nIt will show up as new on the next folder scan.' : ''}`)) return;
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
