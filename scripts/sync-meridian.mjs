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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import Core from '../assets/core.js';
import { lock, readJSON } from './lib/io.mjs';
import { treasury, parseTransfers } from './lib/treasury.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'meridian');
const release = lock(resolve(OUT_DIR, 'sync.lock.local'));
const HOME = process.env.MERIDIAN_HOME || '/root/main/meridian';
const WIB = 7 * 3600e3;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const trueUsd = (row, name) => Core.number(row[`${name}_true_usd`] ?? row[`${name}_usd`], name);

/**
 * Jalankan CLI bot dan ambil JSON-nya.
 *
 * Dua hal yang perlu ditoleransi: bot menulis baris log sebelum JSON, dan ia
 * keluar dengan status bukan-nol meski datanya lengkap. Yang menentukan sukses
 * di sini adalah JSON yang bisa dibaca, bukan kode keluar.
 */
function cli(command) {
  // The bot installs cache setIntervals. Exit only after its awaited read command
  // has returned and stdout is flushed, rather than waiting for those timers.
  const entry = resolve(HOME, 'cli.js');
  const wrapper = `process.argv = ${JSON.stringify([process.execPath, entry, command])}; await import(${JSON.stringify(pathToFileURL(entry).href)}); await new Promise(r => process.stdout.write('', r)); process.exit(0);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: HOME, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error || run.signal) throw new Error(`CLI ${command} terputus`);
  const out = run.stdout || '';
  const start = out.indexOf('{');
  if (start === -1) {
    throw new Error(`keluaran '${command}' tanpa JSON (status ${run.status}): ${(run.stderr || '').slice(0, 200)}`);
  }
  return JSON.parse(out.slice(start));
}

const balance = cli('balance');
const book = cli('positions');
if (!Array.isArray(book.positions) || balance.error || book.error) throw new Error('CLI mengembalikan data parsial');
const solPrice = Core.number(balance.sol_price, 'Harga SOL', .01);
for (const key of ['sol','sol_usd','usdc']) Core.number(balance[key], key, 0);
// Some balance providers include SOL/USDC again in the token list.
const mainMints = new Set(['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
const extraTokens = (balance.tokens || []).filter(t => !mainMints.has(t.mint));
const unpricedTokens = extraTokens.filter(t => Core.number(t.balance,'Saldo token',0)>0 && t.usd == null);
if (unpricedTokens.length) throw new Error(`${unpricedTokens.length} token bersaldo positif belum memiliki harga; rekonsiliasi sumber sebelum memperbarui NAV`);
for (const t of extraTokens) if (t.balance>0) Core.number(t.usd, 'Nilai token', 0);

// ─── isi dompet ───────────────────────────────────────────────────────────
const holdings = [
  { symbol: 'SOL', amount: num(balance.sol), price: solPrice, usd: num(balance.sol_usd) },
  { symbol: 'USDC', amount: num(balance.usdc), price: 1, usd: num(balance.usdc) },
  ...extraTokens.filter(t=>t.balance>0).map((t) => ({
    symbol: t.symbol || String(t.mint || '').slice(0, 8),
    amount: num(t.balance), price: null, usd: num(t.usd),
  })),
].filter((h) => h.usd > 0);

// ─── posisi terbuka ───────────────────────────────────────────────────────
//
// SATU POSISI TIDAK BISA BERNILAI LEBIH BESAR DARI DANANYA.
//
// Pada 2026-09-21 pukul 21:53 WIB, posisi CATE-USDC terbaca $48.590 pada dana
// bermodal $3.250, dan nilai dana ikut melompat 1.392% menjadi $51.647. Pool
// itu ber-quote USDC, bukan SOL; harganya tidak terbaca benar dan angkanya
// masuk apa adanya. Nilai yang tidak mungkin dicapai sebuah posisi adalah
// bacaan yang salah, bukan kabar baik.
//
// Batasnya diturunkan dari modal dana: sebuah posisi tidak boleh melebihi
// seluruh setoran dikali `maxPositionMultiple` (bawaan 1,5). Yang melewatinya
// memakai nilai terakhir yang pernah terbaca benar, dan kalau belum pernah,
// snapshot dibatalkan agar NAV tidak diam-diam kehilangan posisi.
const cfgFund = (() => {
  try { return JSON.parse(readFileSync(resolve(OUT_DIR, 'config.json'), 'utf8')); }
  catch { throw new Error('Konfigurasi dana tidak terbaca'); }
})();
const setoran = (cfgFund.events || [])
  .filter((e) => e.type === 'deposit')
  .reduce((t, e) => t + num(e.usd), 0);
const batasPosisi = Math.max(
  num(cfgFund.fund?.maxPositionUsd),
  (setoran || num(cfgFund.fund?.capacityUsd) || 10000) * (num(cfgFund.fund?.maxPositionMultiple) || 1.5),
);
const prevLive = readJSON(resolve(OUT_DIR, 'snapshot.local.json')) || readJSON(resolve(OUT_DIR, 'live.json'));
const prevPos = new Map((prevLive?.positions || []).map((x) => [String(x.tokenId), x]));
const ditolak = [];

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

}).map((pos) => {
  if (pos.valueUsd < 0) throw new Error('Nilai posisi negatif');
  if (pos.valueUsd <= batasPosisi) return pos;
  const before = prevPos.get(String(pos.tokenId));
  ditolak.push(`${pos.symbol} terbaca $${pos.valueUsd.toFixed(2)} (batas $${batasPosisi.toFixed(0)})`);
  if (before && Number(before.valueUsd) > 0 && Number(before.valueUsd) <= batasPosisi) {
    return { ...pos, ...before, stale: true, staleReason: 'nilai tidak masuk akal, memakai bacaan terakhir' };
  }
  throw new Error('Nilai posisi tidak masuk akal dan tidak ada cadangan');
});

const walletUsd = holdings.reduce((t, h) => t + h.usd, 0);
const lpUsd = positions.reduce((t, p) => t + p.valueUsd, 0);
const totalUsd = walletUsd + lpUsd;
if (ditolak.length) console.warn(`[meridian] nilai posisi ditolak — ${ditolak.join('; ')}`);

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

const startAt = Math.min(...cfgFund.events.map(Core.eventTime));
let unpricedCloses = 0;
const closes = (tracking.entries || []).filter(e => {
  const at = Date.parse(e.close_ts);
  return Number.isFinite(at) && at >= startAt;
}).map(e => {
  const net = e.realized_pnl_usd ?? e.close_pnl_usd;
  if (net == null || !Number.isFinite(Number(net))) { unpricedCloses++; return null; }
  const opened = state.positions?.[e.position]?.deployed_at;
  return { symbol: e.pool_name || '—', strategy: e.mode || null, netUsd: Core.money(Number(net)),
    netPct: e.close_pnl_pct == null ? null : num(e.close_pnl_pct), sizeUsd: num(e.entry_value_usd),
    openedAt: opened ? Date.parse(opened) : null, closedAt: Date.parse(e.close_ts),
    holdMinutes: opened ? Math.round((Date.parse(e.close_ts)-Date.parse(opened))/60000) : null,
    reason: String(e.close_reason || '').split(':')[0] || null };
}).filter(Boolean).sort((a,b)=>a.closedAt-b.closedAt);

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
  estimated: false,
  unpricedCloses,
  historyComplete: unpricedCloses === 0,
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

const cashFile = resolve(OUT_DIR, 'treasury.jsonl');
const cash = treasury(cfgFund, [], existsSync(cashFile) ? parseTransfers(readFileSync(cashFile,'utf8')) : []);
const snapshot = {
  ...cash,
  fund: 'meridian',
  historyNote: unpricedCloses ? `${unpricedCloses} posisi tertutup belum memiliki nilai realisasi USD; tidak dihitung sebagai nol.` : null,
  updatedAt: Date.now(),
  usdIdr,
  totalUsd: Number(totalUsd.toFixed(2)),
  botWalletUsd: Number(walletUsd.toFixed(2)),

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

saveSnapshot(resolve(OUT_DIR,'live.json'), snapshot, cfgFund);
console.log(`[meridian] total=$${snapshot.totalUsd} positions=${positions.length} complete=${snapshot.quality.complete} unpricedCloses=${unpricedCloses}`);
release();
process.exit(0);
