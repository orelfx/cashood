#!/usr/bin/env node
/*
 * cashood — laporan bot Meridian untuk tab "Bot".
 *
 *   MERIDIAN_HOME=/root/main/meridian node scripts/report-meridian.mjs
 *
 * Reborn Rich menulis laporannya sendiri ke Telegram dan cashood tinggal
 * menyalin. Meridian tidak punya laporan berkala yang setara, jadi laporannya
 * disusun di sini dari angka yang sudah ada: snapshot yang baru ditulis,
 * status prosesnya, dan briefing harian bot (yang hanya membaca state, tidak
 * mengubah apa pun).
 *
 * Bentuknya sengaja sama dengan heartbeat Reborn Rich — judul, lalu bagian yang
 * dipisah garis — supaya halaman bisa menampilkannya dengan perender yang sama.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { atomicJSON, assertPublic, lock } from './lib/io.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'data', 'meridian', 'heartbeat.json');
const release = lock(resolve(dirname(OUT), 'heartbeat.lock.local'));
const HOME = process.env.MERIDIAN_HOME || '/root/main/meridian';
const WIB = 7 * 3600e3;

const wib = (ms) => new Date(ms + WIB).toISOString().replace('T', ' ').slice(0, 19) + ' WIB';
const usd = (n) => '$' + (Number(n) || 0).toFixed(2);
const dur = (min) => {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const rule = '━'.repeat(30);
const section = (title, body) => `${rule}\n${title}\n${rule}\n${body}`;

const snap = JSON.parse(readFileSync(resolve(HERE, '..', 'data', 'meridian', 'live.json'), 'utf8'));

// ─── status proses ────────────────────────────────────────────────────────
let uptime = null; let status = 'unknown'; let restarts = null;
try {
  const out = spawnSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 20000 }).stdout || '[]';
  const proc = JSON.parse(out).find((p) => p.name === 'meridian-live');
  if (proc) {
    status = proc.pm2_env?.status ?? 'unknown';
    restarts = proc.pm2_env?.restart_time ?? null;
    if (proc.pm2_env?.pm_uptime) uptime = Date.now() - proc.pm2_env.pm_uptime;
  }
} catch { /* status tidak wajib */ }

// ─── briefing bot (baca-saja) ─────────────────────────────────────────────
let briefing = '';
try {
  process.chdir(HOME);
  const mod = await import(pathToFileURL(resolve(HOME, 'briefing.js')).href);
  const raw = await mod.generateBriefing();
  briefing = String(raw || '')
    .replace(/<[^>]+>/g, '')                    // teks Telegram memakai tag HTML
    .split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l || a[i - 1])
    .join('\n').trim();
} catch (error) {
  briefing = `briefing tidak tersedia: ${error.message}`;
}

// ─── susun laporan ────────────────────────────────────────────────────────
const s = snap.stats || {};
const open = snap.positions || [];
const inRange = open.filter((p) => p.inRange).length;

const head = ['💠 MERIDIAN BRIEFING', 'Meteora DLMM · Solana', wib(Date.now()),
  uptime ? `\n⏱️ Uptime: ${dur(uptime / 60000)}` : null].filter(Boolean).join('\n');

const system = [
  `Agent: ${status.toUpperCase()}`,
  restarts == null ? null : `Restart tercatat: ${restarts}`,
  `Harga SOL: ${usd(snap.solPrice)}`,
  `Snapshot: ${wib(snap.updatedAt)}`,
].filter(Boolean).join('\n');

const portfolio = [
  `Nilai dana: ${usd(snap.totalUsd)}`,
  `Dompet: ${usd(snap.walletUsd)} · LP: ${usd(snap.lpUsd)} · Kas: ${usd(snap.treasuryUsd)}`,
  `Posisi: ${open.length} terbuka, ${inRange} di dalam range`,
  `Fee belum dipanen: ${usd(s.openFeesUsd)}`,
].join('\n');

const positions = open.length
  ? open.map((p) => [
      `${p.inRange ? '🟢' : '🔴'} ${p.symbol} ${p.inRange ? 'IN RANGE' : 'OUT OF RANGE'}`
        + ` · nilai ${usd(p.valueUsd)} · pnl ${p.pnlUsd >= 0 ? '+' : ''}${usd(p.pnlUsd)} (${p.pnlPct}%)`,
      `   fee belum dipanen ${usd(p.feesUsd)} · umur ${dur(p.ageMinutes)}`
        + (p.throughBandPct == null ? '' : ` · ${p.throughBandPct.toFixed(0)}% melewati rentang bin`)
        + (p.outOfRangeMinutes > 0 ? ` · di luar range ${dur(p.outOfRangeMinutes)}` : ''),
    ].join('\n')).join('\n')
  : '(tidak ada posisi terbuka)';

const recent = (snap.closedRecent || []).slice(0, 8)
  .map((c) => `${c.netPct >= 0 ? '🟢' : '🔴'} ${c.symbol} ${c.netPct >= 0 ? '+' : ''}${c.netPct}%`
    + ` · ${c.holdMinutes == null ? '—' : dur(c.holdMinutes)} · ${c.reason || '—'}`).join('\n')
  || '(belum ada)';

const record = [
  `Ditutup: ${s.closedCount ?? 0} posisi · menang ${s.winRate ?? 0}%`,
  `Hasil realisasi USD yang tercatat: ${usd(s.realisedUsd)}`,
  `Rata-rata ukuran posisi: ${usd(s.avgInvestedUsd)}`,
  s.bestDay ? `Hari terbaik: ${s.bestDay.date} ${usd(s.bestDay.usd)}` : null,
].filter(Boolean).join('\n');

const text = [
  head,
  section('SYSTEM', system),
  section('PORTFOLIO', portfolio),
  section('POSISI TERBUKA', positions),
  section('TERAKHIR DITUTUP', recent),
  section('REKOR', record),
  section('BRIEFING BOT', briefing || '(kosong)'),
  `\n${s.unpricedCloses || 0} penutupan tidak memiliki realisasi USD; tidak dianggap nol. ${snap.quality?.complete ? 'Snapshot lengkap.' : 'Snapshot belum terverifikasi lengkap.'}`,
].join('\n\n');

// ─── arsip sepuluh laporan terakhir ───────────────────────────────────────
let archive = [];
if (existsSync(OUT)) {
  try {
    const old = JSON.parse(readFileSync(OUT, 'utf8'));
    const previous = old.text ? [{ updatedAt: old.updatedAt, generatedAt: old.generatedAt, source: old.source, text: old.text }] : [];
    archive = [...previous, ...(old.archive || [])]
      .filter((row, i, all) => row.text !== text && all.findIndex((r) => r.generatedAt === row.generatedAt) === i)
      .slice(0, 10);
  } catch { archive = []; }
}

const redactPublic = text => String(text).replace(/0x[0-9a-fA-F]{40,64}\b/g, '[identitas disembunyikan]').replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '[identitas disembunyikan]');
mkdirSync(dirname(OUT), { recursive: true });
const published = {
  updatedAt: Date.now(), generatedAt: wib(Date.now()), source: 'built', text: redactPublic(text), archive: archive.map(r=>({...r,text:redactPublic(r.text)})),
};
assertPublic(published);
atomicJSON(OUT, published);

console.log(`[meridian] laporan ${text.length} karakter · arsip ${archive.length} -> ${OUT}`);
release();
process.exit(0);
