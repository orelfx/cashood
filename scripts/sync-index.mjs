#!/usr/bin/env node
/*
 * Cashood Index — satu angka untuk seluruh dana sungguhan Cashood.
 *
 * Isinya semua dana di funds.json yang BUKAN uji coba (paper) — Safe Box bukan
 * dana, jadi tidak ikut. Dana yang lulus dari dry-run otomatis masuk begitu
 * tanda `paper`-nya dicabut.
 *
 * Cara hitung (aturan pemilik 2026-10-03):
 *   - Level mulai 100. Tiap siklus ia bergerak sebesar rata-rata tertimbang
 *     perubahan HARGA SAHAM tiap dana (nilai dana ÷ unit beredar). Harga saham
 *     tidak melompat saat ada setoran atau pembagian profit, jadi yang terukur
 *     murni kinerja.
 *   - Bobot tiap dana = nilai kepemilikan Orel di dana itu (sisi pengelola);
 *     di atas kertas index mewakili dananya secara penuh.
 *   - Index dirantai (chain-linked): dana baru masuk dengan bobotnya sendiri
 *     tanpa membuat level melompat.
 *
 *   node scripts/sync-index.mjs            # satu langkah dari keadaan terakhir
 *   node scripts/sync-index.mjs --backfill # bangun ulang riwayat dari deret tiap dana
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../assets/core.js';
import { atomicJSON, assertPublic, downsample, generation, lock, readJSON } from './lib/io.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.CASHOOD_DATA_DIR || resolve(ROOT, 'data');
const DIR = resolve(DATA, 'index');
const release = lock(resolve(DIR, 'sync.lock.local'));
const WIB = 7 * 3600e3;
const OWNER = 'orel';
const BASE = 100;
const now = Date.now();
const r = (n, dp = 4) => Number(Number(n).toFixed(dp));

const registry = JSON.parse(readFileSync(resolve(ROOT, 'data', 'funds.json'), 'utf8'));
const members = (registry.funds || []).filter((f) => !f.paper);

/** Harga saham dan nilai sisi pengelola sebuah dana pada waktu `t`. */
function quote(cfg, navUsd, t) {
  const ledger = Core.buildLedger(cfg, { before: t + 1 });
  if (!(ledger.totalUnits > 0) || !(navUsd > 0)) return null;
  const mine = ledger.owners.find((o) => o.id === OWNER);
  const share = mine ? mine.units / ledger.totalUnits : 0;
  return { price: navUsd / ledger.totalUnits, value: share * navUsd, share };
}

/** Satu langkah rantai: bobot dari nilai sebelumnya, gerak dari rasio harga. */
function step(prev, quotes) {
  let weightSum = 0, move = 0;
  for (const [id, q] of Object.entries(quotes)) {
    const p = prev.quotes?.[id];
    if (!p || !(p.price > 0) || !(p.value > 0)) continue;     // dana baru: ikut mulai langkah berikutnya
    weightSum += p.value; move += p.value * (q.price / p.price - 1);
  }
  return weightSum > 0 ? prev.level * (1 + move / weightSum) : prev.level;
}

const loaded = members.map((f) => {
  const cfg = readJSON(resolve(DATA, f.id, 'config.json'));
  const live = readJSON(resolve(DATA, f.id, 'live.json'));
  return cfg && live ? { ...f, cfg, live } : null;
}).filter(Boolean);
if (!loaded.length) throw new Error('belum ada dana untuk index');

const stateFile = resolve(DIR, 'state.local.json');
let state = process.argv.includes('--backfill') ? null : readJSON(stateFile);
let points = state ? (readJSON(resolve(DIR, 'nav.local.json'), { points: [] }).points || []) : [];

if (!state) {
  // Riwayat dibangun dari deret nilai tiap dana, per jam, mulai saat semua
  // anggota sekarang sudah punya data.
  const series = Object.fromEntries(loaded.map((f) => [f.id, (readJSON(resolve(DATA, f.id, 'nav.json'), { points: [] }).points || [])
    .filter((p) => Number.isFinite(p.t) && p.usd > 0).sort((a, b) => a.t - b.t)]));
  const at = (id, t) => { let hit = null; for (const p of series[id]) { if (p.t <= t) hit = p; else break; } return hit; };
  const start = Math.max(...loaded.map((f) => series[f.id][0]?.t ?? now));
  const quotesAt = (t) => Object.fromEntries(loaded.map((f) => { const p = at(f.id, t); const q = p ? quote(f.cfg, p.usd, t) : null; return [f.id, q]; }).filter(([, q]) => q));
  state = { baseAt: start, level: BASE, quotes: quotesAt(start), joined: {} };
  for (const [id, q] of Object.entries(state.quotes)) state.joined[id] = { at: start, price: q.price };
  points = [{ t: start, usd: BASE }];
  for (let t = start + 3600e3; t < now - 600e3; t += 3600e3) {
    const q = quotesAt(t);
    state.level = step(state, q); state.quotes = { ...state.quotes, ...q };
    points.push({ t, usd: r(state.level) });
  }
}

// Langkah sekarang, dari snapshot terbaru tiap dana.
const quotes = Object.fromEntries(loaded.map((f) => [f.id, quote(f.cfg, Number(f.live.totalUsd), now)]).filter(([, q]) => q));
const level = step(state, quotes);
for (const [id, q] of Object.entries(quotes)) if (!state.joined[id]) state.joined[id] = { at: now, price: q.price };
state = { ...state, level, quotes: { ...state.quotes, ...quotes }, at: now };
points = downsample([...points, { t: now, usd: r(level) }], now);

const total = Object.values(quotes).reduce((t, q) => t + q.value, 0);

