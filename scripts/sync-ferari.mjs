#!/usr/bin/env node
/*
 * cashood — snapshot "No Risk No Ferari".
 *
 * Dana ketiga, di Robinhood Chain seperti Reborn Rich, tapi dompetnya bukan
 * dompet bot: situs ini hanya MEMBACA alamat itu. Tidak ada key, tidak ada
 * perintah, tidak ada apa pun yang bisa menggerakkan uangnya dari sini.
 *
 * Isinya dihitung sama seperti dana lain: saldo token di dompet + nilai tiap
 * posisi likuiditas Uniswap v4 yang dipegangnya.
 *
 *   RR_HOME=/root/robinhood node scripts/sync-ferari.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Core from '../assets/core.js';
import { atomicJSON, lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'ferari');
const OUT = resolve(DIR, 'live.json');
const NAV = resolve(DIR, 'nav.json');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';
const WIB = 7 * 3600e3;

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
// Alamatnya dibaca dari berkas lokal, bukan dari config yang ikut terbit.
const secret = JSON.parse(readFileSync(resolve(DIR, 'wallet.local.json'), 'utf8'));
const WALLET = String(secret.address);

process.chdir(RR_HOME);
const load = (rel) => import(pathToFileURL(resolve(RR_HOME, rel)).href);
await load('node_modules/dotenv/config.js').catch(() => {});

const { getClient } = await load('chain/rpc.js');
const { ERC20_ABI } = await load('chain/abi.js');
const { USDG, WETH, decimalsOf } = await load('chain/addresses.js');
const { ethUsd } = await load('venue/price.js');
const { openPositions } = await load('venue/lpagent.js');

const client = getClient();
const num = (v) => Core.number(v, 'Angka sumber');

// SATU PEMBACAAN LAMBAT TIDAK BOLEH MENGGANTUNG SELURUH SIKLUS. RPC rantai ini
// dipakai bot ratusan kali per menit; saat ia sibuk, satu getBalance bisa
// menggantung menit-menitan dan cron sepuluh menit menumpuk di belakangnya.
// Yang gagal dianggap nol dan dicatat, bukan membatalkan snapshot.
const slow = [];
const withTimeout = async (label, work, fallback, ms = 20000) => {
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lewat ' + ms + 'ms')), ms)),
    ]);
  } catch (err) {
    slow.push(`${label}: ${err.message}`);
    throw new Error(`Pembacaan ${label} gagal; snapshot lama dipertahankan`);
  }
};

const readErc20 = (token, decimals) => withTimeout(`saldo ${token.slice(0, 8)}`,
  () => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }), 0n)
  .then((raw) => num(raw) / 10 ** decimals);

// ─── saldo dompet ─────────────────────────────────────────────────────────
const [nativeWei, usdg, weth, rpcPrice] = await Promise.all([
  withTimeout('saldo ETH', () => client.getBalance({ address: WALLET }), 0n),
  readErc20(USDG, 6),
  readErc20(WETH, 18),
  withTimeout('harga ETH', () => ethUsd(), 0),
]);
const nativeEth = num(nativeWei) / 1e18;

// ─── posisi likuiditas ────────────────────────────────────────────────────
// Lewat LP Agent, bukan dengan menyisir rantai sendiri. Dompet ini memegang
// 346 NFT posisi seumur hidupnya; membaca satu per satu lewat RPC butuh
// ribuan panggilan dan tidak pernah selesai dalam satu siklus sepuluh menit.
// LP Agent sudah mengindeks posisi yang MASIH terbuka — tujuh di antaranya —
// dan jawabannya ia simpan sepuluh menit, jadi biayanya satu panggilan.
//
// Ia saksi luar, bukan pengambil keputusan: yang dipakai cuma angka, dan
// kalau ia diam, dana ini tampil apa adanya dari saldo dompet saja.
let positions = [];

let lpSource = 'lpagent';
try {
  const rows = await openPositions(WALLET);
  if (!Array.isArray(rows)) throw new Error('Daftar posisi tidak lengkap');
  positions = rows.map((r) => {
    const value = Core.number(r.currentValue ?? r.value, 'Nilai LP', 0);
    const fees = num(r.unCollectedFee ?? r.uncollectedFee);
    const basis = num(r.inputValue);
    return {
      tokenId: String(r.tokenId ?? r.id ?? '').split('-').pop(),
      symbol: r.pairName ?? null,
      inRange: (r.inRange ?? r.isInRange) === true,
      // `principalUsd` di situs berarti NILAI posisi sekarang, di luar fee yang
      // belum dipanen — bukan modal yang dulu dimasukkan. Mengisinya dengan
      // modal awal membuat subjudul "token + LP" tidak sama dengan totalnya
      // ($3.059 di LP pada dana bernilai $2.838).
      principalUsd: Number(value.toFixed(2)),
      // Modal awal punya namanya sendiri; ini yang dipakai kartu "Modal masuk".
      investedUsd: Number(basis.toFixed(2)),
      collectedFeesUsd: Number(num(r.collectedFee ?? 0).toFixed(2)),
      feesUsd: Number(fees.toFixed(2)),
      valueUsd: Number(value.toFixed(2)),
      // Dihitung sendiri: nilai sekarang + fee (dipanen dan belum) − modal.
      // Angka `pnl` dari LP Agent tidak selalu ada dan tidak selalu berupa angka.
      pnlUsd: basis > 0 ? Number((value + fees + num(r.collectedFee ?? 0) - basis).toFixed(2)) : null,
      feePct: Number.isFinite(num(r.poolInfo?.feeTier ?? 0)) ? num(r.poolInfo?.feeTier ?? 0) / 10000 : null,
      ageMinutes: Number.isFinite(num(r.ageHour ?? 0)) ? Math.round(num(r.ageHour ?? 0) * 60) : null,
    };
  }).filter((p) => p.valueUsd > 0 || p.feesUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);
} catch (err) {
  lpSource = 'gagal';
  throw new Error('Posisi LP tidak terbaca; snapshot lama dipertahankan');
}

// Harga ETH: dari RPC kalau sempat, kalau tidak dari angka yang sudah ada di
// jawaban LP Agent — dua sumber untuk satu angka, bukan satu titik gagal.
const price = Core.number(rpcPrice, 'Harga ETH', .01);
if (!(price > 0)) throw new Error('harga ETH tidak terbaca dari RPC maupun LP Agent');

const holdings = [
  { symbol: 'ETH', amount: nativeEth, price: price, usd: nativeEth * price },
  { symbol: 'WETH', amount: weth, price: price, usd: weth * price },
  { symbol: 'USDG', amount: usdg, price: 1, usd: usdg },
].filter((h) => h.usd > 0.01)
  .map((h) => ({ ...h, amount: Number(h.amount.toFixed(6)), usd: Number(h.usd.toFixed(2)) }));

const walletUsd = holdings.reduce((s, h) => s + h.usd, 0);

const lpUsd = positions.reduce((s, p) => s + p.valueUsd + p.feesUsd, 0);
const totalUsd = Number((walletUsd + lpUsd).toFixed(2));
if (!(totalUsd > 0)) throw new Error(`nilai dompet tidak masuk akal: ${totalUsd}`);

// ─── posisi yang sudah ditutup ────────────────────────────────────────────
//
// LP Agent mengindeks posisi tertutup dompet ini (599 saat ditulis), tapi
// mengambil semuanya berarti enam permintaan bertingkat dan jeda 20 detik di
// antaranya — tidak muat dalam satu siklus sepuluh menit. Jadi: halaman
// pertama saja tiap siklus, disimpan lokal, dan digabungkan. Yang baru
// tertutup selalu ada di halaman pertama, jadi tidak ada yang terlewat selama
// sinkronisasi berjalan. `--backfill` menarik seluruh riwayat sekali saja.
const CLOSED = resolve(DIR, 'closed.json');
const simpanan = existsSync(CLOSED) ? JSON.parse(readFileSync(CLOSED, 'utf8')) : { rows: {} };
simpanan.rows = simpanan.rows || {};

const ambilTutup = async (page = 1, pageSize = 100) => {
  const key = String(process.env.LPAGENT_API_KEY || '').trim();
  if (!key) throw new Error('Sumber riwayat belum dikonfigurasi');
  const url = new URL('https://api.lpagent.io/open-api/v1/lp-positions/historical');
  url.searchParams.set('chain', 'ROBINHOOD');
  url.searchParams.set('owner', WALLET);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page', String(page));
  const res = await fetch(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  const data = body?.data ?? body;
  const rows = Array.isArray(data) ? data : (data?.data || data?.list || data?.rows || []);
  return Array.isArray(rows) ? rows : [];
};

const backfill = process.argv.includes('--backfill');
try {
  const halaman = backfill ? 8 : 1;
  for (let page = 1; page <= halaman; page += 1) {
    const rows = await withTimeout(`riwayat tutup hal. ${page}`, () => ambilTutup(page), []);
    if (!rows.length) break;
    for (const r of rows) {
      const id = String(r.tokenId ?? r.position ?? '').split('-').pop();
      if (!id) continue;
      const tutupAt = Date.parse(r.closeAt || r.close_At || r.updatedAt || '') || null;
      const basis = num(r.inputValue);
      // `pnl` dari LP Agent itu OBJEK {value, percent, ...}, bukan angka.
      // Number({}) = NaN, dan NaN yang ditulis ke JSON menjadi null — seluruh
      // riwayat sempat tersimpan tanpa hasil sama sekali karena itu.
      const hasil = num(r.pnl?.value ?? r.pnl);
      const hasilPct = Number.isFinite(num(r.pnl?.percent ?? 0)) && r.pnl?.percent != null
        ? num(r.pnl.percent)
        : (basis > 0 ? (hasil / basis) * 100 : null);
      simpanan.rows[id] = {
        tokenId: id,
        symbol: r.pairName ?? null,
        closedAt: tutupAt,
        investedUsd: Number(basis.toFixed(2)),
        netUsd: Number(hasil.toFixed(2)),
        netPct: hasilPct == null ? null : Number(hasilPct.toFixed(2)),
        feesUsd: Number(num(r.collectedFee ?? 0).toFixed(2)),
        holdMinutes: Number.isFinite(num(r.ageHour ?? 0)) ? Math.round(num(r.ageHour ?? 0) * 60) : null,
      };
    }
    if (backfill && page < halaman) await new Promise((r) => setTimeout(r, 21000));
  }
  simpanan.updatedAt = Date.now();   // `now` baru lahir di bagian deret, di bawah
  atomicJSON(CLOSED, simpanan);
} catch (err) {
  console.error('[ferari] riwayat posisi tertutup tidak terbaca:', err.message);
}

// HANYA SEJAK DANA INI MULAI DICATAT. Dompetnya sudah menutup 599 posisi
// seumur hidupnya, senilai belasan ribu dolar — jauh sebelum kita memantaunya
// dan sebelum modalnya dicatat. Menampilkan semuanya sebagai riwayat profit
// dana ini berarti memamerkan hasil yang bukan milik periode yang dihitung.
const mulaiDicatat = Math.min(...(cfg.events || [])
  .map((e) => Number(e.at) || Date.parse(`${e.date}T00:00:00+07:00`))
  .filter((t) => Number.isFinite(t)), Date.now());

const tutup = Object.values(simpanan.rows)
  .filter((r) => Number.isFinite(r.closedAt) && Number.isFinite(r.netUsd) && r.closedAt >= mulaiDicatat)
  .sort((a, b) => a.closedAt - b.closedAt);

// Hari dihitung pakai jam Jakarta, sama seperti dana lain.
const hariWib = (ms) => new Date(ms + WIB).toISOString().slice(0, 10);
const perHari = new Map();
let menang = 0, kalah = 0;
for (const r of tutup) {
  const hari = hariWib(r.closedAt);
  const baris = perHari.get(hari) || { date: hari, usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  baris.usd += r.netUsd;
  baris.closes += 1;
  if (r.netPct > 0.5) { baris.wins += 1; baris.winUsd += r.netUsd; menang += 1; }
  else if (r.netPct < -0.5) { baris.losses += 1; baris.lossUsd += r.netUsd; kalah += 1; }
  perHari.set(hari, baris);
}
const history = [...perHari.values()]
  .map((r) => ({ ...r, usd: Number(r.usd.toFixed(2)), winUsd: Number(r.winUsd.toFixed(2)), lossUsd: Number(r.lossUsd.toFixed(2)) }))
  .sort((a, b) => a.date.localeCompare(b.date));

const realisedUsd = tutup.reduce((t, r) => t + r.netUsd, 0);
const terbaik = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const terburuk = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);
const closedRecent = [...tutup].reverse().slice(0, 10);

// ─── kurs rupiah, sama seperti dana lain ──────────────────────────────────
let usdIdr = null;
try {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,idr',
    { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const u = Number(j?.ethereum?.usd), i = Number(j?.ethereum?.idr);
  if (u > 0 && i > 0) usdIdr = Number((i / u).toFixed(2));
} catch { /* tanpa kurs, situs mencarinya sendiri */ }

