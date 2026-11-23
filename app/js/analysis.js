/* Analytics engine: turns enriched transactions + statement summaries into insights. */
(function () {
  'use strict';

  const FEE_CATS = new Set(['Interest & finance charges', 'Late payment fees', 'Card fees', 'Taxes (GST)', 'Forex markup', 'Fuel surcharge']);
  const CONVENIENCE = new Set(['Swiggy', 'Zomato', 'Swiggy Instamart', 'Blinkit', 'Zepto', 'BigBasket', 'Uber', 'Ola', 'Rapido']);

  const sum = a => a.reduce((s, x) => s + x, 0);
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const monthOf = d => d.slice(0, 7);
  const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

  function monthRange(a, b) {
    const out = []; let [y, m] = a.split('-').map(Number); const [Y, M] = b.split('-').map(Number);
    while (y < Y || (y === Y && m <= M)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }

  function isSpend(t) { return t.type === 'debit' && !FEE_CATS.has(t.category) && t.category !== 'Card payment'; }
  function isFee(t) { return t.type === 'debit' && FEE_CATS.has(t.category); }

  function groupBy(arr, keyFn) { const m = new Map(); for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

  function linearSlope(ys) {
    const n = ys.length; if (n < 3) return 0;
    const xm = (n - 1) / 2, ym = sum(ys) / n;
    let num = 0, den = 0; ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
    return den ? num / den : 0;
  }

  function analyse(txns, statements, opts) {
    opts = opts || {};
    const cards = [...new Set(statements.map(s => s.card))].sort();
    const spend = txns.filter(isSpend);
    const fees = txns.filter(isFee);
    const credits = txns.filter(t => t.type === 'credit');
    const payments = credits.filter(t => t.category === 'Card payment');
    const refunds = credits.filter(t => t.category === 'Refund / reversal');
    const cashback = credits.filter(t => t.category === 'Cashback & rewards');

    const dates = txns.map(t => t.date).sort();
    if (!dates.length) return { empty: true, cards };
    const months = monthRange(monthOf(dates[0]), monthOf(dates[dates.length - 1]));
    const nMonths = Math.max(1, months.length);
    const totalSpend = sum(spend.map(t => t.amount));
    const totalRefunds = sum(refunds.map(t => t.amount));
    const totalCashback = sum(cashback.map(t => t.amount));
    const totalFees = sum(fees.map(t => t.amount));
    const totalPayments = sum(payments.map(t => t.amount));

    // ---- monthly ----
    const monthly = months.map(m => {
      const row = { month: m, total: 0, fees: 0, refunds: 0, byCard: {} };
      cards.forEach(c => row.byCard[c] = 0);
      return row;
    });
    const mIdx = Object.fromEntries(months.map((m, i) => [m, i]));
    for (const t of spend) { const r = monthly[mIdx[monthOf(t.date)]]; r.total += t.amount; r.byCard[t.card] = (r.byCard[t.card] || 0) + t.amount; }
    for (const t of fees) monthly[mIdx[monthOf(t.date)]].fees += t.amount;
    for (const t of refunds) monthly[mIdx[monthOf(t.date)]].refunds += t.amount;
    const monthlyTotals = monthly.map(r => r.total);

    // ---- categories ----
    const half = Math.floor(nMonths / 2);
    const firstHalf = new Set(months.slice(0, half)), secondHalf = new Set(months.slice(nMonths - half));
    const categories = [...groupBy(spend, t => t.category)].map(([name, list]) => {
      const total = sum(list.map(t => t.amount));
      const h1 = sum(list.filter(t => firstHalf.has(monthOf(t.date))).map(t => t.amount));
      const h2 = sum(list.filter(t => secondHalf.has(monthOf(t.date))).map(t => t.amount));
      const byMonth = months.map(m => sum(list.filter(t => monthOf(t.date) === m).map(t => t.amount)));
      return { name, total, count: list.length, share: total / (totalSpend || 1), monthlyAvg: total / nMonths, avgTicket: total / list.length,
        nature: (Categoriser.CATEGORIES[name] || {}).nature || 'discretionary', change: half >= 2 && h1 > 0 ? (h2 - h1) / h1 : null, h1, h2, byMonth };
    }).sort((a, b) => b.total - a.total);
    let acc = 0; categories.forEach(c => { acc += c.share; c.cumShare = acc; });
    const paretoCats = categories.findIndex(c => c.cumShare >= 0.8) + 1;

    const essential = sum(categories.filter(c => c.nature === 'essential').map(c => c.total));
    const discretionary = sum(categories.filter(c => c.nature === 'discretionary').map(c => c.total));

    // ---- merchants (ABC) ----
    const merchants = [...groupBy(spend, t => t.merchant)].map(([name, list]) => ({
      name, total: sum(list.map(t => t.amount)), count: list.length,
      cards: [...new Set(list.map(t => t.card))], months: new Set(list.map(t => monthOf(t.date))).size,
      category: list[0].category, last: list.map(t => t.date).sort().pop(), avg: sum(list.map(t => t.amount)) / list.length,
    })).sort((a, b) => b.total - a.total);
    acc = 0; merchants.forEach(m => { acc += m.total / (totalSpend || 1); m.cumShare = acc; m.share = m.total / (totalSpend || 1); m.abc = acc <= 0.8 || m === merchants[0] ? 'A' : acc <= 0.95 ? 'B' : 'C'; });
    const merchantsA = merchants.filter(m => m.abc === 'A').length;

    // ---- time patterns ----
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = dowNames.map(n => ({ name: n, total: 0, count: 0, days: 0 }));
    for (const t of spend) { const d = new Date(t.date + 'T00:00:00Z').getUTCDay(); dow[d].total += t.amount; dow[d].count++; }
    const start = Date.parse(dates[0]), end = Date.parse(dates[dates.length - 1]);
    for (let x = start; x <= end; x += 86400000) dow[new Date(x).getUTCDay()].days++;
    dow.forEach(d => d.perDay = d.days ? d.total / d.days : 0);
    const weekendPerDay = (dow[0].total + dow[6].total) / Math.max(1, dow[0].days + dow[6].days);
    const weekdayPerDay = sum(dow.slice(1, 6).map(d => d.total)) / Math.max(1, sum(dow.slice(1, 6).map(d => d.days)));

    const dom = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, total: 0, count: 0 }));
    for (const t of spend) { const d = +t.date.slice(8, 10); dom[d - 1].total += t.amount; dom[d - 1].count++; }

    const timed = spend.filter(t => t.time);
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, count: 0 }));
    for (const t of timed) { const h = +t.time.slice(0, 2); hours[h].total += t.amount; hours[h].count++; }
    const lateNight = timed.filter(t => { const h = +t.time.slice(0, 2); return h >= 23 || h < 5; });

    // ---- small transactions ----
    const smallLimit = opts.smallLimit || 250;
    const small = spend.filter(t => t.amount < smallLimit);

    // ---- recurring / subscriptions ----
    const recurring = [];
    for (const [name, list] of groupBy(spend, t => t.merchant)) {
      const byM = groupBy(list, t => monthOf(t.date));
      if (byM.size < 3) continue;
      const perMonth = [...byM.values()].map(l => sum(l.map(t => t.amount)));
      const perMonthCount = [...byM.values()].map(l => l.length);
      const med = median(perMonth);
      const close = perMonth.filter(v => Math.abs(v - med) <= Math.max(0.1 * med, 10)).length / perMonth.length;
      const monthKeys = [...byM.keys()].sort();
      const span = monthRange(monthKeys[0], monthKeys[monthKeys.length - 1]).length;
      if (close < 0.75 || median(perMonthCount) > 2 || byM.size / span < 0.6) continue;
      const lastDate = list.map(t => t.date).sort().pop();
      const amounts = list.map(t => t.amount);
      recurring.push({ name, category: list[0].category, monthly: med, annual: med * 12, months: byM.size, coverage: byM.size / nMonths,
        last: lastDate, active: dayDiff(lastDate, dates[dates.length - 1]) <= 45, cards: [...new Set(list.map(t => t.card))],
        priceChanged: Math.max(...amounts) - Math.min(...amounts) > Math.max(1, 0.05 * med) });
    }
    recurring.sort((a, b) => b.annual - a.annual);

    // ---- duplicates ----
    const duplicates = [];
    for (const [, list] of groupBy(spend.filter(t => t.amount >= 100), t => t.merchant + '|' + t.amount.toFixed(2))) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < list.length; i++) if (dayDiff(list[i].date, list[i - 1].date) <= 1) duplicates.push([list[i - 1], list[i]]);
    }

    // ---- anomalies ----
    const anomalies = [];
    for (const [cat, list] of groupBy(spend, t => t.category)) {
      if (list.length < 6) continue;
      const amts = list.map(t => t.amount);
      const med = median(amts);
      const mad = median(amts.map(a => Math.abs(a - med))) || med * 0.5 || 1;
      for (const t of list) {
        const z = 0.6745 * (t.amount - med) / mad;
        if (z > 3.5 && t.amount >= 3 * med && t.amount >= 1000) anomalies.push({ txn: t, reason: `${Math.round(t.amount / med)} times a usual ${cat.toLowerCase()} purchase (${fmtINR(med)})`, score: z });
      }
    }
    const seenMerchant = new Map();
    const p95 = [...spend.map(t => t.amount)].sort((a, b) => a - b)[Math.floor(spend.length * 0.95)] || Infinity;
    [...spend].sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
      if (!seenMerchant.has(t.merchant)) { seenMerchant.set(t.merchant, 1); if (t.amount >= p95 && t.amount >= 2000 && !anomalies.find(a => a.txn === t)) anomalies.push({ txn: t, reason: 'First purchase here, and one of your biggest', score: 3 }); }
    });
    // category spikes
    const spikes = [];
    for (const c of categories) {
      if (c.byMonth.filter(v => v > 0).length < 3) continue;
      const med = median(c.byMonth.filter(v => v > 0));
      c.byMonth.forEach((v, i) => { if (v > 2 * med && v - med > 2000) spikes.push({ category: c.name, month: months[i], amount: v, typical: med }); });
    }
    anomalies.sort((a, b) => b.txn.amount - a.txn.amount);

    // ---- leakage ----
    const feeGroups = [...groupBy(fees, t => t.category)].map(([name, list]) => ({ name, total: sum(list.map(t => t.amount)), count: list.length, annual: sum(list.map(t => t.amount)) * 12 / nMonths, items: list }))
      .sort((a, b) => b.total - a.total);
    const forexSpend = spend.filter(t => t.foreign);
    const emi = spend.filter(t => t.category === 'EMI');
    const cashAdv = spend.filter(t => t.category === 'Cash advance');

    // ---- per card ----
    const pointValue = opts.pointValue || {};
    const cardStats = cards.map(card => {
      const ct = txns.filter(t => t.card === card);
      const cs = ct.filter(isSpend);
      const cf = ct.filter(isFee);
      const sts = statements.filter(s => s.card === card).sort((a, b) => (a.meta.statementDate || '').localeCompare(b.meta.statementDate || ''));
      const points = sum(ct.map(t => t.points || 0));
      const cb = sum(ct.filter(t => t.category === 'Cashback & rewards').map(t => t.amount));
      const interest = sum(cf.filter(t => t.category === 'Interest & finance charges').map(t => t.amount));
      const late = sum(cf.filter(t => t.category === 'Late payment fees').map(t => t.amount));
      const otherFees = sum(cf.map(t => t.amount)) - interest - late;
      const pv = pointValue[card] != null ? pointValue[card] : 0.25;
      const util = sts.map(s => {
        const lim = s.meta.creditLimit;
        const used = s.meta.totalDue != null ? s.meta.totalDue : (lim && s.meta.availableLimit != null ? lim - s.meta.availableLimit : null);
        return { statementDate: s.meta.statementDate, limit: lim, used, ratio: lim && used != null ? used / lim : null, totalDue: s.meta.totalDue, minDue: s.meta.minDue, dueDate: s.meta.dueDate };
      });
      const ratios = util.map(u => u.ratio).filter(r => r != null && r >= 0 && r < 5);
      // payment behaviour: payments in the next statement vs total due of this one
      const shortfalls = [];
      for (let i = 0; i + 1 < sts.length; i++) {
        const due = sts[i].meta.totalDue;
        if (!(due > 0)) continue;
        const paid = sum(sts[i + 1].txns.filter(t => t.type === 'credit' && (t.category === 'Card payment')).map(t => t.amount));
        if (paid + 1 < due) shortfalls.push({ statementDate: sts[i].meta.statementDate, due, paid });
      }
      const mSpend = groupBy(cs, t => monthOf(t.date));
      return {
        card, spend: sum(cs.map(t => t.amount)), count: cs.length, avgTicket: cs.length ? sum(cs.map(t => t.amount)) / cs.length : 0,
        share: sum(cs.map(t => t.amount)) / (totalSpend || 1), statements: sts.length,
        refunds: sum(ct.filter(t => t.category === 'Refund / reversal').map(t => t.amount)),
        cashback: cb, points, pointValue: pv, interest, late, otherFees, fees: sum(cf.map(t => t.amount)),
        netBenefit: cb + points * pv - sum(cf.map(t => t.amount)),
        effectiveReturn: cs.length ? (cb + points * pv - sum(cf.map(t => t.amount))) / (sum(cs.map(t => t.amount)) || 1) : 0,
        util, avgUtil: ratios.length ? sum(ratios) / ratios.length : null, maxUtil: ratios.length ? Math.max(...ratios) : null,
        latestLimit: [...util].reverse().find(u => u.limit)?.limit || null,
        latest: util[util.length - 1] || null, shortfalls,
        topCategories: [...groupBy(cs, t => t.category)].map(([n, l]) => ({ name: n, total: sum(l.map(t => t.amount)) })).sort((a, b) => b.total - a.total).slice(0, 4),
        activeMonths: mSpend.size,
      };
    });

    // ---- cross-card ----
    const multiCardMerchants = merchants.filter(m => m.cards.length > 1).slice(0, 15);
    const swiggyCard = cards.find(c => /swiggy/i.test(c));
    let missedSwiggy = null;
    if (swiggyCard) {
      const list = spend.filter(t => /^Swiggy/.test(t.merchant) && t.card !== swiggyCard);
      if (list.length) missedSwiggy = { total: sum(list.map(t => t.amount)), count: list.length, card: swiggyCard };
    }
    const upiCards = cards.filter(c => /upi|rupay/i.test(c));

    // ---- behaviour ----
    const foodDelivery = sum(spend.filter(t => t.category === 'Food delivery').map(t => t.amount));
    const foodOrders = spend.filter(t => t.category === 'Food delivery').length;
    const convenience = sum(spend.filter(t => CONVENIENCE.has(t.merchant) || t.category === 'Food delivery').map(t => t.amount));
    const mean = sum(monthlyTotals) / nMonths;
    const sd = Math.sqrt(sum(monthlyTotals.map(v => (v - mean) ** 2)) / nMonths);
    const slope = linearSlope(monthlyTotals);
    const first3 = monthlyTotals.slice(0, Math.min(3, half || 1)), last3 = monthlyTotals.slice(-Math.min(3, half || 1));
    const top5Share = sum(merchants.slice(0, 5).map(m => m.total)) / (totalSpend || 1);

    return {
      empty: false, cards, months, nMonths, txnCount: spend.length, totalSpend, totalRefunds, totalCashback, totalFees, totalPayments,
      netSpend: totalSpend - totalRefunds - totalCashback, avgMonthly: totalSpend / nMonths, avgTicket: spend.length ? totalSpend / spend.length : 0,
      medianTicket: median(spend.map(t => t.amount)), perMonthTxns: spend.length / nMonths,
      monthly, categories, paretoCats, essential, discretionary, merchants, merchantsA,
      dow, weekendPerDay, weekdayPerDay, dom, hours, timedCount: timed.length, lateNight,
      small, smallLimit, recurring, duplicates, anomalies: anomalies.slice(0, 40), spikes,
      feeGroups, forexSpend, emi, cashAdv,
      cardStats, multiCardMerchants, missedSwiggy, upiCards,
      behaviour: {
        foodDelivery, foodShare: foodDelivery / (totalSpend || 1), foodOrdersPerMonth: foodOrders / nMonths,
        convenienceShare: convenience / (totalSpend || 1), discretionaryShare: discretionary / (totalSpend || 1),
        cv: mean ? sd / mean : 0, slopePct: mean ? slope / mean : 0, first3: first3.length ? sum(first3) / first3.length : 0, last3: last3.length ? sum(last3) / last3.length : 0,
        top5Share, smallPerMonth: small.length / nMonths, smallShareCount: small.length / (spend.length || 1),
        lateNightShare: timed.length ? lateNight.length / timed.length : null,
        weekendRatio: weekdayPerDay ? weekendPerDay / weekdayPerDay : null,
      },
    };
  }

  function fmtINR(v, opts) {
    if (v == null || isNaN(v)) return '—';
    const neg = v < 0; v = Math.abs(v);
    const s = opts && opts.compact && v >= 100000 ? (v / 100000).toFixed(v >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + ' L'
      : opts && opts.compact && v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      : v.toLocaleString('en-IN', { maximumFractionDigits: opts && opts.decimals ? 2 : 0, minimumFractionDigits: opts && opts.decimals ? 2 : 0 });
    return (neg ? '−' : '') + '₹' + s;
  }

  function futureValue(monthly, annualRate, years) {
    const r = Math.pow(1 + annualRate, 1 / 12) - 1, n = years * 12;
    const series = [];
    let v = 0;
    for (let i = 1; i <= n; i++) { v = (v + monthly) * (1 + r); if (i % 12 === 0) series.push({ year: i / 12, value: v, invested: monthly * i }); }
    return { value: v, invested: monthly * n, series };
  }

  window.Analysis = { analyse, fmtINR, futureValue, FEE_CATS, isSpend, isFee, monthRange };
})();
