#!/usr/bin/env node
/*
 * GMSOL — Grok Meridian LIVE (UANG ASLI), HIGH RISK, modal buku $1.200 (v3.2).
 * Terpisah total dari arsip dry run Grok Meridian (data/gm): angka tidak digabung.
 *
 * Sumber: HANYA /root/cashood-inbox/gmsol-live.json, ditulis mesin gmsol-live
 * gmsol-live-v3 (spec v3.2 r2) di server ini, mode LIVE saja. HANYA DIBACA.
 * Kinerja = equityLedgerUsd (buku GMSOL: 1200 + PnL realisasi + belum realisasi
 * posisi engine), BUKAN saldo wallet. walletSolShared hanya info sekunder
 * (wallet dipakai bersama Meridian). Berkas v2.x (tanpa equityLedgerUsd) → menunggu.
 * Berkas belum ada / rusak / bukan mode live / basi (>15 menit) → status tanpa
 * angka ("menunggu data on-chain"). Hanya field allowlist yang terbit; teks bebas
 * dibersihkan dari string mirip alamat.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, lock, readJSON } from './lib/io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'gmsol');
const SRC = process.env.GMSOL_SRC || '/root/cashood-inbox/gmsol-live.json';
const CAPITAL = 1200;
const STALE_MS = 15 * 60e3;
const release = lock(resolve(DIR, 'sync.lock.local'));
const now = Number(process.env.GMSOL_NOW) || Date.now();
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(2)));
const r3 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(3)));
const time = (v) => { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const ADDR = /0x[0-9a-fA-F]{16,}|[1-9A-HJ-NP-Za-km-z]{32,}/g;
const text = (v, max = 160) => (v == null || typeof v === 'object' ? null : String(v).replace(ADDR, '…').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
const base = { fund: 'gmsol', system: 'GMSOL', realMoney: true, risk: 'high', capitalUsd: CAPITAL, checkedAt: now };

function out(o) {
  const s = JSON.stringify(o);
  if (/[1-9A-HJ-NP-Za-km-z]{32,}/.test(s)) throw new Error('string mirip alamat di keluaran');
  assertPublic(o);
  atomicJSON(resolve(DIR, 'live.json'), o);
}
// Riwayat ekuitas (satu titik per pembaruan sumber, 30 hari terakhir) untuk grafik
// dan perubahan 24 jam di beranda; disimpan lokal, terbit di dalam live.json.
function curve(asOf, eq) {
  const f = resolve(DIR, 'nav.local.json'), h = readJSON(f, { points: [] });
  if (!h.points.length || asOf > h.points.at(-1).t) h.points.push({ t: asOf, usd: eq });
  h.points = h.points.filter((p) => p.t > now - 30 * 86400e3).slice(-4000);
  atomicJSON(f, h);
  const step = Math.max(1, Math.ceil(h.points.length / 400));
  return h.points.filter((_, i) => i % step === 0 || i === h.points.length - 1);
}
function wait(reason, asOf = null) { out({ ...base, status: 'waiting', reason, asOf }); console.log(`[gmsol] waiting: ${reason}`); release(); process.exit(0); }

const v3Fields = (j) => {
  const b = j.brakes || {};
  return {
    t0At: time(j.t0At), spec: text(j.spec, 40), equityStatus: text(j.equityStatus, 80),
    walletSolShared: num(j.walletSolShared?.sol) == null ? null : { sol: Number(Number(j.walletSolShared.sol).toFixed(4)), label: 'dipakai bersama Meridian' },
    sizing: { sizeUsd: r2(j.sizing?.sizeUsd) ?? 50, maxOpen: num(j.sizing?.maxOpen) ?? 5 },
    brakes: { dailyPct: num(b.dailyPct) ?? 25, totalFloorUsd: r2(b.totalFloorUsd) ?? 600, dailyBlocked: b.dailyBlocked === true,
      dailyBlockedUntil: time(b.dailyBlockedUntil), dayChangePct: r3(b.dayChangePct), halted: b.halted === true },
  };
};

try {
  if (!existsSync(SRC)) wait('belum jalan — menunggu mesin v3.2 menulis data live');
  let j; try { j = JSON.parse(readFileSync(SRC, 'utf8')); } catch { wait('berkas sumber rusak'); }
  if (j?.fund !== 'gmsol' || j?.mode !== 'live') wait('belum jalan — sumber bukan mode live');
  // Berkas lama v2.x (rem lama, ekuitas wallet) tidak dipakai lagi.
  if (!('equityLedgerUsd' in j)) wait('belum jalan — menunggu mesin v3.2 (data v2 lama diabaikan)');
  const asOf = time(j.updatedAt);
  const eq = r2(j.equityLedgerUsd);
  if (!asOf) wait('belum jalan — menunggu data live');
  if (now - asOf > STALE_MS) wait('data tertunda', asOf);
  if (eq == null) { out({ ...base, status: 'waiting', reason: 'ekuitas buku belum diketahui', asOf, ...v3Fields(j) }); console.log('[gmsol] waiting: ledger unknown'); release(); process.exit(0); }
  const seats = (Array.isArray(j.openSeats) ? j.openSeats : []).slice(0, 10).map((p) => ({
    symbol: text(p.symbol, 24), openedAt: time(p.openedAt), basisUsd: r2(p.basisUsd), pnlUsd: r2(p.pnlUsd), pnlPct: r3(p.pnlPct), inRange: typeof p.inRange === 'boolean' ? p.inRange : null }));
  const closes = (Array.isArray(j.closeHistory) ? j.closeHistory : []).slice(0, 200).map((c) => ({
    symbol: text(c.symbol, 24), openedAt: time(c.openedAt), closedAt: time(c.closedAt), netUsd: r2(c.netUsd), netPct: r3(c.netPct), reason: text(c.reason, 80) }));
  out({ ...base, status: 'ok', asOf, ...v3Fields(j),
    equityUsd: eq, pnlUsd: r2(eq - CAPITAL), pnlPct: r3((eq / CAPITAL - 1) * 100),
    realizedUsd: r2(j.realizedUsd), unrealizedUsd: r2(j.unrealizedUsd),
    openSeats: seats, closes, equityCurve: curve(asOf, eq) });
  console.log(`[gmsol] ok ledger ${eq}`);
} finally { release(); }
