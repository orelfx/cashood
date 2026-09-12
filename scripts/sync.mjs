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
const { getClient } = await load('chain/rpc.js');
const { ERC20_ABI } = await load('chain/abi.js');

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

const books = await readBook();

// ─── fee yang sudah dipanen ──────────────────────────────────────────────
//
// Bot tidak mencatat fee yang sudah dipanen per posisi, jadi satu-satunya cara
// mengetahuinya tanpa mengindeks ulang seluruh chain adalah dengan mengawasi
// angka fee yang belum dipanen: kalau ia terjun mendekati nol sementara
// posisinya masih terbuka, fee-nya baru saja diambil.
//
// Ambangnya sengaja ketat — turun di bawah 30% DAN lebih dari lima puluh sen —
// supaya penurunan harga token, yang juga menggerus nilai fee dalam dolar,
// tidak terhitung sebagai panen. Lebih baik melaporkan kurang daripada
// mengarang angka yang tidak pernah masuk dompet.
const FEES_OUT = resolve(dirname(OUT), 'fees.json');
const feeBook = existsSync(FEES_OUT)
  ? (JSON.parse(readFileSync(FEES_OUT, 'utf8')).positions || {})
  : {};

const positions = [];
for (const book of books) {
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

    const id = String(p.tokenId ?? '');
    const unclaimed = Number(p.feesUsd) || 0;
    const seen = feeBook[id] || { collectedUsd: 0, lastUnclaimedUsd: unclaimed, since: Date.now() };
    if (seen.lastUnclaimedUsd - unclaimed > 0.5 && unclaimed < seen.lastUnclaimedUsd * 0.3) {
      seen.collectedUsd += seen.lastUnclaimedUsd - unclaimed;
    }
    seen.lastUnclaimedUsd = unclaimed;
    feeBook[id] = seen;

    positions.push({
      tokenId: String(p.tokenId ?? ''),
      symbol: p.symbol ?? null,
      strategy: book.strategy ?? null,
      inRange: p.inRange === true,
      principalUsd: Number(p.principalUsd) || 0,
      feesUsd: unclaimed,                          // belum dipanen
      collectedFeesUsd: Number(seen.collectedUsd.toFixed(2)),
      totalFeesUsd: Number((seen.collectedUsd + unclaimed).toFixed(2)),
      feesTrackedSince: seen.since || null,
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

// ─── token lain yang nyangkut di dompet ──────────────────────────────────
//
// Sisa swap dan posisi yang ditutup ke token dasarnya mendarat di dompet dan
// diam di sana. Daftarnya dirakit dari buku bot sendiri — token yang pernah
// dipegang — lalu saldonya dibaca satu per satu; harga diambil dari DexScreener
// yang gratis dan tanpa kunci. Semuanya dibatasi: token yang diperiksa dibatasi
// jumlahnya, dan kegagalan apa pun di sini tidak boleh menjatuhkan snapshot.
const extra = [];
try {
  const client = getClient();
  const seen = new Set([NATIVE, USDG.toLowerCase(), WETH.toLowerCase()]);
  const candidates = [];
  for (const r of [...books.flatMap((b) => b.positions || []), ...closed.slice(0, 60)]) {
    const token = String(r.baseToken || r.token || '').toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
    if (candidates.length >= 25) break;
  }

  const held = [];
  for (const token of candidates) {
    try {
      const [raw, dec] = await Promise.all([
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet.address] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ]);
      if (raw > 0n) held.push({ token, amount: Number(raw) / 10 ** Number(dec) });
    } catch { /* token tidak menjawab; lewati */ }
  }

  for (const h of held.slice(0, 12)) {
    let unit = null, symbol = h.token.slice(0, 8);
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + h.token, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const pair = (j.pairs || []).find((x) => String(x.baseToken?.address || '').toLowerCase() === h.token);
      if (pair) { unit = Number(pair.priceUsd) || null; symbol = pair.baseToken?.symbol || symbol; }
    } catch { /* tanpa harga, barisnya tidak diterbitkan */ }
    const value = unit == null ? null : h.amount * unit;
    if (value != null && value >= 0.5) extra.push({ symbol, amount: h.amount, price: unit, usd: value });
  }
} catch (error) {
  console.error('[cashood] gagal membaca token sisa:', error.message);
}

holdings.push(...extra);

// Posisi yang sudah ditutup tidak perlu diawasi lagi; catatannya dibuang
// supaya berkasnya tidak tumbuh selamanya.
const openIds = new Set(positions.map((p) => p.tokenId));
for (const id of Object.keys(feeBook)) if (!openIds.has(id)) delete feeBook[id];
writeFileSync(FEES_OUT, JSON.stringify({ updatedAt: Date.now(), positions: feeBook }, null, 2) + '\n');

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

// Kas cadangan tinggal di wallet lain, tapi ia tetap harta dana. Kalau tidak
// ikut dihitung, memindahkannya akan terbaca sebagai kerugian sebesar uang
// yang dipindahkan — dan harga saham semua orang turun karena tindakan yang
// justru mengamankan uang mereka.
let treasuryUsd = 0;
try {
  const cfg = JSON.parse(readFileSync(resolve(dirname(OUT), 'config.json'), 'utf8'));
  treasuryUsd = Number(cfg?.treasury?.movedUsd) || 0;
} catch { /* tanpa config, kas cadangan dianggap nol */ }

// Alamat wallet sengaja TIDAK ditulis ke snapshot: berkas ini terbit di repo
// publik, dan satu baris saja sudah cukup untuk menghubungkan situs ini dengan
// dompet yang dipantaunya.
// Kurs rupiah ikut ditulis sebagai cadangan: kalau CoinGecko tidak bisa
// dihubungi dari browser pengunjung, tampilan rupiah tetap punya angka.
let usdIdr = null;
try {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,idr',
    { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const u = Number(j?.ethereum?.usd), i = Number(j?.ethereum?.idr);
  if (u > 0 && i > 0) usdIdr = Number((i / u).toFixed(2));
} catch { /* tanpa kurs, situs mencarinya sendiri */ }

const snapshot = {
  updatedAt: Date.now(),
  usdIdr,
  totalUsd: Number((totalUsd + treasuryUsd).toFixed(2)),
  botWalletUsd: Number(totalUsd.toFixed(2)),
  treasuryUsd,
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
  + ` treasury=$${treasuryUsd} closed=${stats.closedCount} realised=$${stats.realisedUsd} navPoints=${kept.length} -> ${OUT}`);
process.exit(0);
