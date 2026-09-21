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

// ─── secukupnya saja ─────────────────────────────────────────────────────
// Bunganya dicatat sekali sehari, jadi membaca posisi tiap sepuluh menit tidak
// menghasilkan apa-apa selain panggilan RPC. Cukup sejam sekali: itu masih
// memberi 24 titik sehari untuk mengukur laju, dan baris harian tetap terbit
// pada sinkronisasi pertama tiap hari. `--now` memaksa baca ulang.
{
  const LIVE = resolve(DIR, 'live.json');
  const DAILY_FILE = resolve(DIR, 'daily.json');
  const force = process.argv.includes('--now');
  if (!force && existsSync(LIVE) && existsSync(DAILY_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(LIVE, 'utf8'));
      const led = JSON.parse(readFileSync(DAILY_FILE, 'utf8'));
      const todayWib = new Date(Date.now() + WIB).toISOString().slice(0, 10);
      const freshMin = (Date.now() - Number(prev.updatedAt || 0)) / 60000;
      const postedToday = (led.days || []).some((d) => d.date === todayWib);
      if (postedToday && freshMin < 55) {
        console.log(`[safebox] dilewati — baris ${todayWib} sudah dicatat, snapshot ${freshMin.toFixed(0)} menit lalu`);
        process.exit(0);
      }
    } catch { /* berkas belum ada atau rusak: jalan normal */ }
  }
}

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
 * JENDELA BERGULIR 24 JAM, bukan seluruh catatan. Mengukur dari seluruh
 * catatan membuat lajunya nyaris tidak bergerak: pada 2026-09-20 rata-rata dua
 * hari keluar 3,61%/bulan sementara enam jam terakhir 1,36%, jadi angkanya
 * mentok di batas 3% berhari-hari dan terlihat seperti angka mati. 24 jam
 * cukup panjang untuk menahan satu jam sepi, cukup pendek untuk ikut bergerak
 * tiap kali fee-nya berubah.
 *
 * Kalau catatannya masih terlalu pendek untuk jendela itu, dipakai jendela
 * yang lebih panjang, dan terakhir seluruh umur posisi.
 */
const startedAt = Date.parse(secret.startedAt || cfg.startedAt) || book.since || now;
const WINDOWS = [
  { ms: 24 * 3600e3, minSpanMs: 3 * 3600e3, label: 'fee 24 jam terakhir' },
  { ms: 7 * 86400e3, minSpanMs: 12 * 3600e3, label: 'fee 7 hari terakhir' },
];

let measured = null;
for (const w of WINDOWS) {
  const inWindow = kept.filter((p) => now - p.t <= w.ms);
  const firstPoint = inWindow.length > 1 ? inWindow[0] : null;
  if (!firstPoint || now - firstPoint.t < w.minSpanMs) continue;
  measured = { first: firstPoint, spanDays: (now - firstPoint.t) / 86400e3, basis: w.label };
  break;
}
if (!measured) {
  measured = {
    first: null,
    spanDays: Math.max(0.5, (now - startedAt) / 86400e3),
    basis: 'seluruh fee sejak posisi dibuka',
  };
}

const first = measured.first;
const spanDays = measured.spanDays;
const feeGain = Math.max(0, first ? interest - num(first.fee) : interest);
const perDay = feeGain / spanDays;

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

// ─── nilai yang ditampilkan, dan bunga harian ────────────────────────────
// Yang tampil di halaman adalah nilai tetap `display.principalUsd`; ukuran
// posisi aslinya tidak ikut terbit.
//
// ATURAN PEMILIK, 2026-09-21: bunga satu hari = FEE YANG BENAR-BENAR
// DIHASILKAN posisi hari itu, bukan hasil perkalian persen. Kalau fee kumulatif
// kemarin $1,25 dan hari ini $2,00, maka hari ini dapat $0,75 — itu yang
// dicatat. Fee yang sudah dipanen tetap dihitung (buku fee menjumlahkan yang
// dipanen dan yang belum), jadi memanen tidak pernah terbaca sebagai bunga
// yang hilang.
//
// Ukuran posisinya sendiri tidak jadi soal: sebagian modal pemilik diputar di
// tempat lain, dan yang dijadikan acuan adalah fee yang masuk. Kalau posisinya
// nanti dibesarkan, fee-nya ikut besar dan angka ini ikut naik sendiri.
//
// Persentasenya lalu dihitung terhadap nilai yang ditampilkan: $0,75 sehari
// atas $3.000 berarti 0,75%/bulan. Tetap dikurung 0,1%–3% sebulan, jadi satu
// hari yang luar biasa ramai tidak menjanjikan hal yang tidak bisa diulang.
const shownPrincipal = Number(cfg.display?.principalUsd) || principal;
const wibDay = (ms) => new Date(ms + WIB).toISOString().slice(0, 10);
const today = wibDay(now);

const perDayFloor = shownPrincipal * (minMonthly / 100) / 30;
const perDayCap = Number.isFinite(maxMonthly) ? shownPrincipal * (maxMonthly / 100) / 30 : Infinity;

