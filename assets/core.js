/* Pure accounting shared by the browser, exporters, forecasts and invoices. */
(function (root) {
  'use strict';
  const WIB = 7 * 3600000;
  const present = v => v !== null && v !== undefined && v !== '';
  function number(v, label = 'angka', min = -Infinity) {
    if (!present(v) || !['number','bigint','string'].includes(typeof v) || (typeof v === 'string' && !v.trim()) || !Number.isFinite(Number(v)) || Number(v) < min) throw new Error(`${label} tidak valid`);
    return Number(v);
  }
  const cents = v => Math.round(number(v) * 100);
  const money = v => cents(v) / 100;
  const day = at => new Date(at + WIB).toISOString().slice(0, 10);
  function eventTime(e) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) throw new Error('Tanggal transaksi tidak valid');
    const midnight = Date.parse(`${e.date}T00:00:00+07:00`);
    if (!Number.isFinite(midnight) || day(midnight) !== e.date) throw new Error('Tanggal transaksi tidak valid');
    const at = present(e.at) ? number(e.at, 'Waktu transaksi', 1) : midnight;
    if (day(at) !== e.date) throw new Error('Tanggal dan waktu transaksi berbeda');
    return at;
  }
  function buildLedger(cfg, { before = Infinity } = {}) {
    const owners = new Map();
    for (const o of cfg.owners || []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(o.id || '') || owners.has(o.id)) throw new Error('ID investor kosong atau duplikat');
      owners.set(o.id, { ...o, units: 0, deposited: 0, withdrawn: 0, reinvested: 0 });
    }
    const ids = new Set();
    const events = (cfg.events || []).map((e, i) => {
      const at = eventTime(e);
      if (e.id) { if (ids.has(e.id)) throw new Error('ID transaksi duplikat'); ids.add(e.id); }
      if (!['deposit', 'withdraw', 'reinvest'].includes(e.type)) throw new Error(`Jenis transaksi tidak valid: ${e.type}`);
      if (!owners.has(e.owner)) throw new Error(`Investor tidak dikenal: ${e.owner}`);
      number(e.usd, 'Nominal transaksi', 0.01);
      if (Math.abs(cents(e.usd) / 100 - Number(e.usd)) > 1e-8) throw new Error('Nominal harus dalam sen');
      return { ...e, at, _i: i };
    }).filter(e => e.at < before).sort((a, b) => a.at - b.at || a._i - b._i);
    let totalUnits = 0, started = false, foundingDate = null;
    const rows = [], prices = new Map(), closedBatches = new Set();
    let lastBatch = null;
    for (const e of events) {
      const who = owners.get(e.owner), amount = Number(e.usd);
      if (e.type === 'reinvest') {
        if (e.founding || who.units <= 0) throw new Error('Reinvestasi memerlukan kepemilikan yang sudah ada');
        who.reinvested += amount;
        rows.push({ ...e, units: 0, unitPrice: null, ownerName: who.name, color: who.color });
        continue;
      }
      if (e.founding && (e.type !== 'deposit' || started)) throw new Error('Founding hanya boleh pada pembukaan dana');
      const batch = e.founding ? 'founding' : (e.batchId || `event:${e.id || e._i}`);
      if (lastBatch && batch !== lastBatch) closedBatches.add(lastBatch);
      if (closedBatches.has(batch)) throw new Error('Transaksi satu batch harus berurutan');
      lastBatch = batch;
      let price;
      if (e.founding) {
        if (foundingDate && foundingDate !== e.date) throw new Error('Setoran founding harus pada tanggal pembukaan');
        foundingDate = e.date; price = 1;
      }
      else {
        started = true;
        const nav = number(e.navBefore, 'NAV sebelum transaksi', 0.01);
        if (!totalUnits && e.type === 'withdraw') throw new Error('Tidak ada saham untuk ditarik');
        const previous = prices.get(batch);
        if (previous && (previous.nav !== nav || previous.date !== e.date)) throw new Error('NAV/tanggal dalam batch berbeda');
        price = previous?.price ?? (totalUnits > 0 ? nav / totalUnits : 1);
        prices.set(batch, { nav, date: e.date, price });
      }
      const units = amount / price;
      if (e.type === 'withdraw') {
        if (units - who.units > 1e-7) throw new Error(`Penarikan melebihi saham ${who.id}`);
        const removed = Math.min(units, who.units);
        who.units -= removed; totalUnits -= removed; who.withdrawn += amount;
        rows.push({ ...e, units: -removed, unitPrice: price, ownerName: who.name, color: who.color });
      } else {
        who.units += units; totalUnits += units; who.deposited += amount;
        rows.push({ ...e, units, unitPrice: price, ownerName: who.name, color: who.color });
      }
    }
    const list = [...owners.values()];
    const sum = key => money(list.reduce((s, o) => s + o[key], 0));
    const deposited = sum('deposited'), withdrawn = sum('withdrawn'), reinvested = sum('reinvested');
    return { owners: list, totalUnits: Math.max(0, totalUnits), events: rows.reverse(), deposited, withdrawn, reinvested,
      capitalBasis: deposited - withdrawn + reinvested, warnings: [] };
  }
  function allocate(amount, shares, scale = 100) {
    const total = Math.round(number(amount, 'Alokasi', 0) * scale);
    const ids = new Set();
    for (const s of shares) {
      if (!s.id || ids.has(s.id)) throw new Error('ID penerima harus unik');
      ids.add(s.id); number(s.share, 'Porsi', 0);
    }
    const weight = shares.reduce((s, r) => s + r.share, 0);
    if (total && weight <= 0) throw new Error('Tidak ada penerima alokasi');
    const exact = shares.map(s => weight ? total * s.share / weight : 0), out = exact.map(Math.floor);
    let left = total - out.reduce((a, b) => a + b, 0);
    exact.map((v, i) => ({ i, rest: v - out[i] })).sort((a, b) => b.rest - a.rest || a.i - b.i).forEach(({ i }) => { if (left > 0) { out[i]++; left--; } });
    return Object.fromEntries(shares.map((s, i) => [s.id, out[i] / scale]));
  }
  function monthlyCosts(cfg, snapshot = {}) {
    if (present(snapshot.costsShareUsd)) return number(snapshot.costsShareUsd, 'Biaya', 0);
    if (cfg.costs?.shared && cfg.costs?.primary === false) return 0;
    return money((cfg.costs?.items || []).reduce((s, r) => s + number(r.usd, 'Biaya', 0), 0));
  }
  function dividendPlan(cfg, { gross, costs = monthlyCosts(cfg), nav = 0 } = {}) {
    const d = cfg.dividend || {};
    const rate = (v, fallback) => { const n = present(v) ? number(v, 'Persentase', 0) : fallback; if (n > 100) throw new Error('Persentase melebihi 100'); return n; };
    const distributePct = rate(d.distributePct, 100), reinvestPct = rate(d.reinvestPct, 0);
    if (Math.abs(distributePct + reinvestPct - 100) > 1e-9) throw new Error('Pembagian dan reinvestasi harus berjumlah 100%');
    gross = money(number(gross, 'Laba tersedia', 0)); costs = money(number(costs, 'Biaya', 0));
    const net = money(Math.max(0, gross - costs)), distributed = money(net * distributePct / 100);
    const feePct = rate(d.investorFeePct, 0), standardFeePct = rate(d.investorFeeStandardPct, 0);
    const fee = money(distributed * feePct / 100);
    return { gross, costs, net, distributed, reinvest: money(net - distributed), fee, received: money(distributed - fee),
      costsFromFund: money(Math.max(0, costs - gross)), distributePct, reinvestPct, feePct, standardFeePct,
      feeIfStandard: money(distributed * standardFeePct / 100), feeNote: d.investorFeeNote || '',
      nav, navAfter: money(nav - costs - distributed), payDay: d.payDayOfMonth || 1 };
  }
  function allocateDividend(cfg, layers, costs = monthlyCosts(cfg)) {
    const gross = money(layers.reduce((s, l) => s + number(l.grossUsd, 'Laba lapisan', 0), 0));
    const plan = dividendPlan(cfg, { gross, costs });
    const layerCuts = allocate(plan.distributed, layers.map((l, i) => ({ id: String(i), share: l.grossUsd })));
    const totals = new Map();
    layers.forEach((l, i) => {
      const shares = l.ledger.owners.filter(o => o.units > 0).map(o => ({ ...o, share: o.units / l.ledger.totalUnits }));
      l.netUsd = layerCuts[String(i)]; l.costUsd = gross ? costs * l.grossUsd / gross : 0; l.shares = shares;
      l.cut = allocate(l.netUsd, shares);
      shares.forEach(o => { const r = totals.get(o.id) || { id: o.id, name: o.name, color: o.color, gross: 0, parts: [] };
        r.gross = money(r.gross + l.cut[o.id]); r.parts.push({ key: l.key, label: l.label, share: o.share * 100, usd: l.cut[o.id] }); totals.set(o.id, r); });
    });
    const rows = [...totals.values()];
    const fees = allocate(plan.fee, rows.map(r => ({ id: r.id, share: r.gross })));
    rows.forEach(r => { r.feeUsd = fees[r.id]; r.feeStdUsd = money(r.gross * plan.standardFeePct / 100); r.netUsd = money(r.gross - r.feeUsd); });
    if (cents(rows.reduce((s, r) => s + r.netUsd, 0)) !== cents(plan.received)) throw new Error('Alokasi tidak cocok');
    return { plan, rows, layers };
  }
  function distribution(cfg, snapshot = {}, options = {}) {
    const nav = number(options.nav ?? snapshot.totalUsd ?? 0, 'NAV', 0);
    const ledger = buildLedger(cfg, { before: options.before ?? Infinity });
    const base = ledger.capitalBasis + number(cfg.dividend?.retainedUsd ?? 0, 'Basis ditahan', 0);
    const treasury = cfg.dividend?.basis === 'treasury';
    const gross = options.gross ?? (treasury ? (snapshot.treasuryDistributableUsd ?? snapshot.treasuryUsd ?? 0) : Math.max(0, nav - base));
    const period = options.period || day(snapshot.updatedAt || Date.now()).slice(0, 7);
    const legacy = cfg.dividend?.legacy;
    let layers = [{ key: 'current', label: 'laba periode ini', grossUsd: gross, ledger }];
    if (treasury && !present(options.gross) && Array.isArray(snapshot.dividendLayers)) {
      layers = snapshot.dividendLayers.map((l, i) => ({ key: String(i), label: l.label || 'kas tersedia', grossUsd: l.usd,
        ledger: buildLedger(cfg, { before: number(l.before, 'Batas hak dividen', 1) }) }));
      if (cents(layers.reduce((t,l)=>t+l.grossUsd,0)) !== cents(gross)) throw new Error('Lapisan kas tidak cocok');
    } else if (legacy?.period === period && gross > 0) {
      const old = Math.min(gross, number(legacy.grossUsd, 'Laba lama', 0));
      layers = [{ key: 'legacy', label: `laba sebelum ${legacy.cutoff}`, grossUsd: old,
        ledger: buildLedger(cfg, { before: eventTime({ date: legacy.cutoff }) }) }];
      if (gross > old) layers.push({ key: 'current', label: 'laba setelah modal baru', grossUsd: money(gross-old), ledger });
    }
    const result = allocateDividend(cfg, layers, Math.max(0, monthlyCosts(cfg, snapshot) - Number(snapshot.costsPaidUsd || 0)));
    return { ...result, ledger, plan: { ...result.plan, nav, navAfter: money(nav-result.plan.costs-result.plan.distributed),
      base, netDeposits: ledger.deposited-ledger.withdrawn, retained: ledger.reinvested + Number(cfg.dividend?.retainedUsd || 0), treasury, period } };
  }
  function validateSnapshot(s, { now = Date.now(), maxAge = Infinity, complete = false } = {}) {
    number(s?.totalUsd, 'NAV', 0); number(s?.updatedAt, 'Waktu snapshot', 1);
    if (s.updatedAt > now + 60000 || now - s.updatedAt > maxAge) throw new Error('Snapshot kedaluwarsa atau waktunya salah');
    if (!Array.isArray(s.holdings) || !Array.isArray(s.positions)) throw new Error('Komponen snapshot tidak tersedia');
    if (complete && s.quality?.complete !== true) throw new Error('Snapshot belum terverifikasi lengkap');
    for (const h of s.holdings) number(h.usd, 'Nilai token', 0);
    for (const p of s.positions) { number(p.principalUsd, 'Nilai posisi', 0); number(p.feesUsd, 'Fee posisi', 0); }
    if (s.schemaVersion >= 2) {
      const sum = s.holdings.reduce((t,h)=>t+Number(h.usd),0)+s.positions.reduce((t,p)=>t+Number(p.principalUsd)+Number(p.feesUsd),0)+number(s.treasuryUsd ?? 0, 'Kas', 0);
      if (Math.abs(sum - s.totalUsd) > 0.011) throw new Error('Total snapshot tidak cocok dengan komponennya');
    }
    return s;
  }
  const api = { WIB, present, number, money, cents, day, eventTime, buildLedger, allocate, monthlyCosts, dividendPlan, allocateDividend, distribution, validateSnapshot };
  if (typeof module !== 'undefined') module.exports = api;
  root.CashoodCore = api;
})(globalThis);
