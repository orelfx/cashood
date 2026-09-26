// Kinerja nyata sebuah dana: dari posisi yang sudah ditutup dan dari deret
// nilai dananya. Tidak ada angka yang diperkirakan di sini — semua dihitung
// dari yang benar-benar terjadi. Dipakai ketiga exporter.
const DAY = 86400000;
const WIB = 7 * 3600000;
const day = (ms) => new Date(ms + WIB).toISOString().slice(0, 10);
const round = (v, dp = 2) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Statistik per posisi yang ditutup.
 * rows: [{ netUsd, netPct (persen), closedAt, holdMinutes, symbol }]
 * Menang/kalah memakai ambang ±flatBand persen, sama dengan laporan bot:
 * posisi di dalam ambang itu impas dan tidak ikut membagi win rate.
 */
export function tradeStats(rows, { flatBand = 0.5 } = {}) {
  // Posisi dihitung kalau punya waktu tutup DAN salah satu dari hasil dolar atau
  // hasil persen. Meridian hanya menyimpan persen; statistik yang butuh dolar
  // (laba kotor, rugi kotor, harapan per posisi) tidak dikarang untuknya.
  const t = rows.filter((r) => Number.isFinite(r.closedAt) && (Number.isFinite(r.netUsd) || Number.isFinite(r.netPct)))
    .sort((a, b) => a.closedAt - b.closedAt);
  if (!t.length) return null;
  const pct = (r) => (Number.isFinite(r.netPct) ? r.netPct : (Number.isFinite(r.netUsd) ? Math.sign(r.netUsd) * (flatBand + 1) : 0));
  const wins = t.filter((r) => pct(r) > flatBand), losses = t.filter((r) => pct(r) < -flatBand);
  const usdComplete = t.every((r) => Number.isFinite(r.netUsd));
  const usdRows = t.filter((r) => Number.isFinite(r.netUsd));
  const grossProfit = usdRows.filter((r) => r.netUsd > 0).reduce((s, r) => s + r.netUsd, 0);
  const grossLoss = usdRows.filter((r) => r.netUsd < 0).reduce((s, r) => s + r.netUsd, 0);
  const net = usdRows.reduce((s, r) => s + r.netUsd, 0);
  const pctWin = t.filter((r) => pct(r) > 0).reduce((s, r) => s + pct(r), 0);
  const pctLoss = t.filter((r) => pct(r) < 0).reduce((s, r) => s + pct(r), 0);
  let win = 0, loss = 0, maxWin = 0, maxLoss = 0;
  for (const r of t) {
    if (pct(r) > flatBand) { win += 1; loss = 0; maxWin = Math.max(maxWin, win); }
    else if (pct(r) < -flatBand) { loss += 1; win = 0; maxLoss = Math.max(maxLoss, loss); }
  }
  const key = usdComplete ? (r) => r.netUsd : pct;
  const best = t.reduce((a, r) => (key(r) > key(a) ? r : a)), worst = t.reduce((a, r) => (key(r) < key(a) ? r : a));
  const holds = t.map((r) => r.holdMinutes).filter((m) => Number.isFinite(m) && m >= 0);
  const spanDays = Math.max(1, (t[t.length - 1].closedAt - t[0].closedAt) / DAY);
  const meanUsd = (a) => (usdComplete && a.length ? a.reduce((s, r) => s + r.netUsd, 0) / a.length : null);
  const meanPct = (a) => (a.length ? a.reduce((s, r) => s + pct(r), 0) / a.length : null);
  const pfUsd = usdComplete && grossLoss < 0 ? grossProfit / -grossLoss : null;
  const pfPct = pctLoss < 0 ? pctWin / -pctLoss : null;
  return {
    count: t.length, wins: wins.length, losses: losses.length, flat: t.length - wins.length - losses.length,
    winRate: wins.length + losses.length ? round((wins.length / (wins.length + losses.length)) * 100) : null,
    usdComplete,
    netUsd: usdComplete ? round(net) : null,
    grossProfitUsd: usdComplete ? round(grossProfit) : null, grossLossUsd: usdComplete ? round(grossLoss) : null,
    // Profit factor dari dolar kalau semua posisi punya nilai dolar; kalau
    // tidak, dari persen per posisi — dan dasarnya ikut diterbitkan.
    profitFactor: round(pfUsd ?? pfPct), profitFactorBasis: pfUsd != null ? 'usd' : (pfPct != null ? 'pct' : null),
    expectancyUsd: usdComplete ? round(net / t.length) : null,
    expectancyPct: round(meanPct(t)),
    avgWinUsd: round(meanUsd(wins)), avgLossUsd: round(meanUsd(losses)),
    avgWinPct: round(meanPct(wins)), avgLossPct: round(meanPct(losses)),
    best: { usd: usdComplete ? round(best.netUsd) : null, pct: round(pct(best)), symbol: best.symbol || null, at: best.closedAt },
    worst: { usd: usdComplete ? round(worst.netUsd) : null, pct: round(pct(worst)), symbol: worst.symbol || null, at: worst.closedAt },
    longestWinStreak: maxWin, longestLossStreak: maxLoss,
    avgHoldMinutes: holds.length ? Math.round(holds.reduce((s, m) => s + m, 0) / holds.length) : null,
    tradesPerDay: round(t.length / spanDays, 1),
    firstAt: t[0].closedAt, lastAt: t[t.length - 1].closedAt,
  };
}