// ─── pemegang index dan dividen ───────────────────────────────────────────
// Unit dibeli pada level saat setoran masuk. Nilai = unit × level. Dividen =
// kelebihan nilai di atas modal; saat dibayar, unit senilai dividen itu
// dicairkan, jadi nilai kembali ke modal — tidak pernah di bawahnya. Kalau
// nilai di bawah modal, tidak ada dividen dan saldo memang ikut turun.
const icfg = readJSON(resolve(DIR, 'config.json'), { holders: [], events: [], payouts: [] });
const levelAt = (t) => { let hit = points[0]; for (const p of points) { if (p.t <= t) hit = p; else break; } return t >= now - 600e3 ? level : (hit?.usd ?? level); };
state.fills ||= {};                                  // level saat tiap peristiwa pertama kali diproses
const book = Object.fromEntries((icfg.holders || []).map((h) => [h.id, { ...h, units: 0, capitalUsd: 0, receivedUsd: 0, joinedAt: null }]));
const flow = [...(icfg.events || []).map((e) => ({ ...e, t: Date.parse(e.at) })), ...(icfg.payouts || []).map((p) => ({ ...p, type: 'dividend', t: Date.parse(p.at) }))]
  .filter((e) => Number.isFinite(e.t) && e.t <= now && book[e.owner]).sort((a, b) => a.t - b.t);
for (const e of flow) {
  const h = book[e.owner];
  const lv = (state.fills[e.id] ??= r(e.level ?? levelAt(e.t)));
  if (e.type === 'deposit') { h.units += e.usd / lv; h.capitalUsd += e.usd; h.joinedAt ??= e.t; }
  else if (e.type === 'withdraw') { const part = Math.min(1, e.usd / (h.units * lv)); h.capitalUsd *= 1 - part; h.units -= e.usd / lv; }
  else if (e.type === 'dividend') { h.units -= e.usd / lv; h.receivedUsd += e.usd; }
}
const feePct = Number(icfg.dividend?.feePct) || 0;
const holders = Object.values(book).filter((h) => h.units > 0).map((h) => {
  const value = h.units * level, gain = value - h.capitalUsd, gross = Math.max(0, gain);
  return { id: h.id, name: h.name, color: h.color || null, test: Boolean(h.test), joinedAt: h.joinedAt,
    capitalUsd: r(h.capitalUsd, 2), units: r(h.units, 6), valueUsd: r(value, 2), pnlUsd: r(gain + h.receivedUsd, 2),
    accruedDividendUsd: r(gross * (1 - feePct / 100), 2), receivedUsd: r(h.receivedUsd, 2) };
});
// Laju nyata index, disetarakan per 30 hari — bahan asumsi, bukan janji.
const spanDays = (now - state.baseAt) / 86400e3;
const monthlyRatePct = spanDays >= 3 ? r((Math.pow(level / BASE, 30 / spanDays) - 1) * 100, 2) : null;
const d1 = new Date(now + WIB); const nextPay = new Date(Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, Number(icfg.dividend?.payDayOfMonth) || 1));
const payoutRows = (icfg.payouts || []).map((p) => ({ period: p.period, at: Date.parse(p.at), owner: p.owner, name: book[p.owner]?.name || p.owner, usd: r(p.usd, 2) }));
const before = (ms) => { let hit = points[0]; for (const p of points) { if (p.t <= now - ms) hit = p; else break; } return hit; };
const chg = (ms) => { const b = before(ms); return b && b.usd > 0 && now - b.t >= ms * 0.5 ? r((level / b.usd - 1) * 100, 2) : null; };
const gen = generation();
const snapshot = {
  fund: 'index',
  schemaVersion: 2,
  generation: gen,
  updatedAt: now,
  generatedAt: new Date(now + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
  level: r(level),
  baseLevel: BASE,
  baseAt: state.baseAt,
  changePct: r((level / BASE - 1) * 100, 2),
  change24hPct: chg(86400e3),
  change7dPct: chg(7 * 86400e3),
  basketUsd: r(total, 2),
  status: icfg.status || 'belum dibuka',
  holders,
  dividend: { payDayOfMonth: Number(icfg.dividend?.payDayOfMonth) || 1, feePct, nextPayDate: nextPay.toISOString().slice(0, 10),
    accruedUsd: r(holders.reduce((t, h) => t + h.accruedDividendUsd, 0), 2), paidUsd: r(payoutRows.reduce((t, p) => t + p.usd, 0), 2),
    history: payoutRows, monthlyRatePct, rateSpanDays: r(spanDays, 1), note: icfg.dividend?.note || null },
  components: loaded.filter((f) => quotes[f.id]).map((f) => {
    const q = quotes[f.id], j = state.joined[f.id];
    return { id: f.id, label: f.label, chain: f.chain, accent: f.accent, risk: f.risk || null,
      weightPct: total > 0 ? r((q.value / total) * 100, 2) : 0,
      unitPrice: r(q.price), joinedAt: j.at, joinPrice: r(j.price),
      changePct: r((q.price / j.price - 1) * 100, 2),
      managerSharePct: r(q.share * 100, 2), valueUsd: r(q.value, 2),
      fundUsd: r(Number(f.live.totalUsd), 2), updatedAt: Number(f.live.updatedAt) || null };
  }).sort((a, b) => b.weightPct - a.weightPct),
};
assertPublic(snapshot);
atomicJSON(stateFile, state);
atomicJSON(resolve(DIR, 'nav.local.json'), { updatedAt: now, points });
atomicJSON(resolve(DIR, 'nav.json'), { updatedAt: now, generation: gen, points });
atomicJSON(resolve(DIR, 'live.json'), snapshot);
console.log(`[index] level=${snapshot.level} (${snapshot.changePct >= 0 ? '+' : ''}${snapshot.changePct}%) anggota=${snapshot.components.length} titik=${points.length}`);
release();
