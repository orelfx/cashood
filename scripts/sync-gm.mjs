#!/usr/bin/env node
/*
 * Grok Meridian (GM) — dry run, panel terpisah, pola yang sama dengan GRR.
 *
 * Sumber: /root/cashood-inbox/grok-meridian.json — HANYA DIBACA. Mesin paper
 * Grok Meridian berjalan di VPS lain (abil-vps) dan menulis berkas itu secara
 * atomik tiap 5 menit di kotak masuk sana; fetch-paper-inbox.sh menariknya ke
 * kotak masuk lokal bersama berkas devil greed. Isinya satu buku kertas
 * (challenger = strategi Grok), varian shadow yang didaftarkan sebelum mulai
 * (dilaporkan, tidak dinilai). Tidak ada buku mirror (keputusan pemilik
 * 2026-10-19).
 *
 * Kolom "Meridian asli" TIDAK diambil dari berkas mesin (mesin Grok tidak boleh
 * menilai lawannya sendiri; blok "live" di berkas itu diabaikan). Skrip ini
 * menghitungnya sendiri dari data dana Meridian yang sudah ada di Cashood
 * (data/meridian/nav.json, live.json, config.json), mulai dari T0 = startedAt
 * di berkas mesin: Modified Dietz harian dirangkai dalam USD (metode yang sama
 * dengan buku Grok), arus dana bersih sejak T0, dan persen mentah sebagai
 * catatan. Tanpa startedAt kolom ini "menunggu T0".
 *
 * Satuan: USD. Modal awal = NAV Meridian saat T0; setoran/penarikan Meridian
 * dicerminkan ke buku kertas, jadi semua buku dinilai dengan persen yang sudah
 * dikoreksi arus dana (pctSinceStart). Angka SOL boleh ikut sebagai info.
 *
 * Belum ada berkas sumber → status "preparing" (mesin paper belum mulai), tanpa
 * angka. Berkas ada tapi rusak/tidak lengkap → "waiting". Tidak ada angka yang
 * dikarang di sini: semua angka disalin dari sumber, hanya dibulatkan.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, downsample, lock, readJSON } from './lib/io.mjs';
import { linkedDietz, meridianFlows } from './lib/dietz.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data');
const DIR = resolve(DATA, 'gm');
const MERIDIAN = resolve(DATA, 'meridian');
const SRC = process.env.GM_STATE || '/root/cashood-inbox/grok-meridian.json';
const release = lock(resolve(DIR, 'sync.lock.local'));
const now = Date.now();
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(2)));
const r4 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(4)));
const time = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); return Number.isFinite(t) ? t : null; };
// Teks bebas: alamat (0x…, base58 Solana) dipangkas, panjang dibatasi.
const text = (v, max = 120) => (v == null ? null : String(v).replace(/0x[0-9a-fA-F]{16,}/g, '0x…').replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '…').replace(/\s+/g, ' ').trim().slice(0, max) || null);
// Hash pra-registrasi: cukup 12 karakter heks di situs (hash utuh 64 heks
// ditolak assertPublic, dan Auditor memegang hash lengkap di grup).
const hash12 = (v) => { const m = String(v ?? '').toLowerCase().match(/[0-9a-f]{12,}/); return m ? m[0].slice(0, 12) : null; };

function stop(status, reason) {
  const prev = readJSON(resolve(DIR, 'live.json'));
  atomicJSON(resolve(DIR, 'live.json'), {
    fund: 'gm', status, paperOnly: true, reason, checkedAt: now, startCapitalUsd: null, startedAt: null,
    challenger: null, live: null, last: prev?.status === 'ok' ? { updatedAt: prev.updatedAt } : null,
  });
  console.log(`[gm] ${status}: ${reason}`);
  release(); process.exit(0);
}

if (!existsSync(SRC)) stop('preparing', 'Persiapan — mesin paper belum mulai.');
let src;
try { src = JSON.parse(readFileSync(SRC, 'utf8')); } catch { stop('waiting', 'berkas data GM tidak terbaca'); }
if (src?.status === 'preparing') stop('preparing', text(src.reason, 200) || 'Persiapan — mesin paper belum mulai.');
const start = num(src?.startCapitalUsd), updatedAt = time(src?.updatedAt ?? src?.as_of);
if (!(start > 0) || !updatedAt || !src.challenger) stop('waiting', 'isi berkas data GM belum lengkap');

const seat = (s) => ({
  symbol: text(s.symbol, 24) || '—', book: text(s.book, 16), binStep: num(s.binStep), bins: num(s.bins), shape: text(s.shape ?? s.strategy, 16),
  openedAt: time(s.openedAt), basisUsd: r2(s.basisUsd), basisSol: r4(s.basisSol), pnlPct: r2(s.pnlPct),
  inRange: s.inRange === true ? true : s.inRange === false ? false : null,
});
const close = (c) => ({
  symbol: text(c.symbol, 24) || '—', book: text(c.book, 16), openedAt: time(c.openedAt), closedAt: time(c.closedAt ?? c.at),
  netUsd: r2(c.netUsd ?? c.pnlUsd), netSol: r4(c.netSol), netPct: r2(c.netPct ?? c.pnlPct), feesUsd: r2(c.feesUsd), reason: text(c.reason ?? c.closeReason, 80),
});
const book = (b, id) => ({
  id: text(id ?? b.id, 32), label: text(b.label, 80), equityUsd: r2(b.equityUsd), equitySol: r4(b.equitySol), pctSinceStart: r2(b.pctSinceStart),
  netFlowsUsd: r2(b.netFlowsUsd), maxDrawdownPct: r2(b.maxDrawdownPct),
  closes: num(b.closes) ?? 0, winRatePct: r2(b.winRatePct), avgWinUsd: r2(b.avgWinUsd), avgLossUsd: r2(b.avgLossUsd),
  feesUsd: r2(b.feesUsd), costsUsd: r2(b.costsUsd),
  openSeats: (Array.isArray(b.openSeats) ? b.openSeats : []).slice(0, 40).map(seat),
  last10Closes: (Array.isArray(b.last10Closes) ? b.last10Closes : []).slice(0, 10).map(close),
});
// Shadow: varian yang didaftarkan sebelum T0 (mis. range 70 dan 100 bin).
// Dilaporkan apa adanya; ringkas saja, tanpa daftar seat.
const shadow = (b) => { const x = book(b); return { id: x.id, label: x.label, equityUsd: x.equityUsd, pctSinceStart: x.pctSinceStart, maxDrawdownPct: x.maxDrawdownPct, closes: x.closes, winRatePct: x.winRatePct, feesUsd: x.feesUsd, costsUsd: x.costsUsd }; };
// Kolom pembanding: dihitung di sini dari data dana Meridian, bukan dari mesin.
function meridianLive(t0) {
  if (!t0) return { status: 'waiting_t0', note: 'Menunggu T0: mesin paper belum menetapkan waktu mulai.' };
  const nav = readJSON(resolve(MERIDIAN, 'nav.json'), { points: [] });
  const snap = readJSON(resolve(MERIDIAN, 'live.json'));
  const cfg = readJSON(resolve(MERIDIAN, 'config.json'));
  const points = (nav.points || []).filter((p) => p.quality == null || p.quality === 'complete').map((p) => ({ t: p.t, usd: p.usd, outflowTotalUsd: p.outflowTotalUsd }));
  const lastT = points.at(-1)?.t ?? 0;
  if (snap && Number.isFinite(snap.updatedAt) && snap.updatedAt > lastT && Number.isFinite(snap.totalUsd) && (snap.quality?.complete ?? true))
    points.push({ t: snap.updatedAt, usd: snap.totalUsd, outflowTotalUsd: snap.outflowTotalUsd });
  const res = cfg ? linkedDietz({ points, flows: meridianFlows(cfg, points), t0 }) : null;
  if (!res) return { status: 'unavailable', note: 'Data dana Meridian di Cashood belum cukup untuk menghitung hasil sejak T0.' };
  const gap = start > 0 ? (start / res.startNavUsd - 1) * 100 : null;
  return {
    status: 'ok', equityUsd: r2(res.endNavUsd), pctSinceStart: r2(res.pctSinceStart), rawPctSinceStart: r2(res.rawPctSinceStart),
    netFlowsUsd: r2(res.netFlowsUsd), maxDrawdownPct: r2(res.maxDrawdownPct), startNavUsd: r2(res.startNavUsd), startNavAt: res.startNavAt,
    asOf: res.asOf, source: 'cashood meridian',
    note: `Dihitung Cashood dari data dana Meridian, bukan dari mesin Grok: Modified Dietz harian dirangkai (USD) sejak T0. `
      + `NAV di T0 $${res.startNavUsd.toFixed(2)}, sekarang $${res.endNavUsd.toFixed(2)}; arus dana bersih sejak T0 $${res.netFlowsUsd.toFixed(2)}; `
      + `tanpa koreksi arus dana ${res.rawPctSinceStart >= 0 ? '+' : ''}${res.rawPctSinceStart.toFixed(2)}%.`
      + (gap != null && Math.abs(gap) > 1 ? ` Perhatian: modal kertas berbeda ${gap.toFixed(2)}% dari NAV Meridian di T0.` : ''),
  };
}
const live = meridianLive(time(src.startedAt));
const pr = src.preregistration && typeof src.preregistration === 'object' ? {
  version: text(src.preregistration.version, 24), lockedAt: time(src.preregistration.lockedAt),
  prereg12: hash12(src.preregistration.sha256Prereg), params12: hash12(src.preregistration.sha256Params),
} : null;

const snapshot = {
  fund: 'gm', status: 'ok', paperOnly: src.paperOnly !== false,
  updatedAt, checkedAt: now, startCapitalUsd: start, startedAt: time(src.startedAt), solPriceUsd: r2(src.solPriceUsd),
  stale: now - updatedAt > 20 * 60e3,
  preregistration: pr,
  challenger: book(src.challenger, 'challenger'),
  shadows: (Array.isArray(src.shadows) ? src.shadows : []).slice(0, 8).map(shadow),
  live,
};
assertPublic(snapshot);

// Riwayat persen tiap buku untuk grafik (satu titik per pembaruan sumber).
const histFile = resolve(DIR, 'nav.json');
const hist = readJSON(histFile, { points: [] });
const lastT = hist.points.at(-1)?.t ?? 0;
if (updatedAt > lastT) hist.points.push({ t: updatedAt, usd: snapshot.challenger.equityUsd ?? start, challenger: snapshot.challenger.pctSinceStart, live: live.pctSinceStart ?? null });
const points = downsample(hist.points, now).map((p) => ({ t: p.t, usd: p.usd, challenger: p.challenger ?? null, live: p.live ?? null }));
atomicJSON(histFile, { updatedAt, points });
atomicJSON(resolve(DIR, 'live.json'), snapshot);
console.log(`[gm] grok ${snapshot.challenger.pctSinceStart}% · live ${live.pctSinceStart ?? live.status}%`);
release();
