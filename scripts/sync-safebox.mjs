#!/usr/bin/env node
/*
 * cashood — snapshot Safe Box.
 *
 *   RR_HOME=/root/robinhood node scripts/sync-safebox.mjs
 *
 * Safe Box adalah SATU posisi likuiditas. Yang dibaca di sini cuma posisi itu,
 * lewat nomor posisinya — bukan lewat alamat dompet, jadi alamatnya tidak perlu
 * ada di mana pun, termasuk di berkas ini.
 *
 * Yang dilaporkan: nilai posisi sekarang, dan fee yang sudah dihasilkannya.
 * Fee yang sudah dipanen tidak dicatat di chain per posisi, jadi diawasi sendiri
 * dengan cara yang sama seperti dana lain: fee-belum-dipanen yang terjun
 * mendekati nol berarti baru saja diambil.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..', 'data', 'safebox');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';
const WIB = 7 * 3600e3;

const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
// Identitas posisi dibaca dari berkas lokal yang tidak ikut terbit: tokenId
// menunjuk ke posisi di blockchain, dan dari sana dompetnya ketahuan.
const secret = JSON.parse(readFileSync(resolve(DIR, 'position.local.json'), 'utf8'));
const tokenId = BigInt(secret.position.tokenId);

process.chdir(RR_HOME);
const load = (rel) => import(pathToFileURL(resolve(RR_HOME, rel)).href);
await load('node_modules/dotenv/config.js').catch(() => {});

const { getPositionPnl } = await load('venue/univ4.js');
const { ethUsd } = await load('venue/price.js');

const price = Number(await ethUsd()) || 0;
const pos = await getPositionPnl({ tokenId });

const num = (v) => Number(v || 0);
const eth = (wei) => (num(wei) / 1e18) * price;
const usdg = (units) => num(units) / 1e6;

// currency0 pada pool ini adalah ETH asli, currency1 adalah USDG.
const valueUsd = eth(pos.amount0) + usdg(pos.amount1);
const unclaimedUsd = eth(pos.fees0) + usdg(pos.fees1);

// ─── fee yang sudah dipanen ───────────────────────────────────────────────
const FEES = resolve(DIR, 'fees.json');
const book = existsSync(FEES) ? JSON.parse(readFileSync(FEES, 'utf8')) : { collectedUsd: 0, lastUnclaimedUsd: unclaimedUsd, since: Date.now() };
// SATU PEMBACAAN KACAU TIDAK BOLEH MERUSAK BUKU FEE. Pada 2026-09-20
// collectedUsd terisi 1,6e46 — fee yang terbaca sekali meleset jauh, lalu
// tersimpan selamanya karena buku ini hanya menambah. Fee yang belum dipanen
// tidak mungkin lebih besar dari posisinya sendiri; yang di atas itu diabaikan
// dan tidak ikut disimpan.
const sane = (v) => Number.isFinite(v) && v >= 0 && v <= Math.max(10, valueUsd * 2);
const lastUnclaimed = sane(num(book.lastUnclaimedUsd)) ? num(book.lastUnclaimedUsd) : 0;
if (!sane(num(book.collectedUsd))) book.collectedUsd = 0;
if (sane(unclaimedUsd) && lastUnclaimed - unclaimedUsd > 0.02 && unclaimedUsd < lastUnclaimed * 0.3) {
  book.collectedUsd += lastUnclaimed - unclaimedUsd;
}
if (sane(unclaimedUsd)) book.lastUnclaimedUsd = unclaimedUsd;
writeFileSync(FEES, JSON.stringify(book, null, 2) + '\n');

const principal = Number(secret.principalUsd) || 0;   // ukuran posisi asli, hanya untuk mengukur laju
const interest = book.collectedUsd + unclaimedUsd;

// ─── deret nilai, untuk mengukur laju bunga ───────────────────────────────
const SERIES = resolve(DIR, 'nav.json');
const now = Date.now();
const points = existsSync(SERIES) ? (JSON.parse(readFileSync(SERIES, 'utf8')).points || []) : [];
const kept = points.filter((p) => {
  const age = now - p.t;
  if (age < 2 * 86400e3) return true;
  const at = new Date(p.t);
  if (age < 30 * 86400e3) return at.getUTCMinutes() < 10;
  return at.getUTCHours() === 0 && at.getUTCMinutes() < 10;
});
kept.push({ t: now, usd: Number(valueUsd.toFixed(2)), fee: Number(interest.toFixed(4)) });
writeFileSync(SERIES, JSON.stringify({ updatedAt: now, points: kept.slice(-4000) }, null, 2) + '\n');

/**
 * Laju bunga diukur dari pertumbuhan fee yang tercatat, bukan dari angka tetap.
 *
 * Dipakai jendela terpanjang yang tersedia sampai tujuh hari; kalau catatannya
 * masih pendek, dipakai sejak awal pengamatan. Jendela yang terlalu pendek
 * membuat satu jam sepi terbaca sebagai penurunan bunga yang besar.
 */
const startedAt = Date.parse(secret.startedAt || cfg.startedAt) || book.since || now;
const window = kept.filter((p) => now - p.t <= 7 * 86400e3);
const first = window.length > 1 ? window[0] : null;
const seriesDays = first ? (now - first.t) / 86400e3 : 0;

// Jendela yang terlalu pendek membuat laju bunga meledak: satu jam pengamatan
// yang kebetulan memuat panen fee akan terbaca sebagai ratusan persen setahun.
// Di bawah satu hari catatan, dipakai seluruh umur posisi.
const useSeries = first && seriesDays >= 1;
const spanDays = Math.max(0.5, useSeries ? seriesDays : (now - startedAt) / 86400e3);
const feeGain = Math.max(0, useSeries ? interest - num(first.fee) : interest);
const perDay = feeGain / spanDays;
const apyActualPct = principal > 0 ? (perDay / principal) * 365 * 100 : null;

