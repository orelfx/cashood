#!/usr/bin/env node
/**
 * Snapshot Binance Bot — bot crypto futures di Binance TESTNET (dana virtual).
 *
 * Sejak 29 Sep 2026 bot berjalan dengan mesin baru (`demo_runner.py`,
 * "demo-v2") yang mencatat semuanya di `data/demo_v2.sqlite3`: status akun,
 * posisi aktif, dan tiap trade tertutup dengan hasil BERSIH dalam dolar
 * (setelah komisi dan funding, dari fill bursa). Situs membacanya read-only.
 *
 * Riwayat mesin lama (Mei–Juni, `data/memory/budi_trade_conflict.jsonl`)
 * tetap diterbitkan sebagai arsip. Mesin lama hanya mencatat persen dari nilai
 * posisi, jadi baris-baris itu tidak punya angka dolar dan tidak ikut dihitung
 * dalam statistik kinerja mesin baru.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, lock, readJSON } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'binance');
const OUT = resolve(DIR, 'live.json');
const NAV = resolve(DIR, 'nav.json');
const HOME = process.env.BINANCE_HOME || '/root/binance';
const WIB = 7 * 3600e3;

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
const r2 = (n) => Number((Number(n) || 0).toFixed(2));
const now = Date.now();
const tgl = (t) => new Date(t + WIB).toISOString().slice(0, 10);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const Database = createRequire('/root/charon RH/package.json')('better-sqlite3');
const db = new Database(resolve(HOME, 'data', 'demo_v2.sqlite3'), { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const kv = (key) => parse(db.prepare('SELECT body FROM kv WHERE key=?').get(key)?.body);
const status = kv('status');
if (!status?.account) throw new Error('status akun testnet belum tercatat');

// ─── mesin baru: trade tertutup, dalam dolar bersih ───────────────────────
const EXIT = {
  take_profit: 'target tercapai', stop_loss: 'kena stop', time_exit: 'batas waktu habis', trailing_stop: 'trailing stop',
  protection_failed: 'ditutup: pengaman gagal dipasang', commissioning_complete: 'uji pemasangan selesai', manual: 'ditutup manual',
};
const label = (s) => String(s || '').replace(/_/g, ' ');
const baru = db.prepare("SELECT body FROM trades WHERE status='CLOSED' ORDER BY closed_ms").all().map((r) => parse(r.body)).filter(Boolean)
  .filter((t) => Number.isFinite(t.closed_ms) && Number.isFinite(t.net_usd)).map((t) => ({
    symbol: String(t.symbol || '?').replace(/USDT$/, ''),
    closedAt: t.closed_ms,
    investedUsd: null,
    netUsd: r2(t.net_usd),
    netPct: t.equity_at_entry > 0 ? Number(((t.net_usd / t.equity_at_entry) * 100).toFixed(3)) : null,
    rMultiple: Number.isFinite(t.r_multiple) ? r2(t.r_multiple) : null,
    holdMinutes: Math.round((t.closed_ms - t.opened_ms) / 60000),
    strategy: `${t.direction === 'LONG' ? 'long' : 'short'} · ${label(t.strategy)}`,
    reason: EXIT[t.exit_reason] || (t.exit_reason ? label(t.exit_reason) : 'ditutup bursa (SL/TP)'),
    feesUsd: r2(Number(t.commission_usd || 0) + Number(t.funding_usd || 0)),
    equityAtEntry: Number(t.equity_at_entry) || null,
    openedAt: t.opened_ms,
  }));

// ─── posisi aktif ─────────────────────────────────────────────────────────
const positions = (status.active || []).map((a, i) => {
  const t = typeof a === 'string' ? parse(db.prepare('SELECT body FROM trades WHERE id=?').get(a)?.body) || { id: a } : a;
  return {
    tokenId: `bn-${t.id || i}`,
    symbol: String(t.symbol || '?').replace(/USDT$/, ''),
    direction: t.direction || null,
    lot: Number(t.qty ?? t.requested_qty) || null,
    entryPrice: Number(t.entry ?? t.planned_price) || null,
    slPrice: Number(t.sl) || null,
    tpPrice: Number(t.tp) || null,
    bookLabel: `${t.direction === 'LONG' ? 'long' : 'short'} · ${label(t.strategy)}${t.leverage ? ` · ${t.leverage}×` : ''}`,
    ageMinutes: t.opened_ms ? Math.round((now - t.opened_ms) / 60000) : null,
    principalUsd: 0, feesUsd: 0, investedUsd: null, collectedFeesUsd: 0, pnlUsd: null,
  };
});

// ─── aktivitas 24 jam ─────────────────────────────────────────────────────
const since = now - 86400e3;
const count = (kind) => db.prepare('SELECT COUNT(*) n FROM events WHERE kind=? AND time_ms>=?').get(kind, since).n;
const act = { scans: count('scan'), skips: count('entry_skip'), opened: count('position_open'), closed: count('position_closed'), errors: count('cycle_error') };
const lastErrAt = db.prepare("SELECT MAX(time_ms) t FROM events WHERE kind IN ('cycle_error','entry_error','reconcile_error')").get().t;
const startedAt = Number(kv('created_ms')) || baru[0]?.openedAt || null;
db.close();

// ─── arsip mesin lama (persen saja) ───────────────────────────────────────
const OUTCOME = { TP_HIT: 'target tercapai', SL_HIT: 'kena stop', SERSAN_FRONT_RUN: 'ditutup lebih awal (Sersan)', WIN_FRONT_RUN: 'untung ditutup lebih awal' };
let lama = [];
try {
  lama = readFileSync(resolve(HOME, 'data/memory/budi_trade_conflict.jsonl'), 'utf8').split('\n').filter(Boolean).map(parse)
    .filter((r) => r?.metadata?.pnl_pct != null && r.metadata.mode === 'testnet').map((r) => {
      const m = r.metadata;
      return {
        symbol: String(m.pair || '?').replace(/USDT$/, ''), closedAt: Date.parse(m.timestamp || r.timestamp),
        investedUsd: null, netUsd: null, netPct: Number(Number(m.pnl_pct).toFixed(2)), holdMinutes: null,
        strategy: `${m.direction === 'LONG' ? 'long' : 'short'} · mesin lama`,
        reason: OUTCOME[m.outcome] || label(m.outcome).toLowerCase(), legacy: true,
      };
    }).filter((r) => Number.isFinite(r.closedAt));
} catch { /* arsip tidak wajib */ }