const DAILY = resolve(DIR, 'daily.json');
const ledger = existsSync(DAILY) ? JSON.parse(readFileSync(DAILY, 'utf8')) : { days: [] };
ledger.days = Array.isArray(ledger.days) ? ledger.days : [];
ledger.days.sort((a, b) => a.date.localeCompare(b.date));

// Baris hari ini dihitung ulang tiap sinkronisasi — hari belum selesai, fee-nya
// masih bertambah. Baris hari-hari sebelumnya tidak pernah disentuh lagi.
const prior = ledger.days.filter((d) => d.date < today);
const lastMark = [...prior].reverse().find((d) => Number.isFinite(Number(d.feeTotal)));
// Titik awal: fee kumulatif saat hari kemarin ditutup. Kalau belum pernah
// dicatat (pindahan dari cara lama), pakai fee kumulatif sekarang — hari ini
// dimulai dari nol, bukan mewarisi seluruh fee sejak posisi dibuka.
const feeBase = lastMark ? Number(lastMark.feeTotal) : interest;
const feeToday = Math.max(0, interest - feeBase);
const todayUsd = Math.min(perDayCap, Math.max(perDayFloor, feeToday));

const existing = ledger.days.find((d) => d.date === today);
const entry = existing && existing.frozen
  ? existing                                   // baris lama dari cara lama: dibiarkan
  : Object.assign(existing || { date: today }, {
    usd: Number(todayUsd.toFixed(4)),
    feeUsd: Number(feeToday.toFixed(4)),        // fee apa adanya, sebelum dikurung
    feeTotal: Number(interest.toFixed(4)),      // penanda untuk menghitung hari berikutnya
    monthlyPct: Number((shownPrincipal > 0 ? (todayUsd * 30 / shownPrincipal) * 100 : 0).toFixed(3)),
    at: now,
  });
if (!existing) ledger.days.push(entry);
ledger.days.sort((a, b) => a.date.localeCompare(b.date));
ledger.updatedAt = now;
writeFileSync(DAILY, JSON.stringify(ledger, null, 2) + '\n');

const shownToday = Number(entry.usd) || 0;
const interestShown = ledger.days.reduce((sum, d) => sum + (Number(d.usd) || 0), 0);
// Laju yang ditampilkan mengikuti baris hari ini, bukan pengukuran terpisah —
// supaya "bunga hari ini" dan "bunga per bulan" selalu bercerita hal yang sama.
const shownMonthlyPct = shownPrincipal > 0 ? (shownToday * 30 / shownPrincipal) * 100 : 0;
const apyPct = shownMonthlyPct * 365 / 30;

// Yang terbit hanya angka tampilan. Nilai posisi, fee asli dan lajunya yang
// sebenarnya tidak ikut — berkas ini ada di repo publik.
const snapshot = {
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  venue: secret.position.venue || 'LP',
  principalUsd: Number(shownPrincipal.toFixed(2)),
  valueUsd: Number((shownPrincipal + interestShown).toFixed(2)),
  interestUsd: Number(interestShown.toFixed(4)),
  interestTodayUsd: Number(shownToday.toFixed(4)),
  interestDay: entry.date,
  days: ledger.days.slice(-30).map((d) => ({ date: d.date, usd: Number(Number(d.usd).toFixed(4)) })),
  balanceUsd: Number((shownPrincipal + interestShown).toFixed(2)),
  inRange: pos.inRange === true,
  measure: {
    monthlyPct: Number(shownMonthlyPct.toFixed(2)),
    apyPct: Number(apyPct.toFixed(2)),
    perDayUsd: Number(shownToday.toFixed(4)),
    measuredMonthlyPct: Number(monthlyPct.toFixed(2)),
    minMonthlyPct: minMonthly,
    maxMonthlyPct: Number.isFinite(maxMonthly) ? maxMonthly : null,
    capped: monthlyActualPct > maxMonthly,
    spanDays: Number(spanDays.toFixed(2)),
    since: new Date((first ? first.t : startedAt) + WIB).toISOString().slice(0, 16).replace('T', ' '),
    basis: measured.basis,
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
  todayUsd: Number(shownToday.toFixed(4)),
  feeTodayUsd: Number(feeToday.toFixed(4)),
  feeBaseUsd: Number(feeBase.toFixed(4)),
  daysRecorded: ledger.days.length,
};

mkdirSync(DIR, { recursive: true });
writeFileSync(resolve(DIR, 'live.json'), JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(resolve(DIR, 'internal.json'), JSON.stringify(internal, null, 2) + '\n');
console.log(`[safebox] tampil $${snapshot.balanceUsd} (pokok $${snapshot.principalUsd} + bunga $${snapshot.interestUsd}, hari ini $${snapshot.interestTodayUsd})`
  + ` · ${snapshot.measure.monthlyPct}%/bulan`
  + ` · internal: LP $${internal.lpValueUsd}, fee $${internal.feesUsd}, terukur ${internal.monthlyActualPct}%/bulan`
  + ` (diukur ${snapshot.measure.spanDays} hari)`);
process.exit(0);
