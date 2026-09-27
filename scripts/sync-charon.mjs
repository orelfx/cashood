#!/usr/bin/env node
/**
 * Snapshot Charon RH — bot trading token (meme/spekulatif) di Robinhood Chain.
 *
 * Bot ini masih SIMULASI (paper / dry-run): modal $500 di atas kertas, harga
 * dari quote pasar sungguhan, tanpa dompet dan tanpa transaksi. Situs hanya
 * MEMBACA database bot dalam mode read-only — tidak mengambil lock-nya, tidak
 * menulis apa pun ke foldernya.
 *
 * Yang terbit hanya simbol token, angka, dan alasan keputusan. Alamat kontrak
 * token tidak ikut: halaman ini laporan kinerja, bukan daftar beli.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../assets/core.js';
import { atomicJSON, readJSON, lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'charon');
const OUT = resolve(DIR, 'live.json');
const NAV = resolve(DIR, 'nav.json');
const HOME = process.env.CHARON_HOME || '/root/charon RH';
const WIB = 7 * 3600e3;

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
const Database = createRequire(resolve(HOME, 'package.json'))('better-sqlite3');
const db = new Database(resolve(HOME, 'data', 'paper-rh.sqlite'), { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const now = Date.now();
const meta = (key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
const metaJSON = (key) => { try { return JSON.parse(meta(key) || 'null'); } catch { return null; } };
const plan = (p) => { try { return JSON.parse(p.plan_json) || {}; } catch { return {}; } };
const r2 = (n) => Number((Number(n) || 0).toFixed(2));
// Teks bebas dari model atau bot: alamat kontrak dipangkas, panjangnya dibatasi.
const clean = (s, max = 320) => {
  const t = String(s ?? '').replace(/0x[0-9a-fA-F]{6,}/g, '0x…').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

const account = db.prepare('SELECT * FROM account WHERE id=1').get();
if (!account) throw new Error('akun paper Charon RH belum ada');
const rows = db.prepare('SELECT * FROM positions ORDER BY id').all();
const open = rows.filter((p) => p.status !== 'closed');
const closed = rows.filter((p) => p.status === 'closed' && Number.isFinite(p.closed_at));

// ─── posisi terbuka ───────────────────────────────────────────────────────
const BAND = { low: 'low cap', mid: 'mid cap', large: 'large cap' };
const HORIZON = { scalp: 'scalp', intraday: 'intraday', swing: 'swing' };
const label = (pl, band) => [HORIZON[pl.horizon] || pl.horizon, BAND[band] || band].filter(Boolean).join(' · ');

const positions = open.map((p) => {
  const pl = plan(p);
  const qty = Number(p.quantity_raw) / 10 ** (p.decimals ?? 18);
  const qty0 = Number(p.initial_raw) / 10 ** (p.decimals ?? 18);
  const pnl = p.net_value + p.realized_pnl - p.remaining_cost;
  return {
    tokenId: `charon-${p.id}`,
    symbol: clean(p.symbol || '?', 24),
    band: p.band || null,
    horizon: pl.horizon || null,
    bookLabel: label(pl, p.band),
    strategy: pl.strategy || 'llm',
    experimental: Boolean(pl.experimental),
    principalUsd: r2(p.net_value),
    feesUsd: 0,
    investedUsd: r2(p.remaining_cost),
    collectedFeesUsd: r2(p.realized_pnl),
    costUsd: r2(p.initial_cost),
    realizedUsd: r2(p.realized_pnl),
    pnlPct: p.initial_cost > 0 ? Number(((pnl / p.initial_cost) * 100).toFixed(2)) : null,
    stopPct: Number.isFinite(pl.stop) ? Number((pl.stop * 100).toFixed(2)) : null,
    targetPct: Number.isFinite(pl.target) ? Number((pl.target * 100).toFixed(2)) : null,
    maxHoldHours: Number.isFinite(pl.maxHoldMs) ? Number((pl.maxHoldMs / 3600e3).toFixed(1)) : null,
    ageMinutes: p.opened_at ? Math.round((now - p.opened_at) / 60000) : null,
    amount: qty,
    priceUsd: qty > 0 ? p.net_value / qty : null,
    entryPriceUsd: qty0 > 0 ? p.initial_cost / qty0 : null,
    partialDone: Boolean(p.partial_done),
    bestPct: Number(((p.max_return || 0) * 100).toFixed(2)),
    worstPct: Number(((p.min_return || 0) * 100).toFixed(2)),
    markedAt: p.marked_at,
    // Bot sendiri menganggap harga basi setelah 120 detik; situs memberi
    // kelonggaran lima menit sebelum menandai posisinya belum terverifikasi.
    stale: now - p.marked_at > 5 * 60e3,
    thesis: clean(pl.thesis, 240),
  };
});

// ─── posisi tertutup ──────────────────────────────────────────────────────
const REASON = [
  [/^STOP_LOSS/, 'stop loss'], [/^TRAILING_TP/, 'trailing take-profit'], [/^(LLM_)?PARTIAL_TP|^TAKE_PARTIAL/, 'ambil untung sebagian'],
  [/^MAX_HOLD/, 'batas waktu habis'], [/^THESIS_INVALIDATED/, 'alasan masuk batal'], [/^TARGET|^TAKE_PROFIT/, 'target tercapai'],
  [/^EXIT/, 'keluar atas keputusan AI'], [/^EMERGENCY/, 'keluar darurat'],
];
const reasonOf = (text) => (REASON.find(([re]) => re.test(String(text || ''))) || [null, 'lainnya'])[1];
const tutup = closed.map((p) => {
  const pl = plan(p);
  return {
    symbol: clean(p.symbol || '?', 24),
    closedAt: p.closed_at,
    investedUsd: r2(p.initial_cost),
    netUsd: r2(p.realized_pnl),
    netPct: p.initial_cost > 0 ? Number(((p.realized_pnl / p.initial_cost) * 100).toFixed(2)) : null,
    holdMinutes: p.opened_at ? Math.round((p.closed_at - p.opened_at) / 60000) : null,
    strategy: label(pl, p.band),
    reason: reasonOf(p.exit_reason),
    reasonDetail: clean(p.exit_reason, 240),
  };
}).sort((a, b) => a.closedAt - b.closedAt);

const hariWib = (ms) => new Date(ms + WIB).toISOString().slice(0, 10);
const perHari = new Map();
let menang = 0, kalah = 0;
for (const r of tutup) {
  const hari = hariWib(r.closedAt);
  const baris = perHari.get(hari) || { date: hari, usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  baris.usd += r.netUsd; baris.closes += 1;
  if (r.netPct > 0.5) { baris.wins += 1; baris.winUsd += r.netUsd; menang += 1; }
  else if (r.netPct < -0.5) { baris.losses += 1; baris.lossUsd += r.netUsd; kalah += 1; }
  perHari.set(hari, baris);
}
const history = [...perHari.values()]
  .map((r) => ({ ...r, usd: r2(r.usd), winUsd: r2(r.winUsd), lossUsd: r2(r.lossUsd) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const terbaik = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const terburuk = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);

// ─── status bot ───────────────────────────────────────────────────────────
const health = readJSON(resolve(HOME, 'data', 'health.json'), null);
const heartbeat = Number(meta('heartbeat')) || null;
const lastScanAt = Number(meta('lastScanAt')) || null;
const since = now - 86400e3;
const count = (kind) => db.prepare('SELECT COUNT(*) n FROM events WHERE kind=? AND at>=?').get(kind, since).n;
const lastEvent = (kind) => {
  const e = db.prepare('SELECT at,payload FROM events WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind);
  if (!e) return null;
  try { return { at: e.at, payload: JSON.parse(e.payload) }; } catch { return { at: e.at, payload: {} }; }
};
const decision = lastEvent('decision');
const lastReq = lastEvent('llm_request');
const fees = db.prepare('SELECT COALESCE(SUM(network_fee+rent),0) f FROM fills').get().f;
const feeHealth = metaJSON('feeHealth');
const cashHealth = metaJSON('cashHealth');

const cash = r2(account.cash);
const inPositions = r2(positions.reduce((s, p) => s + p.principalUsd, 0));
const totalUsd = r2(cash + inPositions);
const realizedUsd = r2(closed.reduce((s, p) => s + p.realized_pnl, 0) + open.reduce((s, p) => s + p.realized_pnl, 0));
const unrealizedUsd = r2(open.reduce((s, p) => s + p.net_value - p.remaining_cost, 0));
const peak = Math.max(Number(account.peak) || 0, totalUsd);

const trading = {
  paper: true,
  mode: 'dry_run',
  initialUsd: r2(account.initial),
  cashUsd: cash,
  positionsUsd: inPositions,
  realizedUsd,
  unrealizedUsd,
  modeledFeesUsd: r2(fees),
  peakUsd: r2(peak),
  drawdownPct: peak > 0 ? Number((((peak - totalUsd) / peak) * 100).toFixed(2)) : 0,
  dayStartUsd: r2(account.day_equity),
  paused: Boolean(account.paused),
  startedAt: account.created_at,
  status: health?.status || null,
  processStatus: health?.processStatus || null,
  heartbeatAt: heartbeat,
  lastScanAt,
  cashPeg: Number(cashHealth?.priceUsd) || null,
  llm: {
    model: clean(lastReq?.payload?.model, 40) || null,
    calls24h: count('llm_request'),
    dailyBudget: 96,
    lastDecisionAt: decision?.at || null,
    lastAction: clean(decision?.payload?.decision?.action, 20) || null,
    lastReason: clean(decision?.payload?.decision?.reason, 360) || null,
  },
  activity24h: {
    scans: count('scan'),
    decisions: count('decision'),
    quotesRejected: count('quote_rejected'),
    entriesRejected: count('entry_rejected'),
    buys: count('paper_buy'),
    sells: count('paper_sell'),
  },
};

// ─── deret nilai: dari catatan equity bot sendiri (tiap ±30 detik) ─────────
// Bot mencatat nilainya sejak hari pertama; deret situs diturunkan dari sana
// setiap kali, jadi grafik punya riwayat penuh dan tidak bergantung pada kapan
// situs mulai membaca.
const eq = db.prepare('SELECT at,equity FROM equity_history WHERE stale=0 ORDER BY at').all();
db.close();
atomicJSON(NAV, { updatedAt: now, points: eq.map((r) => ({ t: r.at, usd: r2(r.equity), quality: 'complete' })) });

const snapshot = {
  fund: 'charon',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  nativeSymbol: 'ETH',
  nativePrice: Number(feeHealth?.ethUsd) || null,
  ethPrice: Number(feeHealth?.ethUsd) || null,
  totalUsd,
  botWalletUsd: totalUsd,
  walletUsd: cash,
  lpUsd: inPositions,
  holdings: [{ symbol: 'USDG', amount: cash, price: 1, usd: cash }],
  positions,
  history,
  historyNote: 'hasil trade simulasi yang sudah ditutup, bersih setelah biaya swap dan jaringan yang dimodelkan',
  stats: {
    closedCount: tutup.length,
    openCount: positions.length,
    graded: menang + kalah,
    wins: menang,
    losses: kalah,
    winRate: menang + kalah ? Number(((menang / (menang + kalah)) * 100).toFixed(2)) : null,
    realisedUsd: r2(tutup.reduce((t, r) => t + r.netUsd, 0)),
    bestDay: terbaik ? { date: terbaik.date, usd: terbaik.usd } : null,
    worstDay: terburuk ? { date: terburuk.date, usd: terburuk.usd } : null,
    worstClosePct: tutup.length ? Number(Math.min(...tutup.map((r) => r.netPct ?? 0)).toFixed(2)) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  closedRecent: [...tutup].reverse().slice(0, 15),
  trading,
};
if (heartbeat && now - heartbeat > 10 * 60e3) {
  snapshot.quality = { complete: false, reasons: [`bot tidak memberi tanda hidup sejak ${Math.round((now - heartbeat) / 60000)} menit`] };
}

snapshot.performanceInput = { closes: tutup.map((r) => ({ netUsd: r.netUsd, netPct: r.netPct, closedAt: r.closedAt, holdMinutes: r.holdMinutes, symbol: r.symbol })), flatBand: 0.5 };
saveSnapshot(OUT, snapshot, cfg);
console.log(`[charon] total=$${snapshot.totalUsd} open=${positions.length} closed=${tutup.length} complete=${snapshot.quality.complete}`);
release();
process.exit(0);
