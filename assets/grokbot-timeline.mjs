/*
 * Replay buku paper Devil Greed.
 * Hanya kejadian yang sudah ada di feed: titik nav, buka posisi (dari hold/umur
 * atau keputusan enter), jual separuh, dan tutup penuh. Tidak ada harga
 * sisipan dan tidak ada kejadian karangan. Di antara dua titik nav, saldo
 * tetap di titik nyata terakhir sampai jam replay menyentuh titik berikutnya.
 */
const MATCH_MS = 2 * 60e3;
const WIN_BAND = 0.5;
const RANK = { open: 0, partial: 1, close: 2, nav: 3 };

export const BIG_USD = 20;
export const BIG_PCT = 30;

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const isPartial = (c) => /^jual separuh/i.test(c?.reasonDetail || '');

export function isBigClose(e) {
  const net = num(e?.netUsd);
  const pctv = num(e?.netPct);
  return !!e && (e.type === 'partial' || e.type === 'close') && net != null && net > 0 && (net >= BIG_USD || (pctv != null && pctv >= BIG_PCT));
}

function blankLot(symbol, openedAt, book) {
  return {
    symbol, openedAt, book: book || null, partialAt: null, partialInv: null, closeAt: null, closeInv: null,
    posCost: null, openPos: null,
  };
}

function findLot(lots, symbol, openedAt, openOnly) {
  if (!symbol || openedAt == null) return null;
  return lots.find((l) => l.symbol === symbol && l.openedAt != null && Math.abs(l.openedAt - openedAt) <= MATCH_MS && (!openOnly || l.closeAt == null)) || null;
}

function navPoints(live, nav) {
  const raw = (nav?.points || [])
    .map((p) => ({ t: num(p.t), usd: num(p.usd) }))
    .filter((p) => p.t != null && p.usd != null)
    .sort((a, b) => a.t - b.t || a.usd - b.usd);
  const points = [];
  for (const p of raw) {
    if (points.length && points.at(-1).t === p.t) points[points.length - 1] = { t: p.t, usd: p.usd, source: 'nav' };
    else points.push({ t: p.t, usd: p.usd, source: 'nav' });
  }
  const updatedAt = num(live?.updatedAt);
  const total = num(live?.totalUsd);
  if (updatedAt != null && total != null && (!points.length || updatedAt > points.at(-1).t)) {
    points.push({ t: updatedAt, usd: total, source: 'live' });
  }
  return points;
}

export function buildReplay(live, nav, closes) {
  const initialUsd = num(live?.trading?.initialUsd);
  const startedAt = num(live?.trading?.startedAt);
  const updatedAt = num(live?.updatedAt);
  const cashUsd = num(live?.trading?.cashUsd);
  const points = navPoints(live, nav);
  const lots = [];
  const closeRows = (closes || []).filter((c) => num(c?.closedAt) != null).map((c) => {
    const hold = num(c.holdMinutes);
    return {
      symbol: c.symbol || '',
      book: c.strategy || c.bookLabel || null,
      closedAt: num(c.closedAt),
      openedAt: hold != null && hold >= 0 ? num(c.closedAt) - hold * 60000 : null,
      partial: isPartial(c),
      investedUsd: num(c.investedUsd),
      netUsd: num(c.netUsd),
      netPct: num(c.netPct),
      reason: c.reason || null,
      reasonDetail: c.reasonDetail || null,
    };
  });

  for (const c of closeRows) {
    let lot = findLot(lots, c.symbol, c.openedAt, false);
    if (!lot && c.openedAt != null && c.symbol) {
      lot = blankLot(c.symbol, c.openedAt, c.book);
      lots.push(lot);
    }
    if (!lot) continue;
    if (!lot.book && c.book) lot.book = c.book;
    if (c.partial) {
      if (lot.partialAt == null || c.closedAt < lot.partialAt) { lot.partialAt = c.closedAt; lot.partialInv = c.investedUsd; }
    } else if (lot.closeAt == null || c.closedAt < lot.closeAt) { lot.closeAt = c.closedAt; lot.closeInv = c.investedUsd; }
  }

  for (const p of live?.positions || []) {
    const age = num(p.ageMinutes);
    if (!p.symbol || age == null || age < 0 || updatedAt == null) continue;
    const openedAt = updatedAt - age * 60000;
    let lot = findLot(lots, p.symbol, openedAt, true);
    if (!lot) { lot = blankLot(p.symbol, openedAt, p.bookLabel); lots.push(lot); }
    if (p.bookLabel) lot.book = p.bookLabel;
    lot.posCost = num(p.costUsd);
    lot.openPos = {
      valueUsd: num(p.valueUsd), pnlUsd: num(p.pnlUsd), pnlPct: num(p.pnlPct),
      stopPct: num(p.stopPct), targetPct: num(p.targetPct), peakPct: num(p.peakPct),
      strategy: p.strategy || '', stale: p.stale === true,
    };
  }

  for (const d of live?.copyTrade?.decisions || []) {
    const at = num(d.at);
    const action = String(d.action || '').toLowerCase();
    if (at == null || action !== 'enter' || !d.symbol || d.symbol === 'tanpa simbol') continue;
    if (findLot(lots, d.symbol, at, false)) continue;
    const m = String(d.reason || '').match(/beli paper \$([\d.,]+)/);
    const lot = blankLot(d.symbol, at, d.basket || null);
    lot.posCost = m ? num(m[1].replace(/,/g, '')) : null;
    lots.push(lot);
  }

  for (const lot of lots) {
    const part = lot.partialInv;
    const rest = lot.closeInv != null ? lot.closeInv : lot.posCost;
    lot.costOpen = part != null && rest != null ? part + rest : (rest ?? part ?? lot.posCost);
    lot.costRest = rest;
  }

  const events = [];
  for (const p of points) events.push({ type: 'nav', t: p.t, usd: p.usd, source: p.source });
  for (const lot of lots) {
    if (lot.openedAt == null) continue;
    events.push({ type: 'open', t: lot.openedAt, symbol: lot.symbol, book: lot.book, cost: lot.costOpen, source: 'lot' });
  }
  for (const c of closeRows) {
    events.push({
      type: c.partial ? 'partial' : 'close', t: c.closedAt, symbol: c.symbol, book: c.book,
      cost: c.investedUsd, investedUsd: c.investedUsd, netUsd: c.netUsd, netPct: c.netPct,
      reason: c.reason, reasonDetail: c.reasonDetail, source: 'close',
    });
  }
  events.sort((a, b) => a.t - b.t || (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) || String(a.symbol || '').localeCompare(String(b.symbol || '')));

  const times = [...(startedAt != null ? [startedAt] : []), ...(updatedAt != null ? [updatedAt] : []), ...events.map((e) => e.t)];
  const start = times.length ? Math.min(...times) : 0;
  const end = times.length ? Math.max(...times) : start;
  return { initialUsd, startedAt, updatedAt, cashUsd, points, lots, events, start, end };
}

