#!/usr/bin/env node
/*
 * cashood — snapshot dana Meridian (DLMM Meteora di Solana).
 *
 *   MERIDIAN_HOME=/root/main/meridian node scripts/sync-meridian.mjs
 *
 * Angkanya diambil dari CLI bot itu sendiri (`balance` dan `positions`), yang
 * sudah memegang rantai RPC dan sumber harganya sendiri. Situs tidak pernah
 * menyentuh chain, jadi alamat wallet tidak perlu ikut terbit ke mana pun.
 *
 * Catatan penting soal dua skala angka: keluaran bot memuat `*_usd` dan
 * `*_true_usd`. Kode bot sendiri selalu memakai `true` lebih dulu — versi polos
 * meleset ketika bot berjalan dalam mode SOL — jadi script ini mengikuti urutan
 * yang sama, `true_usd ?? usd`.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'data', 'meridian');
const HOME = process.env.MERIDIAN_HOME || '/root/main/meridian';
const WIB = 7 * 3600e3;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const trueUsd = (row, name) => num(row[`${name}_true_usd`] ?? row[`${name}_usd`]);

/**
 * Jalankan CLI bot dan ambil JSON-nya.
 *
 * Dua hal yang perlu ditoleransi: bot menulis baris log sebelum JSON, dan ia
 * keluar dengan status bukan-nol meski datanya lengkap. Yang menentukan sukses
 * di sini adalah JSON yang bisa dibaca, bukan kode keluar.
 */
