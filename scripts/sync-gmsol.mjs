#!/usr/bin/env node
/*
 * GMSOL — Grok Meridian LIVE (UANG ASLI), medium risk, modal $1.200.
 * Terpisah total dari arsip dry run Grok Meridian (data/gm): angka tidak digabung.
 *
 * Sumber: HANYA /root/cashood-inbox/gmsol-live.json, ditulis mesin gmsol-live
 * (spec gmsol-live-v2) di server ini, mode LIVE saja. HANYA DIBACA.
 * PnL = ekuitas on-chain − $1.200 (modal). Tidak ada angka lain yang dihitung.
 * Berkas belum ada / rusak / bukan mode live / basi (>15 menit) → status tanpa
 * angka ("menunggu data on-chain"). Hanya field allowlist yang terbit; teks bebas
 * dibersihkan dari string mirip alamat.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, lock } from './lib/io.mjs';

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
const base = { fund: 'gmsol', system: 'GMSOL', realMoney: true, risk: 'medium', capitalUsd: CAPITAL, checkedAt: now };

function out(o) {
  const s = JSON.stringify(o);
  if (/[1-9A-HJ-NP-Za-km-z]{32,}/.test(s)) throw new Error('string mirip alamat di keluaran');
  assertPublic(o);
  atomicJSON(resolve(DIR, 'live.json'), o);
}
function wait(reason, asOf = null) { out({ ...base, status: 'waiting', reason, asOf }); console.log(`[gmsol] waiting: ${reason}`); release(); process.exit(0); }

try {
  if (!existsSync(SRC)) wait('menunggu data on-chain (uji $50 belum jalan)');
  let j; try { j = JSON.parse(readFileSync(SRC, 'utf8')); } catch { wait('berkas sumber rusak'); }
  if (j?.fund !== 'gmsol' || j?.mode !== 'live') wait('berkas sumber bukan mode live');
  const asOf = time(j.updatedAt);
  const eq = r2(j.equityUsd);
  if (!asOf || eq == null) wait('ekuitas on-chain belum diketahui', asOf);
  if (now - asOf > STALE_MS) wait('data tertunda', asOf);
  const seats = (Array.isArray(j.openSeats) ? j.openSeats : []).slice(0, 10).map((p) => ({
    symbol: text(p.symbol, 24), openedAt: time(p.openedAt), basisUsd: r2(p.basisUsd), valueUsd: r2(p.valueUsd), feesUsd: r2(p.feesUsd), pnlPct: r3(p.pnlPct), inRange: typeof p.inRange === 'boolean' ? p.inRange : null }));
  const closes = (Array.isArray(j.closeHistory) ? j.closeHistory : []).slice(0, 200).map((c) => ({
    symbol: text(c.symbol, 24), openedAt: time(c.openedAt), closedAt: time(c.closedAt), netUsd: r2(c.netUsd), netPct: r3(c.netPct), reason: text(c.reason, 80) }));
  const b = j.brakes || {};
  out({ ...base, status: 'ok', asOf, t0At: time(j.t0At), spec: text(j.spec, 40),
    equityUsd: eq, pnlUsd: r2(eq - CAPITAL), pnlPct: r3((eq / CAPITAL - 1) * 100),
    walletUsd: r2(j.walletUsd), lpUsd: r2(j.lpUsd), tokensUsd: r2(j.tokensUsd),
    sizing: { sizeUsd: r2(j.sizing?.sizeUsd), maxOpen: num(j.sizing?.maxOpen) },
    brakes: { dailyBlocked: b.dailyBlocked === true, halted: b.halted === true, dayLossUsd: r2(b.dayLossUsd), totalLossUsd: r2(b.totalLossUsd) },
    openSeats: seats, closes });
  console.log(`[gmsol] ok equity ${eq}`);
} finally { release(); }