/**
 * Kinerja dari deret nilai dana, dikoreksi arus kas.
 * points: [{ t, usd }] — nilai total dana. flows: [{ at, usd }] — setoran (+),
 * penarikan (−). Setoran menaikkan nilai dana tapi bukan hasil; di antara dua
 * titik, arus kas yang terjadi dikurangkan dulu sebelum hasil dihitung. Dari
 * situ disusun indeks (seperti harga per saham) yang tidak melompat saat uang
 * masuk. Penurunan terdalam dibaca dari indeks itu, titik per titik — itulah
 * "floating" terdalam yang pernah dialami dana.
 */
export function equityStats(points, flows = [], { minDaysRatio = 14, minDaysCalmar = 30 } = {}) {
  const p = points.filter((x) => Number.isFinite(x.t) && x.usd > 0).sort((a, b) => a.t - b.t);
  if (p.length < 2) return null;
  const f = flows.filter((x) => Number.isFinite(x.at) && Number.isFinite(x.usd)).sort((a, b) => a.at - b.at);
  let index = 1, peak = 1, peakAt = p[0].t, peakUsd = p[0].usd;
  let maxDd = 0, maxDdAt = null, maxDdPeakUsd = p[0].usd, maxDdTroughUsd = p[0].usd;
  const idx = [{ t: p[0].t, i: 1 }];
  for (let k = 1; k < p.length; k += 1) {
    const prev = p[k - 1], cur = p[k];
    const flow = f.filter((x) => x.at > prev.t && x.at <= cur.t).reduce((s, x) => s + x.usd, 0);
    const r = (cur.usd - flow) / prev.usd - 1;
    if (!Number.isFinite(r) || r <= -1) continue;
    index *= 1 + r;
    idx.push({ t: cur.t, i: index });
    if (index > peak) { peak = index; peakAt = cur.t; peakUsd = cur.usd; }
    const dd = 1 - index / peak;
    if (dd > maxDd) { maxDd = dd; maxDdAt = cur.t; maxDdPeakUsd = peakUsd; maxDdTroughUsd = cur.usd; }
  }
  // Hasil harian dari indeks, pakai titik terakhir tiap hari WIB.
  const byDay = new Map();
  for (const x of idx) byDay.set(day(x.t), x.i);
  const closes = [...byDay.values()];
  const daily = [];
  for (let k = 1; k < closes.length; k += 1) daily.push(closes[k] / closes[k - 1] - 1);
  const n = daily.length;
  const avg = n ? daily.reduce((s, v) => s + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(daily.reduce((s, v) => s + (v - avg) ** 2, 0) / (n - 1)) : 0;
  const downs = daily.filter((v) => v < 0);
  const dsd = downs.length ? Math.sqrt(downs.reduce((s, v) => s + v * v, 0) / n) : 0;
  const totalReturn = index - 1;
  const spanDays = Math.max(1, (p[p.length - 1].t - p[0].t) / DAY);
  const annual = Math.pow(1 + totalReturn, 365 / spanDays) - 1;
  const current = 1 - index / peak;
  return {
    days: n, spanDays: round(spanDays, 1),
    returnPct: round(totalReturn * 100),
    maxDrawdownPct: round(maxDd * 100), maxDrawdownAt: maxDdAt,
    maxDrawdownUsd: round(maxDdPeakUsd * maxDd), maxDrawdownPeakUsd: round(maxDdPeakUsd), maxDrawdownTroughUsd: round(maxDdTroughUsd),
    currentDrawdownPct: round(current * 100), currentDrawdownUsd: round(p[p.length - 1].usd * (current / Math.max(1e-9, 1 - current))),
    positiveDaysPct: n ? round((daily.filter((v) => v > 0).length / n) * 100) : null,
    bestDayPct: n ? round(Math.max(...daily) * 100) : null, worstDayPct: n ? round(Math.min(...daily) * 100) : null,
    // Rasio tahunan dari periode pendek mudah melebar tak masuk akal; di bawah
    // batas hari minimal, angkanya tidak diterbitkan.
    sharpe: n >= minDaysRatio && sd > 0 ? round((avg / sd) * Math.sqrt(365)) : null,
    sortino: n >= minDaysRatio && dsd > 0 ? round((avg / dsd) * Math.sqrt(365)) : null,
    calmar: spanDays >= minDaysCalmar && maxDd > 0 ? round(annual / maxDd) : null,
    since: p[0].t,
  };
}

/**
 * Skor strategi 0–100 dari lima sumbu. Rumusnya sengaja sederhana dan ditulis
 * di halaman, supaya siapa pun bisa menghitung ulang:
 *   win rate      = win rate itu sendiri
 *   profit factor = PF 1 → 0, PF 3 atau lebih → 100
 *   risiko        = 100 − 2,5 × penurunan terdalam (%)  (40% → 0)
 *   pemulihan     = recovery factor 5 atau lebih → 100
 *   konsistensi   = persentase hari yang naik
 */
export function strategyScore(trades, equity, recoveryFactor) {
  const axis = {
    winRate: trades?.winRate == null ? null : clamp(trades.winRate, 0, 100),
    profitFactor: trades?.profitFactor == null ? null : clamp(((trades.profitFactor - 1) / 2) * 100, 0, 100),
    risk: equity?.maxDrawdownPct == null ? null : clamp(100 - 2.5 * equity.maxDrawdownPct, 0, 100),
    recovery: recoveryFactor == null ? null : clamp((recoveryFactor / 5) * 100, 0, 100),
    consistency: equity?.positiveDaysPct == null ? null : clamp(equity.positiveDaysPct, 0, 100),
  };
  const vals = Object.values(axis).filter((v) => v != null);
  return {
    axes: Object.fromEntries(Object.entries(axis).map(([k, v]) => [k, v == null ? null : round(v)])),
    overall: vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length) : null,
    complete: vals.length === 5,
  };
}

/** Semua digabung jadi satu blok `performance` untuk snapshot publik. */
export function buildPerformance({ closes = [], points = [], flows = [], capitalUsd = 0, navUsd = 0, flatBand = 0.5 }) {
  const trades = tradeStats(closes, { flatBand });
  const equity = equityStats(points, flows);
  const profit = navUsd - capitalUsd;
  const recoveryFactor = equity?.maxDrawdownUsd > 0 ? round(profit / equity.maxDrawdownUsd) : null;
  return {
    generatedAt: Date.now(),
    trades, equity,
    profitUsd: round(profit), profitPct: capitalUsd > 0 ? round((profit / capitalUsd) * 100) : null,
    recoveryFactor,
    score: strategyScore(trades, equity, recoveryFactor),
  };
}