// ─── nilai akun ───────────────────────────────────────────────────────────
const equity = r2(status.account.equity);
if (!(equity > 0)) throw new Error('equity testnet tidak masuk akal');
const updatedAt = Number(status.updated_ms) || null;
const hidup = updatedAt && now - updatedAt < 10 * 60e3;
const modal = Number(cfg.events?.[0]?.usd) || null;

// Deret nilai: saldo saat tiap trade dibuka (dicatat bot) sebagai titik
// awal, lalu satu titik per siklus situs dari status akun bot.
const nav = readJSON(NAV, { points: [] });
if (!nav.points?.length) {
  const seed = [...(modal && startedAt ? [{ t: startedAt, usd: modal }] : []),
    ...baru.filter((r) => r.equityAtEntry).map((r) => ({ t: r.openedAt, usd: r2(r.equityAtEntry) }))];
  atomicJSON(NAV, { updatedAt: now, points: seed.map((p) => ({ ...p, quality: 'complete' })) });
}

const hariWib = (t) => new Date(t + WIB).toISOString().slice(0, 10);
const perHari = new Map();
let menang = 0, kalah = 0;
for (const r of baru) {
  const b = perHari.get(hariWib(r.closedAt)) || { date: hariWib(r.closedAt), usd: 0, closes: 0, wins: 0, losses: 0, winUsd: 0, lossUsd: 0 };
  b.usd += r.netUsd; b.closes += 1;
  if (r.netUsd > 0.5) { b.wins += 1; b.winUsd += r.netUsd; menang += 1; } else if (r.netUsd < -0.5) { b.losses += 1; b.lossUsd += r.netUsd; kalah += 1; }
  perHari.set(b.date, b);
}
const history = [...perHari.values()].map((r) => ({ ...r, usd: r2(r.usd), winUsd: r2(r.winUsd), lossUsd: r2(r.lossUsd) })).sort((a, b) => a.date.localeCompare(b.date));
const semua = [...baru, ...lama].sort((a, b) => b.closedAt - a.closedAt);
const bersih = ({ equityAtEntry, openedAt, ...r }) => r;

