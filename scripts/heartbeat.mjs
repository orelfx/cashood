#!/usr/bin/env node
/*
 * cashood — ambil laporan heartbeat bot buat ditampilkan di situs.
 *
 *   RR_HOME=/root/robinhood node scripts/heartbeat.mjs
 *
 * Yang diambil CUMA teks laporan yang memang sudah dikirim bot ke Telegram.
 * Tidak ada isi .env, tidak ada log, tidak ada kunci — script ini memanggil
 * dua fungsi baca-saja milik bot (`gather` + `renderReport`) lalu menulis
 * teksnya apa adanya.
 *
 * Bagian REVIEW sengaja tidak ikut: itu tulisan model, dibuat ulang berarti
 * bayar panggilan LLM lagi untuk keluaran yang belum tentu sama.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '..', 'data', 'heartbeat.json');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';

const load = (rel) => import(pathToFileURL(resolve(RR_HOME, rel)).href);

process.chdir(RR_HOME);
await load('node_modules/dotenv/config.js').catch(() => {});

// Sumber pertama: salinan yang ditulis bot sendiri waktu mengirim ke Telegram.
// Itu teks yang sama persis, termasuk uptime dan mode yang cuma diketahui oleh
// proses bot yang sedang jalan.
const MIRROR = resolve(RR_HOME, '.state/heartbeat.json');

let text = null;
let generatedAt = null;
let source = 'mirror';

if (existsSync(MIRROR)) {
  const mirror = JSON.parse(readFileSync(MIRROR, 'utf8'));
  if (typeof mirror.text === 'string' && mirror.text.trim()) {
    text = mirror.text.trim();
    generatedAt = mirror.generatedAt ?? null;
  }
}

// Cadangan: susun ulang laporannya sendiri. Tiga baris dibuang karena isinya
// milik proses yang merender — proses ini baru hidup beberapa detik, jadi
// uptime, mode dan hitungan panggilan RPC-nya akan bohong kalau ikut terbit.
if (!text) {
  const { gather, renderReport } = await load('heartbeat.js');
  const state = await gather();        // baca-saja: tidak menutup posisi, tidak menyapu dompet
  const PROCESS_LINES = [/^Agent: /, /^⏱️ Uptime:/, /^RPC calls:/, /^Model: /];
  text = String(renderReport(state) || '')
    .split('\n')
    .filter((line) => !PROCESS_LINES.some((re) => re.test(line.trim())))
    .join('\n')
    .trim();
  generatedAt = state.at ?? null;
  source = 'rendered';
}

if (!text) throw new Error('tidak ada teks heartbeat yang bisa diterbitkan');

// Jaring pengaman. Laporan ini tidak pernah memuat rahasia, tapi file ini
// terbit ke repo publik — kalau suatu hari formatnya berubah dan sesuatu yang
// panjang dan berbentuk kunci ikut masuk, lebih baik berhenti daripada terbit.
const LEAKS = [
  [/\b(0x)?[0-9a-fA-F]{64}\b/, 'sesuatu sepanjang private key'],
  [/\b([a-z]+\s+){11,}[a-z]+\b/, 'sesuatu berbentuk seed phrase'],
  [/(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|BOT_TOKEN|api[_-]?key)\s*[:=]/i, 'nama variabel rahasia'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, 'token bot Telegram'],
];
for (const [pattern, what] of LEAKS) {
  const hit = text.match(pattern);
  if (hit) throw new Error(`laporan memuat ${what} (${hit[0].slice(0, 12)}…) — tidak diterbitkan`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  updatedAt: Date.now(),
  generatedAt,
  source,
  text,
}, null, 2) + '\n');

console.log(`[cashood] heartbeat ${text.length} karakter (${source}) -> ${OUT}`);
process.exit(0);
