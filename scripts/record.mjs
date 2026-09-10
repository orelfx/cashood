#!/usr/bin/env node
/*
 * cashood — catat setoran / penarikan.
 *
 *   node scripts/record.mjs deposit  orel 500          --note "topup"
 *   node scripts/record.mjs withdraw as   200
 *   node scripts/record.mjs withdraw --prorata 800     --push
 *
 * Kenapa lewat script, bukan ngetik JSON sendiri: `navBefore` harus nilai
 * wallet TEPAT sebelum transaksi, dan penarikan pro-rata harus dibagi dengan
 * harga unit yang sama untuk semua orang. Dua hal itu gampang meleset kalau
 * diketik manual, dan salahnya baru kelihatan berbulan-bulan kemudian sebagai
 * porsi saham yang bergeser sendiri.
 *
 * Hitungannya bukan disalin dari situs — script ini menjalankan mesin ledger
 * di assets/app.js apa adanya, jadi angka yang keluar di sini sama dengan yang
 * dilihat orang di halaman.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(ROOT, 'data/config.json');
const LIVE = resolve(ROOT, 'data/live.json');

const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };

// ─── mesin ledger, diambil dari kode situs ────────────────────────────────
const ctx = vm.createContext({ console, Date, Math, JSON, Number, Object, Array, String, Promise, Error, isNaN, Set, Map });
ctx.globalThis = ctx;
vm.runInContext(readFileSync(resolve(ROOT, 'assets/app.js'), 'utf8'), ctx);
const { buildLedger } = ctx.cashood;

// ─── argumen ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? null : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const type = positional[0];
if (!['deposit', 'withdraw'].includes(type)) {
  die('pakai: node scripts/record.mjs <deposit|withdraw> <owner> <usd> [--note "..."] [--push]\n'
    + '       node scripts/record.mjs withdraw --prorata <usd> [--push]');
}

const prorata = flag('prorata');
const owner = prorata ? null : positional[1];
const amount = Number(prorata === true ? positional[1] : (prorata ?? positional[2]));
if (!Number.isFinite(amount) || amount <= 0) die(`jumlah tidak masuk akal: ${amount}`);
if (prorata && type !== 'withdraw') die('--prorata cuma untuk withdraw');

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const known = new Set(cfg.owners.map((o) => o.id));
if (owner && !known.has(owner)) die(`owner "${owner}" tidak ada. Yang terdaftar: ${[...known].join(', ')}`);

// ─── nilai wallet sekarang ────────────────────────────────────────────────
// flag() balikin null kalau tidak dipakai, dan Number(null) itu 0 — bukan NaN.
// Kalau dibiarkan, navBefore jadi $0 dan semua orang seolah tidak punya apa-apa.
const navFlag = flag('nav');
let navUsd = navFlag == null || navFlag === true ? NaN : Number(navFlag);
if (!Number.isFinite(navUsd) || navUsd <= 0) {
  const live = JSON.parse(readFileSync(LIVE, 'utf8'));
  const ageMin = (Date.now() - live.updatedAt) / 60000;
  if (ageMin > 30) {
    die(`data/live.json umurnya ${ageMin.toFixed(0)} menit — terlalu tua untuk dijadikan navBefore.\n`
      + '  Jalankan dulu: node scripts/sync.mjs   (atau paksa dengan --nav <angka>)');
  }
  navUsd = live.totalUsd;
  console.log(`nilai wallet: $${navUsd.toFixed(2)} (snapshot ${ageMin.toFixed(0)} menit lalu)`);
}

// ─── siapkan event ────────────────────────────────────────────────────────
const before = buildLedger(cfg);
const unitPrice = before.totalUnits > 0 ? navUsd / before.totalUnits : 1;
const valueOf = (id) => (before.owners.find((o) => o.id === id)?.units ?? 0) * unitPrice;

const date = String(flag('date') || new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10));
const note = typeof flag('note') === 'string' ? flag('note') : '';

const events = [];
if (prorata) {
  for (const o of before.owners) {
    const share = before.totalUnits > 0 ? o.units / before.totalUnits : 0;
    const cut = Number((amount * share).toFixed(2));
    if (cut > 0) events.push({ date, type, owner: o.id, usd: cut, navBefore: Number(navUsd.toFixed(2)), note });
  }
} else {
  events.push({ date, type, owner, usd: Number(amount.toFixed(2)), navBefore: Number(navUsd.toFixed(2)), note });
}

// ─── penarikan tidak boleh melebihi jatah ─────────────────────────────────
for (const e of events.filter((x) => x.type === 'withdraw')) {
  const have = valueOf(e.owner);
  if (e.usd - have > 0.01) {
    die(`${e.owner} cuma punya $${have.toFixed(2)}, tidak bisa tarik $${e.usd.toFixed(2)}`);
  }
}

// ─── tulis ────────────────────────────────────────────────────────────────
cfg.events.push(...events);
const after = buildLedger(cfg);
if (after.warnings.length) console.log('catatan:', after.warnings.join(' · '));

console.log('\ntransaksi yang dicatat:');
for (const e of events) {
  const name = cfg.owners.find((o) => o.id === e.owner)?.name ?? e.owner;
  console.log(`  ${e.date}  ${e.type.padEnd(8)} ${name.padEnd(6)} $${e.usd.toFixed(2)}  (harga unit $${unitPrice.toFixed(4)})`);
}

const navAfter = navUsd + events.reduce((s, e) => s + (e.type === 'withdraw' ? -e.usd : e.usd), 0);
console.log('\nsesudahnya:');
for (const o of after.owners) {
  const share = after.totalUnits > 0 ? (o.units / after.totalUnits) * 100 : 0;
  console.log(`  ${o.name.padEnd(6)} ${share.toFixed(2).padStart(6)}%  $${(share / 100 * navAfter).toFixed(2)}`);
}

if (flag('dry')) { console.log('\n--dry: config.json tidak diubah'); process.exit(0); }

writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
console.log(`\n✓ ditulis ke ${CONFIG}`);

if (flag('push')) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  git('add', 'data/config.json');
  git('commit', '-m', `chore: ${type} $${amount.toFixed(2)}${owner ? ' ' + owner : ' pro-rata'} ${date}`);
  git('push');
  console.log('✓ dipush — situs ikut berubah setelah build Pages selesai');
} else {
  console.log('  jalankan dengan --push kalau mau langsung naik ke situs');
}
