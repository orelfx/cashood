#!/usr/bin/env node
/*
 * Grok Reborn Rich (GRR) — dry run, terpisah dari panel lain.
 *
 * Sumber: /root/grok-reborn-rich/state/cashood.json (ditulis proses pm2
 * grr-paper tiap 5 menit) — HANYA DIBACA. Isinya dua buku kertas (mirror =
 * aturan live Reborn Rich, challenger = Grok v1.1) dan "live" (Reborn Rich
 * asli) sebagai pembanding, masing-masing dalam persen sejak modal awal yang
 * sama. Kalau berkasnya belum ada atau rusak, yang terbit adalah status
 * "menunggu data", bukan error.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, downsample, lock, readJSON } from './lib/io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'grr');
const SRC = process.env.GRR_STATE || '/root/grok-reborn-rich/state/cashood.json';
const release = lock(resolve(DIR, 'sync.lock.local'));
const now = Date.now();
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(2)));
const time = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
// Teks bebas: alamat (0x…, base58 Solana) dipangkas, panjang dibatasi.
const text = (v, max = 120) => (v == null ? null : String(v).replace(/0x[0-9a-fA-F]{16,}/g, '0x…').replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '…').replace(/\s+/g, ' ').trim().slice(0, max) || null);

function waiting(reason) {
  const prev = readJSON(resolve(DIR, 'live.json'));
  atomicJSON(resolve(DIR, 'live.json'), { fund: 'grr', status: 'waiting', reason, checkedAt: now, last: prev?.status === 'ok' ? { updatedAt: prev.updatedAt } : null });
  console.log(`[grr] menunggu data: ${reason}`);
  release(); process.exit(0);
}

let src;
try { src = JSON.parse(readFileSync(SRC, 'utf8')); } catch { waiting('berkas data GRR belum ada atau tidak terbaca'); }
const start = num(src?.startCapitalUsd), updatedAt = time(src?.updatedAt);
if (!(start > 0) || !updatedAt || !src.mirror || !src.challenger) waiting('isi berkas data GRR belum lengkap');

const seat = (s) => ({
  symbol: text(s.symbol, 24) || '—', book: text(s.book, 16), feeTierPct: r2(s.feeTierPct), openedAt: time(s.openedAt),
  basisUsd: r2(s.basisUsd), pnlPct: r2(s.pnlPct), inRange: s.inRange === true ? true : s.inRange === false ? false : null,
});
const close = (c) => ({
  symbol: text(c.symbol, 24) || '—', book: text(c.book, 16), openedAt: time(c.openedAt), closedAt: time(c.closedAt ?? c.at),
  netUsd: r2(c.netUsd ?? c.pnlUsd), netPct: r2(c.netPct ?? c.pnlPct), feesUsd: r2(c.feesUsd), reason: text(c.reason ?? c.closeReason, 80),
});
const book = (b) => ({
  label: text(b.label, 80), equityUsd: r2(b.equityUsd), pctSinceStart: r2(b.pctSinceStart),
  closes: num(b.closes) ?? 0, winRatePct: r2(b.winRatePct), avgWinUsd: r2(b.avgWinUsd), avgLossUsd: r2(b.avgLossUsd),
  feesUsd: r2(b.feesUsd), costsUsd: r2(b.costsUsd),
  openSeats: (Array.isArray(b.openSeats) ? b.openSeats : []).map(seat),
  last10Closes: (Array.isArray(b.last10Closes) ? b.last10Closes : []).slice(0, 10).map(close),
});
const live = src.live && typeof src.live === 'object' ? {
  equityUsd: r2(src.live.equityUsd), pctSinceStart: r2(src.live.pctSinceStart), rawPctSinceStart: r2(src.live.rawPctSinceStart),
  netFlowsUsd: r2(src.live.netFlowsUsd), asOf: time(src.live.asOf), source: text(src.live.source, 30), note: text(src.live.note, 600),
} : null;

const snapshot = {
  fund: 'grr', status: 'ok', paperOnly: src.paperOnly !== false,
  updatedAt, checkedAt: now, startCapitalUsd: start, startedAt: time(src.startedAt),
  stale: now - updatedAt > 20 * 60e3,
  mirror: book(src.mirror), challenger: book(src.challenger), live,
};
assertPublic(snapshot);

// Riwayat persen tiap buku untuk grafik (satu titik per pembaruan sumber).
const histFile = resolve(DIR, 'nav.json');
const hist = readJSON(histFile, { points: [] });
const lastT = hist.points.at(-1)?.t ?? 0;
if (updatedAt > lastT) hist.points.push({ t: updatedAt, usd: snapshot.challenger.equityUsd ?? start, mirror: snapshot.mirror.pctSinceStart, challenger: snapshot.challenger.pctSinceStart, live: live?.pctSinceStart ?? null });
const points = downsample(hist.points, now).map((p) => ({ t: p.t, usd: p.usd, mirror: p.mirror ?? null, challenger: p.challenger ?? null, live: p.live ?? null }));
atomicJSON(histFile, { updatedAt, points });
atomicJSON(resolve(DIR, 'live.json'), snapshot);
console.log(`[grr] mirror ${snapshot.mirror.pctSinceStart}% · challenger ${snapshot.challenger.pctSinceStart}% · live ${live?.pctSinceStart ?? '—'}%`);
release();
