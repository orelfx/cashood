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
const tokenId = BigInt(cfg.position.tokenId);

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
if (book.lastUnclaimedUsd - unclaimedUsd > 0.02 && unclaimedUsd < book.lastUnclaimedUsd * 0.3) {
  book.collectedUsd += book.lastUnclaimedUsd - unclaimedUsd;
}
book.lastUnclaimedUsd = unclaimedUsd;
writeFileSync(FEES, JSON.stringify(book, null, 2) + '\n');

const principal = Number(cfg.principalUsd) || 0;
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
const startedAt = Date.parse(cfg.startedAt) || book.since || now;
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

// ─── batas bunga: 0%–3% setahun (aturan pemilik, 2026-09-19) ─────────────
// Laju yang terukur boleh 6% atau 60%; yang ditampilkan paling tinggi 3%.
// Laju tidak pernah minus: fee tidak bisa negatif, dan rugi harga (termasuk
// impermanent loss) memang tidak dihitung sebagai bunga — paling rendah 0%.
//
// Batasnya dikenakan pada DUA hal, bukan hanya pada persentasenya: bunga yang
// terkumpul juga tidak boleh melebihi yang dihasilkan 3% setahun sejak Safe Box
// dibuka. Kalau hanya APY yang dikunci, saldo tetap tumbuh secepat fee aslinya
// dan angka "3% setahun" tidak akan cocok dengan saldonya sendiri.
const minApy = Number.isFinite(Number(cfg.rate?.minApyPct)) ? Number(cfg.rate.minApyPct) : 0;
const maxApy = Number.isFinite(Number(cfg.rate?.maxApyPct)) ? Number(cfg.rate.maxApyPct) : Infinity;
const clampApy = (v) => Math.min(maxApy, Math.max(minApy, v));
const apyPct = apyActualPct == null ? null : clampApy(apyActualPct);
const perDayShown = principal > 0 && apyPct != null ? (principal * apyPct / 100) / 365 : 0;
const monthlyPct = principal > 0 && apyPct != null ? apyPct * 30 / 365 : null;

const ageDays = Math.max(0, (now - startedAt) / 86400e3);
const interestCap = principal * (maxApy / 100) * ageDays / 365;
const interestFloor = principal * (minApy / 100) * ageDays / 365;
const interestShown = Math.min(Number.isFinite(interestCap) ? interestCap : interest, Math.max(interestFloor, interest));

const snapshot = {
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  venue: cfg.position.venue || 'LP',
  principalUsd: Number(principal.toFixed(2)),
  valueUsd: Number(valueUsd.toFixed(2)),
  interestUsd: Number(interestShown.toFixed(4)),
  // Fee yang benar-benar dihasilkan, sebelum dibatasi — untuk pemilik, tidak tampil.
  interestActualUsd: Number(interest.toFixed(4)),
  unclaimedUsd: Number(unclaimedUsd.toFixed(4)),
  collectedUsd: Number(book.collectedUsd.toFixed(4)),
  balanceUsd: Number((principal + interestShown).toFixed(2)),
  inRange: pos.inRange === true,
  measure: {
    spanDays: Number(spanDays.toFixed(2)),
    perDayUsd: Number(perDayShown.toFixed(4)),
    perDayActualUsd: Number(perDay.toFixed(4)),
    monthlyPct: monthlyPct == null ? null : Number(monthlyPct.toFixed(2)),
    apyPct: apyPct == null ? null : Number(apyPct.toFixed(2)),
    apyActualPct: apyActualPct == null ? null : Number(apyActualPct.toFixed(2)),
    minApyPct: minApy,
    maxApyPct: Number.isFinite(maxApy) ? maxApy : null,
    capped: apyActualPct != null && apyActualPct > maxApy,
    since: new Date((useSeries ? first.t : startedAt) + WIB).toISOString().slice(0, 10),
    basis: useSeries ? 'pertumbuhan fee tercatat' : 'seluruh fee sejak posisi dibuka',
  },
  ethPrice: price,
  nativeSymbol: 'ETH',
  nativePrice: price,
};

mkdirSync(DIR, { recursive: true });
writeFileSync(resolve(DIR, 'live.json'), JSON.stringify(snapshot, null, 2) + '\n');
console.log(`[safebox] nilai $${snapshot.valueUsd} · bunga $${snapshot.interestUsd}`
  + ` · ${snapshot.measure.perDayUsd}/hari · bulanan ${snapshot.measure.monthlyPct}% · APY ${snapshot.measure.apyPct}%`
  + ` (terukur ${snapshot.measure.apyActualPct}%, bunga asli $${snapshot.interestActualUsd})`
  + ` (diukur ${snapshot.measure.spanDays} hari)`);
process.exit(0);
