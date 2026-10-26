#!/usr/bin/env node
/*
 * SolBot — buku trading meme coin Solana dengan UANG ASLI (Devil Greed live).
 * High risk. Terpisah total dari buku paper Devil Greed (dgsol, grokbot/solana):
 * angkanya tidak pernah digabung dengan paper, tidak masuk Cashood Index.
 *
 * Sumber: /root/cashood-inbox/live-solana-public.json, skema
 * "devil-greed-live-solana/v1", ditarik dari VPS bot oleh fetch-live-solana.sh
 * (key sendiri). HANYA DIBACA.
 *
 * Yang terbit hanya field yang dikenal (allowlist). chart_url, label, alamat
 * wallet/mint/pool dan signature tidak pernah ikut: teks bebas dibersihkan dari
 * string base58/0x panjang, lalu seluruh hasil diperiksa sekali lagi.
 * Kalau berkas belum ada, rusak, atau umurnya lebih dari 15 menit, yang terbit
 * adalah status tanpa angka — angka lama tidak boleh tampil seolah live.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, lock } from './lib/io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'solbot');
const SRC = process.env.SOLBOT_SRC || '/root/cashood-inbox/live-solana-public.json';
const SCHEMA = 'devil-greed-live-solana/v1';
const STALE_MS = 15 * 60e3;
const release = lock(resolve(DIR, 'sync.lock.local'));
const now = Number(process.env.SOLBOT_NOW) || Date.now();

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(2)));
const r4 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(4)));
// Harga meme coin bisa 0,00000123 → simpan 6 angka penting, bukan 2 desimal.
const px = (v) => (num(v) == null ? null : Number(Number(v).toPrecision(6)));
const time = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
// Teks bebas: alamat/signature (base58 Solana, 0x…) dibuang, panjang dibatasi.
const ADDR = /0x[0-9a-fA-F]{16,}|[1-9A-HJ-NP-Za-km-z]{32,}/g;
const text = (v, max = 120) => (v == null || typeof v === 'object' ? null : String(v).replace(ADDR, '…').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
const MODES = ['DRY_RUN', 'LIVE', 'HALTED'];
const EXITS = ['TP', 'STOP', 'HALT', 'MANUAL'];

function publish(snapshot) {
  assertPublic(snapshot);
  const raw = JSON.stringify(snapshot);
  if (/[1-9A-HJ-NP-Za-km-z]{32,}/.test(raw)) throw new Error('string mirip alamat/signature lolos ke data SolBot; dibatalkan');
  atomicJSON(resolve(DIR, 'live.json'), snapshot);
}
// Kiriman bot tertunda/rusak: angka terakhir yang sah tetap diterbitkan
// (status 'stale' + asOf lama), supaya SolBot tidak hilang dari halaman dan
// Total aset. 2026-10-26: kiriman Grok putus 39 jam dan SolBot lenyap dari beranda.
const KEEP_MS = 7 * 24 * 3600e3;
function waiting(status, reason, extra = {}) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(resolve(DIR, 'live.json'), 'utf8')); } catch { /* belum ada */ }
  if (prev && ['ok', 'stale'].includes(prev.status) && prev.equityUsd != null && prev.asOf && now - prev.asOf <= KEEP_MS) {
    publish({ ...prev, status: 'stale', reason: 'Data tertunda', checkedAt: now });
    console.log(`[solbot] stale: ${reason}; angka terakhir dipertahankan`);
    release(); process.exit(0);
  }
  publish({ fund: 'solbot', status, reason, checkedAt: now, ...extra });
  console.log(`[solbot] ${status}: ${reason}`);
  release(); process.exit(0);
}

let src;
try {
  statSync(SRC);
  src = JSON.parse(readFileSync(SRC, 'utf8'));
} catch { waiting('waiting', 'Data belum masuk'); }
if (src?.schema !== SCHEMA) waiting('waiting', 'Format data belum sesuai');
const asOf = time(src.as_of);
if (!asOf) waiting('waiting', 'Data belum lengkap (as_of kosong)');
const mode = MODES.includes(String(src.mode).toUpperCase()) ? String(src.mode).toUpperCase() : null;
// Umur dinilai dari as_of milik bot, bukan dari waktu berkas ditarik.
// Lewat 15 menit tetap diolah, tapi ditandai 'stale'; lewat 7 hari tanpa angka.
const late = now - asOf > STALE_MS;
if (now - asOf > KEEP_MS) waiting('stale', 'Data tertunda', { asOf, mode });

