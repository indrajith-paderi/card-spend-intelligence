/* UI layer. */
(function () {
  'use strict';
  const { analyse, fmtINR, futureValue, FEE_CATS, isSpend } = Analysis;
  const $ = s => document.querySelector(s);
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
  }

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
      $('#pwTitle').textContent = 'Unlock ' + card;
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
    $('#scanBtn').textContent = n ? `Import ${n} new statement${n > 1 ? 's' : ''}` : 'Scan folders';
    $('#scanBtn').classList.toggle('primary', n > 0);
  }
  $('#scanBtn').addEventListener('click', () => { if (state.folders.length) scan({ import: true }); else { state.tab = 'folders'; render(); } });
  $('#foldersBtn').addEventListener('click', () => { state.tab = 'folders'; store.set('tab', 'folders'); render(); });

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

  $('#clearData').addEventListener('click', async () => {
    if (!confirm('Delete all imported statements, category edits and settings from the database?\nYour folders stay registered, and the PDFs on disk are not touched.')) return;
    try { await api('DELETE', 'all'); await reload(); state.pending = await api('GET', 'scan'); updateScanButton(); render(); } catch (e) { showError(e); }
  });

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
          <label class="small ink2">Folder path <span class="muted">(in File Explorer: right-click the folder → Copy as path)</span><br>
            <input type="text" id="fPath" placeholder="e.g. D:\\Statements" style="width:100%" required></label>
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
    const out = [];
    for (const s of state.statements) for (const t of s.txns) {
      const c = Categoriser.categorise(t, state.overrides);
      out.push(Object.assign({}, t, c, { card: s.card, nature: (Categoriser.CATEGORIES[c.category] || {}).nature }));
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  }
  function cardOrder() { return [...new Set(state.statements.map(s => s.card))].sort(); }
  function cardColor(card) { return seriesColor(cardOrder().indexOf(card)); }

  function filtered() {
    const txns = allTxns();
    const f = state.filter;
    const okCard = c => !f.cards || f.cards.includes(c);
    const okDate = d => (!f.from || d.slice(0, 7) >= f.from) && (!f.to || d.slice(0, 7) <= f.to);
    return {
      txns: txns.filter(t => okCard(t.card) && okDate(t.date)),
      statements: state.statements.filter(s => okCard(s.card)).map(s => Object.assign({}, s, {
        txns: s.txns.map(t => Object.assign({}, t, Categoriser.categorise(t, state.overrides))),
      })),
      all: txns,
    };
  }

  /* ---------- tabs & filters ---------- */
  const TABS = [['overview', 'Overview'], ['spending', 'Spending'], ['merchants', 'Merchants'], ['cards', 'Cards'], ['leakage', 'Leakage & risk'], ['behaviour', 'Behaviour'], ['savings', 'Savings & wealth'], ['transactions', 'Transactions'], ['parser', 'Parser check'], ['folders', 'Folders']];
  function renderTabs(hasData, tab) {
    const nav = $('#tabs');
    const tabs = hasData ? TABS : TABS.filter(t => t[0] === 'folders');
    nav.innerHTML = tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join('');
    nav.querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; store.set('tab', state.tab); render(); });
    document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
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
      <span class="muted">|</span>
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
  function chart(id, config) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    const el = document.getElementById(id);
    if (!el) return;
    const ink2 = css('--ink-2'), muted = css('--muted'), grid = css('--grid'), axis = css('--axis'), surface = css('--surface');
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = ink2;
    const base = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', color: ink2 } },
        tooltip: {
          backgroundColor: surface, titleColor: css('--ink'), bodyColor: ink2, borderColor: css('--border'), borderWidth: 1, padding: 10,
          boxWidth: 8, boxHeight: 8, usePointStyle: true,
          callbacks: { label: ctx => ` ${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${config._fmt ? config._fmt(ctx.parsed[config._axis || 'y']) : inr(ctx.parsed[config._axis || 'y'])}` },
        },
      },
      scales: {},
    };
    const scaleBase = { grid: { color: grid, drawTicks: false }, border: { color: axis }, ticks: { color: muted, padding: 6 } };
    const opts = config.options || {};
    const scales = {};
    for (const k of Object.keys(opts.scales || { x: {}, y: {} })) scales[k] = Object.assign({}, scaleBase, (opts.scales || {})[k] || {});
    if (scales.x && !(opts.scales && opts.scales.x && opts.scales.x.grid)) scales.x.grid = { display: false };
    const merged = Object.assign({}, base, opts, { scales, plugins: Object.assign({}, base.plugins, opts.plugins || {}, { tooltip: Object.assign({}, base.plugins.tooltip, (opts.plugins || {}).tooltip || {}) }) });
    if (opts.plugins && opts.plugins.legend) merged.plugins.legend = Object.assign({}, base.plugins.legend, opts.plugins.legend, { labels: Object.assign({}, base.plugins.legend.labels, (opts.plugins.legend.labels || {})) });
    state.charts[id] = new Chart(el, { type: config.type, data: config.data, options: merged });
  }
  const barDs = (label, data, color, extra) => Object.assign({ label, data, backgroundColor: color, borderColor: css('--surface'), borderWidth: { top: 0, bottom: 0, left: 0, right: 0 }, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 36, categoryPercentage: 0.8, barPercentage: 0.9 }, extra || {});

  function legendHtml(items) { return `<div class="legend">${items.map(([l, c]) => `<span><i class="swatch" style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`; }

  /* ---------- insight generation ---------- */
  function insights(A) {
    const out = [];
    const add = (sev, html) => out.push({ sev, html });
    const B = A.behaviour;
    const interest = A.feeGroups.find(g => g.name === 'Interest & finance charges');
    const late = A.feeGroups.find(g => g.name === 'Late payment fees');
    if (interest) add('critical', `<b>You paid ${inr(interest.total)} in interest/finance charges</b> (${inr(interest.annual)}/yr run-rate). This means a balance was revolving. Paying the full statement balance by the due date brings this to ₹0. Clear the highest-interest balance first.`);
    if (late) add('critical', `<b>${late.count} late-payment fee${late.count > 1 ? 's' : ''} totalling ${inr(late.total)}</b>. Late payments also hurt your credit score. Set up auto-debit for at least the minimum due on every card.`);
    if (A.cashAdv.length) add('critical', `<b>${A.cashAdv.length} cash withdrawal${A.cashAdv.length > 1 ? 's' : ''} on credit card (${inr(A.cashAdv.reduce((s, t) => s + t.amount, 0))})</b>. Cash advances start charging interest from day one and carry a fee.`);
    const shortfalls = A.cardStats.flatMap(c => c.shortfalls.map(s => ({ ...s, card: c.card })));
    if (shortfalls.length) add('serious', `<b>${shortfalls.length} statement${shortfalls.length > 1 ? 's' : ''} where the next payment was below the total due</b>. Check these on the Cards tab. This is how interest starts. (Can be a false alarm if you paid from outside the statement cycle.)`);
    const otherFees = A.feeGroups.filter(g => !['Interest & finance charges', 'Late payment fees'].includes(g.name));
    const otherFeeTotal = otherFees.reduce((s, g) => s + g.total, 0);
    if (otherFeeTotal > 0) add('serious', `<b>${inr(otherFeeTotal)} in other card charges</b> (${otherFees.map(g => `${g.name.toLowerCase()} ${inr(g.total)}`).join(', ')}). Ask for annual-fee waivers. Many banks waive the fee once you cross a spend threshold.`);
    const subs = A.recurring.filter(r => r.active);
    if (subs.length) add('warning', `<b>${subs.length} recurring payment${subs.length > 1 ? 's' : ''} still active, about ${inr(subs.reduce((s, r) => s + r.monthly, 0))}/month (${inr(subs.reduce((s, r) => s + r.annual, 0))}/yr)</b>. Top ones: ${subs.slice(0, 4).map(r => esc(r.name)).join(', ')}. Review them on the Leakage tab.`);
    if (A.duplicates.length) add('warning', `<b>${A.duplicates.length} possible duplicate charge${A.duplicates.length > 1 ? 's' : ''}</b> (same merchant and amount within a day). Worth checking against your receipts.`);
    if (A.missedSwiggy && A.missedSwiggy.total > 0) add('warning', `<b>${inr(A.missedSwiggy.total)} of Swiggy spend went on cards other than your Swiggy card</b>. The HDFC Swiggy card typically pays its highest cashback on Swiggy. At 10% that is roughly ${inr(A.missedSwiggy.total * 0.1)} missed (check the card's current terms).`);
    if (B.foodShare > 0.15) add('info', `<b>Food delivery is ${pct(B.foodShare)} of card spend</b> (${inr(B.foodDelivery / A.nMonths)}/month, about ${B.foodOrdersPerMonth.toFixed(0)} orders a month). Cutting this by a quarter frees about ${inr(B.foodDelivery / A.nMonths * 0.25)}/month.`);
    if (B.slopePct > 0.02 && A.nMonths >= 6) add('warning', `<b>Spending is trending up about ${pct(B.slopePct, 1)} a month</b> (average of the last 3 months ${inr(B.last3)} vs the first 3 months ${inr(B.first3)}). This is a lifestyle-inflation signal. Compare it with how fast your income is growing.`);
    if (B.smallPerMonth > 15) add('info', `<b>${B.smallPerMonth.toFixed(0)} small purchases (under ₹${A.smallLimit}) a month</b>, together ${inr(A.small.reduce((s, t) => s + t.amount, 0) / A.nMonths)}/month. Small amounts add up.`);
    const util = A.cardStats.filter(c => c.maxUtil != null && c.maxUtil > 0.3);
    if (util.length) add('warning', `<b>High credit utilization</b> on ${util.map(c => `${esc(c.card)} (peak ${pct(c.maxUtil)})`).join(', ')}. Keeping the statement balance under 30% of the limit helps your credit score.`);
    if (!interest && !late && !shortfalls.length) add('good', `<b>No interest or late fees found</b> in the selected period. You seem to pay in full, which is the most important credit-card habit.`);
    return out;
  }

  /* ---------- views ---------- */
  function viewOverview(A) {
    const el = $('#tab-overview');
    const cards = A.cards;
    const ins = insights(A);
    const topCats = A.categories.slice(0, 10);
    el.innerHTML = `
      <div class="grid g4">
        ${kpi('Total card spend', inr(A.totalSpend), `${A.nMonths} months · ${A.txnCount} purchases`)}
        ${kpi('Average per month', inr(A.avgMonthly), `${A.perMonthTxns.toFixed(0)} purchases/month · median ticket ${inr(A.medianTicket)}`)}
        ${kpi('Fees, interest & taxes', inr(A.totalFees), A.totalFees ? `${inr(A.totalFees * 12 / A.nMonths)} a year at this rate` : 'No avoidable charges found')}
        ${kpi('Refunds & cashback', inr(A.totalRefunds + A.totalCashback), `Cashback ${inr(A.totalCashback)} · refunds ${inr(A.totalRefunds)}`)}
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Monthly spend by card</h2>${cards.length > 1 ? legendHtml(cards.map(c => [c, cardColor(c)])) : ''}</div>
          <div class="chart-box"><canvas id="cMonthly"></canvas></div>
          <p class="note">Purchases only. Bill payments, refunds and fees are left out.</p>
        </div>
        <div class="card">
          <div class="head"><h2>Where the money goes</h2><span class="small muted">${A.paretoCats} categor${A.paretoCats === 1 ? 'y makes' : 'ies make'} up 80% of spend</span></div>
          <div class="chart-box"><canvas id="cCats"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Key findings</h2><span class="small muted">From your selected statements</span></div>
        <ul class="insights">${ins.map(i => `<li><span class="badge ${i.sev}" aria-label="${i.sev}">${{ critical: '!', serious: '!', warning: '•', info: 'i', good: '✓' }[i.sev]}</span><div>${i.html}</div></li>`).join('')}</ul>
      </div>
      <div class="grid g3">
        <div class="card kpi"><div class="label">Essential vs discretionary</div><div class="value">${pct(A.discretionary / (A.totalSpend || 1))}</div><div class="sub">discretionary (${inr(A.discretionary / A.nMonths)}/mo) · essential ${inr(A.essential / A.nMonths)}/mo</div></div>
        <div class="card kpi"><div class="label">Merchant concentration</div><div class="value">${A.merchantsA}</div><div class="sub">merchants make up 80% of spend, out of ${A.merchants.length} in total</div></div>
        <div class="card kpi"><div class="label">Bill payments made</div><div class="value">${inr(A.totalPayments)}</div><div class="sub">Paying your card bill is not counted as spending</div></div>
      </div>`;
    chart('cMonthly', {
      type: 'bar',
      data: { labels: A.months.map(monthLabel), datasets: cards.map(c => barDs(c, A.monthly.map(r => r.byCard[c] || 0), cardColor(c), { stack: 's', borderWidth: { top: 2 } })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => inrC(v) } } }, plugins: { tooltip: { callbacks: { footer: items => 'Total: ' + inr(items.reduce((s, i) => s + i.parsed.y, 0)) } } } },
    });
    chart('cCats', {
      type: 'bar', _axis: 'x',
      data: { labels: topCats.map(c => c.name), datasets: [barDs('Spend', topCats.map(c => c.total), seriesColor(0), { maxBarThickness: 18 })] },
      options: { indexAxis: 'y', interaction: { mode: 'nearest', axis: 'y', intersect: false }, scales: { x: { ticks: { callback: v => inrC(v) }, grid: { color: css('--grid') } }, y: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { afterLabel: ctx => ` ${pct(topCats[ctx.dataIndex].share, 1)} of spend · ${topCats[ctx.dataIndex].count} txns` } } } },
    });
  }
  const kpi = (label, value, sub) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  function viewSpending(A) {
    const el = $('#tab-spending');
    const maxShare = Math.max(...A.categories.map(c => c.share), 0.0001);
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Category breakdown</h2><span class="small muted">Change compares the second half of the period with the first half</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Category</th><th>Type</th><th class="r">Total</th><th class="r">Per month</th><th>Share</th><th class="r">Txns</th><th class="r">Avg ticket</th><th class="r">Change</th></tr></thead>
          <tbody>${A.categories.map(c => `<tr><td>${esc(c.name)}</td><td><span class="tag">${c.nature}</span></td><td class="r">${inr(c.total)}</td><td class="r">${inr(c.monthlyAvg)}</td>
            <td class="bar-cell"><div class="bar" style="width:${(c.share / maxShare * 100).toFixed(1)}%"></div><span class="small muted">${pct(c.share, 1)}</span></td>
            <td class="r">${c.count}</td><td class="r">${inr(c.avgTicket)}</td><td class="r ${c.change > 0.15 ? 'bad' : c.change < -0.15 ? 'ok' : ''}">${c.change == null ? '—' : (c.change > 0 ? '▲ ' : '▼ ') + pct(Math.abs(c.change))}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="head"><h2>Monthly trend: top categories</h2>${legendHtml(A.categories.slice(0, 6).map((c, i) => [c.name, seriesColor(i)]))}</div>
        <div class="chart-box"><canvas id="cCatTrend"></canvas></div>
      </div>
      <div class="grid g2">
        <div class="card"><div class="head"><h2>Spend per day, by weekday</h2><span class="small muted">Weekend ${inr(A.weekendPerDay)}/day vs weekday ${inr(A.weekdayPerDay)}/day</span></div><div class="chart-box short"><canvas id="cDow"></canvas></div></div>
        <div class="card"><div class="head"><h2>Spend by day of month</h2><span class="small muted">Look for spikes just after payday</span></div><div class="chart-box short"><canvas id="cDom"></canvas></div></div>
      </div>
      ${A.timedCount ? `<div class="card"><div class="head"><h2>Spend by hour of day</h2><span class="small muted">${A.timedCount} transactions have a timestamp · ${pct(A.behaviour.lateNightShare)} between 11pm and 5am</span></div><div class="chart-box short"><canvas id="cHour"></canvas></div></div>` : ''}`;
    chart('cCatTrend', {
      type: 'line',
      data: { labels: A.months.map(monthLabel), datasets: A.categories.slice(0, 6).map((c, i) => ({ label: c.name, data: c.byMonth, borderColor: seriesColor(i), backgroundColor: seriesColor(i), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'), tension: 0 })) },
      options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } },
    });
    chart('cDow', { type: 'bar', data: { labels: A.dow.map(d => d.name), datasets: [barDs('Avg spend per day', A.dow.map(d => d.perDay), seriesColor(0))] }, options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } } });
    chart('cDom', { type: 'bar', data: { labels: A.dom.map(d => d.day), datasets: [barDs('Total spend', A.dom.map(d => d.total), seriesColor(0), { maxBarThickness: 14 })] }, options: { scales: { x: {}, y: { ticks: { callback: v => inrC(v) } } } } });
    if (A.timedCount) chart('cHour', { type: 'bar', _fmt: v => v + ' txns', data: { labels: A.hours.map(h => String(h.hour).padStart(2, '0')), datasets: [barDs('Transactions', A.hours.map(h => h.count), seriesColor(0), { maxBarThickness: 18 })] }, options: { scales: { x: {}, y: {} } } });
  }

  function viewMerchants(A) {
    const el = $('#tab-merchants');
    const top = A.merchants.slice(0, 60);
    el.innerHTML = `
      <div class="grid g3">
        ${kpi('Unique merchants', A.merchants.length, `${A.merchantsA} "A" merchants make up 80% of spend`)}
        ${kpi('Top 5 merchants', pct(A.behaviour.top5Share), 'share of total spend')}
        ${kpi('Paid with more than one card', A.multiCardMerchants.length, 'Merchants you split across cards')}
      </div>
      <div class="card">
        <div class="head"><h2>Merchant ABC / Pareto analysis</h2><span class="small muted">A = top 80% of spend · B = next 15% · C = the rest</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Merchant</th><th>Class</th><th>Category</th><th class="r">Total</th><th class="r">Share</th><th class="r">Cumulative</th><th class="r">Txns</th><th class="r">Avg</th><th class="r">Months</th><th>Cards</th></tr></thead>
          <tbody>${top.map((m, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(m.name)}</td><td><span class="tag ${m.abc}">${m.abc}</span></td><td class="ink2">${esc(m.category)}</td><td class="r">${inr(m.total)}</td><td class="r">${pct(m.share, 1)}</td><td class="r muted">${pct(m.cumShare)}</td><td class="r">${m.count}</td><td class="r">${inr(m.avg)}</td><td class="r">${m.months}</td><td>${m.cards.map(c => `<i class="swatch" title="${esc(c)}" style="background:${cardColor(c)}"></i>`).join(' ')}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="note">Merchant names are normalised (for example, every SWIGGY* variant is counted as Swiggy, and Instamart separately). You can fix a category on the Transactions tab and it applies to that merchant everywhere.</p>
      </div>`;
  }

  function viewCards(A) {
    const el = $('#tab-cards');
    const rows = A.cardStats;
    el.innerHTML = `
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
          <div class="head"><h2>Credit utilization per statement</h2>${rows.length > 1 ? legendHtml(rows.map(c => [c.card, cardColor(c.card)])) : ''}</div>
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
        <div class="head"><h2>Payment behaviour</h2><span class="small muted">The payment in the next statement compared with the total due of this one</span></div>
        ${rows.some(c => c.shortfalls.length) ? `<table><thead><tr><th>Card</th><th>Statement</th><th class="r">Total due</th><th class="r">Paid in next cycle</th><th class="r">Shortfall</th></tr></thead><tbody>
          ${rows.flatMap(c => c.shortfalls.map(s => `<tr><td>${esc(c.card)}</td><td>${dateLabel(s.statementDate)}</td><td class="r">${inr(s.due)}</td><td class="r">${inr(s.paid)}</td><td class="r bad">${inr(s.due - s.paid)}</td></tr>`)).join('')}</tbody></table>`
        : `<p class="ok">✓ Every statement with a readable total due was fully paid in the next cycle.</p>`}
      </div>
      <div class="card">
        <div class="head"><h2>Cross-card optimisation</h2></div>
        <ul class="insights">
          ${A.missedSwiggy ? `<li><span class="badge warning">•</span><div>${inr(A.missedSwiggy.total)} of Swiggy/Instamart spend (${A.missedSwiggy.count} txns) was paid with other cards. Send it through <b>${esc(A.missedSwiggy.card)}</b>.</div></li>` : ''}
          ${A.multiCardMerchants.slice(0, 8).map(m => `<li><span class="badge info">i</span><div><b>${esc(m.name)}</b> (${inr(m.total)}) was paid with ${m.cards.length} cards: ${m.cards.map(esc).join(', ')}. Pick the card that earns the most for ${esc(m.category.toLowerCase())}.</div></li>`).join('')}
          ${!A.missedSwiggy && !A.multiCardMerchants.length ? '<li><span class="badge good">✓</span><div>Each merchant is mostly paid with a single card.</div></li>' : ''}
        </ul>
      </div>`;
    el.querySelectorAll('input[data-pv]').forEach(inp => inp.onchange = () => { state.settings.pointValue[inp.dataset.pv] = parseFloat(inp.value) || 0; saveSettings(); render(); });
    const labels = [...new Set(rows.flatMap(c => c.util.map(u => u.statementDate)).filter(Boolean))].sort();
    chart('cUtil', {
      type: 'line', _fmt: v => pct(v),
      data: { labels: labels.map(d => dateLabel(d)), datasets: rows.map(c => ({ label: c.card, data: labels.map(d => { const u = c.util.find(x => x.statementDate === d); return u && u.ratio != null ? u.ratio : null; }), borderColor: cardColor(c.card), backgroundColor: cardColor(c.card), borderWidth: 2, pointRadius: 3, spanGaps: true, tension: 0 })) },
      options: { scales: { x: {}, y: { min: 0, ticks: { callback: v => pct(v) } } } },
    });
  }

  function viewLeakage(A) {
    const el = $('#tab-leakage');
    const subsAnnual = A.recurring.filter(r => r.active).reduce((s, r) => s + r.annual, 0);
    const forexTotal = A.forexSpend.reduce((s, t) => s + t.amount, 0);
    const leak = [
      ['Interest & finance charges', 'High priority', A.feeGroups.find(g => g.name === 'Interest & finance charges')],
      ['Late payment fees', 'High priority', A.feeGroups.find(g => g.name === 'Late payment fees')],
      ['Card fees', 'Investigate', A.feeGroups.find(g => g.name === 'Card fees')],
      ['Taxes (GST)', 'Follows from fees', A.feeGroups.find(g => g.name === 'Taxes (GST)')],
      ['Forex markup', 'Investigate', A.feeGroups.find(g => g.name === 'Forex markup')],
      ['Fuel surcharge', 'Investigate', A.feeGroups.find(g => g.name === 'Fuel surcharge')],
    ];
    el.innerHTML = `
      <div class="grid g4">
        ${kpi('Avoidable charges paid', inr(A.totalFees), `${inr(A.totalFees * 12 / A.nMonths)} a year at this rate`)}
        ${kpi('Active recurring payments', inr(subsAnnual), 'per year (estimated)')}
        ${kpi('EMI payments', inr(A.emi.reduce((s, t) => s + t.amount, 0)), `${A.emi.length} instalments in this period`)}
        ${kpi('Foreign-currency spend', inr(forexTotal), `${A.forexSpend.length} txns · a markup of about 3.5% is common`)}
      </div>
      <div class="card">
        <div class="head"><h2>Financial leakage audit</h2></div>
        <table><thead><tr><th>Leak</th><th>Priority</th><th class="r">Occurrences</th><th class="r">Paid</th><th class="r">Annualised</th></tr></thead>
        <tbody>${leak.map(([n, p, g]) => `<tr><td>${n}</td><td><span class="tag">${p}</span></td><td class="r">${g ? g.count : 0}</td><td class="r ${g ? 'bad' : 'ok'}">${g ? inr(g.total) : '₹0'}</td><td class="r">${g ? inr(g.annual) : '—'}</td></tr>`).join('')}
          <tr><td>Recurring / subscriptions</td><td><span class="tag">Investigate</span></td><td class="r">${A.recurring.filter(r => r.active).length}</td><td class="r">—</td><td class="r">${inr(subsAnnual)}</td></tr>
          ${A.feeGroups.find(g => g.name === 'Forex markup') ? '' : `<tr><td>Forex markup (estimated at 3.5%)</td><td><span class="tag">Investigate</span></td><td class="r">${A.forexSpend.length}</td><td class="r">${inr(forexTotal * 0.035)}</td><td class="r">${inr(forexTotal * 0.035 * 12 / A.nMonths)}</td></tr>`}
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
          <div class="head"><h2>Unusual transactions</h2><span class="small muted">Robust outlier test within each category</span></div>
          ${A.anomalies.length ? `<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Date</th><th>Merchant</th><th class="r">Amount</th><th>Why</th></tr></thead><tbody>${A.anomalies.map(a => `<tr><td>${dateLabel(a.txn.date)}</td><td>${esc(a.txn.merchant)}</td><td class="r">${inr(a.txn.amount)}</td><td class="small ink2">${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ok">✓ Nothing unusual.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Risk checklist</h2></div>
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
      ['Food-delivery dependency', pct(B.foodShare), `${inr(B.foodDelivery / A.nMonths)}/month · ${B.foodOrdersPerMonth.toFixed(1)} orders/month`, B.foodShare > 0.15 ? 'High' : B.foodShare > 0.07 ? 'Moderate' : 'Low'],
      ['Convenience-driven spend', pct(B.convenienceShare), 'Delivery, quick-commerce and cabs as a share of spend', B.convenienceShare > 0.3 ? 'High' : B.convenienceShare > 0.15 ? 'Moderate' : 'Low'],
      ['Discretionary share', pct(B.discretionaryShare), 'Wants vs needs (by category)', B.discretionaryShare > 0.6 ? 'High' : B.discretionaryShare > 0.4 ? 'Moderate' : 'Low'],
      ['Small-ticket frequency', `${B.smallPerMonth.toFixed(1)}/mo`, `${pct(B.smallShareCount)} of purchases are under ₹${A.smallLimit}`, B.smallPerMonth > 20 ? 'High' : B.smallPerMonth > 8 ? 'Moderate' : 'Low'],
      ['Weekend intensity', B.weekendRatio == null ? '—' : B.weekendRatio.toFixed(2) + '×', 'Weekend spend per day ÷ weekday spend per day', B.weekendRatio > 1.4 ? 'High' : B.weekendRatio > 1.1 ? 'Moderate' : 'Low'],
      ['Late-night purchases', B.lateNightShare == null ? '—' : pct(B.lateNightShare), B.lateNightShare == null ? 'Your statements have no timestamps' : '11pm to 5am. A possible sign of impulse buying.', B.lateNightShare == null ? '—' : B.lateNightShare > 0.15 ? 'High' : B.lateNightShare > 0.07 ? 'Moderate' : 'Low'],
      ['Spending consistency', B.cv.toFixed(2), 'Variation in monthly spend (lower = steadier)', B.cv > 0.5 ? 'Volatile' : B.cv > 0.25 ? 'Moderate' : 'Steady'],
      ['Lifestyle inflation', (B.slopePct >= 0 ? '+' : '') + pct(B.slopePct, 1) + '/mo', `Average of the last 3 months ${inr(B.last3)} vs the first 3 months ${inr(B.first3)}`, B.slopePct > 0.02 ? 'Rising' : B.slopePct < -0.02 ? 'Falling' : 'Flat'],
      ['Merchant concentration', pct(B.top5Share), 'Share of spend at your top 5 merchants', B.top5Share > 0.5 ? 'Concentrated' : 'Spread out'],
    ];
    const rising = A.categories.filter(c => c.change != null && c.change > 0.2 && c.h2 - c.h1 > 1000).sort((a, b) => (b.h2 - b.h1) - (a.h2 - a.h1));
    el.innerHTML = `
      <div class="card">
        <div class="head"><h2>Spending behaviour profile</h2><span class="small muted">Based on your transactions. These are spending signals, not a judgement.</span></div>
        <table><thead><tr><th>Indicator</th><th class="r">Value</th><th>Meaning</th><th>Level</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="ink2 small">${r[2]}</td><td><span class="tag">${r[3]}</span></td></tr>`).join('')}</tbody></table>
      </div>
      <div class="grid g2">
        <div class="card">
          <div class="head"><h2>Categories growing fastest</h2><span class="small muted">Second half vs first half of the period</span></div>
          ${rising.length ? `<table><thead><tr><th>Category</th><th class="r">Before</th><th class="r">After</th><th class="r">Change</th></tr></thead><tbody>${rising.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${inr(c.h1)}</td><td class="r">${inr(c.h2)}</td><td class="r bad">▲ ${pct(c.change)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">✓ No category grew more than 20%.</p>'}
        </div>
        <div class="card">
          <div class="head"><h2>Monthly category spikes</h2><span class="small muted">Months where a category ran above 2× its usual level</span></div>
          ${A.spikes.length ? `<table><thead><tr><th>Month</th><th>Category</th><th class="r">Spent</th><th class="r">Typical</th></tr></thead><tbody>${A.spikes.slice(0, 15).map(s => `<tr><td>${monthLabel(s.month)}</td><td>${esc(s.category)}</td><td class="r">${inr(s.amount)}</td><td class="r muted">${inr(s.typical)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">✓ No spikes.</p>'}
        </div>
      </div>
      <div class="card">
        <div class="head"><h2>Essential vs discretionary, by month</h2>${legendHtml([['Essential', seriesColor(0)], ['Discretionary', seriesColor(1)]])}</div>
        <div class="chart-box short"><canvas id="cNature"></canvas></div>
      </div>`;
    const ess = A.months.map((m, i) => A.categories.filter(c => c.nature === 'essential').reduce((s, c) => s + c.byMonth[i], 0));
    const dis = A.months.map((m, i) => A.categories.filter(c => c.nature === 'discretionary').reduce((s, c) => s + c.byMonth[i], 0));
    chart('cNature', { type: 'bar', data: { labels: A.months.map(monthLabel), datasets: [barDs('Essential', ess, seriesColor(0), { stack: 's' }), barDs('Discretionary', dis, seriesColor(1), { stack: 's', borderWidth: { top: 2 } })] }, options: { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => inrC(v) } } } } });
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
          <div class="head"><h2>Savings levers</h2><span class="small muted">How much you'd cut from each discretionary category</span></div>
          <div id="sliders">${disc.map(c => `<div class="slider-row"><span>${esc(c.name)}<div class="small muted">${inr(c.monthlyAvg)}/mo</div></span><input type="range" min="0" max="100" step="5" value="${cutOf(c)}" data-cut="${esc(c.name)}"><span class="num" data-cutlbl="${esc(c.name)}">${cutOf(c)}%</span><span class="num r" data-cutamt="${esc(c.name)}">${inr(c.monthlyAvg * cutOf(c) / 100)}</span></div>`).join('')}</div>
          <label class="chip" style="margin-top:10px"><input type="checkbox" id="dropFees" ${S.dropFees !== false ? 'checked' : ''}> Remove all avoidable fees & interest (${inr(feesMonthly)}/mo)</label>
          <div class="grid g3" style="margin-top:14px">
            <label class="small ink2">Monthly take-home income (optional)<br><input type="number" id="income" min="0" step="1000" value="${S.income || ''}" placeholder="e.g. 120000" style="width:100%"></label>
            <label class="small ink2">Expected annual return %<br><input type="number" id="rate" min="0" max="30" step="0.5" value="${S.rate}" style="width:100%"></label>
            <label class="small ink2">Years invested<br><input type="number" id="years" min="1" max="40" step="1" value="${S.years}" style="width:100%"></label>
          </div>
        </div>
        <div class="card" id="savingsOut"></div>
      </div>
      <div class="card">
        <div class="head"><h2>What the redirected savings could grow to</h2>${legendHtml([['Value if invested', seriesColor(0)], ['Amount invested', seriesColor(1)]])}</div>
        <div class="chart-box short"><canvas id="cFV"></canvas></div>
        <p class="note">Assumes the monthly saving is invested at the start of each month and grows at the chosen annual rate, compounded monthly. Taxes and costs are ignored. Returns are not guaranteed. This is an illustration, not investment advice.</p>
      </div>
      <div class="card">
        <div class="head"><h2>12-month improvement roadmap</h2></div>
        <ol class="ink2" style="margin:0;padding-left:20px;display:grid;gap:6px">${roadmap(A).map(x => `<li>${x}</li>`).join('')}</ol>
      </div>`;
    const update = () => {
      const { monthly } = compute();
      const fv = futureValue(monthly, (S.rate || 0) / 100, S.years || 10);
      const income = S.income || 0;
      $('#savingsOut').innerHTML = `
        <div class="head"><h2>Impact</h2></div>
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
        { label: 'Value if invested', data: fv.series.map(p => p.value), borderColor: seriesColor(0), backgroundColor: seriesColor(0), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.2 },
        { label: 'Amount invested', data: fv.series.map(p => p.invested), borderColor: seriesColor(1), backgroundColor: seriesColor(1), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, borderDash: [5, 4] }] },
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
    r.push('<b>Month 3:</b> Start a monthly SIP for the amount you\'re saving, on the day after your salary arrives. That way the money is invested before it can be spent.');
    r.push('<b>Month 4–6:</b> Build an emergency fund of 6 months of expenses (about ' + inr(A.avgMonthly * 6) + ' based on card spend alone) so emergencies never go on the card as revolving debt.');
    r.push('<b>Month 6:</b> Load new statements here and compare with this baseline: monthly spend, discretionary share, fees, and subscriptions.');
    r.push('<b>Month 9–12:</b> Review whether each card is worth keeping (Net benefit on the Cards tab). Close or downgrade any card that costs more than it returns. Raise your SIP with every income increase.');
    return r;
  }

  let txnQuery = '', txnCat = '', txnSort = 'date-desc';
  function viewTransactions(F) {
    const el = $('#tab-transactions');
    const cats = Object.keys(Categoriser.CATEGORIES);
    const q = txnQuery.toLowerCase();
    let list = F.txns.filter(t => (!q || (t.description + ' ' + t.merchant).toLowerCase().includes(q)) && (!txnCat || t.category === txnCat));
    const [k, dir] = txnSort.split('-');
    list.sort((a, b) => (k === 'amount' ? a.amount - b.amount : a.date.localeCompare(b.date)) * (dir === 'desc' ? -1 : 1));
    const shown = list.slice(0, 1500);
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
        <p class="small muted" style="margin-bottom:8px">${list.length} transactions · net ${inr(tot)}${list.length > shown.length ? ` · showing the first ${shown.length}` : ''}. Change a category and it applies to <b>every</b> transaction from that merchant.</p>
        <div class="table-wrap" style="max-height:640px"><table>
          <thead><tr><th>Date</th><th>Description</th><th>Merchant</th><th>Category</th><th>Card</th><th class="r">Amount</th></tr></thead>
          <tbody>${shown.map(t => `<tr><td class="num">${dateLabel(t.date)}${t.time ? `<div class="small muted">${t.time}</div>` : ''}</td><td class="small">${esc(t.description)}</td><td>${esc(t.merchant)}</td>
            <td><select data-merchant="${esc(t.merchant)}" style="max-width:190px">${cats.map(c => `<option ${c === t.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>${t.overridden ? ' <span class="tag" title="Edited by you">edited</span>' : ''}</td>
            <td><i class="swatch" style="background:${cardColor(t.card)}" title="${esc(t.card)}"></i></td>
            <td class="r ${t.type === 'credit' ? 'ok' : ''}">${t.type === 'credit' ? '+' : ''}${fmtINR(t.amount, { decimals: true })}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    $('#ts').value = txnSort;
    let deb; $('#tq').oninput = e => { clearTimeout(deb); deb = setTimeout(() => { txnQuery = e.target.value; viewTransactions(filtered()); const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200); };
    $('#tc').onchange = e => { txnCat = e.target.value; viewTransactions(filtered()); };
    $('#ts').onchange = e => { txnSort = e.target.value; viewTransactions(filtered()); };
    el.querySelectorAll('select[data-merchant]').forEach(s => s.onchange = () => { state.overrides[s.dataset.merchant] = s.value; saveOverrides(); render(); });
  }

  const KEEP_WORDS = new Set('date dates transaction transactions description details amount amounts total due minimum payment statement credit debit limit available cash balance opening closing previous purchases reward rewards points cr dr rs inr reference ref no merchant category domestic international emi interest finance charges charge fee fees gst igst cgst sgst tax card number name page of time pi upi'.split(' '));
  function anonymise(lines) {
    return lines.map(l => l.replace(/[A-Za-z]+/g, w => KEEP_WORDS.has(w.toLowerCase()) ? w : w.replace(/[a-z]/g, 'x').replace(/[A-Z]/g, 'X')).replace(/\d/g, '9')).join('\n');
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
              <td style="white-space:nowrap"><button class="btn" data-raw="${i}">Raw text</button> <button class="btn" data-anon="${i}">Copy anonymised layout</button> <button class="btn ghost" data-del="${i}" title="Remove this statement">✕</button></td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
      <div class="card" id="rawBox" style="display:none"></div>`;
    el.querySelectorAll('[data-raw]').forEach(b => b.onclick = () => {
      const s = sts[+b.dataset.raw];
      const box = $('#rawBox'); box.style.display = '';
      box.innerHTML = `<div class="head"><h3>${esc(s.fileName)}</h3><span class="small muted">${s.rawLines.length} lines · highlighted = read as a transaction</span></div>
        ${s.rawLines.length ? `<pre class="raw">${s.rawLines.map((l, j) => `<span class="${s.lineFlags[j] ? 'hit' : ''}">${esc(l) || ' '}</span>`).join('')}</pre>` : '<p class="muted">No raw text was saved for this statement. Delete it here and import it again to see it.</p>'}`;
      box.scrollIntoView({ behavior: 'smooth' });
    });
    el.querySelectorAll('[data-anon]').forEach(b => b.onclick = async () => {
      const s = sts[+b.dataset.anon];
      const txt = `# ${s.card} (${s.rawLines.length} lines, ${s.txns.length} parsed)\n` + anonymise(s.rawLines.map((l, j) => (s.lineFlags[j] ? '[T] ' : '    ') + l));
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
    const A = analyse(F.txns, F.statements, { pointValue: state.settings.pointValue, smallLimit: state.settings.smallLimit });
    if (A.empty && state.tab !== 'parser') {
      document.querySelectorAll('section.tab.active').forEach(s => s.innerHTML = '<div class="card"><p>No transactions in the selected filters. If statements are loaded but show 0 transactions, open <b>Parser check</b>.</p></div>');
      return;
    }
    const views = { overview: () => viewOverview(A), spending: () => viewSpending(A), merchants: () => viewMerchants(A), cards: () => viewCards(A), leakage: () => viewLeakage(A), behaviour: () => viewBehaviour(A), savings: () => viewSavings(A), transactions: () => viewTransactions(F), parser: viewParser };
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
