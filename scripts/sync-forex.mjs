#!/usr/bin/env node
/**
 * Snapshot Forex Bot — bot forex/emas di akun DEMO Exness (MT5).
 *
 * Uangnya virtual (akun demo), jadi dana ini tampil sebagai uji coba seperti
 * Charon RH. Situs hanya MEMBACA database bot (`/root/forex/data/forex.db`)
 * dalam mode read-only; tidak ada nomor akun, server, atau tiket MT5 yang ikut
 * terbit — hanya simbol, arah, angka, dan alasan singkat.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'forex');
const OUT = resolve(DIR, 'live.json');
const NAV = resolve(DIR, 'nav.json');
const HOME = process.env.FOREX_HOME || '/root/forex';
const WIB = 7 * 3600e3;

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
const Database = createRequire('/root/charon RH/package.json')('better-sqlite3');
const db = new Database(resolve(HOME, 'data', 'forex.db'), { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const now = Date.now();
// Waktu di database ini kadang tanpa zona; semuanya UTC.
const ms = (t) => { if (!t) return null; const s = String(t).replace(' ', 'T'); const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z'); return Number.isFinite(v) ? v : null; };
const r2 = (n) => Number((Number(n) || 0).toFixed(2));
const clean = (s, max = 320) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const sym = (s) => String(s || '').replace(/m$/, '');
const INITIAL = Number(cfg.events?.[0]?.usd) || 10000;

// ─── deret nilai akun (tiap ±5 menit) ─────────────────────────────────────
// Bacaan gagal tercatat sebagai 100 (bukan saldo); titik yang jatuh di bawah
// separuh median tetangganya dibuang sebelum diterbitkan.
const raw = db.prepare('SELECT timestamp, equity FROM risk_snapshots ORDER BY id').all()
  .map((r) => ({ t: ms(r.timestamp), usd: Number(r.equity) })).filter((p) => p.t && p.usd > 0);
const points = raw.filter((p, i) => {
  const win = raw.slice(Math.max(0, i - 6), i + 7).map((q) => q.usd).sort((a, b) => a - b);
  const med = win[Math.floor(win.length / 2)];
  return p.usd >= 0.5 * med && p.usd <= 2 * med;
});
const last = points[points.length - 1];
if (!last) throw new Error('equity akun demo belum terbaca');

// ─── trade tertutup ───────────────────────────────────────────────────────
const REASON = { sl_hit: 'kena stop', tp_hit: 'target tercapai', expert_close: 'ditutup bot' };
let saldo = INITIAL;
const tutup = db.prepare('SELECT * FROM trades ORDER BY exit_time').all().map((t) => {
  const net = Number(t.pnl_currency) + Number(t.commission || 0) + Number(t.swap || 0);
  const buka = ms(t.entry_time), tutupAt = ms(t.exit_time);
  const row = {
    symbol: sym(t.symbol),
    closedAt: tutupAt,
    investedUsd: null,
    netUsd: r2(net),
    // Persen terhadap saldo akun sebelum trade ini, bukan terhadap nilai lot.
    netPct: saldo > 0 ? Number(((net / saldo) * 100).toFixed(3)) : null,
    rMultiple: Number.isFinite(Number(t.pnl_r)) ? Number(Number(t.pnl_r).toFixed(2)) : null,
    holdMinutes: buka && tutupAt ? Math.round((tutupAt - buka) / 60000) : null,
    strategy: `${t.direction === 'LONG' ? 'beli' : 'jual'} · ${String(t.setup_type || '').replace(/_/g, ' ')}`.trim(),
    reason: REASON[t.exit_reason] || String(t.exit_reason || '—').replace(/_/g, ' '),
    ...(t.entry_reasoning ? { reasonDetail: String(t.entry_reasoning).replace(/\s+/g, ' ').slice(0, 240) } : {}),
    lot: Number(t.lot) || null,
  };
  saldo += net;
  return row;
}).filter((r) => r.closedAt);

const hariWib = (t) => new Date(t + WIB).toISOString().slice(0, 10);
const perHari = new Map();
let menang = 0, kalah = 0;
for (const r of tutup) {
  const hari = hariWib(r.closedAt);
  const b = perHari.get(hari) || { date: hari, usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  b.usd += r.netUsd; b.closes += 1;
  if (r.netUsd > 0.5) { b.wins += 1; b.winUsd += r.netUsd; menang += 1; }
  else if (r.netUsd < -0.5) { b.losses += 1; b.lossUsd += r.netUsd; kalah += 1; }
  perHari.set(hari, b);
}
const history = [...perHari.values()].map((r) => ({ ...r, usd: r2(r.usd), winUsd: r2(r.winUsd), lossUsd: r2(r.lossUsd) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const terbaik = history.reduce((a, r) => (a == null || r.usd > a.usd ? r : a), null);
const terburuk = history.reduce((a, r) => (a == null || r.usd < a.usd ? r : a), null);

// ─── posisi terbuka ───────────────────────────────────────────────────────
// Database tidak menyimpan nilai berjalan per posisi; nilainya sudah masuk
// equity akun. Yang terbit: simbol, arah, lot, harga masuk, SL/TP.
// Dolar per 1 satuan harga untuk posisi ini, dari risiko awal yang dicatat bot
// saat fill (risiko $ ÷ jarak entry–SL awal), disesuaikan kalau lot sudah
// dijual sebagian. Dengan itu hasil kalau kena SL/TP dan nilai kontrak bisa
// dihitung tanpa menebak ukuran kontrak tiap pair.
function fxFutures(p) {
  const entry = Number(p.entry_price), sl0 = Number(p.initial_sl ?? p.sl), risk = Number(p.initial_risk_amount);
  const lot = Number(p.lot), lot0 = Number(p.initial_lot) || lot;
  let unit = risk > 0 && entry && sl0 && Math.abs(entry - sl0) > 0 ? (risk / Math.abs(entry - sl0)) * (lot0 ? lot / lot0 : 1) : null;
  if (!unit && Number(p.current_price) && Number(p.floating_usd) && Math.abs(p.current_price - entry) > 0) unit = Math.abs(p.floating_usd / (p.current_price - entry));
  return {
    kind: 'fx',
    leverage: Number(p.leverage) || null,
    marginUsd: Number.isFinite(Number(p.margin_usd)) && p.margin_usd !== null ? r2(p.margin_usd) : null,
    unitUsd: unit,
    notionalUsd: unit && Number(p.current_price || entry) ? r2(unit * Number(p.current_price || entry)) : null,
    riskUsd: risk > 0 ? r2(risk) : null,
    markPrice: Number(p.current_price) || null,
    unrealizedUsd: p.floating_usd != null && Number.isFinite(Number(p.floating_usd)) ? r2(p.floating_usd) : null,
    timeframe: /h1/i.test(String(p.setup_type)) ? 'H1' : /h4/i.test(String(p.setup_type)) ? 'H4' : null,
  };
}
const positions = db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY entry_time").all().map((p) => ({
  tokenId: `fx-${p.id}`,
  symbol: sym(p.symbol),
  direction: p.direction,
  lot: Number(p.lot) || null,
  entryPrice: Number(p.entry_price) || null,
  slPrice: Number(p.sl) || null,
  tpPrice: Number(p.tp) || null,
  bookLabel: `${p.direction === 'LONG' ? 'beli' : 'jual'} · ${String(p.setup_type || '').replace(/_/g, ' ')}`,
  ageMinutes: ms(p.entry_time) ? Math.round((now - ms(p.entry_time)) / 60000) : null,
  // Alasan masuk, keyakinan, dan nilai berjalan baru terisi kalau bot mencatatnya
  // (entry_reasoning, confidence, floating_usd / current_price).
  ...(p.entry_reasoning ? { thesis: String(p.entry_reasoning).replace(/\s+/g, ' ').slice(0, 300) } : {}),
  ...(Number.isFinite(Number(p.confidence)) && p.confidence !== null ? { confidence: Number(p.confidence) } : {}),
  ...(Number(p.current_price) ? { priceUsd: Number(p.current_price) } : {}),
  principalUsd: 0, feesUsd: 0, investedUsd: null, collectedFeesUsd: 0,
  pnlUsd: null,
  // Disimpan terpisah: rekonsiliasi snapshot menghitung ulang pnlUsd dari nilai/modal.
  ...(p.floating_usd != null && Number.isFinite(Number(p.floating_usd)) ? { floatingUsd: r2(p.floating_usd) } : {}),
  futures: fxFutures(p),
}));

// ─── status bot ───────────────────────────────────────────────────────────
const hb = db.prepare('SELECT timestamp, mt5_connected, health_status FROM heartbeat_log ORDER BY id DESC LIMIT 1').get();
const ctl = db.prepare('SELECT trading_paused, pause_reason FROM bot_control_state WHERE id=1').get();
const since = new Date(now - 86400e3).toISOString().slice(0, 19);
const count = (sql) => db.prepare(sql).get(since).n;
const llm24 = count('SELECT COUNT(*) n FROM llm_calls WHERE timestamp >= ?');
const cek24 = count('SELECT COUNT(*) n FROM pre_trade_decisions WHERE timestamp >= ?');
const buka24 = count('SELECT COUNT(*) n FROM positions WHERE entry_time >= ?');
const tutup24 = count('SELECT COUNT(*) n FROM trades WHERE exit_time >= ?');
const bias = db.prepare('SELECT timestamp, session, confidence, reasoning FROM macro_bias WHERE llm_success=1 ORDER BY id DESC LIMIT 1').get();
const model = db.prepare('SELECT model FROM llm_calls ORDER BY id DESC LIMIT 1').get()?.model;
const fxAccount = (() => { const cols = db.prepare('PRAGMA table_info(risk_snapshots)').all().map((c) => c.name);
  if (!cols.includes('margin_used_usd')) return {};
  const a = db.prepare('SELECT equity, margin_used_usd, free_margin_usd FROM risk_snapshots ORDER BY id DESC LIMIT 1').get();
  return a?.margin_used_usd != null ? { account: { equityUsd: r2(a.equity), marginUsd: r2(a.margin_used_usd), availableUsd: a.free_margin_usd != null ? r2(a.free_margin_usd) : null } } : {}; })();
db.close();

const hbAt = ms(hb?.timestamp);
const peak = Math.max(...points.map((p) => p.usd));
const totalUsd = r2(last.usd);
const realizedUsd = r2(tutup.reduce((s, r) => s + r.netUsd, 0));
const dow = new Date(now).getUTCDay();
const akhirPekan = dow === 6 || (dow === 0 && new Date(now).getUTCHours() < 22) || (dow === 5 && new Date(now).getUTCHours() >= 22);
const hidup = hbAt && now - hbAt < 15 * 60e3;

atomicJSON(NAV, { updatedAt: now, points: points.map((p) => ({ t: p.t, usd: r2(p.usd), quality: 'complete' })) });

const snapshot = {
  fund: 'forex',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  totalUsd,
  botWalletUsd: totalUsd,
  walletUsd: totalUsd,
  lpUsd: 0,
  holdings: [{ symbol: 'USD (akun demo)', amount: totalUsd, price: 1, usd: totalUsd }],
  positions,
  history,
  historyNote: 'hasil trade yang sudah ditutup di akun demo, dalam dolar setelah komisi dan swap',
  stats: {
    closedCount: tutup.length, openCount: positions.length, graded: menang + kalah, wins: menang, losses: kalah,
    winRate: menang + kalah ? r2((menang / (menang + kalah)) * 100) : null,
    realisedUsd: realizedUsd,
    bestDay: terbaik ? { date: terbaik.date, usd: terbaik.usd } : null,
    worstDay: terburuk ? { date: terburuk.date, usd: terburuk.usd } : null,
    worstClosePct: tutup.length ? Math.min(...tutup.map((r) => r.netPct ?? 0)) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  // Dua puluh terakhir di snapshot; seluruh riwayat di trades.json, yang baru
  // diambil halaman saat pembaca meminta "tampilkan semua".
  closedRecent: [...tutup].reverse().slice(0, 20),
  tradesAll: tutup,
  tradesFlatBand: 0.005,
  trading: {
    paper: true,
    // Margin akun dari snapshot risiko terakhir, kalau bot mencatatnya
    // (margin_used_usd / free_margin_usd / account_leverage).
    ...fxAccount,
    mode: 'demo',
    initialUsd: INITIAL,
    cashUsd: totalUsd,
    positionsUsd: 0,
    realizedUsd,
    unrealizedUsd: 0,
    peakUsd: r2(peak),
    drawdownPct: peak > 0 ? r2(((peak - totalUsd) / peak) * 100) : 0,
    paused: Boolean(ctl?.trading_paused),
    startedAt: points[0].t,
    heartbeatAt: hbAt,
    status: !hidup ? (akhirPekan ? 'pasar tutup (akhir pekan)' : 'tidak aktif') : ctl?.trading_paused ? 'dijeda' : hb?.health_status === 'healthy' ? 'sehat' : clean(hb?.health_status, 30),
    healthy: Boolean(hidup && hb?.health_status === 'healthy' && !ctl?.trading_paused),
    lead: `Bot forex dan emas yang berjalan di akun DEMO Exness — uangnya virtual, harganya pasar sungguhan. Modal demo awal $${INITIAL.toLocaleString('en-US')}.`,
    tiles: [
      { k: 'Keputusan AI', v: String(llm24), n: 'panggilan 24 jam' },
      { k: 'Setup diperiksa', v: String(cek24), n: 'pemeriksaan sebelum entry, 24 jam' },
      { k: 'Buka · tutup', v: `${buka24} · ${tutup24}`, n: '24 jam terakhir' },
    ],
    llm: bias ? {
      model: clean(model, 40) || null,
      lastDecisionAt: ms(bias.timestamp),
      lastAction: `bias ${clean(bias.session, 20).replace('_', ' ')}`,
      lastReason: clean(bias.reasoning, 360),
    } : null,
  },
};
snapshot.performanceInput = { closes: tutup.map((r) => ({ netUsd: r.netUsd, netPct: r.netPct, closedAt: r.closedAt, holdMinutes: r.holdMinutes, symbol: r.symbol })), flatBand: 0.005 };
saveSnapshot(OUT, snapshot, cfg);
console.log(`[forex] total=$${totalUsd} open=${positions.length} closed=${tutup.length} points=${points.length} complete=${snapshot.quality.complete}`);
release();
process.exit(0);
