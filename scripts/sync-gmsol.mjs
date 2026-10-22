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
import { readFileSync, existsSync, readdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, lock, readJSON } from './lib/io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'gmsol');
const SRC = process.env.GMSOL_SRC || '/root/cashood-inbox/gmsol-live.json';
const ENGINE = process.env.GMSOL_ENGINE_DIR || '/root/grok-meridian-live-v3'; // HANYA DIBACA
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

// Ringkasan screening dari scan terakhir logs/screen-*.jsonl (baris satu scan berbagi ts).
// Hanya simbol pasangan + jumlah; teks alasan dibersihkan dari string mirip alamat.
function tailText(f, max = 3e6) { const fd = openSync(f, 'r'); try { const n = fstatSync(fd).size, len = Math.min(n, max), b = Buffer.alloc(len); readSync(fd, b, 0, len, n - len); return b.toString('utf8'); } finally { closeSync(fd); } }
function screening(dir = resolve(ENGINE, 'logs')) {
  try {
    const f = readdirSync(dir).filter((x) => /^screen-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().at(-1); if (!f) return null;
    const rows = []; for (const l of tailText(resolve(dir, f)).split('\n')) { try { const o = JSON.parse(l); if (o && o.ts) rows.push(o); } catch { /* baris terpotong */ } }
    const lastTs = rows.at(-1)?.ts; if (!lastTs) return null;
    const scan = rows.filter((r) => r.ts === lastTs), sum = scan.find((r) => r.pool_symbol === '*'), pools = scan.filter((r) => r.pool_symbol !== '*');
    const m = /sol_dlmm=(\d+) inactive_1h=(\d+)/.exec(sum?.reasons?.[0] || '');
    const key = (s) => String(s).split(/[ =!<>]/)[0];
    const cnt = {}; for (const p of pools) for (const k of new Set((p.reasons || []).map(key))) cnt[k] = (cnt[k] || 0) + 1;
    const rejected = pools.filter((p) => (p.reasons || []).length).length;
    return { scannedAt: time(lastTs), solPools: m ? Number(m[1]) : null, inactive1h: m ? Number(m[2]) : null, checked: pools.length, passed: pools.length - rejected,
      topReasons: Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ reason: text(k, 60), pools: n })),
      closest: pools.filter((p) => (p.reasons || []).length).sort((a, b) => a.reasons.length - b.reasons.length).slice(0, 5).map((p) => ({ symbol: text(p.pool_symbol, 24), binStep: num(p.bs), reasons: p.reasons.slice(0, 4).map((x) => text(x, 90)) })) };
  } catch { return null; }
}
const goLive = (j) => time(j.t0At) ?? time(readJSON(resolve(ENGINE, 'state', 'live.json'), {})?.created);
const v3Fields = (j) => {
  const b = j.brakes || {};
  return {
    t0At: goLive(j), spec: text(j.spec, 40), execErrors: num(j.execErrors), screening: screening(), equityStatus: text(j.equityStatus, 80),
    walletSolShared: num(j.walletSolShared?.sol) == null ? null : { sol: Number(Number(j.walletSolShared.sol).toFixed(4)), usd: num(j.solPriceUsd) == null ? null : r2(j.walletSolShared.sol * j.solPriceUsd), label: 'dipakai bersama Meridian2' },
    sizing: { sizeUsd: r2(j.sizing?.sizeUsd) ?? 50, maxOpen: num(j.sizing?.maxOpen) ?? 5 },
    brakes: { dailyPct: num(b.dailyPct) ?? 25, totalFloorUsd: r2(b.totalFloorUsd) ?? 600, dailyBlocked: b.dailyBlocked === true,
      dailyBlockedUntil: time(b.dailyBlockedUntil), dayChangePct: r3(b.dayChangePct), dayStartLedgerUsd: r2(b.dayStartLedgerUsd), dayFloorUsd: r2(b.dayFloorUsd), gateUnknownBlock: b.gateUnknownBlock === true, halted: b.halted === true },
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
  if (now - asOf > STALE_MS) wait('Mesin berhenti, menunggu restart', asOf);
  if (eq == null) { out({ ...base, status: 'waiting', reason: 'ekuitas buku belum diketahui', asOf, ...v3Fields(j) }); console.log('[gmsol] waiting: ledger unknown'); release(); process.exit(0); }
  // valueUsd/feesUsd per posisi: dari state mesin (HANYA DIBACA), pembacaan on-chain terakhir p.last.
  // valueUsd = (likuiditas + fee belum diklaim + rent) x harga SOL; feesUsd = fee belum diklaim + fee sudah diklaim (USD saat klaim).
  // Tidak ada pembacaan / basi (>15 menit) / harga tidak ada -> null (tidak dikarang).
  const px = num(j.solPriceUsd), st = Object.values(readJSON(resolve(ENGINE, 'state', 'live.json'), {})?.positions || {});
  const live = (p) => { const s = st.find((q) => time(q.openedAt) === time(p.openedAt) && text(q.name, 24) === text(p.symbol, 24)); const l = s?.last;
    return s && l && px != null && num(l.valueL) != null && num(l.unclaimedL) != null && now - (time(l.t) ?? 0) <= STALE_MS ? { s, l } : null; };
  const seats = (Array.isArray(j.openSeats) ? j.openSeats : []).slice(0, 10).map((p) => { const m = live(p);
    return { symbol: text(p.symbol, 24), openedAt: time(p.openedAt), basisUsd: r2(p.basisUsd), pnlUsd: r2(p.pnlUsd), pnlPct: r3(p.pnlPct), inRange: typeof p.inRange === 'boolean' ? p.inRange : null,
      valueUsd: m ? r2((Number(m.l.valueL) + Number(m.l.unclaimedL) + (num(m.s.rentL) || 0)) / 1e9 * px) : null,
      feesUsd: m ? r2(Number(m.l.unclaimedL) / 1e9 * px + (num(m.s.claimedUsd) || 0)) : null }; });
  const closes = (Array.isArray(j.closeHistory) ? j.closeHistory : []).slice(0, 200).map((c) => ({
    symbol: text(c.symbol, 24), openedAt: time(c.openedAt), closedAt: time(c.closedAt), netUsd: r2(c.netUsd), netPct: r3(c.netPct), reason: text(c.reason, 80) }));
  out({ ...base, status: 'ok', asOf, ...v3Fields(j),
    equityUsd: eq, pnlUsd: r2(eq - CAPITAL), pnlPct: r3((eq / CAPITAL - 1) * 100),
    realizedUsd: r2(j.realizedUsd), unrealizedUsd: r2(j.unrealizedUsd),
    openSeats: seats, closes, equityCurve: curve(asOf, eq) });
  console.log(`[gmsol] ok ledger ${eq}`);
} finally { release(); }
