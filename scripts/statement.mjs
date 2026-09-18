#!/usr/bin/env node
/*
 * cashood — laporan pembagian dividen, satu lembar A4 untuk semua pemegang saham.
 *
 * Desainnya tinggal di sini supaya setiap tanggal 1 cukup jalankan ulang dengan
 * angka bulan itu — tidak perlu mendesain dari nol lagi.
 *
 *   node scripts/statement.mjs --withdrawn 1000 --rate 17650 \
 *        --period 2026-09 --balance 9300 [--fund reborn] [--example]
 *
 * Aturan pemilik, 2026-09-18:
 *   dibagikan = uang yang ditarik bot bulan itu − biaya sistem bulanan
 *   100% dari angka itu dibagikan menurut porsi saham (tidak ada 30% mengendap),
 *   sekecil apa pun porsinya. Fee admin standar (config: investorFeeStandardPct)
 *   dicoret selama investorFeePct = 0.
 *
 * Porsi saham dihitung oleh buildLedger() dari assets/app.js yang sama dengan
 * situsnya — angka di PDF tidak bisa berbeda dari angka di cashood.id.
 *
 * Keluaran: reports/dividen-<fund>-<tanggal bayar>[-contoh].html dan .pdf
 * (dicetak Chromium headless, tanpa dependensi npm).
 */

import vm from 'node:vm';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const fund = arg('fund', 'reborn');
const withdrawn = Number(arg('withdrawn'));
const rate = Number(arg('rate'));
const balance = Number(arg('balance', 0));
const example = flag('example');
if (!(withdrawn >= 0) || !(rate > 0)) {
  console.error('pakai: node scripts/statement.mjs --withdrawn <USD> --rate <IDR per USD> [--period YYYY-MM] [--balance USD] [--example]');
  process.exit(1);
}

// Periode = bulan yang dihitung; dibayar tanggal 1 bulan berikutnya.
const now = new Date();
const period = arg('period') || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const [py, pm] = period.split('-').map(Number);
const payDate = new Date(Date.UTC(pm === 12 ? py + 1 : py, pm === 12 ? 0 : pm, 1));
const payIso = payDate.toISOString().slice(0, 10);

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const periodLabel = `${BULAN[pm - 1]} ${py}`;
const payLabel = `${payDate.getUTCDate()} ${BULAN[payDate.getUTCMonth()]} ${payDate.getUTCFullYear()}`;

const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', fund, 'config.json'), 'utf8'));
const funds = JSON.parse(readFileSync(resolve(ROOT, 'data', 'funds.json'), 'utf8'));
const fundMeta = (funds.funds || []).find((f) => f.id === fund) || {};

// Mesin buku yang sama dengan situs.
const ctx = vm.createContext({ console, Date, Math, JSON, Number, Object, Array, String, Promise, Error, isNaN, Set, Map });
vm.runInContext(readFileSync(resolve(ROOT, 'assets/app.js'), 'utf8'), ctx);
const ledger = ctx.cashood.buildLedger(cfg);

// Biaya: dana yang menanggung tagihan (costs.primary) membayar penuh; dana
// lain tidak membayar dua kali untuk sistem yang sama.
const costItems = (cfg.costs?.items || []).map((i) => ({ name: i.name, usd: Number(i.usd) || 0 }));
const costsUsd = cfg.costs?.shared && !cfg.costs?.primary ? 0 : costItems.reduce((s, i) => s + i.usd, 0);
const d = cfg.dividend || {};
const feeStd = Number(d.investorFeeStandardPct) || 0;
const feeNow = Number(d.investorFeePct) || 0;
const distributePct = Number(d.distributePct ?? 100);

const net = Math.max(0, withdrawn - costsUsd);
const pool = net * distributePct / 100;

// Sen dibagi dengan sisa terbesar, supaya jumlah baris = total persis.
const owners = ledger.owners.filter((o) => o.units > 0);
const cents = Math.round(pool * 100);
const raw = owners.map((o) => ({ o, exact: (o.units / ledger.totalUnits) * cents }));
const base = raw.map((r) => Math.floor(r.exact));
let left = cents - base.reduce((s, c) => s + c, 0);
raw.map((r, i) => ({ i, frac: r.exact - base[i] })).sort((a, b) => b.frac - a.frac)
  .forEach(({ i }) => { if (left > 0) { base[i] += 1; left -= 1; } });

