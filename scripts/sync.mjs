#!/usr/bin/env node
/*
 * cashood — snapshot exporter (opsional).
 *
 * Situsnya sendiri hanya bisa membaca saldo token dari RPC publik. Nilai posisi
 * LP tidak kelihatan dari browser, jadi script ini yang menghitungnya: dia
 * memakai kode bot yang sudah ada (bookValueUsd + readBook) lalu menulis
 * data/live.json. Yang keluar cuma angka — tidak ada key, tidak ada seed.
 *
 *   RR_HOME=/root/robinhood node scripts/sync.mjs
 *
 * Jalankan tiap jam lewat cron, lalu commit + push data/live.json:
 *   0 * * * * cd /root/cashood && node scripts/sync.mjs >> /tmp/cashood-sync.log 2>&1
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '..', 'data', 'live.json');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';

const load = (rel) => import(pathToFileURL(resolve(RR_HOME, rel)).href);

process.chdir(RR_HOME);                       // .env dan .state dibaca relatif ke sini
await load('node_modules/dotenv/config.js').catch(() => {});

const { bookValueUsd, readBook } = await load('manager.js');
const { balanceOf } = await load('venue/quote.js');
const { ethUsd } = await load('venue/price.js');
const { getWallet } = await load('chain/signer.js');
const { getClosed } = await load('store.js');
const { NATIVE, USDG, WETH, decimalsOf } = await load('chain/addresses.js');

const wallet = getWallet('multi');
if (!wallet) throw new Error('wallet "multi" tidak ketemu — cek RR_* di .env');

const price = await ethUsd();
const [eth, usdg, weth] = await Promise.all([
  balanceOf(NATIVE, wallet.address).catch(() => 0n),
  balanceOf(USDG, wallet.address).catch(() => 0n),
  balanceOf(WETH, wallet.address).catch(() => 0n),
]);

const holdings = [
  { symbol: 'ETH', amount: Number(eth) / 1e18, price },
  { symbol: 'USDG', amount: Number(usdg) / 1e6, price: 1 },
  { symbol: 'WETH', amount: Number(weth) / 1e18, price },
]
  .map((h) => ({ ...h, usd: h.price == null ? null : h.amount * h.price }))
  .filter((h) => h.usd == null || h.usd >= 0.01);            // buang debu sisa swap

// Modal per posisi disimpan bot dalam satuan token kuotanya, bukan dolar.
// Hanya tiga token yang boleh jadi kuota di sini, jadi konversinya pasti.
const toUsd = (amount, token) => {
  const dec = decimalsOf(token);
  if (dec == null) return null;
  const units = Number(amount) / 10 ** dec;
  const quote = String(token || '').toLowerCase();
  if (quote === USDG.toLowerCase()) return units;
  if (quote === WETH.toLowerCase() || quote === NATIVE) return price == null ? null : units * price;
  return null;
};

const positions = [];
for (const book of await readBook()) {
  for (const p of book.positions || []) {
    if (p.error) continue;

    const investedUsd = toUsd(p.basisQuote, p.quoteToken);
    const valueUsd = Number(p.valueUsd);          // principal + fee yang belum dipanen
    const pnlUsd = investedUsd == null || !Number.isFinite(valueUsd) ? null : valueUsd - investedUsd;

    // Seberapa jauh harga berjalan di dalam pitanya — 0% di tepi bawah,
    // 100% di tepi atas. Di luar pita angkanya keluar dari rentang itu.
    const span = Number(p.tickUpper) - Number(p.tickLower);
    const through = Number.isFinite(span) && span > 0
      ? ((Number(p.currentTick) - Number(p.tickLower)) / span) * 100
      : null;

    positions.push({
      tokenId: String(p.tokenId ?? ''),
      symbol: p.symbol ?? null,
      strategy: book.strategy ?? null,
      inRange: p.inRange === true,
      principalUsd: Number(p.principalUsd) || 0,
      feesUsd: Number(p.feesUsd) || 0,            // belum dipanen
      valueUsd: Number.isFinite(valueUsd) ? Number(valueUsd.toFixed(2)) : null,
      investedUsd: investedUsd == null ? null : Number(investedUsd.toFixed(2)),
      pnlUsd: pnlUsd == null ? null : Number(pnlUsd.toFixed(2)),
      pnlPct: pnlUsd == null || !investedUsd ? null : Number(((pnlUsd / investedUsd) * 100).toFixed(2)),
      feePct: Number(p.lpFeePct) || null,
      ageMinutes: Math.round(Number(p.ageMinutes) || 0),
      outOfRangeMinutes: Math.round(Number(p.outOfRangeMinutes) || 0),
      throughBandPct: through == null ? null : Number(through.toFixed(1)),
    });
  }
}

// ─── riwayat profit yang sudah terkunci (posisi yang ditutup) ─────────────
const closed = getClosed({ limit: 5000 }).filter((r) => Number.isFinite(Number(r.netUsd)));

// Hari dihitung pakai jam Jakarta, bukan UTC. Posisi yang ditutup jam 2 pagi
// WIB itu kejadian hari itu buat operatornya — kalau dibiarkan UTC, angkanya
// mendarat di kotak kalender hari sebelumnya.
const WIB_OFFSET = 7 * 3600e3;
const dayKey = (ts) => new Date((Number(ts) || 0) + WIB_OFFSET).toISOString().slice(0, 10);

const byDay = new Map();
let wins = 0, losses = 0, graded = 0;
const bases = [];

for (const r of closed) {
  const netUsd = Number(r.netUsd);
  const day = dayKey(r.closedAt);
  const row = byDay.get(day) || { date: day, usd: 0, closes: 0, wins: 0 };
  row.usd += netUsd;
  row.closes += 1;

  const pct = Number(r.netPct);
  if (Number.isFinite(pct)) {
    graded += 1;
    if (pct > 0.005) { wins += 1; row.wins += 1; }
    else if (pct < -0.005) losses += 1;
    // Modal per posisi tidak disimpan dalam dolar, tapi netUsd/netPct memberi
    // angka yang sama tanpa perlu tahu token kuotenya apa.
    if (Math.abs(pct) > 1e-6) bases.push(Math.abs(netUsd / pct));
  }
  byDay.set(day, row);
}

const history = [...byDay.values()]
  .map((r) => ({ ...r, usd: Number(r.usd.toFixed(2)) }))
  .sort((a, b) => a.date.localeCompare(b.date));

const realisedUsd = history.reduce((s, r) => s + r.usd, 0);
const best = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const worst = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);

// Sepuluh posisi terakhir yang ditutup — cukup untuk melihat apa yang baru
// saja terjadi tanpa mengunduh dua ratus baris yang tidak dibaca siapa pun.
const closedRecent = [...closed]
  .sort((a, b) => (Number(b.closedAt) || 0) - (Number(a.closedAt) || 0))
  .slice(0, 10)
  .map((r) => ({
    symbol: r.symbol ?? null,
    strategy: r.strategy ?? null,
    netUsd: Number(Number(r.netUsd).toFixed(2)),
    netPct: Number.isFinite(Number(r.netPct)) ? Number((Number(r.netPct) * 100).toFixed(2)) : null,
    openedAt: Number(r.openedAt) || null,
    closedAt: Number(r.closedAt) || null,
    holdMinutes: r.openedAt && r.closedAt ? Math.round((r.closedAt - r.openedAt) / 60000) : null,
    reason: String(r.closeReason || '').split(':')[0] || null,
  }));

const stats = {
  closedCount: closed.length,
  winRate: graded ? Number(((wins / graded) * 100).toFixed(2)) : null,
  wins,
  losses,
  avgInvestedUsd: bases.length ? Number((bases.reduce((s, b) => s + b, 0) / bases.length).toFixed(2)) : null,
  realisedUsd: Number(realisedUsd.toFixed(2)),
  bestDay: best ? { date: best.date, usd: best.usd } : null,
  worstDay: worst ? { date: worst.date, usd: worst.usd } : null,
  openCount: positions.length,
  openFeesUsd: Number(positions.reduce((s, p) => s + (Number(p.feesUsd) || 0), 0).toFixed(2)),
  timezone: 'Asia/Jakarta (UTC+7)',
};

const totalUsd = await bookValueUsd('multi');
if (!Number.isFinite(totalUsd) || totalUsd <= 0) throw new Error(`bookValueUsd tidak masuk akal: ${totalUsd}`);

const snapshot = {
  updatedAt: Date.now(),
  address: wallet.address,
  totalUsd: Number(totalUsd.toFixed(2)),
  ethPrice: price,
  holdings,
  positions,
  history,
  stats,
  closedRecent,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');

// ─── deret nilai wallet ───────────────────────────────────────────────────
//
// Satu titik tiap kali script ini jalan. Yang lama diencerkan, bukan dibuang:
// dua hari terakhir disimpan utuh, sebulan terakhir sejam sekali, sisanya
// sehari sekali. Tanpa itu, tiap 10 menit selama setahun jadi 52 ribu titik —
// file yang harus diunduh ulang tiap kali orang buka halamannya.
const NAV_OUT = resolve(dirname(OUT), 'nav.json');
const now = Date.now();

const previous = existsSync(NAV_OUT)
  ? (JSON.parse(readFileSync(NAV_OUT, 'utf8')).points || [])
  : [];

const kept = previous.filter((p) => {
  const age = now - p.t;
  if (age < 2 * 86400e3) return true;
  const at = new Date(p.t);
  if (age < 30 * 86400e3) return at.getUTCMinutes() < 10;
  return at.getUTCHours() === 0 && at.getUTCMinutes() < 10;
});

kept.push({ t: now, usd: snapshot.totalUsd, lp: Number(positions.reduce((s, p) => s + p.principalUsd + p.feesUsd, 0).toFixed(2)) });

writeFileSync(NAV_OUT, JSON.stringify({
  updatedAt: now,
  points: kept.slice(-4000),
}, null, 2) + '\n');
console.log(`[cashood] ${new Date().toISOString()} total=$${snapshot.totalUsd} positions=${positions.length}`
  + ` closed=${stats.closedCount} realised=$${stats.realisedUsd} navPoints=${kept.length} -> ${OUT}`);
process.exit(0);
