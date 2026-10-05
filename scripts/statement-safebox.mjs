#!/usr/bin/env node
/*
 * cashood — invoice imbal hasil Safe Box, satu lembar A4.
 *
 *   node scripts/statement-safebox.mjs --period 2026-09 --rate 17650 [--revision 1]
 *
 * Aturan pemilik (2026-10-01): imbal hasil sebulan DITARIK tiap tanggal 1 dan
 * dibayarkan ke pemilik menurut porsi pokok; pokok tetap di dalam Safe Box
 * ($3.000) dan terus bekerja. Tidak ada fee.
 *
 * Hak bunga dibaca dari buku akrual Safe Box (data/safebox/accrual-v3.local.json):
 * total hak tiap pemilik dikurangi yang sudah dibayar dan dikurangi bunga yang
 * lahir SESUDAH periode tutup. Jumlah yang dibayar dibulatkan ke bawah per sen;
 * sisa pecahan sen tetap menjadi hak pemilik di bulan berikutnya.
 *
 * Selain PDF, skrip ini mencatat pembayaran di data/safebox/payouts.jsonl
 * (satu baris per pemilik, ID unik per periode) sehingga saldo di situs kembali
 * ke pokok. Menjalankan ulang periode yang sama tidak mencatat dua kali.
 */
import Core from '../assets/core.js';
import { atomicJSON, lock, readJSON } from './lib/io.mjs';
import { ownersAt } from './lib/accrual.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(process.env.CASHOOD_DATA_DIR || resolve(ROOT, 'data'), 'safebox');
const REPORTS = process.env.CASHOOD_REPORTS_DIR || resolve(ROOT, 'reports');
const release = lock(resolve(REPORTS, 'statement.lock.local'));
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };

const period = arg('period');
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) throw new Error('pakai: --period YYYY-MM --rate <IDR per USD>');
const rate = Core.number(arg('rate'), 'Kurs', 1);
const revision = arg('revision', '1');
const [py, pm] = period.split('-').map(Number);
const payIso = new Date(Date.UTC(pm === 12 ? py + 1 : py, pm === 12 ? 0 : pm, 1)).toISOString().slice(0, 10);
const periodEnd = Core.eventTime({ date: payIso });
if (Date.now() < periodEnd) throw new Error('Periode belum selesai');

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const periodLabel = `${BULAN[pm - 1]} ${py}`;
const payLabel = `${Number(payIso.slice(8))} ${BULAN[Number(payIso.slice(5, 7)) - 1]} ${payIso.slice(0, 4)}`;

const cfg = JSON.parse(readFileSync(resolve(DATA, 'config.json'), 'utf8'));
const state = readJSON(resolve(DATA, 'accrual-v3.local.json'));
if (!state?.balances) throw new Error('buku akrual Safe Box belum ada');
const payoutFile = resolve(DATA, 'payouts.jsonl');
const idOf = (owner) => `sb-${period}-${owner}`;
const already = existsSync(payoutFile) ? readFileSync(payoutFile, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => JSON.parse(l)) : [];

// Hak bunga periode = hak total − sudah dibayar − bunga yang lahir sesudah periode.
const after = state.days.filter((d) => d.date >= payIso);
// Pokok dihitung dari pemilik yang aktif di akhir periode; pemilik yang sudah
// keluar tetap mendapat baris selama masih punya sisa bunga.
const activeEnd = ownersAt(cfg, periodEnd - 1);
const everyone = [...new Map([...cfg.owners, ...(cfg.ownerEvents || []).flatMap((e) => e.owners)].map((o) => [o.id, o])).values()];
const principal = activeEnd.reduce((s, o) => s + Number(o.principalUsd), 0);
const rows = everyone.map((o) => ({ ...o, principalUsd: activeEnd.find((a) => a.id === o.id)?.principalUsd ?? 0 })).map((o) => {
  const b = state.balances[o.id] || { accrued: 0, paid: 0 };
  const prior = already.find((p) => p.id === idOf(o.id));
  const later = after.reduce((s, d) => s + (d.owners?.[o.id] || 0), 0);
  const entitled = prior ? Number(prior.usd) : Math.max(0, b.accrued - b.paid - later);
  const usd = prior ? Number(prior.usd) : Math.floor(entitled * 100 + 1e-6) / 100;
  return { id: o.id, name: o.name, color: o.color, principalUsd: Number(o.principalUsd), share: principal ? (Number(o.principalUsd) / principal) * 100 : 0, usd, idr: 0 };
}).filter((r) => r.principalUsd > 0 || r.usd > 0);
const total = Core.money(rows.reduce((s, r) => s + r.usd, 0));
// Rupiah dibagi dengan sisa terbesar, supaya baris-barisnya pas dengan total.
{
  const target = Math.round(total * rate), exact = rows.map((r) => r.usd * rate), fl = exact.map(Math.floor);
  let rest = target - fl.reduce((s, v) => s + v, 0);
  exact.map((v, i) => ({ i, f: v - fl[i] })).sort((a, b) => b.f - a.f).forEach(({ i }) => { if (rest > 0) { fl[i] += 1; rest -= 1; } });
  rows.forEach((r, i) => { r.idr = fl[i]; });
}
const days = state.days.filter((d) => d.date.startsWith(period));
const tracked = days.reduce((s, d) => s + d.usd, 0);
const frozenPart = Math.max(0, total - tracked);
const startIso = String(cfg.startedAt || `${period}-01`);
const fromIso = startIso.startsWith(period) ? startIso : `${period}-01`;
const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
const spanDays = lastDay - Number(fromIso.slice(8)) + 1;
const monthlyPct = principal ? (total / principal) * 100 * (30 / spanDays) : 0;

