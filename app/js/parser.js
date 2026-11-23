/* Statement parser: decrypts a PDF locally with pdf.js, rebuilds text lines from
 * positioned glyphs, and extracts transactions + statement summary values.
 * Nothing here touches the network. */
(function () {
  'use strict';

  let pdfReady = null;
  function loadPdfJs() {
    if (!pdfReady) pdfReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf.min.js';
      s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; resolve(); };
      s.onerror = () => { pdfReady = null; reject(new Error('Could not load the PDF reader.')); };
      document.head.appendChild(s);
    });
    return pdfReady;
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const AMOUNT_RE = /(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}(?!\d)/g;
  const DATE_START_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})|^(\d{1,2})[\s\-]([A-Za-z]{3,4})[\s\-,]+(\d{2,4})/;
  const TIME_RE = /^\s*\|?\s*(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM)\b)?\s*\|?/i;
  const CURRENCY_CELL = /^[+\-]?\s*(₹|Rs\.?|INR|C|`)?\s*$/i;
  const POINTS_CELL = /^([+\-])?\s*(\d{1,6})$/;
  const SKIP_DESC_RE = /^(opening|closing|previous|total|minimum|payment due|statement|credit limit|available|balance|purchases?\/|cash limit|due date|reward points? (earned|summary))/i;

  function toNumber(s) { return parseFloat(String(s).replace(/,/g, '')); }

  function parseDateToken(m) {
    let d, mo, y;
    if (m[1]) { d = +m[1]; mo = +m[2] - 1; y = +m[3]; }
    else { d = +m[4]; mo = MONTHS[m[5].toLowerCase()]; y = +m[6]; if (mo === undefined) return null; }
    if (y < 100) y += 2000;
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return new Date(Date.UTC(y, mo, d));
  }

  function iso(d) { return d ? d.toISOString().slice(0, 10) : null; }

  /* ---------- PDF → lines ---------- */

  async function openPdf(data, password) {
    await loadPdfJs();
    const task = pdfjsLib.getDocument({ data, password: password || '', isEvalSupported: false });
    return task.promise;
  }

  async function extractLines(pdf) {
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter(it => it.str && it.str.trim() !== '')
        .map(it => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 8, str: it.str }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const tol = Math.max(2, it.h * 0.45);
        let row = rows.find(r => Math.abs(r.y - it.y) <= tol);
        if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
        row.items.push(it);
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let text = '';
        let lastEnd = null;
        for (const it of r.items) {
          if (lastEnd !== null) {
            const gap = it.x - lastEnd;
            if (gap > 12) text = text.replace(/ +$/, '') + '  ';
            else if (gap > 1.5 && !/\s$/.test(text)) text += ' ';
          }
          it.start = text.length;
          text += it.str;
          it.end = text.length;
          lastEnd = it.x + it.w;
        }
        lines.push({ page: p, y: r.y, items: r.items, text: text.replace(/\s+$/, '') });
      }
    }
    return lines;
  }

  /* ---------- transactions ---------- */

  function parseTransactionLine(text) {
    const t = text.replace(/₹/g, ' ₹ ').replace(/\t/g, '  ').trim();
    const dm = t.match(DATE_START_RE);
    if (!dm) return null;
    const date = parseDateToken(dm);
    if (!date) return null;
    let rest = t.slice(dm[0].length);
    let time = null;
    const tm = rest.match(TIME_RE);
    if (tm) {
      let hh = +tm[1];
      if (tm[3]) { const pm = tm[3].toUpperCase() === 'PM'; if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
      if (hh < 24) time = String(hh).padStart(2, '0') + ':' + tm[2];
      rest = rest.slice(tm[0].length);
    }
    rest = rest.replace(/^\s*\|\s*/, ' ');
    // posting date column (some banks print two dates)
    const second = rest.trim().match(DATE_START_RE);
    if (second) rest = rest.trim().slice(second[0].length);

    const amounts = [...rest.matchAll(AMOUNT_RE)];
    if (!amounts.length) return null;
    const last = amounts[amounts.length - 1];
    const amount = toNumber(last[0]);
    if (!(amount > 0)) return null;
    const before = rest.slice(0, last.index);
    const after = rest.slice(last.index + last[0].length);
    if (after.replace(/\b(cr|dr|c|d)\b/ig, '').replace(/[^A-Za-z0-9]/g, '').length > 3) return null; // amount must end the row

    let credit = /^\s*(cr|c)\b/i.test(after);
    if (/\+\s*(₹|Rs\.?|INR|C|`)?\s*$/i.test(before)) credit = true;
    if (/^\s*(dr|d)\b/i.test(after)) credit = false;

    // Split the remainder into columns (2+ spaces = column gap).
    let b = before
      .replace(/[+\-]?\s*(₹|Rs\.?|INR|`)\s*$/i, '')
      .replace(/\+\s*C\s*$/, '')
      .replace(/(\s)C\s*$/, '$1') // rupee glyph that some fonts extract as "C"
      .replace(/\s*\+\s*$/, '');
    const cells = b.split(/\s{2,}|\s*\|\s*/).map(c => c.replace(/\s+/g, ' ').trim()).filter(c => c && !CURRENCY_CELL.test(c));
    let points = 0;
    if (cells.length > 1) {
      const pm = cells[cells.length - 1].match(POINTS_CELL);
      if (pm) { if (pm[1] || cells.length > 1) points = (pm[1] === '-' ? -1 : 1) * +pm[2]; cells.pop(); }
    }
    // single-cell rows: points glued with a "+"
    if (cells.length === 1) {
      const pm = cells[0].match(/\s([+\-])\s*(\d{1,6})$/);
      if (pm) { points = (pm[1] === '-' ? -1 : 1) * +pm[2]; cells[0] = cells[0].slice(0, pm.index).trim(); }
    }
    const textCells = cells.filter(c => /[A-Za-z]/.test(c));
    let desc = (textCells[0] || '').trim();
    const extra = textCells.slice(1).join(' ');
    if (!desc || desc.length < 2 || SKIP_DESC_RE.test(desc)) return null;
    // a short trailing city/category column belongs with the description for matching
    if (extra && desc.length < 12) desc = desc + ' ' + extra;

    let foreign = null;
    const fx = before.match(/\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|THB|MYR|CHF)\s*([\d,]+\.\d{2})?/);
    if (fx) foreign = fx[1];

    return { date: iso(date), time, description: desc, extra: extra || '', amount, type: credit ? 'credit' : 'debit', points, foreign };
  }

  /* ---------- statement summary values ---------- */

  const META_LABELS = {
    totalDue: /total\s+(amount\s+)?due|total\s+dues|amount\s+payable|total\s+outstanding/i,
    minDue: /minimum\s+(amount\s+)?due|min\.?\s+amount\s+due/i,
    creditLimit: /(total\s+)?credit\s+limit/i,
    availableLimit: /available\s+credit(\s+limit)?/i,
    cashLimit: /(available\s+)?cash\s+limit/i,
    openingBalance: /opening\s+balance|previous\s+(statement\s+)?(balance|dues)/i,
    financeCharges: /finance\s+charges?/i,
  };
  const DATE_LABELS = {
    statementDate: /statement\s+date/i,
    dueDate: /(payment\s+)?due\s+date/i,
  };

  function posToX(line, idx) {
    for (const it of line.items) {
      if (idx < it.start) return it.x;
      if (idx < it.end) return it.x + it.w * (idx - it.start) / Math.max(1, it.end - it.start);
    }
    const last = line.items[line.items.length - 1];
    return last ? last.x + last.w : 0;
  }

  const DATE_ANY_RE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})|(\d{1,2})[\s\-]([A-Za-z]{3,4})[\s\-,]+(\d{2,4})/g;

  const META_AMOUNT_RE = /(?<![\d.,])(₹\s?|Rs\.?\s?|INR\s?)?(\d{1,3}(?:,\d{2,3})+(?:\.\d{2})?|\d+\.\d{2}|\d+)(?![\d,]|\.\d)/g;

  function lineAmounts(line) {
    return [...line.text.matchAll(META_AMOUNT_RE)].filter(m => m[1] || /[.,]/.test(m[2])).map(m => {
      const x = posToX(line, m.index), end = posToX(line, m.index + m[0].length - 1);
      return { value: toNumber(m[2]), x, end, cx: (x + end) / 2 };
    });
  }

  function lineDates(line) {
    const out = [];
    for (const m of line.text.matchAll(DATE_ANY_RE)) {
      const d = parseDateToken(m);
      if (!d) continue;
      const x = posToX(line, m.index), end = posToX(line, m.index + m[0].length - 1);
      out.push({ value: iso(d), x, end, cx: (x + end) / 2 });
    }
    return out;
  }

  function findLabels(line, re, excludeBefore) {
    const g = new RegExp(re.source, 'gi');
    const out = [];
    for (const m of line.text.matchAll(g)) {
      if (excludeBefore && excludeBefore.test(line.text.slice(Math.max(0, m.index - 14), m.index))) continue;
      const x = posToX(line, m.index), end = posToX(line, m.index + m[0].length - 1);
      out.push({ x, end, cx: (x + end) / 2, idx: m.index + m[0].length });
    }
    return out;
  }

  function findValue(lines, re, getter, excludeBefore) {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (parseTransactionLine(L.text)) continue;
      const labels = findLabels(L, re, excludeBefore);
      if (!labels.length) continue;
      const lab = labels[0];
      // same line: first value to the right of the label, before the next label-ish text
      const right = getter(L).filter(v => v.x >= lab.end - 2).sort((a, b) => a.x - b.x);
      if (right.length) {
        const between = L.text.slice(lab.idx, L.text.length);
        const firstLetters = between.search(/[A-Za-z]{4,}/);
        const valPos = between.search(/\d/);
        if (firstLetters === -1 || valPos < firstLetters) return right[0].value;
      }
      // following lines: value centred under the label
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (lines[j].page !== L.page) break;
        const ownsValue = v => {
          let best = null, bd = Infinity;
          for (const it of L.items) { const d = Math.abs(it.x + it.w / 2 - v.cx); if (d < bd) { bd = d; best = it; } }
          return !best || (best.x <= lab.end + 4 && best.x + best.w >= lab.x - 4);
        };
        const cands = getter(lines[j]).map(v => ({ ...v, d: Math.abs(v.cx - lab.cx) })).filter(v => v.d < 120 && ownsValue(v)).sort((a, b) => a.d - b.d);
        if (cands.length) return cands[0].value;
      }
    }
    return null;
  }

  function extractMeta(lines) {
    const meta = {};
    for (const [k, re] of Object.entries(META_LABELS)) {
      const ex = k === 'creditLimit' ? /(available|cash|avl\.?)\s*$/i : null;
      meta[k] = findValue(lines, re, lineAmounts, ex);
    }
    for (const [k, re] of Object.entries(DATE_LABELS)) {
      meta[k] = findValue(lines, re, lineDates, null);
    }
    return meta;
  }

  function metaFromFilename(name) {
    const out = {};
    let m = name.match(/_(\d{2})-(\d{2})-(\d{4})/); // e.g. 1234XXXXXXXXXX56_DD-MM-YYYY.pdf
    if (m) out.statementDate = `${m[3]}-${m[2]}-${m[1]}`;
    m = name.match(/_(\d{2})(\d{2})(20\d{2})(\d{2})(\d{2})(20\d{2})\.pdf$/i); // e.g. ..._DDMMYYYYDDMMYYYY.pdf (period start + end)
    if (m) { out.periodStart = `${m[3]}-${m[2]}-${m[1]}`; out.statementDate = `${m[6]}-${m[5]}-${m[4]}`; }
    m = name.match(/^(\d{4})X+(\d{2})/i);
    if (m) out.cardRef = `${m[1]}…${m[2]}`;
    return out;
  }

  /* ---------- public ---------- */

  async function parseStatement(file, cardName, password) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(buf, password);
    const lines = await extractLines(pdf);
    const fileMeta = metaFromFilename(file.name);
    const meta = Object.assign({}, extractMeta(lines));
    if (fileMeta.statementDate) meta.statementDate = fileMeta.statementDate;
    if (fileMeta.periodStart) meta.periodStart = fileMeta.periodStart;
    meta.cardRef = fileMeta.cardRef || null;

    const id = `${cardName}::${file.name}::${file.size}`;
    const txns = [];
    const lineFlags = [];
    lines.forEach((L, i) => {
      const t = parseTransactionLine(L.text);
      lineFlags.push(t ? 1 : 0);
      if (t) {
        t.id = `${id}#${i}`;
        t.card = cardName;
        t.statementId = id;
        txns.push(t);
      }
    });
    return {
      id, card: cardName, fileName: file.name, size: file.size, pages: pdf.numPages,
      meta, txns,
      rawLines: lines.map(l => l.text), lineFlags,
      parsedAt: new Date().toISOString(),
    };
  }

  async function needsPassword(file, password) {
    try {
      const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()), password);
      pdf.destroy();
      return false;
    } catch (e) {
      if (e && e.name === 'PasswordException') return true;
      throw e;
    }
  }

  window.StatementParser = { parseStatement, needsPassword, parseTransactionLine };
})();
