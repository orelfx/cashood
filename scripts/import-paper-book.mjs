#!/usr/bin/env node
/*
 * Impor buku paper (devil greed) menjadi snapshot situs.
 *
 *   node scripts/import-paper-book.mjs dgrh  /path/devil-greed-robin-hood.json
 *   node scripts/import-paper-book.mjs dgsol /path/devil-greed-solana.json
 *
 * Aturan pemilik (2026-10-03):
 *   - angka disalin APA ADANYA dari berkas sumber: kas, equity, pnl, notional,
 *     unrealized tidak dihitung ulang dan tidak dibulatkan;
 *   - totalUsd = equity_usd; satu baris kas (harga 1); tiap posisi
 *     principalUsd = notional + unrealized, feesUsd = 0, pnlUsd = unrealized;
 *   - harga yang null TIDAK diisi: posisinya ditandai stale;
 *   - tidak ada alamat kontrak, pool, mint, atau wallet yang boleh terbit;
 *   - belum ada trade tutup: riwayat dikosongkan, tidak dikarang.
 * Skrip berhenti tanpa menulis apa pun kalau validasi schema v2 atau
 * pemeriksaan rahasia gagal.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../assets/core.js';
import { atomicJSON, assertPublic, downsample, generation, lock, privateId, readJSON } from './lib/io.mjs';
import { groupTradeDays, writeTradeDays } from './lib/trades.mjs';
import { buildPerformance } from './lib/performance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS = { dgrh: 'devil greed Robin Hood', dgsol: 'devil greed Solana' };
const [fund, file] = process.argv.slice(2);
if (!BOOKS[fund] || !file) { console.error('pakai: import-paper-book.mjs <dgrh|dgsol> <berkas.json>'); process.exit(1); }
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(ROOT, 'data'), fund);
const release = lock(resolve(DIR, 'sync.lock.local'));
const src = JSON.parse(readFileSync(resolve(file), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));

// Nama kolom dicari dari beberapa ejaan yang wajar; kolom wajib yang tidak
// ditemukan menghentikan impor — tidak ada nilai bawaan yang dikarang.
const pick = (o, names) => { for (const n of names) if (o?.[n] !== undefined) return o[n]; return undefined; };
const must = (o, names, what) => { const v = pick(o, names); if (v === undefined || v === null || !Number.isFinite(Number(v))) throw new Error(`${what} tidak ada di berkas sumber (${names.join(' / ')})`); return Number(v); };
const time = (v, what) => { const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); if (!Number.isFinite(t)) throw new Error(`${what} tidak valid`); return t; };
const optNum = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const tidy = (n) => Number(n.toFixed(8));   // hanya membuang galat biner penjumlahan, bukan membulatkan angka sumber

if (src.label !== undefined && src.label !== BOOKS[fund]) throw new Error(`Label berkas "${src.label}" bukan "${BOOKS[fund]}" — berkas tertukar?`);
const equity = must(src, ['equity_usd', 'equity'], 'equity');
const cash = must(src, ['cash_usd', 'cash'], 'kas');
const pnl = optNum(pick(src, ['pnl_usd', 'pnl']));
const initial = optNum(pick(src, ['initial_usd', 'initial', 'start_usd'])) ?? 1000;
if (initial !== 1000) throw new Error(`Modal awal di berkas ${initial}, seharusnya 1000`);
const startedAt = time(pick(src, ['started_at', 'startedAt', 'start']), 'started_at');
const asOfRaw = pick(src, ['as_of', 'asOf', 'updated_at', 'updatedAt', 'marked_at', 'timestamp']);
const now = Date.now();
const asOf = asOfRaw === undefined ? now : time(asOfRaw, 'waktu snapshot');
if (asOf > now + 60000) throw new Error('as_of berada di masa depan');
// Berkas yang belum berubah sejak impor terakhir tidak diterbitkan ulang.
const before = readJSON(resolve(DIR, 'snapshot.local.json'));
if (before && before.updatedAt === asOf && !process.argv.includes('--force')) { console.log(`[${fund}] belum ada pembaruan sejak ${new Date(asOf).toISOString()}`); release(); process.exit(0); }
if (before && asOf < before.updatedAt) throw new Error('as_of lebih lama dari snapshot yang sudah terbit');
const list = pick(src, ['positions', 'open_positions', 'open']);
if (!Array.isArray(list)) throw new Error('daftar posisi tidak ada di berkas sumber');

const positions = list.map((p, i) => {
  const symbol = String(pick(p, ['symbol', 'ticker']) ?? '').trim();
  if (!symbol) throw new Error(`posisi #${i + 1} tanpa simbol`);
  const notional = must(p, ['notional_usd', 'notional'], `notional ${symbol}`);
  const unrealized = must(p, ['unrealized_usd', 'unrealized', 'unrealized_pnl_usd'], `unrealized ${symbol}`);
  const entry = optNum(pick(p, ['entry_price_usd', 'entry_price', 'entry']));
  const mark = optNum(pick(p, ['mark_price_usd', 'mark_price', 'mark', 'price_usd', 'price']));
  const stale = entry == null || mark == null || p.stale === true;
  const opened = pick(p, ['opened_at', 'openedAt', 'entry_at']);
  const value = tidy(notional + unrealized);
  return {
    tokenId: privateId(DIR, `${fund}:${i}:${symbol}`),
    symbol,
    bookLabel: String(pick(p, ['sleeve', 'book']) ?? '—'),
    costUsd: notional,
    investedUsd: notional,
    principalUsd: value,
    valueUsd: value,
    feesUsd: 0,
    collectedFeesUsd: 0,
    pnlUsd: unrealized,
    pnlPct: notional > 0 ? Number(((unrealized / notional) * 100).toFixed(2)) : null,
    ...(entry != null ? { entryPriceUsd: entry } : {}),
    ...(mark != null ? { priceUsd: mark } : {}),          // harga null tidak diisi
    ...(opened !== undefined ? { ageMinutes: Math.max(0, Math.round((asOf - time(opened, 'opened_at')) / 60000)) } : {}),
    stale,
    ...(stale ? { staleReason: 'harga masuk/mark belum tersedia' } : {}),
  };
});

// Trade yang sudah ditutup (opsional). Tanpa daftar ini riwayat tetap kosong.
const closedSrc = pick(src, ['closed_trades', 'closed', 'history']);
const closed = (Array.isArray(closedSrc) ? closedSrc : []).map((c, i) => {
  const symbol = String(pick(c, ['symbol', 'ticker']) ?? '').trim();
  if (!symbol) throw new Error(`trade tutup #${i + 1} tanpa simbol`);
  const notional = must(c, ['notional_usd', 'notional'], `notional trade tutup ${symbol}`);
  const net = must(c, ['realized_usd', 'realized', 'pnl_usd', 'pnl'], `hasil trade tutup ${symbol}`);
  const closedAt = time(pick(c, ['closed_at', 'closedAt']), `closed_at ${symbol}`);
  const openedRaw = pick(c, ['opened_at', 'openedAt']);
  return { symbol, strategy: String(pick(c, ['sleeve', 'book']) ?? '—'), investedUsd: notional, netUsd: net,
    netPct: notional > 0 ? Number(((net / notional) * 100).toFixed(2)) : null,
    holdMinutes: openedRaw === undefined ? null : Math.max(0, Math.round((closedAt - time(openedRaw, 'opened_at')) / 60000)),
    reason: String(pick(c, ['reason', 'exit_reason']) ?? '—'), closedAt };
}).sort((a, b) => a.closedAt - b.closedAt);
const trades = groupTradeDays(closed, 0.5);
const wins = closed.filter((c) => c.netPct > 0.5).length, losses = closed.filter((c) => c.netPct < -0.5).length;
const realizedClosed = tidy(closed.reduce((t, c) => t + c.netUsd, 0));

const unrealized = tidy(positions.reduce((t, p) => t + p.pnlUsd, 0));
const inPositions = tidy(positions.reduce((t, p) => t + p.principalUsd, 0));
const gen = generation();
const WIB = 7 * 3600e3;
const sleeves = [...new Set(positions.map((p) => p.bookLabel))];
const nStale = positions.filter((p) => p.stale).length;
// Deret nilai: impor pertama = dua titik (modal awal, equity sekarang); tiap
// pembaruan berikutnya menambah satu titik.
const navOld = readJSON(resolve(DIR, 'nav.json'), { points: [] }).points || [];
const points = downsample([...(navOld.length ? navOld : [{ t: startedAt, usd: initial }]), { t: asOf, usd: equity }].map(({ t, usd }) => ({ t, usd })), now);

const snapshot = {
  fund,
  schemaVersion: 2,
  generation: gen,
  updatedAt: asOf,
  generatedAt: new Date(asOf + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  totalUsd: equity,
  botWalletUsd: equity,
  walletUsd: cash,
  lpUsd: inPositions,
  treasuryUsd: 0,
  holdings: [{ symbol: 'Kas (paper)', amount: cash, price: 1, usd: cash }],
  positions,
  history: trades.index.map((x) => ({ date: x.d, usd: x.usd ?? 0, closes: x.n, wins: x.w, losses: x.l })),
  historyNote: closed.length ? 'hasil trade paper yang sudah ditutup' : 'belum ada trade yang ditutup di buku paper ini',
  stats: { closedCount: closed.length, openCount: positions.length, graded: wins + losses, wins, losses,
    winRate: wins + losses ? Number(((wins / (wins + losses)) * 100).toFixed(2)) : null, realisedUsd: realizedClosed,
    bestDay: null, worstDay: null, worstClosePct: closed.length ? Math.min(...closed.map((c) => c.netPct ?? 0)) : null, timezone: 'Asia/Jakarta (UTC+7)' },
  closedRecent: [...closed].reverse().slice(0, 20),
  tradeDays: trades.index,
  trading: {
    paper: true,
    mode: 'paper',
    initialUsd: initial,
    cashUsd: cash,
    positionsUsd: inPositions,
    realizedUsd: tidy(equity - initial - unrealized),
    unrealizedUsd: unrealized,
    pnlUsd: pnl ?? tidy(equity - initial),
    paused: false,
    startedAt,
    heartbeatAt: asOf,
    status: now - asOf < 20 * 60e3 ? 'berjalan (paper)' : 'data paper terlambat',
    healthy: now - asOf < 20 * 60e3,
    lead: `${BOOKS[fund]} adalah buku paper dengan modal kertas $1.000 — bukan uang sungguhan, bukan dana investor, dan bukan LP. Angkanya diimpor apa adanya dari catatan paper.`,
    tiles: [
      { k: 'Posisi terbuka', v: String(positions.length), n: `${sleeves.length} sleeve` },
      { k: 'Kas', usd: cash, n: 'belum dipakai' },
      { k: 'Belum terealisasi', v: `${unrealized >= 0 ? '+' : '−'}$${Math.abs(unrealized).toFixed(4)}`, n: 'dari posisi terbuka', tone: unrealized >= 0 ? 'pos' : 'neg' },
      ...(nStale ? [{ k: 'Harga belum tersedia', v: String(nStale), n: 'posisi ditandai belum terverifikasi', tone: 'neg' }] : []),
    ],
    llm: null,
  },
  quality: nStale ? { complete: false, reasons: [`${nStale} posisi tanpa harga masuk/mark; nilainya dari catatan paper`] } : { complete: true, reasons: [] },
  costsShareUsd: 0,
};
snapshot.performance = buildPerformance({ closes: closed.map((c) => ({ netUsd: c.netUsd, netPct: c.netPct, closedAt: c.closedAt, holdMinutes: c.holdMinutes, symbol: c.symbol })), points, flows: [{ at: startedAt, usd: initial }], capitalUsd: initial, navUsd: equity, flatBand: 0.5 });

// ─── validasi: tidak ada yang ditulis sebelum semuanya lulus ───────────────
Core.validateSnapshot(snapshot);                                   // komponen vs total, dalam $0,011
const gap = Math.abs(cash + inPositions - equity);
const publik = { ...snapshot, positions: positions.map(({ staleReason: _s, ...p }) => p) };
assertPublic(publik);
if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(JSON.stringify(publik).replace(/"(tokenId|generation)":"[^"]*"/g, ''))) throw new Error('Data mengandung sesuatu berbentuk alamat Solana; impor dibatalkan');
Core.buildLedger(cfg);

atomicJSON(resolve(DIR, 'snapshot.local.json'), snapshot);
atomicJSON(resolve(DIR, 'nav.json'), { updatedAt: asOf, generation: gen, points: points.map((p) => ({ ...p, quality: 'complete' })) });
atomicJSON(resolve(DIR, 'live.json'), publik);
writeTradeDays(DIR, fund, trades.files);
console.log(`[${fund}] ${BOOKS[fund]}`);
console.log(`  mulai   ${new Date(startedAt).toISOString()}`);
console.log(`  kas     ${cash}`);
console.log(`  equity  ${equity}`);
console.log(`  pnl     ${snapshot.trading.pnlUsd}`);
console.log(`  posisi  ${positions.length} (${nStale} stale)`);
console.log(`  selisih kas + posisi terhadap equity: ${gap.toFixed(6)}`);
release();