const usd = (n, dp = 2) => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const idr = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const pct = (n, dp = 2) => n.toLocaleString('id-ID', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tglPendek = (iso) => `${Number(iso.slice(8))} ${BULAN[Number(iso.slice(5, 7)) - 1].slice(0, 3)}`;
const invoiceNo = `INV/SB/${payIso.slice(0, 7)}/R${revision}`;
const now = new Date();
const generated = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(now);

const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<title>Invoice Imbal Hasil Safe Box — ${esc(periodLabel)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  :root { --ink:#0b1220; --ink2:#334155; --mute:#64748b; --line:#e2e8f0; --soft:#f5f7fb; --navy:#0b1220; --gold:#d4a64a; --teal:#0f9d8a; --teal-soft:#e6f6f3; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 400 9pt/1.5 Inter, system-ui, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 210mm; min-height: 297mm; padding: 0 0 12mm; position: relative; }
  .num { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  header { background: linear-gradient(135deg, #0b1220, #12213b); color: #fff; padding: 9mm 14mm 7mm; }
  .hrow { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { display: flex; gap: 4mm; align-items: center; }
  .logo { width: 11mm; height: 11mm; border-radius: 3mm; background: linear-gradient(145deg, #5eead4, #0f9d8a); display: grid; place-items: center; font: 800 14pt Inter; color: #0b1220; }
  .brand b { font-size: 13pt; letter-spacing: .02em; display: block; }
  .brand span { font-size: 8pt; color: #a8b3c7; }
  .doc { text-align: right; }
  .doc .t { font-size: 7pt; letter-spacing: .14em; color: var(--gold); font-weight: 700; text-transform: uppercase; }
  .doc .f { font-size: 15pt; font-weight: 800; margin-top: 1mm; }
  .doc .p { font-size: 8pt; color: #a8b3c7; }
  .meta { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4mm; margin-top: 7mm; padding-top: 4mm; border-top: .3mm solid rgba(255,255,255,.12); }
  .meta .k { font-size: 6.6pt; color: #8f9bb0; text-transform: uppercase; letter-spacing: .08em; }
  .meta .v { font-size: 9pt; font-weight: 600; margin-top: .6mm; }
  main { padding: 7mm 14mm 0; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3.5mm; }
  .tile { border: .3mm solid var(--line); border-radius: 2.5mm; padding: 3.5mm 4mm; }
  .tile.hi { background: linear-gradient(145deg, #0b1220, #16213a); color: #fff; border-color: #0b1220; }
  .tile .k { font-size: 6.6pt; letter-spacing: .09em; text-transform: uppercase; color: var(--mute); font-weight: 700; }
  .tile.hi .k { color: var(--gold); }
  .tile .v { font-size: 15pt; font-weight: 700; margin: 1.5mm 0 .5mm; }
  .tile .s { font-size: 7.4pt; color: var(--mute); }
  .tile.hi .s { color: #a8b3c7; }
  .pos { color: var(--teal); }
  h3 { font-size: 7.4pt; letter-spacing: .12em; text-transform: uppercase; color: var(--ink2); margin: 7mm 0 2.5mm; font-weight: 800; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 6.8pt; letter-spacing: .08em; text-transform: uppercase; color: var(--mute); text-align: right; padding: 2mm; border-bottom: .4mm solid var(--ink); font-weight: 700; }
  th:first-child, td:first-child { text-align: left; }
  td { padding: 2.4mm 2mm; border-bottom: .25mm solid var(--line); text-align: right; }
  tr.total td { border-bottom: 0; border-top: .4mm solid var(--ink); font-weight: 700; }
  .who { display: flex; align-items: center; gap: 2mm; font-weight: 600; }
  .dot { width: 2.4mm; height: 2.4mm; border-radius: 50%; }
  .two { display: grid; grid-template-columns: 1.1fr 1fr; gap: 7mm; }
  .steps { display: grid; gap: 2.2mm; font-size: 8.4pt; color: var(--ink2); }
  .step { display: flex; gap: 2.5mm; }
  .step .n { flex: none; width: 4.6mm; height: 4.6mm; border-radius: 50%; background: var(--ink); color: #fff; font-size: 7pt; font-weight: 700; display: grid; place-items: center; }
  .box { background: var(--teal-soft); border: .3mm dashed var(--teal); border-radius: 2.5mm; padding: 3mm 4mm; margin-top: 3mm; font-size: 8.2pt; color: #0b3d36; }
  .daily td, .daily th { padding: 1.5mm 2mm; font-size: 8pt; }
  footer { position: absolute; left: 14mm; right: 14mm; bottom: 8mm; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; font-size: 7.2pt; color: var(--mute); border-top: .3mm solid var(--line); padding-top: 3mm; }
  footer .line { grid-column: 1 / -1; display: flex; justify-content: space-between; font-size: 7pt; }
</style></head>
<body><div class="page">
<header>
  <div class="hrow">
    <div class="brand"><div class="logo">C</div><div><b>CASHOOD HEADFUND</b><span>Safe Box · simpanan dengan imbal hasil fluktuatif</span></div></div>
    <div class="doc"><div class="t">Invoice imbal hasil</div><div class="f">Safe Box</div><div class="p">Periode ${esc(periodLabel)}</div></div>
  </div>
  <div class="meta">
    <div><div class="k">No. invoice</div><div class="v num">${invoiceNo}</div></div>
    <div><div class="k">Tanggal pembayaran</div><div class="v">${payLabel}</div></div>
    <div><div class="k">Kurs yang dipakai</div><div class="v num">1 USD = ${idr(rate)}</div></div>
    <div><div class="k">Pemilik simpanan</div><div class="v">${rows.length} orang</div></div>
    <div><div class="k">Fee pengelola</div><div class="v">tanpa fee</div></div>
  </div>
</header>
<main>
  <div class="tiles">
    <div class="tile"><div class="k">Pokok simpanan</div><div class="v num">${usd(principal, 0)}</div><div class="s num">${idr(principal * rate)}</div></div>
    <div class="tile"><div class="k">Imbal hasil ${esc(BULAN[pm - 1])}</div><div class="v num pos">${usd(total)}</div><div class="s">${tglPendek(fromIso)} – ${lastDay} ${BULAN[pm - 1].slice(0, 3)} · ${spanDays} hari</div></div>
    <div class="tile"><div class="k">Laju setara</div><div class="v num">${pct(monthlyPct)}</div><div class="s">per bulan · maks ${pct(Number(cfg.rate?.maxMonthlyPct ?? 3), 0)}</div></div>
    <div class="tile hi"><div class="k">Ditarik &amp; dibayarkan</div><div class="v num">${usd(total)}</div><div class="s num">${idr(total * rate)}</div></div>
  </div>

  <h3>Pembayaran per pemilik</h3>
  <table>
    <thead><tr><th>Pemilik</th><th>Pokok</th><th>Porsi</th><th>Imbal hasil (USD)</th><th>Diterima (IDR)</th><th>Saldo setelah ditarik</th></tr></thead>
    <tbody>
      ${rows.map((r) => `<tr><td><span class="who"><span class="dot" style="background:${r.color || '#0f9d8a'}"></span>${esc(r.name)}</span></td>
        <td class="num">${usd(r.principalUsd, 0)}</td><td class="num">${pct(r.share)}</td>
        <td class="num pos"><b>${usd(r.usd)}</b></td><td class="num">${idr(r.idr)}</td><td class="num">${usd(r.principalUsd, 0)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="num">${usd(principal, 0)}</td><td class="num">100,00%</td>
        <td class="num pos">${usd(total)}</td><td class="num">${idr(rows.reduce((s, r) => s + r.idr, 0))}</td><td class="num">${usd(principal, 0)}</td></tr>
    </tbody>
  </table>

  <div class="two">
    <div>
      <h3>Cara pembayaran</h3>
      <div class="steps">
        <div class="step"><div class="n">1</div><div>Pokok ${usd(principal, 0)} disimpan pengelola. Bunganya dihitung setiap hari mengikuti kinerja bot Cashood (Cashood Index) hari itu.</div></div>
        <div class="step"><div class="n">2</div><div>Hari bot rugi bunganya 0; hari bot untung paling tinggi ${pct(Number(cfg.rate?.maxMonthlyPct ?? 3) / 30, 2)} per hari, jadi paling banyak ${pct(Number(cfg.rate?.maxMonthlyPct ?? 3), 0)} per bulan. Tidak pernah negatif.</div></div>
        <div class="step"><div class="n">3</div><div>Tiap tanggal 1, seluruh imbal hasil bulan sebelumnya <b>ditarik dan dibayarkan</b> menurut porsi pokok. Pokok tetap di dalam Safe Box dan terus bekerja.</div></div>
      </div>
      <div class="box"><b>Pokok tetap ${usd(principal, 0)}.</b> Imbal hasil tidak diputar ulang — setelah pembayaran ini saldo tiap pemilik kembali ke pokoknya, dan imbal hasil ${esc(BULAN[pm % 12])} mulai dihitung dari nol.</div>
    </div>
    <div>
      <h3>Imbal hasil harian</h3>
      <table class="daily">
        <thead><tr><th>Tanggal</th><th>Imbal hasil</th></tr></thead>
        <tbody>
          ${frozenPart > 0.005 ? `<tr><td>${tglPendek(fromIso)} – ${days.length ? tglPendek(new Date(Date.parse(days[0].date) - 86400000).toISOString().slice(0, 10)) : lastDay + ' ' + BULAN[pm - 1].slice(0, 3)} <span style="color:var(--mute)">(akumulasi)</span></td><td class="num">${usd(frozenPart)}</td></tr>` : ''}
          ${days.map((d) => `<tr><td>${tglPendek(d.date)}</td><td class="num">${usd(d.usd)}</td></tr>`).join('')}
          <tr class="total"><td>Total dibayarkan</td><td class="num">${usd(total)}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</main>
<footer>
  <div><b>Kurs.</b> Nilai rupiah memakai kurs yang ditetapkan pengelola, 1 USD = ${idr(rate)}. Dana dikirim dalam USD; rupiah yang diterima dapat berbeda mengikuti kurs saat pencairan.</div>
  <div><b>Catatan.</b> Imbal hasil Safe Box tidak tetap dan bukan janji hasil. Pokok dijaga; pada bulan yang sepi imbal hasil bisa mendekati batas bawah. Pembulatan per sen dibawa ke bulan berikutnya.</div>
  <div class="line"><b>cashood.id</b><span>Dibuat ${esc(generated)} WIB · ${invoiceNo}</span></div>
</footer>
</div></body></html>`;

mkdirSync(resolve(REPORTS, 'private'), { recursive: true });
const stem = `invoice-safebox-${payIso}-r${revision}`;
const htmlPath = resolve(REPORTS, `${stem}.html`), pdfPath = resolve(REPORTS, `${stem}.pdf`);
if (existsSync(htmlPath) || existsSync(pdfPath)) throw new Error('Laporan sudah ada; gunakan --revision baru');
writeFileSync(htmlPath, html);
const chrome = [process.env.CHROME, '/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { encoding: 'utf8', timeout: 90_000 });
if (r.status !== 0 || !existsSync(pdfPath)) throw new Error(r.stderr || 'cetak PDF gagal');
atomicJSON(resolve(REPORTS, 'private', `${stem}.json`), { fund: 'safebox', period, rate, rows, total, generatedAt: now.toISOString() });

// Catat penarikan: satu baris per pemilik, waktu efektif = akhir periode.
for (const row of rows) {
  if (already.some((p) => p.id === idOf(row.id)) || !(row.usd > 0)) continue;
  appendFileSync(payoutFile, JSON.stringify({ type: 'interest', id: idOf(row.id), owner: row.id, usd: row.usd, at: new Date(periodEnd).toISOString(), period, note: `imbal hasil ${periodLabel} ditarik, ${invoiceNo}` }) + '\n');
}

const manifestPath = resolve(REPORTS, 'index.json');
let manifest = []; try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* pertama */ }
manifest = manifest.filter((m) => m.pdf !== `reports/${stem}.pdf`);
manifest.push({ fund: 'safebox', period, periodLabel, payDate: payIso, payLabel, example: false, status: 'final', revision: Number(revision), invoiceNo,
  withdrawnUsd: total, costsUsd: 0, distributedUsd: total, rate, pdf: `reports/${stem}.pdf`, html: `reports/${stem}.html`, generatedAt: now.toISOString() });
manifest.sort((a, b) => b.payDate.localeCompare(a.payDate) || a.fund.localeCompare(b.fund));
atomicJSON(manifestPath, manifest);

console.log(`[safebox] ${periodLabel} · imbal hasil ${usd(total)} ditarik · kurs ${idr(rate)}`);
for (const row of rows) console.log(`  ${row.name.padEnd(10)} ${pct(row.share).padStart(7)}  ${usd(row.usd).padStart(8)}  ${idr(row.idr)}`);
console.log(`-> ${pdfPath}`);
release();