// ─── laju bunga: 0,1%–3% per bulan ───────────────────────────────────────
// Lajunya diukur dari fee yang benar-benar dihasilkan posisi ETH/USD: fee per
// hari dibagi ukuran posisi, dikali 30. Fee $0,10 sehari pada posisi $300
// berarti 1% sebulan. Yang ditampilkan dikunci di antara minMonthlyPct dan
// maxMonthlyPct — fee sebesar apa pun berhenti di batas atas, dan turunnya
// harga (termasuk impermanent loss) tidak pernah membuatnya minus.
const monthlyActualPct = principal > 0 ? (perDay * 30 / principal) * 100 : 0;
const minMonthly = Number.isFinite(Number(cfg.rate?.minMonthlyPct)) ? Number(cfg.rate.minMonthlyPct) : 0;
const maxMonthly = Number.isFinite(Number(cfg.rate?.maxMonthlyPct)) ? Number(cfg.rate.maxMonthlyPct) : Infinity;
const monthlyPct = Math.min(maxMonthly, Math.max(minMonthly, monthlyActualPct));

// ─── nilai yang ditampilkan, dan bunganya yang ditabung ──────────────────
// Yang tampil di halaman adalah nilai tetap `display.principalUsd`; ukuran
// posisi aslinya tidak ikut terbit.
//
// Bunga DITABUNG, tidak dihitung ulang dari laju hari ini. Kalau dihitung
// ulang, laju yang turun dari 3% ke 1% akan membuat saldo yang sudah tampil
// ikut turun — padahal bunga yang sudah lewat tidak bisa ditarik kembali.
// Tiap sepuluh menit, sepotong bunga sebesar laju saat itu ditambahkan:
//
//   tambahan = nilai tampil × laju sebulan × (selisih waktu / 30 hari)
//
// Karena lajunya tidak pernah negatif, saldonya tidak pernah turun.
const shownPrincipal = Number(cfg.display?.principalUsd) || principal;
const ACCRUAL = resolve(DIR, 'accrual.json');
const acc = existsSync(ACCRUAL)
  ? JSON.parse(readFileSync(ACCRUAL, 'utf8'))
  : { accruedUsd: 0, lastAt: now, startedAt: now };
const dtDays = Math.max(0, Math.min(1, (now - Number(acc.lastAt || now)) / 86400e3));
const added = shownPrincipal * (monthlyPct / 100) * (dtDays / 30);
acc.accruedUsd = Number(acc.accruedUsd || 0) + added;
acc.lastAt = now;
acc.lastMonthlyPct = Number(monthlyPct.toFixed(4));
writeFileSync(ACCRUAL, JSON.stringify(acc, null, 2) + '\n');

const interestShown = acc.accruedUsd;
const perDayShown = shownPrincipal * (monthlyPct / 100) / 30;
const apyPct = monthlyPct * 365 / 30;

// Yang terbit hanya angka tampilan. Nilai posisi, fee asli dan lajunya yang
// sebenarnya tidak ikut — berkas ini ada di repo publik.
const snapshot = {
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  venue: secret.position.venue || 'LP',
  principalUsd: Number(shownPrincipal.toFixed(2)),
  valueUsd: Number((shownPrincipal + interestShown).toFixed(2)),
  interestUsd: Number(interestShown.toFixed(4)),
  balanceUsd: Number((shownPrincipal + interestShown).toFixed(2)),
  inRange: pos.inRange === true,
  measure: {
    monthlyPct: Number(monthlyPct.toFixed(2)),
    apyPct: Number(apyPct.toFixed(2)),
    perDayUsd: Number(perDayShown.toFixed(4)),
    minMonthlyPct: minMonthly,
    maxMonthlyPct: Number.isFinite(maxMonthly) ? maxMonthly : null,
    capped: monthlyActualPct > maxMonthly,
    spanDays: Number(spanDays.toFixed(2)),
    since: new Date((useSeries ? first.t : startedAt) + WIB).toISOString().slice(0, 10),
    basis: useSeries ? 'pertumbuhan fee tercatat' : 'seluruh fee sejak posisi dibuka',
  },
  ethPrice: price,
  nativeSymbol: 'ETH',
  nativePrice: price,
};

// Angka sebenarnya, untuk pemilik saja. Tidak pernah terbit.
const internal = {
  updatedAt: now,
  lpValueUsd: Number(valueUsd.toFixed(2)),
  lpPrincipalUsd: Number(principal.toFixed(2)),
  feesUsd: Number(interest.toFixed(4)),
  feesPerDayUsd: Number(perDay.toFixed(4)),
  monthlyActualPct: Number(monthlyActualPct.toFixed(2)),
  shownMonthlyPct: Number(monthlyPct.toFixed(2)),
  accruedUsd: Number(interestShown.toFixed(4)),
};

mkdirSync(DIR, { recursive: true });
writeFileSync(resolve(DIR, 'live.json'), JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(resolve(DIR, 'internal.json'), JSON.stringify(internal, null, 2) + '\n');
console.log(`[safebox] tampil $${snapshot.balanceUsd} (pokok $${snapshot.principalUsd} + bunga $${snapshot.interestUsd})`
  + ` · ${snapshot.measure.monthlyPct}%/bulan`
  + ` · internal: LP $${internal.lpValueUsd}, fee $${internal.feesUsd}, terukur ${internal.monthlyActualPct}%/bulan`
  + ` (diukur ${snapshot.measure.spanDays} hari)`);
process.exit(0);