// ─── deret nilai ──────────────────────────────────────────────────────────
const now = Date.now();
// Alamat dompet sengaja TIDAK ikut ke snapshot: berkas ini terbit di repo
// publik, dan satu baris saja cukup untuk menghubungkan situs dengan dompetnya.
const snapshot = {
  fund: 'ferari',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr,
  nativeSymbol: 'ETH',
  nativePrice: price,
  ethPrice: price,
  totalUsd,
  botWalletUsd: totalUsd,
  walletUsd: Number(walletUsd.toFixed(2)),
  lpUsd: Number(lpUsd.toFixed(2)),
  holdings,
  positions,
  lpSource,
  history,
  // Dompet ini dibaca, bukan dijalankan: setoran dan penarikan pemiliknya
  // tidak lewat situs ini, jadi hasil posisi yang ditutup TIDAK sama dengan
  // perubahan nilai dana. Dikatakan terus terang di kartunya.
  historyNote: 'hasil posisi yang ditutup di dompet ini — uang masuk dan keluar dompet tidak tercatat di sini, jadi angkanya tidak sama dengan perubahan nilai dana',
  stats: {
    closedCount: tutup.length,
    openCount: positions.length,
    graded: menang + kalah,
    wins: menang,
    losses: kalah,
    winRate: menang + kalah ? Number(((menang / (menang + kalah)) * 100).toFixed(2)) : null,
    realisedUsd: Number(realisedUsd.toFixed(2)),
    bestDay: terbaik ? { date: terbaik.date, usd: terbaik.usd } : null,
    worstDay: terburuk ? { date: terburuk.date, usd: terburuk.usd } : null,
    worstClosePct: tutup.length ? Number(Math.min(...tutup.map((r) => r.netPct ?? 0)).toFixed(2)) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  closedRecent,
};

snapshot.performanceInput = { closes: tutup.map((r) => ({ netUsd: r.netUsd, netPct: r.netPct, closedAt: r.closedAt, holdMinutes: r.holdMinutes, symbol: r.symbol || null })), flatBand: 0.5 };
saveSnapshot(OUT,snapshot,cfg);
console.log(`[ferari] total=$${snapshot.totalUsd} positions=${positions.length} complete=${snapshot.quality.complete}`);
release();
process.exit(0);
