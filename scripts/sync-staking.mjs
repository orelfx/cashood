#!/usr/bin/env node
/*
 * Staking — MET di-stake di program Referral Staking Meteora (low risk).
 *
 * Yang dibaca otomatis (hanya baca):
 *   - jumlah MET yang di-stake: akun stake wallet di program staking Meteora
 *     (u64 di offset 72; 6 desimal), dan total MET seluruh staker di akun
 *     global (offset 104) — keduanya diverifikasi dengan halaman Meteora;
 *   - harga MET (Jupiter, cadangan CoinGecko);
 *   - statistik siklus publik (APR staking & referral, estimasi rewards).
 * Yang diisi pemilik (config.rewards): rewards diklaim & pending dari halaman
 * Meteora. Rincian rewards per wallet butuh login wallet, jadi tidak bisa
 * dibaca dari server.
 *
 * Untung/rugi = nilai MET sekarang + rewards (diklaim + pending) − modal beli
 * MET. Penurunan harga MET terhadap harga beli ditampilkan terpisah.
 * Alamat wallet dan akun stake hanya ada di data/staking/wallet.local.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../assets/core.js';
import { lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';
import { cashoodEnv } from './lib/rpc-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'staking');
const OUT = resolve(DIR, 'live.json');
const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
const local = JSON.parse(readFileSync(resolve(DIR, 'wallet.local.json'), 'utf8'));
const RPC = cashoodEnv('CASHOOD_SOLANA_RPC') || 'https://api.mainnet-beta.solana.com';
const MET = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
const WIB = 7 * 3600e3;
const r2 = (n) => Number((Number(n) || 0).toFixed(2));

async function rpc(method, params) {
  for (let i = 0; i < 4; i += 1) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await res.json();
      if (j.result !== undefined) return j.result;
    } catch { /* coba lagi */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`RPC ${method} gagal`);
}
async function u64At(account, offset) {
  const info = await rpc('getAccountInfo', [account, { encoding: 'base64' }]);
  if (!info?.value) throw new Error('akun staking tidak terbaca');
  const raw = Buffer.from(info.value.data[0], 'base64');
  return Number(raw.readBigUInt64LE(offset)) / 1e6;
}

// ─── jumlah MET di-stake (on-chain) ────────────────────────────────────────
const stakedMet = await u64At(local.stakeAccount, local.stakedOffset ?? 72);
const totalStakedMet = await u64At(local.globalAccount, local.totalOffset ?? 104);
if (!(stakedMet >= 0) || !(totalStakedMet > 0) || stakedMet > totalStakedMet) throw new Error('jumlah stake tidak wajar');

