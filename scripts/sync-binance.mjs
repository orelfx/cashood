#!/usr/bin/env node
/**
 * Snapshot Binance Bot ("Budi") — bot crypto futures di Binance TESTNET.
 *
 * Dana virtual, jadi tampil sebagai uji coba. Botnya sedang DIJEDA (sejak
 * 23 Juni 2026) dan prosesnya sengaja dimatikan; situs tidak menghidupkannya.
 * Yang dibaca, read-only:
 *   - data/memory/budi_trade_conflict.jsonl — satu baris per trade tertutup.
 *     Bot hanya mencatat hasil dalam PERSEN (PnL ÷ nilai posisi), bukan dolar,
 *     jadi tidak ada angka dolar per trade yang dikarang di sini.
 *   - data/equity_state.json — saldo testnet terakhir yang tercatat bot.
 *   - data/bot_paused.json — status jeda.
 * Modal awal testnet tidak tercatat di mana pun, sehingga untung/rugi dolar
 * dana ini sengaja tidak dihitung.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, lock } from './lib/io.mjs';
import { saveSnapshot } from './lib/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'binance');
const OUT = resolve(DIR, 'live.json');
const HOME = process.env.BINANCE_HOME || '/root/binance';
const WIB = 7 * 3600e3;

const release = lock(resolve(DIR, 'sync.lock.local'));
const cfg = JSON.parse(readFileSync(resolve(DIR, 'config.json'), 'utf8'));
const readJ = (rel) => { try { return JSON.parse(readFileSync(resolve(HOME, rel), 'utf8')); } catch { return null; } };
const r2 = (n) => Number((Number(n) || 0).toFixed(2));
const now = Date.now();

const OUTCOME = { TP_HIT: 'target tercapai', SL_HIT: 'kena stop', SERSAN_FRONT_RUN: 'ditutup lebih awal (Sersan)', WIN_FRONT_RUN: 'untung ditutup lebih awal' };
const rows = readFileSync(resolve(HOME, 'data/memory/budi_trade_conflict.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// Hanya trade testnet; satu baris "shadow" ditandai bot sendiri untuk dikecualikan.
const tutup = rows.filter((r) => r.metadata?.pnl_pct != null && r.metadata?.mode === 'testnet').map((r) => {
  const m = r.metadata;
  const conf = String(r.content || '').match(/Confidence:\s*(\d+)/);
  return {
    symbol: String(m.pair || '?').replace(/USDT$/, ''),
    closedAt: Date.parse(m.timestamp || r.timestamp),
    investedUsd: null,
    netUsd: null,
    netPct: Number(Number(m.pnl_pct).toFixed(2)),
    holdMinutes: null,
    strategy: `${m.direction === 'LONG' ? 'long' : 'short'} futures${conf && Number(conf[1]) > 0 ? ` · yakin ${conf[1]}%` : ''}`,
    reason: OUTCOME[m.outcome] || String(m.outcome || '—').toLowerCase().replace(/_/g, ' '),
  };
}).filter((r) => Number.isFinite(r.closedAt)).sort((a, b) => a.closedAt - b.closedAt);

const menang = tutup.filter((r) => r.netPct > 0.1).length;
const kalah = tutup.filter((r) => r.netPct < -0.1).length;
const eq = readJ('data/equity_state.json');
const paused = readJ('data/bot_paused.json');
const locked = existsSync(resolve(HOME, '.AUTO_RESTART_DISABLED'));
const balance = r2(eq?.balance);
if (!(balance > 0)) throw new Error('saldo testnet terakhir tidak terbaca');
const balanceAt = Date.parse(eq?.updated_at || '') || null;
const pausedAt = Date.parse(paused?.timestamp || '') || null;
const tgl = (t) => new Date(t + WIB).toISOString().slice(0, 10);

const snapshot = {
  fund: 'binance',
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  usdIdr: null,
  totalUsd: balance,
  botWalletUsd: balance,
  walletUsd: balance,
  lpUsd: 0,
  holdings: [{ symbol: 'USDT (testnet)', amount: balance, price: 1, usd: balance }],
  positions: [],
  history: [],
  historyNote: 'bot mencatat hasil tiap trade dalam persen dari nilai posisi, bukan dolar',
  stats: {
    closedCount: tutup.length, openCount: 0, graded: menang + kalah, wins: menang, losses: kalah,
    winRate: menang + kalah ? r2((menang / (menang + kalah)) * 100) : null,
    realisedUsd: null, bestDay: null, worstDay: null,
    worstClosePct: tutup.length ? Math.min(...tutup.map((r) => r.netPct)) : null,
    timezone: 'Asia/Jakarta (UTC+7)',
  },
  // Dua puluh terakhir di snapshot; seluruh riwayat di trades.json, yang baru
  // diambil halaman saat pembaca meminta "tampilkan semua".
  closedRecent: [...tutup].reverse().slice(0, 20),
  trading: {
    paper: true,
    mode: 'testnet',
    capitalKnown: false,
    initialUsd: null,
    cashUsd: balance,
    positionsUsd: 0,
    realizedUsd: null,
    unrealizedUsd: 0,
    paused: Boolean(paused?.paused),
    startedAt: tutup[0]?.closedAt || null,
    heartbeatAt: balanceAt,
    status: paused?.paused ? 'dijeda' : 'tidak aktif',
    healthy: false,
    lead: `Bot crypto futures di Binance TESTNET — dananya virtual. Bot ini sedang dijeda${pausedAt ? ` sejak ${tgl(pausedAt)}` : ''}`
      + `${locked ? ' dan sengaja tidak dinyalakan otomatis' : ''}. Riwayat di bawah adalah seluruh trade yang pernah ia catat.`,
    tiles: [
      { k: 'Saldo testnet terakhir', usd: balance, n: balanceAt ? `tercatat ${tgl(balanceAt)} · belum terverifikasi` : 'belum terverifikasi' },
      { k: 'Trade tercatat', v: String(tutup.length), n: tutup.length ? `${tgl(tutup[0].closedAt)} – ${tgl(tutup.at(-1).closedAt)}` : '—' },
      { k: 'Menang · kalah', v: `${menang} · ${kalah}`, n: `${tutup.length - menang - kalah} impas` },
      { k: 'Mode', v: 'testnet', n: 'dana virtual, bukan uang asli' },
    ],
    llm: null,
  },
  quality: { complete: false, reasons: [`bot dijeda; saldo terakhir tercatat ${balanceAt ? tgl(balanceAt) : '—'} dan belum terverifikasi`] },
};
snapshot.performanceInput = { closes: tutup.map((r) => ({ netPct: r.netPct, closedAt: r.closedAt, symbol: r.symbol })), flatBand: 0.1 };
saveSnapshot(OUT, snapshot, cfg);
atomicJSON(resolve(DIR, 'trades.json'), { fund: snapshot.fund, updatedAt: now, rows: [...tutup].reverse() });
console.log(`[binance] saldo=$${balance} closed=${tutup.length} paused=${Boolean(paused?.paused)}`);
release();
process.exit(0);