function cli(command) {
  const run = spawnSync('node', ['cli.js', command], {
    cwd: HOME, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const out = run.stdout || '';
  const start = out.indexOf('{');
  if (start === -1) {
    throw new Error(`keluaran '${command}' tanpa JSON (status ${run.status}): ${(run.stderr || '').slice(0, 200)}`);
  }
  return JSON.parse(out.slice(start));
}

const balance = cli('balance');
const book = cli('positions');
const solPrice = num(balance.sol_price);

// ─── isi dompet ───────────────────────────────────────────────────────────
const holdings = [
  { symbol: 'SOL', amount: num(balance.sol), price: solPrice, usd: num(balance.sol_usd) },
  { symbol: 'USDC', amount: num(balance.usdc), price: 1, usd: num(balance.usdc) },
  ...(balance.tokens || []).map((t) => ({
    symbol: t.symbol || String(t.mint || '').slice(0, 8),
    amount: num(t.balance), price: null, usd: num(t.usd),
  })),
].filter((h) => h.usd >= 0.5);

// ─── posisi terbuka ───────────────────────────────────────────────────────
const positions = (book.positions || []).map((p) => {
  const value = trueUsd(p, 'total_value');
  const unclaimed = trueUsd(p, 'unclaimed_fees');
  const collected = trueUsd(p, 'collected_fees');
  const pnl = trueUsd(p, 'pnl');
  const span = num(p.upper_bin) - num(p.lower_bin);
  const through = span > 0 ? ((num(p.active_bin) - num(p.lower_bin)) / span) * 100 : null;
  return {
    tokenId: String(p.position || ''),
    symbol: p.pair || p.pool_name || '—',
    strategy: p.strategy || 'dlmm',
    inRange: p.in_range === true,
    valueUsd: Number(value.toFixed(2)),
    investedUsd: Number((value - pnl).toFixed(2)),
    principalUsd: Number(Math.max(0, value - unclaimed).toFixed(2)),
    feesUsd: Number(unclaimed.toFixed(2)),
    collectedFeesUsd: Number(collected.toFixed(2)),
    totalFeesUsd: Number((collected + unclaimed).toFixed(2)),
    pnlUsd: Number(pnl.toFixed(2)),
    pnlPct: Number(num(p.pnl_pct).toFixed(2)),
    feePct: null,
    ageMinutes: Math.round(num(p.age_minutes)),
    outOfRangeMinutes: Math.round(num(p.minutes_out_of_range)),
    throughBandPct: through == null ? null : Number(through.toFixed(1)),
  };
});

const walletUsd = holdings.reduce((t, h) => t + h.usd, 0);
const lpUsd = positions.reduce((t, p) => t + p.valueUsd, 0);
const totalUsd = walletUsd + lpUsd;

// ─── riwayat posisi yang sudah ditutup ────────────────────────────────────
//
// Bot menyimpan HASIL DALAM PERSEN, bukan dolar. Dolarnya diperkirakan dari
// ukuran posisi saat dibuka (SOL) dikali harga SOL hari ini — jadi ini
// perkiraan, dan situs menyebutnya begitu.
const readJson = (name) => {
  const p = resolve(HOME, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const state = readJson('state.json') || { positions: {} };
const tracking = readJson('post-close-tracking.json') || { entries: [] };

const sizeOf = (address) => num(state.positions?.[address]?.amount_sol) * solPrice;
const openedAt = (address) => state.positions?.[address]?.deployed_at || null;

const closes = (tracking.entries || [])
  .filter((e) => e.close_ts && Number.isFinite(Number(e.close_pnl_pct)))
  .map((e) => {
    const size = sizeOf(e.position);
    const pct = num(e.close_pnl_pct);
    const opened = openedAt(e.position);
    const closedAt = Date.parse(e.close_ts);
    return {
      symbol: e.pool_name || '—',
      strategy: e.mode || null,
      netPct: Number(pct.toFixed(2)),
      netUsd: Number(((size * pct) / 100).toFixed(2)),
      sizeUsd: Number(size.toFixed(2)),
      openedAt: opened ? Date.parse(opened) : null,
      closedAt,
      holdMinutes: opened ? Math.round((closedAt - Date.parse(opened)) / 60000) : null,
      reason: String(e.close_reason || '').split(':')[0] || null,
    };
  })
  .sort((a, b) => a.closedAt - b.closedAt);

const byDay = new Map();
for (const c of closes) {
  const day = new Date(c.closedAt + WIB).toISOString().slice(0, 10);
  const row = byDay.get(day) || { date: day, usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  row.usd += c.netUsd;
  row.closes += 1;
  // Sama dengan ambang win rate di bawah (±0,05%): di dalamnya dihitung impas.
  if (c.netPct > 0.05) { row.wins += 1; row.winUsd += c.netUsd; }
  else if (c.netPct < -0.05) { row.losses += 1; row.lossUsd += c.netUsd; }
  byDay.set(day, row);
}
const history = [...byDay.values()]
  .map((r) => ({ ...r, usd: Number(r.usd.toFixed(2)), winUsd: Number(r.winUsd.toFixed(2)), lossUsd: Number(r.lossUsd.toFixed(2)) }))
  .sort((a, b) => a.date.localeCompare(b.date));

const wins = closes.filter((c) => c.netPct > 0.05).length;
const losses = closes.filter((c) => c.netPct < -0.05).length;
const best = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const worst = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);
const sizes = closes.map((c) => c.sizeUsd).filter((s) => s > 0);

const lossPcts = closes.map((c) => c.netPct).filter((v) => Number.isFinite(v));
const countBelow = (limit) => lossPcts.filter((v) => v <= limit).length;

const losers = lossPcts.filter((v) => v < 0);
const winners = lossPcts.filter((v) => v > 0);
const avg = (list) => (list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(2)) : null);


const stats = {
  closedCount: closes.length,
  graded: lossPcts.length,
  worstClosePct: lossPcts.length ? Number(Math.min(...lossPcts).toFixed(2)) : null,
  avgLossPct: avg(losers),
  avgWinPct: avg(winners),
  losersCount: losers.length,
  lossBuckets: { below50: countBelow(-50), below80: countBelow(-80), below90: countBelow(-90), below99: countBelow(-99) },
  winRate: closes.length ? Number(((wins / closes.length) * 100).toFixed(2)) : null,
  wins,
  losses,
  avgInvestedUsd: sizes.length ? Number((sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)) : null,
  realisedUsd: Number(closes.reduce((t, c) => t + c.netUsd, 0).toFixed(2)),
  bestDay: best ? { date: best.date, usd: best.usd } : null,
  worstDay: worst ? { date: worst.date, usd: worst.usd } : null,
  openCount: positions.length,
  openFeesUsd: Number(positions.reduce((t, p) => t + p.feesUsd, 0).toFixed(2)),
  estimated: true,
  timezone: 'Asia/Jakarta (UTC+7)',
};

// ─── kurs rupiah, cadangan kalau browser tidak bisa menghubungi CoinGecko ──
let usdIdr = null;
try {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,idr',
    { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const u = num(j?.solana?.usd), i = num(j?.solana?.idr);
  if (u > 0 && i > 0) usdIdr = Number((i / u).toFixed(2));
} catch { /* situs mencarinya sendiri */ }

const snapshot = {
  updatedAt: Date.now(),
  usdIdr,
  totalUsd: Number(totalUsd.toFixed(2)),
  botWalletUsd: Number(walletUsd.toFixed(2)),
  treasuryUsd: 0,
  solPrice,
  ethPrice: null,
  nativeSymbol: 'SOL',
  nativePrice: solPrice,
  holdings: holdings.map((h) => ({ ...h, usd: Number(h.usd.toFixed(2)) })),
  positions,
  history,
  stats,
  closedRecent: [...closes].reverse().slice(0, 10),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'live.json'), JSON.stringify(snapshot, null, 2) + '\n');

// ─── deret nilai dana ─────────────────────────────────────────────────────
const NAV = resolve(OUT_DIR, 'nav.json');
const now = Date.now();
const previous = existsSync(NAV) ? (JSON.parse(readFileSync(NAV, 'utf8')).points || []) : [];
// Deret ini ikut diunduh tiap kali halaman dibuka, jadi kerapatannya dibayar
// pengunjung. Dua hari penuh pada 10 menit itu 288 titik untuk garis yang di
// layar HP lebarnya 350 piksel — halus di data, tidak kelihatan di mata.
// Sehari terakhir tetap 10 menit (yang dilihat orang), seminggu terakhir per
// jam, sisanya harian. 40 KB turun jadi sekitar 15 KB.
const kept = previous.filter((p) => {
  const age = now - p.t;
  if (age < 86400e3) return true;
  const at = new Date(p.t);
  if (age < 7 * 86400e3) return at.getUTCMinutes() < 10;
  return at.getUTCHours() === 0 && at.getUTCMinutes() < 10;
});
kept.push({ t: now, usd: snapshot.totalUsd, lp: Number(lpUsd.toFixed(2)) });
writeFileSync(NAV, JSON.stringify({ updatedAt: now, points: kept.slice(-4000) }, null, 2) + '\n');

console.log(`[meridian] ${new Date().toISOString()} total=$${snapshot.totalUsd}`
  + ` (dompet $${snapshot.botWalletUsd} + LP $${lpUsd.toFixed(2)})`
  + ` posisi=${positions.length} ditutup=${closes.length} navPoints=${kept.length}`);
process.exit(0);