const rows = raw.map((r, i) => {
  const gross = base[i] / 100;
  const feeStdUsd = gross * feeStd / 100;
  const feeUsd = gross * feeNow / 100;
  const netUsd = gross - feeUsd;
  return { name: r.o.name, share: (r.o.units / ledger.totalUnits) * 100, gross, feeStdUsd, feeUsd, netUsd, idr: Math.round(netUsd * rate) };
}).sort((a, b) => b.share - a.share);

// Rupiah juga dibagi dengan sisa terbesar: dibulatkan per baris, empat baris
// bisa selisih Rp 1 dari kotak "Dibagikan" di atas — kecil, tapi di laporan
// uang, angka yang tidak cocok adalah angka yang dicurigai.
{
  const targetIdr = Math.round(rows.reduce((s, r) => s + r.netUsd, 0) * rate);
  const exact = rows.map((r) => r.netUsd * rate);
  const floor = exact.map(Math.floor);
  let rest = targetIdr - floor.reduce((s, v) => s + v, 0);
  exact.map((v, i) => ({ i, frac: v - floor[i] })).sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => { if (rest > 0) { floor[i] += 1; rest -= 1; } });
  rows.forEach((r, i) => { r.idr = floor[i]; });
}

const totalNet = rows.reduce((s, r) => s + r.netUsd, 0);
const totalIdr = rows.reduce((s, r) => s + r.idr, 0);
const totalFeeStd = rows.reduce((s, r) => s + r.feeStdUsd, 0);

const usd = (n, dp = 2) => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const idr = (n) => (n < 0 ? '−' : '') + 'Rp ' + Math.round(Math.abs(n)).toLocaleString('id-ID');
const pct = (n) => n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fundName = fundMeta.name || (fund === 'reborn' ? 'Reborn Rich' : fund);
const chain = fundMeta.chain || (fund === 'reborn' ? 'Robinhood Chain' : 'Solana');
const generated = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(now);

