#!/usr/bin/env node
/*
 * Impor buku paper (devil greed, SnipeHunt) menjadi snapshot situs.
 *
 *   node scripts/import-paper-book.mjs dgrh  /path/devil-greed-robin-hood.json
 *   node scripts/import-paper-book.mjs dgsol /path/devil-greed-solana.json
 *   node scripts/import-paper-book.mjs snh   /root/cashood-inbox/snipehunt.json
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
const BOOKS = { dgrh: 'devil greed Robin Hood', dgsol: 'devil greed Solana', snh: 'SnipeHunt' };
const [fund, file] = process.argv.slice(2);
if (!BOOKS[fund] || !file) { console.error('pakai: import-paper-book.mjs <dgrh|dgsol|snh> <berkas.json>'); process.exit(1); }
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
const tidy = (n) => Number(n.toFixed(8));
// Teks bebas dari bot (alasan masuk, alasan keputusan): apa pun yang berbentuk
// alamat dipangkas dan panjangnya dibatasi, supaya tidak ada identitas on-chain
// yang ikut terbit dan satu kalimat panjang tidak membatalkan impor.
const text = (v, max = 280) => { if (v === undefined || v === null) return null; const t = String(v).replace(/0x[0-9a-fA-F]{16,}/g, '0x…').replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '…').replace(/\s+/g, ' ').trim(); return t ? (t.length > max ? t.slice(0, max - 1) + '…' : t) : null; };
// Alasan keluar yang dikenal ditulis dalam bahasa situs; lainnya apa adanya.
const REASON = { 'rotation': 'rotasi (datar >48 jam)', 'follow exit': 'ikut wallet keluar', 'stale price': 'harga basi', 'take profit': 'take profit', 'stop': 'stop loss',
  'trailing': 'trailing stop', 'time limit': 'batas waktu', 'rug': 'rug', 'manual': 'manual' };
const reasonText = (v) => { const t = text(v, 60); return t ? REASON[t.toLowerCase()] ?? t : null; };
// Wallet yang ikut membeli (copy-trade): jumlah dan labelnya, tanpa alamat.
const walletsNote = (p) => { const n = optNum(pick(p, ['wallets_joined'])); const labels = Array.isArray(p.wallet_labels) ? [...new Set(p.wallet_labels.map((x) => text(x, 16)).filter(Boolean))] : [];
  return n == null ? null : `${n} wallet${labels.length ? ' (' + labels.join(', ') + ')' : ''}`; };
// Komposisi wallet per label dan tanda bahaya (copy-trade). Kunci label huruf
// kecil pendek; jumlah harus angka. Catatan bebas dipangkas seperti teks lain.
const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
const counts = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, n]) => [keyOf(k), optNum(n)]).filter(([k, n]) => k && n != null && n > 0)) : null);
const flagsOf = (a) => (Array.isArray(a) ? a.map((f) => ({ type: keyOf(f?.type ?? ''), count: optNum(f?.count), ...(text(f?.note, 160) ? { note: text(f.note, 160) } : {}) })).filter((f) => f.type) : []);
const aliasOf = (w) => (w && typeof w === 'object' && text(w.alias, 30) ? `${text(w.alias, 30)}` : null);
const copyFields = (p) => ({
  // Jenis posisi (konsensus, solo, uji solo, uji "avoid", uji chase) dan tanda uji coba.
  ...(text(p.entry_mode_label, 40) ? { modeLabel: text(p.entry_mode_label, 40) } : {}),
  ...(p.entry_mode ? { mode: keyOf(p.entry_mode) } : {}),
  ...(p.is_test === true ? { test: true } : {}),
  ...(counts(p.wallet_breakdown) ? { wallets: counts(p.wallet_breakdown) } : {}),
  ...(flagsOf(p.risk_flags).length ? { flags: flagsOf(p.risk_flags) } : {}),
  ...(aliasOf(p.first_wallet) ? { firstWallet: aliasOf(p.first_wallet) } : {}),
  ...(optNum(p.llm_score) != null ? { llmScore: optNum(p.llm_score) } : {}),
  ...(optNum(p.peak_pct) != null ? { peakPct: Number(optNum(p.peak_pct).toFixed(2)) } : {}),
  ...(optNum(p.max_drawdown_pct) != null ? { ddPct: Number(optNum(p.max_drawdown_pct).toFixed(2)) } : {}),
});
const pctOf = (p, pctNames, priceNames, entry, sign) => {
  const direct = optNum(pick(p, pctNames)); if (direct != null) return Math.abs(direct);
  const px = optNum(pick(p, priceNames)); return px != null && entry > 0 ? Number((Math.abs(px / entry - 1) * 100).toFixed(2)) : null;
};   // hanya membuang galat biner penjumlahan, bukan membulatkan angka sumber

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
    // Data rencana — opsional; yang tidak dikirim bot dibiarkan kosong, tidak dikarang.
    stopPct: pctOf(p, ['stop_pct', 'sl_pct'], ['stop_price', 'sl_price'], entry),
    targetPct: pctOf(p, ['target_pct', 'tp_pct'], ['target_price', 'tp_price'], entry)
      ?? (Array.isArray(p.targets) ? optNum(p.targets.find((x) => !x?.hit)?.pct) : null),
    maxHoldHours: optNum(pick(p, ['max_hold_hours'])),
    ...(optNum(pick(p, ['quantity', 'qty', 'amount'])) != null ? { amount: optNum(pick(p, ['quantity', 'qty', 'amount'])) } : {}),
    ...(text(pick(p, ['strategy'])) || walletsNote(p) ? { strategy: [text(pick(p, ['strategy']), 60), walletsNote(p) && `ikut ${walletsNote(p)}`, p.trailing === true ? 'trailing' : null].filter(Boolean).join(' · ') } : {}),
    ...(optNum(pick(p, ['confidence'])) != null ? { confidence: optNum(pick(p, ['confidence'])) } : {}),
    ...(text(pick(p, ['entry_reason', 'thesis', 'reason'])) || text(p.llm_verdict) ? { thesis: [text(pick(p, ['entry_reason', 'thesis', 'reason'])), text(p.llm_verdict) && !/no answer/i.test(p.llm_verdict) && `LLM: ${text(p.llm_verdict)}`].filter(Boolean).join(' · ').slice(0, 450) } : {}),
    ...copyFields(p),
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
    netPct: optNum(pick(c, ['realized_pct'])) ?? (notional > 0 ? Number(((net / notional) * 100).toFixed(2)) : null),
    holdMinutes: openedRaw === undefined ? null : Math.max(0, Math.round((closedAt - time(openedRaw, 'opened_at')) / 60000)),
    reason: reasonText(pick(c, ['reason', 'exit_reason'])) ?? '—',
    ...(text(pick(c, ['reason_detail', 'note'])) || walletsNote(c) ? { reasonDetail: [text(pick(c, ['reason_detail', 'note']), 200), walletsNote(c) && `ikut ${walletsNote(c)}`].filter(Boolean).join(' · ') } : {}),
    ...(optNum(pick(c, ['fees_usd'])) != null ? { feesUsd: optNum(pick(c, ['fees_usd'])) } : {}),
    ...(text(c.entry_reason) ? { entry: text(c.entry_reason, 300) } : {}),
    ...(text(c.exit_detail) ? { exitDetail: text(c.exit_detail, 300) } : {}),
    ...(counts(c.wallets_sold) ? { walletsSold: counts(c.wallets_sold) } : {}),
    ...copyFields(c), closedAt };
}).sort((a, b) => a.closedAt - b.closedAt);
const trades = groupTradeDays(closed, 0.5);
const wins = closed.filter((c) => c.netPct > 0.5).length, losses = closed.filter((c) => c.netPct < -0.5).length;
const realizedClosed = tidy(closed.reduce((t, c) => t + c.netUsd, 0));

// Keadaan bot (opsional): status, pindai terakhir, keputusan terakhir, aktivitas.
const bot = pick(src, ['bot']) || {};
const dec = typeof bot.last_decision === 'string' ? { reason: bot.last_decision } : (bot.last_decision || {});
// Nama kolom aktivitas berbeda antar bot; dipetakan ke satu set.
const actSrc = bot.activity_24h || {};
const act = { scans: pick(actSrc, ['scans', 'signals']), rejected: pick(actSrc, ['rejected', 'vetoed']), entries: pick(actSrc, ['entries', 'entered']), exits: pick(actSrc, ['exits', 'closed']) };
const lastScanAt = bot.last_scan_at ? time(bot.last_scan_at, 'last_scan_at') : null;
const rules = Array.isArray(src.rules) ? src.rules.filter((x) => typeof x !== 'string').map((x) => [text(x?.[0] ?? x?.k, 40), text(x?.[1] ?? x?.v, 120)]).filter(([k, v]) => k && v) : [];
// Aturan berupa kalimat (bukan pasangan kunci–nilai) tampil sebagai daftar.
const ruleList = Array.isArray(src.rules) ? src.rules.filter((x) => typeof x === 'string').map((x) => text(x, 300)).filter(Boolean) : [];
// Basket modal (copy-trade): alokasi, kursi maksimum, dan posisi terbuka.
const baskets = Array.isArray(src.baskets) ? src.baskets.map((b) => [text(b.label ?? b.id, 30),
  [optNum(b.alloc_pct) != null && `alokasi ${b.alloc_pct}%`, optNum(b.cap) != null && `$${Math.round(b.cap).toLocaleString('en-US')}`,
   Array.isArray(b.seat_basket_pct) && b.seat_basket_pct.length === 2 ? `kursi ${b.seat_basket_pct[0]}–${b.seat_basket_pct[1]}% basket` : null,
   optNum(b.seat_pct) != null && `maks ${b.seat_pct}% equity`, optNum(b.open) != null && `${b.open} terbuka`].filter(Boolean).join(' · ')]).filter(([k, v]) => k && v) : [];
const wallets = src.wallets && typeof src.wallets === 'object' ? src.wallets : null;
// Blok copy-trade (SnipeHunt): segmen wallet, wallet teratas, jejak keputusan.
const byLabel = wallets?.by_label && typeof wallets.by_label === 'object' ? Object.entries(wallets.by_label).map(([k, v]) => (typeof v === 'object' && v
  ? { key: keyOf(k), total: optNum(v.total) ?? 0, active: optNum(v.active) ?? 0, passive: optNum(v.passive) ?? 0 }
  : { key: keyOf(k), total: optNum(v) ?? 0, active: null, passive: null })).filter((x) => x.key) : [];
const copyTrade = wallets || Array.isArray(src.decisions) ? {
  wallets: wallets ? {
    tracked: optNum(wallets.tracked), active: optNum(wallets.active), passive: optNum(wallets.passive),
    trusted: optNum(wallets.trusted), promising: optNum(wallets.promising),
    byLabel: byLabel.sort((a, b) => b.total - a.total),
    definitions: Object.fromEntries(['active', 'passive', 'label', 'trusted', 'promising'].map((k) => [k, text(wallets.definitions?.[k], 300)]).filter(([, v]) => v)),
    top: (Array.isArray(wallets.top) ? wallets.top : []).slice(0, 10).map((w) => ({ alias: text(w.alias, 30), label: keyOf(w.label ?? ''), score: optNum(w.score),
      copied: optNum(w.copied), won: optNum(w.won), pnlUsd: optNum(w.pnl_usd), trusted: w.trusted === true })).filter((w) => w.alias),
  } : null,
  decisions: (Array.isArray(src.decisions) ? src.decisions : []).slice(0, 50).map((d) => ({
    at: d.at ? time(d.at, 'decisions.at') : null, symbol: text(d.symbol, 40), action: keyOf(d.action ?? ''), basket: text(d.basket, 20),
    ...(counts(d.wallet_breakdown) ? { wallets: counts(d.wallet_breakdown) } : {}), ...(flagsOf(d.risk_flags).length ? { flags: flagsOf(d.risk_flags) } : {}),
    reason: text(d.reason, 400) })).filter((d) => d.at && d.action),
  reasonStats: src.reason_stats_24h && typeof src.reason_stats_24h === 'object'
    ? Object.fromEntries(Object.entries(src.reason_stats_24h).map(([g, o]) => [keyOf(g), typeof o === 'number' ? { jumlah: optNum(o) }
      : Object.fromEntries(Object.entries(o || {}).map(([k, n]) => [text(k, 30), optNum(n)]).filter(([k, n]) => k && n != null))])) : null,
} : null;
const walletRows = wallets ? [['Wallet dipantau', `${optNum(wallets.tracked) ?? '—'} · ${optNum(wallets.active) ?? '—'} aktif`],
  ...(optNum(src.reserve_pct) != null ? [['Cadangan kas', `${src.reserve_pct}% untuk gas, tip, dan slippage — tidak dipakai membuka posisi`]] : []),
  ...(optNum(wallets.trusted) != null ? [['Wallet tepercaya', `${wallets.trusted} · menjanjikan ${optNum(wallets.promising) ?? 0}`]] : []),
  ...(wallets.by_label && typeof wallets.by_label === 'object' ? [['Label wallet', Object.entries(wallets.by_label).map(([k, n]) => [k, typeof n === 'object' && n ? optNum(n.total) : optNum(n)]).filter(([, n]) => n).map(([k, n]) => `${text(k, 16)} ${n}`).join(' · ')]] : [])] : [];
const about = (Array.isArray(src.about) ? src.about : src.about ? [src.about] : []).map((x) => text(x, 500)).filter(Boolean);
const sleeveInfo = [...(src.sleeves && typeof src.sleeves === 'object' ? Object.entries(src.sleeves).map(([k, v]) => [text(k, 30), text(v, 160)]).filter(([k, v]) => k && v) : []), ...baskets];
const peak = optNum(pick(src, ['peak_equity_usd']));

const unrealized = tidy(positions.reduce((t, p) => t + p.pnlUsd, 0));
const inPositions = tidy(positions.reduce((t, p) => t + p.principalUsd, 0));
const gen = generation();
const WIB = 7 * 3600e3;
const sleeves = [...new Set(positions.map((p) => p.bookLabel))];
const nStale = positions.filter((p) => p.stale).length;
// Deret nilai: impor pertama = dua titik (modal awal, equity sekarang); tiap
// pembaruan berikutnya menambah satu titik.
const navOld = readJSON(resolve(DIR, 'nav.json'), { points: [] }).points || [];
// Bot yang mengirim riwayat equity: titik yang lebih baru dari deret kita ikut masuk.
const lastOld = navOld.length ? navOld.at(-1).t : -Infinity;
const hist = (Array.isArray(src.equity_history) ? src.equity_history : []).map((h) => ({ t: time(h.t, 'equity_history.t'), usd: optNum(h.equity_usd) }))
  .filter((h) => h.usd != null && h.usd > 0 && h.t > lastOld && h.t < asOf && h.t >= startedAt);
const points = downsample([...(navOld.length ? navOld : [{ t: startedAt, usd: initial }]), ...hist, { t: asOf, usd: equity }].map(({ t, usd }) => ({ t, usd })).sort((a, b) => a.t - b.t), now);

const snapshot = {
  fund,
  schemaVersion: 2,
  generation: gen,
  updatedAt: asOf,
  generatedAt: new Date(asOf + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  totalUsd: equity,
  // Koin asli jaringannya, untuk kurs di header (Solana → SOL, Robin Hood → ETH).
  nativeSymbol: fund === 'dgrh' ? 'ETH' : 'SOL',
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
    status: now - asOf >= 20 * 60e3 ? 'data paper terlambat' : text(bot.status, 30) || 'berjalan (paper)',
    healthy: now - asOf < 20 * 60e3 && !/pause|jeda|halt|error|stop/i.test(String(bot.status || '')),
    ...(peak != null && peak > 0 ? { peakUsd: peak, drawdownPct: Number((Math.max(0, (peak - equity) / peak) * 100).toFixed(2)) } : {}),
    lastScanAt,
    lead: `${BOOKS[fund]} adalah buku paper dengan modal kertas $1.000 — bukan uang sungguhan, bukan dana investor, dan bukan LP. Angkanya diimpor apa adanya dari catatan paper.`,
    tiles: [
      { k: 'Posisi terbuka', v: String(positions.length), n: baskets.length ? `${baskets.length} basket` : `${sleeves.length} sleeve` },
      { k: 'Kas', usd: cash, n: 'belum dipakai' },
      { k: 'Belum terealisasi', v: `${unrealized >= 0 ? '+' : '−'}$${Math.abs(unrealized).toFixed(4)}`, n: 'dari posisi terbuka', tone: unrealized >= 0 ? 'pos' : 'neg' },
      ...(nStale ? [{ k: 'Harga belum tersedia', v: String(nStale), n: 'posisi ditandai belum terverifikasi', tone: 'neg' }] : []),
      ...(optNum(act.scans) != null ? [{ k: fund === 'snh' ? 'Sinyal wallet' : 'Pindai pasar', v: String(act.scans), n: `24 jam${optNum(act.rejected) != null ? ` · ${act.rejected} ${fund === 'snh' ? 'diveto LLM' : 'kandidat ditolak'}` : ''}` }] : []),
      ...(wallets && optNum(wallets.tracked) != null ? [{ k: 'Wallet dipantau', v: String(wallets.tracked), n: `${optNum(wallets.active) ?? 0} aktif` }] : []),
      ...(optNum(act.entries) != null || optNum(act.exits) != null ? [{ k: 'Buka · tutup', v: `${act.entries ?? 0} · ${act.exits ?? 0}`, n: '24 jam terakhir' }] : []),
    ],
    llm: text(dec.reason) ? { model: text(bot.model, 40), lastDecisionAt: dec.at ? time(dec.at, 'last_decision.at') : asOf, lastAction: text(dec.action, 24) || 'keputusan', lastReason: text(dec.reason, 400) } : null,
  },
  // Penjelasan strategi dari bot sendiri (opsional), untuk tab Analys.
  ...(about.length || rules.length || ruleList.length || sleeveInfo.length ? { strategy: { title: `${BOOKS[fund]} — buku paper`, about,
    system: [['Mode', 'paper'], ...(text(bot.model, 40) ? [['Model LLM', text(bot.model, 40)]] : []), ...rules, ...walletRows], requirements: sleeveInfo,
    ...(baskets.length ? { requirementsTitle: 'Basket modal' } : {}), ...(ruleList.length ? { ruleList } : {}), risks: [] } } : {}),
  ...(copyTrade ? { copyTrade } : {}),
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
