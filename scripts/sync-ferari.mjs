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

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..', 'data', 'ferari');
const OUT = resolve(DIR, 'live.json');
const NAV = resolve(DIR, 'nav.json');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';
const WIB = 7 * 3600e3;

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
const num = (v) => Number(v || 0);

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
    return fallback;
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
let lpNativePrice = 0;
let lpSource = 'lpagent';
try {
  const rows = await openPositions(WALLET);
  positions = (Array.isArray(rows) ? rows : []).map((r) => {
    const value = num(r.currentValue ?? r.value);
    const fees = num(r.unCollectedFee ?? r.uncollectedFee);
    const basis = num(r.inputValue);
    return {
      tokenId: String(r.tokenId ?? r.id ?? '').split('-').pop(),
      symbol: r.pairName ?? null,
      inRange: (r.inRange ?? r.isInRange) === true,
      principalUsd: Number(basis.toFixed(2)),
      // Nama yang dipakai kartu ringkasan LP di situs; tanpa ini "Modal masuk"
      // tampil $0 padahal angkanya ada.
      investedUsd: Number(basis.toFixed(2)),
      collectedFeesUsd: Number(num(r.collectedFee).toFixed(2)),
      feesUsd: Number(fees.toFixed(2)),
      valueUsd: Number(value.toFixed(2)),
      pnlUsd: Number.isFinite(num(r.pnl)) ? Number(num(r.pnl).toFixed(2)) : null,
      feePct: Number.isFinite(num(r.poolInfo?.feeTier)) ? num(r.poolInfo.feeTier) / 10000 : null,
      ageMinutes: Number.isFinite(num(r.ageHour)) ? Math.round(num(r.ageHour) * 60) : null,
    };
  }).filter((p) => p.valueUsd > 0 || p.feesUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);
} catch (err) {
  lpSource = 'gagal';
  console.error('[ferari] posisi LP tidak terbaca:', err.message);
}

// Harga ETH: dari RPC kalau sempat, kalau tidak dari angka yang sudah ada di
// jawaban LP Agent — dua sumber untuk satu angka, bukan satu titik gagal.
const price = rpcPrice > 0 ? rpcPrice : num(lpNativePrice);
if (!(price > 0)) throw new Error('harga ETH tidak terbaca dari RPC maupun LP Agent');

const holdings = [
  { symbol: 'ETH', amount: nativeEth, priceUsd: price, usd: nativeEth * price },
  { symbol: 'WETH', amount: weth, priceUsd: price, usd: weth * price },
  { symbol: 'USDG', amount: usdg, priceUsd: 1, usd: usdg },
].filter((h) => h.usd > 0.01)
  .map((h) => ({ ...h, amount: Number(h.amount.toFixed(6)), usd: Number(h.usd.toFixed(2)) }));

const walletUsd = holdings.reduce((s, h) => s + h.usd, 0);

const lpUsd = positions.reduce((s, p) => s + p.valueUsd + p.feesUsd, 0);
const totalUsd = Number((walletUsd + lpUsd).toFixed(2));
if (!(totalUsd > 0)) throw new Error(`nilai dompet tidak masuk akal: ${totalUsd}`);

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
const previous = existsSync(NAV) ? (JSON.parse(readFileSync(NAV, 'utf8')).points || []) : [];
const kept = previous.filter((p) => {
  const age = now - p.t;
  if (age < 86400e3) return true;
  const at = new Date(p.t);
  if (age < 7 * 86400e3) return at.getUTCMinutes() < 10;
  return at.getUTCHours() === 0 && at.getUTCMinutes() < 10;
});
kept.push({ t: now, usd: totalUsd, lp: Number(lpUsd.toFixed(2)) });

// Alamat dompet sengaja TIDAK ikut ke snapshot: berkas ini terbit di repo
// publik, dan satu baris saja cukup untuk menghubungkan situs dengan dompetnya.
const snapshot = {
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
  history: [],
  stats: { closedCount: 0, realisedUsd: 0, timezone: 'Asia/Jakarta (UTC+7)' },
  closedRecent: [],
};

mkdirSync(DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(NAV, JSON.stringify({ updatedAt: now, points: kept.slice(-4000) }, null, 2) + '\n');
console.log(`[ferari] total=$${totalUsd} (dompet $${walletUsd.toFixed(2)} + LP $${lpUsd.toFixed(2)})`
  + ` posisi=${positions.length} navPoints=${kept.length}`
  + (slow.length ? ` · lambat: ${slow.join('; ')}` : ''));

// Koneksi RPC yang masih menggantung menahan proses tetap hidup walau seluruh
// pekerjaan sudah selesai dan berkasnya sudah ditulis. Cron sepuluh menit akan
// menumpuk proses zombi kalau dibiarkan.
process.exit(0);
