#!/usr/bin/env node
/*
 * cashood — snapshot "Robsol".
 *
 * Dana LP di Solana (Meteora DLMM, pasangan TOKEN-SOL). Sama seperti No Risk
 * No Ferari, dompetnya bukan dompet bot kita: situs ini hanya MEMBACA alamat
 * itu. Tidak ada key, tidak ada perintah yang bisa menggerakkan uangnya.
 *
 * Nilai dana = saldo dompet (SOL + token) + nilai tiap posisi LP menurut
 * LP Agent. Saldo dibaca lewat RPC Solana milik situs (CASHOOD_SOLANA_RPC).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Core from '../assets/core.js';
import { atomicJSON, lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';
import { cashoodEnv } from './lib/rpc-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'robsol');
const OUT = resolve(DIR, 'live.json');
const WIB = 7 * 3600e3;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
// Alamatnya dibaca dari berkas lokal, bukan dari config yang ikut terbit.
const WALLET = String(JSON.parse(readFileSync(resolve(DIR, 'wallet.local.json'), 'utf8')).address);
const RPC = cashoodEnv('CASHOOD_SOLANA_RPC') || 'https://api.mainnet-beta.solana.com';

// Kunci LP Agent: milik situs kalau ada, kalau tidak yang sama dengan No Risk
// No Ferari (dari .env bot Robinhood).
const lpKey = (() => {
  const own = cashoodEnv('LPAGENT_API_KEY');
  if (own) return own;
  try {
    const m = readFileSync('/root/robinhood/.env', 'utf8').match(/^\s*LPAGENT_API_KEY\s*=\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch { return ''; }
})();
if (!lpKey) throw new Error('kunci LP Agent tidak tersedia');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Number(num(n).toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function lpAgent(path, extra = {}) {
  const url = new URL('https://api.lpagent.io/open-api/v1/' + path);
  url.searchParams.set('chain', 'SOL');
  url.searchParams.set('owner', WALLET);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'x-api-key': lpKey }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`LP Agent ${path} HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data ?? body;
  const rows = Array.isArray(data) ? data : (data?.data || data?.list || data?.rows);
  if (!Array.isArray(rows)) throw new Error(`LP Agent ${path}: bentuk jawaban tidak dikenal`);
  return rows;
}

// ─── saldo dompet ─────────────────────────────────────────────────────────
const lamports = (await rpc('getBalance', [WALLET])).value;
const tokenAccounts = [];
for (const programId of TOKEN_PROGRAMS) {
  const res = await rpc('getTokenAccountsByOwner', [WALLET, { programId }, { encoding: 'jsonParsed' }]);
  for (const a of res.value) {
    const info = a.account?.data?.parsed?.info;
    const amount = num(info?.tokenAmount?.uiAmount);
    if (info?.mint && amount > 0) tokenAccounts.push({ mint: info.mint, amount });
  }
}
const mints = [...new Set([SOL_MINT, ...tokenAccounts.map((t) => t.mint)])];
const priceRes = await fetch('https://lite-api.jup.ag/price/v3?ids=' + mints.slice(0, 50).join(','), { signal: AbortSignal.timeout(15000) });
if (!priceRes.ok) throw new Error('harga Jupiter tidak terbaca; snapshot lama dipertahankan');
const prices = await priceRes.json();
const solPrice = num(prices[SOL_MINT]?.usdPrice);
if (!(solPrice > 0)) throw new Error('harga SOL tidak terbaca');

// Token tanpa harga dinilai $0 dan tidak disebut namanya: yang terbit hanya
// simbol yang dikenal, bukan alamat mint.
const KNOWN = { [SOL_MINT]: 'wSOL', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
let dustUsd = 0, dustCount = 0;
const holdings = [{ symbol: 'SOL', amount: lamports / 1e9, price: solPrice, usd: (lamports / 1e9) * solPrice }];
for (const t of tokenAccounts) {
  const p = num(prices[t.mint]?.usdPrice);
  const usd = t.amount * p;
  if (KNOWN[t.mint]) holdings.push({ symbol: KNOWN[t.mint], amount: t.amount, price: p || null, usd });
  else { dustUsd += usd; dustCount += 1; }
}
if (dustUsd >= 0.01) holdings.push({ symbol: `token lain (${dustCount})`, amount: dustCount, price: null, usd: dustUsd });
const holdingsOut = holdings.filter((h) => h.usd >= 0.01)
  .map((h) => ({ ...h, amount: Number(h.amount.toFixed(6)), usd: r2(h.usd) }));

// ─── posisi LP ────────────────────────────────────────────────────────────
const openRows = await lpAgent('lp-positions/opening');
const positions = openRows.map((r) => {
  const value = Core.number(r.currentValue ?? r.value, 'Nilai LP', 0);
  const fees = num(r.unCollectedFee ?? r.uncollectedFee);
  const collected = num(r.collectedFee);
  const basis = num(r.inputValue);
  return {
    tokenId: String(r.position ?? r.tokenId ?? r.id ?? ''),
    symbol: r.pairName ?? null,
    bookLabel: r.protocol ? `Meteora ${String(r.strategyType || '').toLowerCase() || 'DLMM'}`.trim() : null,
    inRange: (r.inRange ?? r.isInRange) === true,
    principalUsd: r2(value),
    investedUsd: r2(basis),
    collectedFeesUsd: r2(collected),
    feesUsd: r2(fees),
    valueUsd: r2(value),
    pnlUsd: basis > 0 ? r2(value + fees + collected - basis) : null,
    pnlPct: basis > 0 ? r2(((value + fees + collected - basis) / basis) * 100) : null,
    ageMinutes: Number.isFinite(Date.parse(r.createdAt)) ? Math.round((Date.now() - Date.parse(r.createdAt)) / 60000) : null,
  };
}).filter((p) => p.valueUsd > 0 || p.feesUsd > 0)
  .sort((a, b) => b.valueUsd - a.valueUsd);

const walletUsd = holdingsOut.reduce((s, h) => s + h.usd, 0);
const lpUsd = positions.reduce((s, p) => s + p.valueUsd + p.feesUsd, 0);
const totalUsd = r2(walletUsd + lpUsd);
if (!(totalUsd > 0)) throw new Error(`nilai dompet tidak masuk akal: ${totalUsd}`);

// ─── posisi yang sudah ditutup ────────────────────────────────────────────
// Halaman pertama tiap siklus, digabung ke simpanan lokal; `--backfill`
// menarik beberapa halaman sekali jalan. Jeda antar permintaan menghormati
// batas LP Agent, yang kuncinya dipakai bersama bot Robinhood.
const CLOSED = resolve(DIR, 'closed.json');
const simpanan = existsSync(CLOSED) ? JSON.parse(readFileSync(CLOSED, 'utf8')) : { rows: {} };
simpanan.rows = simpanan.rows || {};
try {
  const halaman = process.argv.includes('--backfill') ? 8 : 1;
  for (let page = 1; page <= halaman; page += 1) {
    await sleep(21000);
    const rows = await lpAgent('lp-positions/historical', { pageSize: 100, page });
    for (const r of rows) {
      const id = String(r.position ?? r.tokenId ?? '');
      if (!id) continue;
      const basis = num(r.inputValue);
      const hasil = num(r.pnl?.value ?? r.pnl);
      const hasilPct = r.pnl?.percent != null && Number.isFinite(num(r.pnl.percent)) ? num(r.pnl.percent) : (basis > 0 ? (hasil / basis) * 100 : null);
      const buka = Date.parse(r.createdAt || '');
      const tutup = Date.parse(r.closeAt || r.close_At || r.updatedAt || '') || null;
      simpanan.rows[id] = {
        symbol: r.pairName ?? null,
        closedAt: tutup,
        investedUsd: r2(basis),
        netUsd: r2(hasil),
        netPct: hasilPct == null ? null : r2(hasilPct),
        feesUsd: r2(r.collectedFee),
        holdMinutes: Number.isFinite(buka) && tutup ? Math.round((tutup - buka) / 60000) : null,
      };
    }
    if (rows.length < 100) break;
  }
  simpanan.updatedAt = Date.now();
  atomicJSON(CLOSED, simpanan);
} catch (err) {
  console.error('[robsol] riwayat posisi tertutup tidak terbaca:', err.message);
}

// Hanya sejak dana ini mulai dicatat (tanggal modal di config).
const mulaiDicatat = Math.min(...(cfg.events || [])
  .map((e) => Number(e.at) || Date.parse(`${e.date}T00:00:00+07:00`))
  .filter((t) => Number.isFinite(t)), Date.now());
const tutup = Object.values(simpanan.rows)
  .filter((r) => Number.isFinite(r.closedAt) && Number.isFinite(r.netUsd) && r.closedAt >= mulaiDicatat)
  .sort((a, b) => a.closedAt - b.closedAt);

const hariWib = (ms) => new Date(ms + WIB).toISOString().slice(0, 10);
const perHari = new Map();
let menang = 0, kalah = 0;
for (const r of tutup) {
  const hari = hariWib(r.closedAt);
  const baris = perHari.get(hari) || { date: hari, usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  baris.usd += r.netUsd; baris.closes += 1;
  if (r.netPct > 0.5) { baris.wins += 1; baris.winUsd += r.netUsd; menang += 1; }
  else if (r.netPct < -0.5) { baris.losses += 1; baris.lossUsd += r.netUsd; kalah += 1; }
  perHari.set(hari, baris);
}
const history = [...perHari.values()]
  .map((r) => ({ ...r, usd: r2(r.usd), winUsd: r2(r.winUsd), lossUsd: r2(r.lossUsd) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const terbaik = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const terburuk = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);

let usdIdr = null;
try {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,idr', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const u = num(j?.solana?.usd), i = num(j?.solana?.idr);
  if (u > 0 && i > 0) usdIdr = Number((i / u).toFixed(2));
} catch { /* tanpa kurs, situs mencarinya sendiri */ }

