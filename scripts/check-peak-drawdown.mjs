#!/usr/bin/env node
/*
 * Cek mandiri: rata-rata puncak per basket dihitung langsung dari berkas bot
 * Meridian (hanya dibaca), lalu dicocokkan dengan angka yang terbit di
 * data/meridian/live.json. Selama semua posisi yang tercatat masih ada di 200
 * entri terakhir berkas bot, angkanya harus sama persis.
 *
 *   node scripts/check-peak-drawdown.mjs
 */
import { readFileSync } from 'node:fs';
const FILE = process.env.MERIDIAN_TRACKING || '/root/main/meridian/post-close-tracking.json';
const LIVE = process.env.MERIDIAN_LIVE || new URL('../data/meridian/live.json', import.meta.url);
const LABEL = { bigcap: 'Big cap', mid: 'Mid', midcap: 'Mid', degen: 'Degen', lowcap: 'Low cap' };
const entries = (JSON.parse(readFileSync(FILE, 'utf8')).entries || []).filter((e) => e.peak_pnl_pct != null || e.max_drawdown_pct != null);
const live = JSON.parse(readFileSync(LIVE, 'utf8')).peakDrawdown || { books: [] };
const groups = new Map();
for (const e of entries) {
  const k = LABEL[String(e.book || '').toLowerCase()] || e.book || '—';
  if (e.peak_pnl_pct != null && Number.isFinite(Number(e.peak_pnl_pct))) (groups.get(k) || groups.set(k, []).get(k)).push(Number(e.peak_pnl_pct));
}
let bad = 0;
console.log(`posisi dengan data puncak/terendah di berkas bot: ${entries.length}`);
for (const [k, v] of groups) {
  const fromFile = Number((v.reduce((t, x) => t + x, 0) / v.length).toFixed(2));
  const onPage = live.books.find((b) => b.label === k)?.avgPeak ?? null;
  const ok = onPage === fromFile;
  if (!ok) bad += 1;
  console.log(`${k.padEnd(8)} berkas ${fromFile}%  halaman ${onPage}%  ${ok ? 'cocok' : 'BEDA (arsip Cashood bisa memuat penutupan yang sudah keluar dari 200 terakhir)'}`);
}
if (!groups.size) console.log('belum ada data — halaman menampilkan "Belum ada posisi yang ditutup sejak pencatatan dimulai."');
process.exitCode = bad ? 1 : 0;