export function frameAt(replay, t) {
  const navSeen = replay.points.filter((p) => p.t <= t);
  let balance = navSeen.length ? navSeen.at(-1).usd : null;
  if (balance == null && replay.startedAt != null && t >= replay.startedAt && replay.initialUsd != null) balance = replay.initialUsd;
  const pnl = balance != null && replay.initialUsd != null ? balance - replay.initialUsd : null;
  const done = replay.events.filter((e) => (e.type === 'partial' || e.type === 'close') && e.t <= t && e.netUsd != null);
  const wins = done.filter((e) => e.netPct != null && e.netPct > WIN_BAND).length;
  const losses = done.filter((e) => e.netPct != null && e.netPct < -WIN_BAND).length;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : null;
  const realized = done.reduce((s, e) => s + e.netUsd, 0);
  const won = done.filter((e) => e.netUsd > 0);
  const largestWin = won.length ? won.reduce((a, b) => (b.netUsd > a.netUsd ? b : a)) : null;
  const positions = replay.lots.filter((lot) => lot.openedAt != null && lot.openedAt <= t && (lot.closeAt == null || lot.closeAt > t)).map((lot) => {
    const after = lot.partialAt != null && lot.partialAt <= t;
    const show = !!(lot.openPos && replay.updatedAt != null && t >= replay.updatedAt);
    return {
      symbol: lot.symbol, book: lot.book, openedAt: lot.openedAt,
      cost: after ? (lot.costRest ?? lot.costOpen) : lot.costOpen,
      value: show ? lot.openPos.valueUsd : null,
      pnl: show ? lot.openPos.pnlUsd : null,
      pnlPct: show ? lot.openPos.pnlPct : null,
      stopPct: show ? lot.openPos.stopPct : null,
      targetPct: show ? lot.openPos.targetPct : null,
      peakPct: show ? lot.openPos.peakPct : null,
      strategy: show ? lot.openPos.strategy : '',
      stale: show ? lot.openPos.stale : false,
      partial: after,
    };
  }).sort((a, b) => (b.cost || 0) - (a.cost || 0) || String(a.symbol).localeCompare(String(b.symbol)));
  const log = replay.events.filter((e) => e.type !== 'nav' && e.t <= t);
  return {
    t, balance, initialUsd: replay.initialUsd, pnl, realized, wins, losses, winRate, largestWin, positions,
    navPoints: navSeen, log,
    cash: replay.updatedAt != null && t >= replay.updatedAt ? replay.cashUsd : null,
  };
}

export function stepTime(replay, t, dir) {
  if (dir > 0) {
    const n = replay.events.find((e) => e.t > t);
    return n ? n.t : replay.end;
  }
  let prev = null;
  for (const e of replay.events) if (e.t < t) prev = e.t;
  return prev == null ? replay.start : prev;
}