const now = Date.now();
const snapshot = {
  fund: 'robsol',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr,
  nativeSymbol: 'SOL',
  nativePrice: solPrice,
  totalUsd,
  botWalletUsd: totalUsd,
  walletUsd: r2(walletUsd),
  lpUsd: r2(lpUsd),
  holdings: holdingsOut,
  positions,
  lpSource: 'lpagent',
  history,
  historyNote: 'hasil posisi yang ditutup di dompet ini — uang masuk dan keluar dompet tidak tercatat di sini, jadi angkanya tidak sama dengan perubahan nilai dana',
  stats: {
    closedCount: tutup.length,
    openCount: positions.length,
    graded: menang + kalah,
    wins: menang,
    losses: kalah,
    winRate: menang + kalah ? r2((menang / (menang + kalah)) * 100) : null,
    realisedUsd: r2(tutup.reduce((t, r) => t + r.netUsd, 0)),
    bestDay: terbaik ? { date: terbaik.date, usd: terbaik.usd } : null,
    worstDay: terburuk ? { date: terburuk.date, usd: terburuk.usd } : null,
    worstClosePct: tutup.length ? r2(Math.min(...tutup.map((r) => r.netPct ?? 0))) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  closedRecent: [...tutup].reverse().slice(0, 10),
};
// Alamat Solana tidak tertangkap pemeriksa rahasia umum (yang mencari 0x…),
// jadi diperiksa di sini secara eksplisit.
if (JSON.stringify(snapshot).includes(WALLET)) throw new Error('alamat dompet bocor ke snapshot; dibatalkan');

snapshot.performanceInput = { closes: tutup.map((r) => ({ netUsd: r.netUsd, netPct: r.netPct, closedAt: r.closedAt, holdMinutes: r.holdMinutes, symbol: r.symbol || null })), flatBand: 0.5 };
saveSnapshot(OUT, snapshot, cfg);
console.log(`[robsol] total=$${snapshot.totalUsd} positions=${positions.length} closed=${tutup.length} complete=${snapshot.quality.complete}`);
release();
process.exit(0);