// ─── harga MET ────────────────────────────────────────────────────────────
let price = null;
try {
  const j = await (await fetch('https://lite-api.jup.ag/price/v3?ids=' + MET, { signal: AbortSignal.timeout(15000) })).json();
  price = Number(j?.[MET]?.usdPrice) || null;
} catch { /* cadangan di bawah */ }
if (!price) {
  try { price = Number((await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=meteora&vs_currencies=usd', { signal: AbortSignal.timeout(10000) })).json())?.meteora?.usd) || null; } catch { /* tetap null */ }
}
if (!price) throw new Error('harga MET tidak tersedia');

// ─── statistik siklus (publik) ─────────────────────────────────────────────
let stats = null;
try {
  const s = await (await fetch('https://referral.meteora.ag/api/v1/campaigns/dlmm-campaign/stats', { signal: AbortSignal.timeout(15000) })).json();
  stats = {
    totalStakedMet: r2(s.totalStakedMet), totalStakers: Number(s.totalStakers) || null,
    aprPct: r2(s.estimatedStakingAprPct), stakingAprPct: r2(s.aprBreakdown?.stakingAprPct), referralAprPct: r2(s.aprBreakdown?.referralAprPct),
    cycle: s.currentEpoch ? { id: String(s.currentEpoch.epochId || '').replace(/^dlmm-campaign-/, ''), start: Date.parse(s.currentEpoch.epochStart), end: Date.parse(s.currentEpoch.epochEnd), estimatedRewardsUsd: r2(s.currentEpoch.estimatedRewardsUsd) } : null,
  };
} catch { /* statistik tidak wajib */ }

// ─── rewards (diisi pemilik dari halaman Meteora) ──────────────────────────
const rw = cfg.rewards || {};
const claimedUsd = r2(rw.claimedUsd), pendingUsd = r2(rw.pendingUsd);
const rewardsUsd = r2(claimedUsd + pendingUsd);

// ─── modal & harga beli ───────────────────────────────────────────────────
const buys = (cfg.events || []).filter((e) => e.type === 'deposit');
const costUsd = r2(buys.reduce((t, e) => t + Number(e.usd), 0));
const boughtMet = buys.reduce((t, e) => t + (Number(e.met) || 0), 0);
const avgBuy = boughtMet > 0 ? costUsd / boughtMet : null;
const metUsd = r2(stakedMet * price);
const priceChangeUsd = avgBuy ? r2((price - avgBuy) * stakedMet) : null;

const share = stakedMet / totalStakedMet;
const stakingApr = Number(stats?.stakingAprPct) || null;
const estStakingPerDay = stakingApr ? r2(metUsd * stakingApr / 100 / 365) : null;
const cyc = stats?.cycle;
const cycleDays = cyc ? (cyc.end - cyc.start) / 86400e3 : null;
const elapsedDays = cyc ? Math.max(0.01, Math.min(cycleDays, (Date.now() - cyc.start) / 86400e3)) : null;
const rewardsAsOf = rw.asOf ? Date.parse(rw.asOf) : null;
const pendingDays = cyc && rewardsAsOf ? Math.max(0.01, (rewardsAsOf - cyc.start) / 86400e3) : null;
const pendingPerDay = pendingDays && pendingUsd ? r2(pendingUsd / pendingDays) : null;

const now = Date.now();
const snapshot = {
  fund: 'staking',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  nativeSymbol: 'SOL',
  totalUsd: r2(metUsd + rewardsUsd),
  botWalletUsd: r2(metUsd + rewardsUsd),
  holdings: [
    { symbol: 'MET (di-stake)', amount: Number(stakedMet.toFixed(6)), price, usd: metUsd },
    { symbol: 'Rewards USDC (diklaim + pending)', amount: rewardsUsd, price: 1, usd: rewardsUsd },
  ],
  positions: [],
  history: [],
  historyNote: 'staking tidak punya posisi yang dibuka-tutup; hasilnya rewards per siklus',
  stats: { closedCount: 0, openCount: 0, graded: 0, wins: 0, losses: 0, winRate: null, realisedUsd: rewardsUsd, timezone: 'Asia/Jakarta (UTC+7)' },
  closedRecent: [],
  staking: {
    stakedMet: Number(stakedMet.toFixed(4)), sharePct: Number((share * 100).toFixed(6)), price,
    metUsd, costUsd, avgBuyPrice: avgBuy ? Number(avgBuy.toFixed(6)) : null, priceChangeUsd,
    priceChangePct: avgBuy ? r2((price / avgBuy - 1) * 100) : null,
    rewards: { claimedUsd, pendingUsd, totalUsd: rewardsUsd, asOf: rewardsAsOf, cycle: rw.cycle ?? null, perDayUsd: pendingPerDay, note: rw.note || null },
    pnlUsd: r2(metUsd + rewardsUsd - costUsd),
    estStakingPerDayUsd: estStakingPerDay,
    stats, cycleDays: cycleDays && r2(cycleDays), elapsedDays: elapsedDays && r2(elapsedDays),
    buys: buys.map((e) => ({ date: e.date, met: Number(e.met) || null, usd: r2(e.usd), price: Number(e.met) ? Number((e.usd / e.met).toFixed(6)) : null, note: e.note || null })),
  },
};
// Alamat Solana tidak tertangkap pemeriksa rahasia umum (yang mencari 0x…).
for (const a of [local.address, local.stakeAccount, local.globalAccount]) if (a && JSON.stringify(snapshot).includes(a)) throw new Error('alamat bocor ke snapshot; dibatalkan');
saveSnapshot(OUT, snapshot, cfg);
console.log(`[staking] total=$${snapshot.totalUsd} MET=${stakedMet.toFixed(2)} @ $${price.toFixed(4)} rewards=$${rewardsUsd}`);
release();
process.exit(0);
