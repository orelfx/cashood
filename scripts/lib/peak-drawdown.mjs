/*
 * Puncak & titik terendah posisi LP Meridian (dicatat bot sejak 6 Okt 2026).
 *
 * Masukan: entri penutupan dari post-close-tracking.json (sudah diarsipkan
 * Cashood, jadi tidak terbatas 200 terakhir). Semua persen basis SOL, sama
 * dengan close_pnl_pct — bukan dolar. Titik terendah yang tidak diketahui
 * (null) tidak pernah dihitung sebagai 0: ia tidak ikut rata-rata dan tampil
 * "—". Alamat (position, base_mint) tidak pernah keluar dari modul ini.
 */
const BOOKS = { bigcap: 'Big cap', mid: 'Mid', midcap: 'Mid', degen: 'Degen', lowcap: 'Low cap' };
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const r2 = (n) => (n == null ? null : Number(n.toFixed(2)));
const clean = (s, max = 240) => (s ? String(s).replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '…').replace(/0x[0-9a-fA-F]{16,}/g, '0x…').replace(/\s+/g, ' ').trim().slice(0, max) : null);
const avg = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Satu baris per posisi yang punya data puncak/titik terendah. */
export function peakRows(entries, openedOf = () => null) {
  return entries.map((e) => {
    const peak = num(e.peak_pnl_pct), dd = num(e.max_drawdown_pct);
    if (peak == null && dd == null) return null;          // sebelum 6 Okt: belum dicatat
    const peakAt = time(e.peak_at), ddAt = time(e.max_drawdown_at), since = time(e.drawdown_tracked_since);
    const opened = openedOf(e);
    const book = e.book ?? e._book ?? null;                // basket; arsip lama dari state bot
    return {
      symbol: clean(e.pool_name, 40) || '—',
      book: book ? String(book).toLowerCase() : null,
      bookLabel: book ? BOOKS[String(book).toLowerCase()] || String(book) : '—',
      closePct: r2(num(e.close_pnl_pct)),
      peakPct: r2(peak), peakAt,
      ddPct: r2(dd), ddAt,
      // Titik terendah mulai dicatat setelah posisi dibuka → angkanya parsial.
      partial: since != null && opened != null && since > opened + 60000,
      first: peakAt != null && ddAt != null ? (peakAt < ddAt ? 'puncak' : peakAt > ddAt ? 'terendah' : 'bersamaan') : null,
      netUsd: num(e.realized_pnl_usd) == null ? null : r2(num(e.realized_pnl_usd)),
      exitDetail: clean(e.exit_detail),
      closedAt: time(e.close_ts),
    };
  }).filter(Boolean).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
}

/** Ringkasan satu kelompok (basket atau koin). */
export function groupStats(rows) {
  const peaks = rows.map((r) => r.peakPct).filter((v) => v != null);
  const dds = rows.map((r) => r.ddPct).filter((v) => v != null);
  const closes = rows.map((r) => r.closePct).filter((v) => v != null);
  return {
    closes: rows.length,
    avgPeak: r2(avg(peaks)), medPeak: r2(median(peaks)),
    avgDd: r2(avg(dds)), medDd: r2(median(dds)), worstDd: dds.length ? r2(Math.min(...dds)) : null,
    ddKnown: dds.length,
    // Sempat turun ≤ −10% tapi akhirnya ditutup untung.
    recovered: rows.filter((r) => r.ddPct != null && r.ddPct <= -10 && r.closePct != null && r.closePct > 0).length,
    medClose: r2(median(closes)),
  };
}

export function buildPeakDrawdown(entries, openedOf) {
  const rows = peakRows(entries, openedOf);
  if (!rows.length) return { since: '2026-10-06', rows: [], books: [], coins: [] };
  const by = (key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const books = [...by((r) => r.bookLabel)].map(([label, rs]) => ({ label, ...groupStats(rs) })).sort((a, b) => b.closes - a.closes);
  const coins = [...by((r) => r.symbol)].filter(([, rs]) => rs.length >= 3).map(([label, rs]) => ({ label, ...groupStats(rs) })).sort((a, b) => b.closes - a.closes);
  return { since: '2026-10-06', rows, books, coins, all: groupStats(rows) };
}