// Kategori market cap dari bot: degen < $200 rb, low $200 rb – $30 jt.
const sleeve = (v) => { const t = String(v ?? '').toLowerCase().trim(); return ['degen', 'low'].includes(t) ? t : text(v, 16); };
const position = (p) => ({
  symbol: text(p.symbol, 24) || '—', name: text(p.name, 40), sleeve: sleeve(p.sleeve),
  openedAt: time(p.opened_at), entryPriceUsd: px(p.entry_price_usd), markPriceUsd: px(p.mark_price_usd),
  sizeUsd: r2(p.size_usd), valueUsd: r2(p.value_usd), pnlUsd: r2(p.pnl_usd), pnlPct: r2(p.pnl_pct),
  tpStage: num(p.tp_stage), tpStagesTotal: num(p.tp_stages_total), stopPriceUsd: px(p.stop_price_usd),
  // Opsional: harga target TP berikutnya dan satu kalimat alasan masuk.
  nextTpPriceUsd: px(p.next_tp_price_usd), entryNote: text(p.entry_note, 200), peakPriceUsd: px(p.peak_price_usd),
});
const trade = (c) => ({
  symbol: text(c.symbol, 24) || '—', sleeve: sleeve(c.sleeve), openedAt: time(c.opened_at), closedAt: time(c.closed_at),
  entryPriceUsd: px(c.entry_price_usd), exitPriceUsd: px(c.exit_price_usd), pnlUsd: r2(c.pnl_usd), pnlPct: r2(c.pnl_pct),
  exitReason: EXITS.includes(String(c.exit_reason).toUpperCase()) ? String(c.exit_reason).toUpperCase() : text(c.exit_reason, 16),
  simulated: c.simulated === true, exitNote: text(c.exit_note, 200), tpStage: num(c.tp_stage),
  // Modal yang dipakai trade ini: dari bot kalau ada, kalau tidak dihitung dari PnL $ dan %.
  sizeUsd: r2(c.size_usd) ?? (num(c.pnl_usd) != null && num(c.pnl_pct) ? r2(num(c.pnl_usd) / (num(c.pnl_pct) / 100)) : null),
});
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const positions = arr(src.positions).map(position).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
const allClosed = arr(src.closed_trades).map(trade).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

// Kurva ekuitas: maksimal ~720 titik (rata dari awal sampai akhir, titik terakhir selalu ikut).
let curve = arr(src.equity_curve).map((p) => ({ t: time(p.t), usd: r2(p.equity_usd) })).filter((p) => p.t && p.usd != null).sort((a, b) => a.t - b.t);
if (curve.length > 720) { const step = curve.length / 719; curve = [...Array.from({ length: 719 }, (_, i) => curve[Math.floor(i * step)]), curve.at(-1)]; }

const g = src.guards && typeof src.guards === 'object' ? src.guards : {};
const stopButton = typeof g.stop_button === 'boolean' ? g.stop_button : text(g.stop_button, 30);
const closedStat = (list) => {
  const graded = list.filter((c) => c.pnlUsd != null);
  const wins = graded.filter((c) => c.pnlUsd > 0).length;
  return { count: list.length, wins, losses: graded.filter((c) => c.pnlUsd < 0).length, winRatePct: graded.length ? r2((wins / graded.length) * 100) : null, pnlUsd: r2(graded.reduce((t, c) => t + c.pnlUsd, 0)) };
};
const startUsd = r2(src.start_capital_usd), equityUsd = r2(src.equity_usd);
// Field tambahan (opsional, aditif di v1): arus dana, biaya, untung terealisasi.
// Nama field t/usd/sol (spesifikasi) atau at/amount_usd/amount_sol (yang dikirim bot) sama-sama diterima.
const flows = arr(src.flows).map((f) => ({ t: time(f.t ?? f.at), usd: r2(f.usd ?? f.amount_usd), sol: r4(f.sol ?? f.amount_sol), type: ['deposit', 'withdraw'].includes(String(f.type).toLowerCase()) ? String(f.type).toLowerCase() : null, note: text(f.note, 200) }))
  .filter((f) => f.t && f.usd != null && f.type).sort((a, b) => a.t - b.t);
