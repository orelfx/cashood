// Riwayat lengkap posisi tertutup, diterbitkan sebagai SATU BERKAS KECIL PER HARI
// (data/<dana>/trades/<YYYY-MM-DD>.json, hari menurut WIB).
//
// Kenapa per hari: berkas hari yang sudah lewat tidak pernah berubah lagi, jadi
// tiap siklus hanya berkas hari ini yang ditulis ulang — repo data tidak
// membengkak, dan halaman cukup mengunduh hari yang sedang ditampilkan.
// Indeksnya (hari, jumlah, hasil, menang, kalah) ikut di live.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJSON, assertPublic } from './io.mjs';

const WIB = 7 * 3600e3;
// Hanya kolom ini yang boleh terbit; ID posisi, alamat, dan tiket tidak pernah ikut.
const KEYS = ['symbol', 'strategy', 'bookLabel', 'entryVia', 'door', 'orderedBy', 'netUsd', 'estUsd', 'netPct', 'rMultiple', 'holdMinutes', 'reason', 'reasonDetail', 'closedAt', 'investedUsd', 'feesUsd', 'lot', 'legacy', 'wallets', 'flags', 'firstWallet', 'llmScore', 'peakPct', 'ddPct', 'entry', 'exitDetail', 'walletsSold'];
// Teks bebas dari bot (alasan tutup, nama strategi) bisa memuat alamat kontrak
// atau kalimat panjang: alamat dipangkas, panjangnya dibatasi.
const LIMIT = { symbol: 40, strategy: 60, reason: 90, reasonDetail: 240, entry: 300, exitDetail: 300, firstWallet: 30 };
const text = (v, max) => { const t = String(v).replace(/(?:0x)?[0-9a-fA-F]{24,}/g, '0x…').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const clean = (r) => Object.fromEntries(KEYS.filter((k) => r[k] !== undefined && r[k] !== null).map((k) => [k, LIMIT[k] ? text(r[k], LIMIT[k]) : r[k]]));
const dayOf = (t) => new Date(t + WIB).toISOString().slice(0, 10);
const r2 = (n) => Number(Number(n).toFixed(2));

export function groupTradeDays(rows, flatBand = 0.5) {
  const days = new Map();
  for (const raw of rows) {
    if (!Number.isFinite(raw?.closedAt)) continue;
    const d = dayOf(raw.closedAt);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(clean(raw));
  }
  const index = [], files = [];
  for (const d of [...days.keys()].sort()) {
    const list = days.get(d).sort((a, b) => b.closedAt - a.closedAt);
    const val = (r) => r.netUsd ?? r.estUsd ?? null;
    const usd = list.some((r) => val(r) != null) ? r2(list.reduce((t, r) => t + (val(r) || 0), 0)) : null;
    const grade = (r) => (r.netPct != null ? r.netPct : (val(r) == null ? 0 : Math.sign(val(r)) * (flatBand + 1)));
    index.push({ d, n: list.length, usd, w: list.filter((r) => grade(r) > flatBand).length, l: list.filter((r) => grade(r) < -flatBand).length,
      ...(list.some((r) => r.netUsd == null && r.estUsd != null) ? { est: true } : {}) });
    files.push({ d, rows: list });
  }
  return { index, files };
}

export function writeTradeDays(dir, fund, files) {
  const out = resolve(dir, 'trades');
  mkdirSync(out, { recursive: true });
  const keep = new Set();
  for (const { d, rows } of files) {
    const path = resolve(out, `${d}.json`), body = { fund, day: d, rows };
    keep.add(`${d}.json`);
    assertPublic(body);
    // Hari yang isinya sama tidak ditulis ulang.
    if (existsSync(path)) { try { if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).rows) === JSON.stringify(rows)) continue; } catch { /* tulis ulang */ } }
    atomicJSON(path, body);
  }
  for (const name of readdirSync(out)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && !keep.has(name)) unlinkSync(resolve(out, name));
}