const snapshot = {
  fund: 'binance',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  totalUsd: equity,
  botWalletUsd: equity,
  walletUsd: equity,
  lpUsd: 0,
  holdings: [{ symbol: 'USDT (testnet)', amount: equity, price: 1, usd: equity }],
  positions,
  history,
  historyNote: 'hasil bersih mesin baru (sejak 29 Sep) setelah komisi dan funding',
  stats: {
    closedCount: semua.length, openCount: positions.length, graded: menang + kalah, wins: menang, losses: kalah,
    winRate: menang + kalah ? r2((menang / (menang + kalah)) * 100) : null,
    realisedUsd: r2(baru.reduce((s, r) => s + r.netUsd, 0)),
    bestDay: history.length ? history.reduce((a, r) => (r.usd > a.usd ? r : a)) : null,
    worstDay: history.length ? history.reduce((a, r) => (r.usd < a.usd ? r : a)) : null,
    worstClosePct: baru.length ? Math.min(...baru.map((r) => r.netPct ?? 0)) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  closedRecent: semua.slice(0, 20).map(bersih),
  trading: {
    paper: true,
    mode: 'testnet',
    initialUsd: modal,
    cashUsd: equity,
    positionsUsd: 0,
    realizedUsd: r2(baru.reduce((s, r) => s + r.netUsd, 0)),
    unrealizedUsd: 0,
    peakUsd: null,
    paused: Boolean(status.paused || status.daily_halt),
    startedAt,
    heartbeatAt: updatedAt,
    status: !hidup ? 'tidak aktif' : status.paused ? 'dijeda' : status.daily_halt ? 'berhenti hari ini (batas rugi)' : 'berjalan',
    healthy: Boolean(hidup && !status.paused && !status.daily_halt),
    lead: `Bot crypto futures di Binance TESTNET — dananya virtual. Sejak ${startedAt ? tgl(startedAt) : '29 Sep'} berjalan dengan mesin baru `
      + `yang mencatat hasil bersih tiap trade dalam dolar. Riwayat mesin lama (Mei–Juni) tetap tersimpan sebagai arsip.`,
    tiles: [
      { k: 'Pindai pasar', v: String(act.scans), n: `24 jam · ${act.skips} kandidat dilewati` },
      { k: 'Buka · tutup', v: `${act.opened} · ${act.closed}`, n: '24 jam terakhir' },
      { k: 'Error siklus', v: String(act.errors), n: lastErrAt ? `24 jam · terakhir ${tgl(lastErrAt)} ${new Date(lastErrAt + WIB).toISOString().slice(11, 16)} WIB` : '24 jam', tone: act.errors ? 'neg' : 'pos' },
      { k: 'Mode', v: 'testnet', n: `mesin ${String(status.version || 'demo-v2')} · dana virtual` },
    ],
    llm: null,
  },
};
if (!hidup) snapshot.quality = { complete: false, reasons: [`bot tidak memperbarui status sejak ${updatedAt ? tgl(updatedAt) : '—'}`] };

snapshot.performanceInput = { closes: baru.map((r) => ({ netUsd: r.netUsd, netPct: r.netPct, closedAt: r.closedAt, holdMinutes: r.holdMinutes, symbol: r.symbol })), flatBand: 0.005 };
saveSnapshot(OUT, snapshot, cfg);
atomicJSON(resolve(DIR, 'trades.json'), { fund: 'binance', updatedAt: now, rows: semua.map(bersih) });
console.log(`[binance] equity=$${equity} baru=${baru.length} arsip=${lama.length} aktif=${positions.length} status=${snapshot.trading.status}`);
release();
process.exit(0);