const netFlowUsd = flows.length ? r2(flows.reduce((t, f) => t + (f.type === 'withdraw' ? -Math.abs(f.usd) : Math.abs(f.usd)), 0)) : 0;
const basisUsd = startUsd > 0 ? r2(startUsd + netFlowUsd) : null;   // modal awal + setoran − penarikan
const st = src.stats && typeof src.stats === 'object' ? src.stats : {};
// Perubahan 24 jam dari kurva ekuitas (titik terdekat ke 24 jam lalu, minimal 20 jam ke belakang).
const day = curve.length ? curve.filter((p) => p.t <= asOf - 20 * 3600e3).at(-1) : null;
const flows24 = flows.filter((f) => day && f.t > day.t).reduce((t, f) => t + (f.type === 'withdraw' ? -Math.abs(f.usd) : Math.abs(f.usd)), 0);

const snapshot = {
  fund: 'solbot', status: late ? 'stale' : 'ok', ...(late ? { reason: 'Data tertunda' } : {}), schema: SCHEMA, realMoney: true,
  mode, haltReason: text(src.halt_reason, 200),
  asOf, startedAt: time(src.started_at), checkedAt: now,
  startCapitalUsd: startUsd, startCapitalSol: r4(src.start_capital_sol), solPriceUsd: r2(src.sol_price_usd),
  cashUsd: r2(src.cash_usd), equityUsd,
  // Untung/rugi terhadap modal bersih (modal awal + setoran − penarikan).
  changeUsd: basisUsd > 0 && equityUsd != null ? r2(equityUsd - basisUsd) : null,
  changePct: basisUsd > 0 && equityUsd != null ? r2((equityUsd / basisUsd - 1) * 100) : null,
  basisUsd, netFlowUsd, flows,
  change24hUsd: day && equityUsd != null ? r2(equityUsd - day.usd - flows24) : null,
  change24hPct: day && day.usd > 0 && equityUsd != null ? r2(((equityUsd - flows24) / day.usd - 1) * 100) : null,
  capitalInUsd: r2(src.capital_in_usd), botNetPnlUsd: r2(src.net_pnl_usd), botNetPnlPct: r2(src.net_pnl_pct),
  realizedPnlUsd: r2(src.realized_pnl_usd), unrealizedPnlUsd: r2(src.unrealized_pnl_usd), feesUsd: r2(src.fees_usd),
  strategy: text(src.strategy, 300),
  totals: { trades: num(st.trades_total), wins: num(st.wins), losses: num(st.losses), winRatePct: r2(st.win_rate_pct), bestPct: r2(st.best_trade_pct), worstPct: r2(st.worst_trade_pct), avgHoldMin: r2(st.avg_hold_min) },
  equityCurve: curve,
  positions,
  closedTrades: allClosed.slice(0, 200),
  closedStats: { all: closedStat(allClosed), real: closedStat(allClosed.filter((c) => !c.simulated)), simulated: allClosed.filter((c) => c.simulated).length },
  guards: {
    ticketPct: r2(g.ticket_pct), stopPct: r2(g.stop_pct), dailyHaltPct: r2(g.daily_halt_pct), totalHaltPct: r2(g.total_halt_pct),
    dailyPnlPct: r2(g.daily_pnl_pct), dailyRoomPct: r2(g.daily_room_pct), drawdownPct: r2(g.drawdown_pct), stopButton: stopButton ?? null,
  },
  disclaimer: text(src.disclaimer, 400),
};
publish(snapshot);
console.log(`[solbot] ${mode || '?'} equity $${equityUsd ?? '—'} (${snapshot.changePct ?? '—'}%) · ${positions.length} posisi · ${allClosed.length} trade tertutup`);
release();