const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<title>Laporan Dividen ${esc(fundName)} — ${esc(periodLabel)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  :root {
    --ink: #0b1220; --ink2: #334155; --mute: #64748b; --line: #e2e8f0; --soft: #f5f7fb;
    --navy: #0b1220; --navy2: #16213a; --gold: #d4a64a; --green: #0f9d63; --green-soft: #e8f7f0; --red: #c2413b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 210mm; height: 297mm; }
  body { font-family: Inter, system-ui, sans-serif; color: var(--ink); font-size: 9.2pt; line-height: 1.45;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff; }
  .page { width: 210mm; height: 297mm; position: relative; overflow: hidden; display: flex; flex-direction: column; }
  .num { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }

  header { background: linear-gradient(135deg, var(--navy) 0%, var(--navy2) 100%); color: #fff; padding: 11mm 14mm 9mm; position: relative; }
  header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1.2mm; background: linear-gradient(90deg, var(--gold), #f3d48a 50%, var(--gold)); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { display: flex; align-items: center; gap: 3.5mm; }
  .mark { width: 11mm; height: 11mm; border-radius: 2.6mm; background: linear-gradient(135deg, var(--gold), #f0cf7f);
          color: var(--navy); display: grid; place-items: center; font-weight: 800; font-size: 15pt; }
  .brand h1 { font-size: 13.5pt; font-weight: 800; letter-spacing: 0.02em; }
  .brand p { font-size: 7.6pt; color: #aab6cc; letter-spacing: 0.04em; margin-top: 0.5mm; }
  .doc { text-align: right; }
  .doc .kind { font-size: 7.4pt; letter-spacing: 0.18em; color: var(--gold); font-weight: 700; }
  .doc h2 { font-size: 15pt; font-weight: 800; margin-top: 1mm; }
  .doc p { font-size: 8pt; color: #c3cde0; margin-top: 0.6mm; }
  .meta { display: flex; gap: 8mm; margin-top: 7mm; font-size: 7.6pt; color: #aab6cc; }
  .meta b { display: block; color: #fff; font-size: 9pt; font-weight: 600; margin-top: 0.4mm; }
  .stamp { position: absolute; right: 14mm; top: 36mm; border: 0.5mm solid var(--gold); color: var(--gold);
           padding: 1mm 3mm; border-radius: 1mm; font-size: 7pt; font-weight: 800; letter-spacing: 0.16em; transform: rotate(-2deg); }

  main { padding: 7mm 14mm 0; flex: 1; display: flex; flex-direction: column; gap: 5.5mm; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; }
  .tile { border: 0.3mm solid var(--line); border-radius: 2.2mm; padding: 3.4mm 3.6mm; background: #fff; }
  .tile .k { font-size: 6.9pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mute); font-weight: 600; }
  .tile .v { font-size: 14pt; font-weight: 700; margin-top: 1.2mm; }
  .tile .s { font-size: 7.6pt; color: var(--mute); margin-top: 0.4mm; }
  .tile.neg .v { color: var(--red); }
  .tile.hero { background: var(--navy); border-color: var(--navy); color: #fff; }
  .tile.hero .k { color: var(--gold); } .tile.hero .s { color: #aab6cc; } .tile.hero .v { color: #fff; }

  .flow { display: flex; align-items: center; justify-content: center; gap: 3mm; background: var(--soft); border-radius: 2.2mm;
          padding: 2.6mm 4mm; font-size: 8.6pt; color: var(--ink2); }
  .flow .op { color: var(--mute); font-weight: 700; }
  .flow .res { color: var(--green); font-weight: 700; }

  .two { display: grid; grid-template-columns: 1.05fr 1fr; gap: 5mm; }
  h3 { font-size: 7.6pt; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); font-weight: 700; margin-bottom: 2mm; }
  table { width: 100%; border-collapse: collapse; }
  .costs td { padding: 1.35mm 0; border-bottom: 0.25mm solid var(--line); }
  .costs td:last-child { text-align: right; }
  .costs tr.total td { border-bottom: 0; border-top: 0.4mm solid var(--ink); font-weight: 700; padding-top: 1.8mm; }
  .rules { list-style: none; display: grid; gap: 1.6mm; }
  .rules li { display: grid; grid-template-columns: 4.2mm 1fr; gap: 1.5mm; color: var(--ink2); }
  .rules li span { width: 4.2mm; height: 4.2mm; border-radius: 50%; background: var(--navy); color: #fff; font-size: 6.4pt;
                   font-weight: 700; display: grid; place-items: center; margin-top: 0.2mm; }
  .fee { margin-top: 3mm; display: flex; align-items: center; justify-content: space-between; border: 0.3mm dashed var(--green);
         background: var(--green-soft); border-radius: 2mm; padding: 2.4mm 3.2mm; }
  .fee .was { color: var(--mute); text-decoration: line-through; text-decoration-color: var(--red); text-decoration-thickness: 0.4mm; font-weight: 600; }
  .fee .now { color: var(--green); font-weight: 800; letter-spacing: 0.08em; font-size: 9.5pt; }
  .fee small { display: block; color: var(--ink2); font-size: 7.2pt; margin-top: 0.3mm; }

  .holders th { font-size: 6.9pt; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mute); font-weight: 700;
                text-align: right; padding: 2mm 2mm; border-bottom: 0.4mm solid var(--ink); }
  .holders th:first-child, .holders td:first-child { text-align: left; }
  .holders td { padding: 2.5mm 2mm; border-bottom: 0.25mm solid var(--line); text-align: right; }
  .holders tbody tr:nth-child(odd) td { background: #fafbfd; }
  .holders .who { font-weight: 600; }
  .holders .bar { height: 1.2mm; background: var(--line); border-radius: 1mm; margin-top: 1mm; width: 26mm; overflow: hidden; }
  .holders .bar i { display: block; height: 100%; background: var(--gold); }
  .holders .struck { color: var(--mute); text-decoration: line-through; text-decoration-color: var(--red); }
  .holders .free { color: var(--green); font-weight: 700; font-size: 7.2pt; margin-left: 1mm; }
  .holders .get { color: var(--green); font-weight: 700; }
  .holders tfoot td { border-bottom: 0; border-top: 0.4mm solid var(--ink); font-weight: 700; padding-top: 2.6mm; background: #fff; }

  footer { padding: 5mm 14mm 8mm; margin-top: auto; }
  .notes { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; font-size: 7.3pt; color: var(--mute); border-top: 0.25mm solid var(--line); padding-top: 3.5mm; }
  .notes b { color: var(--ink2); }
  .base { display: flex; justify-content: space-between; margin-top: 4mm; font-size: 7pt; color: var(--mute); }
  .base .site { color: var(--ink); font-weight: 700; letter-spacing: 0.04em; }
</style></head>
<body><div class="page">
<header>
  <div class="top">
    <div class="brand"><div class="mark">C</div><div>
      <h1>CASHOOD HEADFUND</h1><p>Private AI Liquidity Provider · ${esc(chain)}</p></div></div>
    <div class="doc"><div class="kind">LAPORAN PEMBAGIAN DIVIDEN</div>
      <h2>${esc(fundName)}</h2><p>Periode ${esc(periodLabel)}</p></div>
  </div>
  <div class="meta">
    <div>Tanggal pembayaran<b>${esc(payLabel)}</b></div>
    <div>Kurs yang dipakai<b class="num">1 USD = ${idr(rate)}</b></div>
    <div>Pemegang saham<b>${rows.length} orang</b></div>
    <div>Porsi dibagikan<b>${distributePct}% laba bersih</b></div>
  </div>
  ${example ? '<div class="stamp">CONTOH PERHITUNGAN</div>' : ''}
</header>

<main>
  <div class="tiles">
    <div class="tile"><div class="k">Modal kerja dana</div><div class="v num">${usd(balance, 0)}</div><div class="s num">${idr(balance * rate)}</div></div>
    <div class="tile"><div class="k">Ditarik bulan ini</div><div class="v num">${usd(withdrawn, 0)}</div><div class="s num">${idr(withdrawn * rate)}</div></div>
    <div class="tile neg"><div class="k">Biaya sistem</div><div class="v num">${usd(-costsUsd, 0)}</div><div class="s num">${idr(-costsUsd * rate)}</div></div>
    <div class="tile hero"><div class="k">Dibagikan</div><div class="v num">${usd(pool, 0)}</div><div class="s num">${idr(Math.round(pool * rate))}</div></div>
  </div>

  <div class="flow">
    <span>Ditarik <b class="num">${usd(withdrawn)}</b></span><span class="op">−</span>
    <span>biaya sistem <b class="num">${usd(costsUsd)}</b></span><span class="op">=</span>
    <span class="res num">${usd(net)}</span><span class="op">→</span>
    <span><b>${distributePct}%</b> dibagikan ke seluruh pemegang saham sesuai porsinya</span>
  </div>

  <div class="two">
    <div>
      <h3>Rincian biaya sistem bulanan</h3>
      <table class="costs"><tbody>
        ${costItems.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${usd(c.usd)}</td></tr>`).join('')}
        <tr class="total"><td>Total biaya</td><td class="num">${usd(costsUsd)}</td></tr>
      </tbody></table>
    </div>
    <div>
      <h3>Cara pembagian</h3>
      <ul class="rules">
        <li><span>1</span><div>Bot bekerja dengan modal tetap. Setiap kelebihan di atasnya ditarik harian dalam kelipatan $100.</div></li>
        <li><span>2</span><div>Tanggal 1, total yang ditarik sebulan dikurangi biaya sistem.</div></li>
        <li><span>3</span><div>Sisanya dibagikan <b>100%</b> menurut porsi saham — sekecil apa pun porsinya, tanpa bagian yang mengendap.</div></li>
      </ul>
      <div class="fee"><div><span class="was">Fee admin ${feeStd}%</span><small>dari bagian tiap pemegang saham</small></div>
        <div class="now">${feeNow > 0 ? `${feeNow}%` : 'GRATIS BULAN INI'}</div></div>
    </div>
  </div>

  <div>
    <h3>Pembagian per pemegang saham</h3>
    <table class="holders">
      <thead><tr><th>Pemegang saham</th><th>Porsi</th><th>Bagian</th><th>Fee admin ${feeStd}%</th><th>Diterima (USD)</th><th>Diterima (IDR)</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>
          <td><div class="who">${esc(r.name)}</div><div class="bar"><i style="width:${Math.min(100, r.share).toFixed(2)}%"></i></div></td>
          <td class="num">${pct(r.share)}</td>
          <td class="num">${usd(r.gross)}</td>
          <td class="num">${feeNow > 0 ? usd(-r.feeUsd) : `<span class="struck">${usd(-r.feeStdUsd)}</span><span class="free">FREE</span>`}</td>
          <td class="num get">${usd(r.netUsd)}</td>
          <td class="num get">${idr(r.idr)}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td>Total</td><td class="num">100,00%</td><td class="num">${usd(pool)}</td>
        <td class="num">${feeNow > 0 ? usd(-rows.reduce((s, r) => s + r.feeUsd, 0)) : `<span class="struck">${usd(-totalFeeStd)}</span><span class="free">FREE</span>`}</td>
        <td class="num get">${usd(totalNet)}</td><td class="num get">${idr(totalIdr)}</td></tr></tfoot>
    </table>
  </div>
</main>

<footer>
  <div class="notes">
    <div><b>Kurs.</b> Nilai rupiah memakai kurs yang ditetapkan pengelola, 1 USD = ${idr(rate)}, bukan kurs pasar. Dana dikirim dalam USD; rupiah yang diterima dapat berbeda mengikuti kurs saat pencairan.</div>
    <div><b>Catatan.</b> Data aktual profit bisa berbeda karena gas fee yang fluktuatif, slippage, price impact, dan biaya bridge. Porsi saham dihitung dengan metode unit dan dapat diperiksa di cashood.id.${example ? ' <b>Dokumen ini adalah contoh perhitungan.</b>' : ''}</div>
  </div>
  <div class="base"><span class="site">cashood.id</span><span>Dibuat ${esc(generated)} WIB</span></div>
</footer>
</div></body></html>`;

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
const stem = `dividen-${fund}-${payIso}${example ? '-contoh' : ''}`;
const htmlPath = resolve(ROOT, 'reports', `${stem}.html`);
const pdfPath = resolve(ROOT, 'reports', `${stem}.pdf`);
writeFileSync(htmlPath, html);

const chrome = [process.env.CHROME, '/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find((p) => p && existsSync(p));
if (!chrome) { console.error(`HTML ditulis (${htmlPath}), tapi Chromium tidak ditemukan untuk mencetak PDF — set CHROME=`); process.exit(2); }
const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer',
  '--virtual-time-budget=8000', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { encoding: 'utf8', timeout: 90_000 });
if (r.status !== 0 || !existsSync(pdfPath)) { console.error(r.stderr || 'cetak PDF gagal'); process.exit(3); }

// Daftar laporan untuk tab Data investor. Satu entri per berkas; menjalankan
// ulang bulan yang sama menimpa entrinya, bukan menambah duplikat.
const manifestPath = resolve(ROOT, 'reports', 'index.json');
let manifest = [];
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* laporan pertama */ }
manifest = manifest.filter((m) => m.pdf !== `reports/${stem}.pdf`);
manifest.push({
  fund, period, periodLabel, payDate: payIso, payLabel, example,
  withdrawnUsd: withdrawn, costsUsd, distributedUsd: Number(pool.toFixed(2)), rate,
  pdf: `reports/${stem}.pdf`, html: `reports/${stem}.html`, generatedAt: now.toISOString(),
});
manifest.sort((a, b) => b.payDate.localeCompare(a.payDate) || Number(a.example) - Number(b.example));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[statement] ${fundName} ${periodLabel} · ditarik ${usd(withdrawn)} − biaya ${usd(costsUsd)} = ${usd(pool)} dibagikan · kurs ${idr(rate)}`);
for (const row of rows) console.log(`  ${row.name.padEnd(10)} ${pct(row.share).padStart(7)}  ${usd(row.netUsd).padStart(9)}  ${idr(row.idr)}`);
console.log(`  total      ${usd(totalNet).padStart(17)}  ${idr(totalIdr)}`);
console.log(`-> ${pdfPath}`);
