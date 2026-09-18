#!/usr/bin/env node
/*
 * cashood — proyeksi nilai dana sampai tanggal pembagian.
 *
 *   node scripts/forecast.mjs            # kedua dana
 *   node scripts/forecast.mjs meridian   # satu dana
 *
 * BUKAN ramalan. Yang dilakukan di sini: mengambil hasil harian yang BENAR-BENAR
 * tercatat di buku posisi bot, lalu mengundi ulang hari-hari itu secara acak
 * sebanyak sisa hari menuju tanggal 1, sepuluh ribu kali. Sebarannya itu yang
 * dilaporkan — terburuk (persentil 10), normal (median), terbaik (persentil 90).
 *
 * Artinya: kalau bot ke depan berperilaku seperti hari-hari yang sudah tercatat,
 * inilah rentang hasilnya. Kalau perilakunya berubah, angka ini tidak berlaku —
 * dan itu ditulis apa adanya di laporannya.
 *
 * Tidak ada model bahasa yang dipanggil. Angkanya harus bisa dihitung ulang
 * siapa pun dari data yang sama, dan model bahasa tidak bisa menjamin itu.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data');
const WIB = 7 * 3600e3;
const PATHS = 10000;

/** Jangka waktu untuk proyeksi seumur hidup bot. */
const HORIZONS = [
  { key: 'w1', label: '1 minggu', days: 7 },
  { key: 'm1', label: '1 bulan', days: 30 },
  { key: 'm3', label: '3 bulan', days: 90 },
  { key: 'm6', label: '6 bulan', days: 180 },
  { key: 'y1', label: '1 tahun', days: 365 },
];

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Undian yang sama tiap hari untuk data yang sama — angkanya tidak goyah tiap jam. */
function rng(seedText) {
  let h = 2166136261;
  for (const ch of seedText) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let s = h >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

function nextPayday(now = Date.now()) {
  const wibNow = new Date(now + WIB);
  const next = Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth() + 1, 1) - WIB;
  return { at: next, days: Math.max(1, Math.ceil((next - now) / 86400e3)) };
}

/** Persentase dari config; kosong → bawaan, tapi 0 tetap 0. */
function pctOr(value, fallback) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

/** Dividen menurut aturan dana, dipakai ulang untuk tiap skenario. */
function dividendAt(navUsd, cfg, ledgerBase, costs) {
  const d = cfg.dividend || {};
  const gross = Math.max(0, navUsd - ledgerBase);
  const net = Math.max(0, gross - costs);
  // `?? ` bukan `||`: 0% mengendap adalah aturan yang sah (sejak 2026-09-18),
  // dan `num(0) || 30` diam-diam mengembalikan sistem 30% yang sudah dihapus.
  const distributePct = pctOr(d.distributePct, 70);
  return {
    gross: Number(gross.toFixed(2)),
    net: Number(net.toFixed(2)),
    distributed: Number((net * (distributePct / 100)).toFixed(2)),
    reinvested: Number((net * (pctOr(d.reinvestPct, 30) / 100)).toFixed(2)),
  };
}

/** Harga koin dan pergerakannya — bahan untuk menilai pasar sedang ramai atau sepi. */
async function coinMarket(symbol) {
  const id = { ETH: 'ethereum', SOL: 'solana' }[symbol];
  if (!id) return null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h,7d`,
      { signal: AbortSignal.timeout(10000) });
    const [row] = await r.json();
    if (!row) return null;
    return {
      symbol,
      priceUsd: num(row.current_price),
      change24hPct: Number(num(row.price_change_percentage_24h_in_currency).toFixed(2)),
      change7dPct: Number(num(row.price_change_percentage_7d_in_currency).toFixed(2)),
    };
  } catch { return null; }
}

/**
 * Peluang modal tergerus dalam-dalam — "Worst Case".
 *
 * Diukur dari titik TERENDAH tiap lintasan undian, bukan nilai akhirnya: dana
 * yang sempat jatuh 90% lalu pulih tetap pernah kehilangan 90%.
 *
 * Undian itu sudah memuat seluruh kerugian yang pernah terjadi — hari sepi,
 * posisi meleset, termasuk satu posisi Reborn Rich yang kehilangan 51%, karena
 * hasil harian dihitung bersih setelah semua yang ditutup hari itu.
 *
 * Yang TIDAK bisa diukur dari sini adalah bencana yang belum pernah terjadi:
 * seluruh pool rugpull bersamaan, atau pasar runtuh serentak. Percobaan pertama
 * mencoba menambalnya dengan aturan tiga — batas atas 1% per posisi dikalikan
 * ribuan posisi — dan hasilnya 99,9% dalam tiga bulan. Itu salah: kalau
 * peluangnya benar 1%, tiga dari 300 posisi seharusnya sudah habis, dan tidak
 * satu pun habis. Batas atas kepercayaan bukan laju kejadian.
 *
 * Jadi yang diterbitkan: peluang dari data apa adanya, dengan lantai 0,001% —
 * karena "belum pernah terjadi" bukan "tidak mungkin" — ditemani skenario
 * tekanan yang dihitung langsung dari posisi hari ini, tanpa peluang yang
 * dikarang.
 */
function ruinRisk({ nav, simLows, stats }) {
  const FLOOR = 0.001;
  const pct = (v) => Math.min(99.9, Math.max(FLOOR, Number((v * 100).toFixed(3))));
  const at = (dropPct) => {
    const limit = nav * (1 - dropPct / 100);
    return pct(simLows.filter((v) => v <= limit).length / Math.max(1, simLows.length));
  };
  const graded = Math.max(1, num(stats?.graded) || num(stats?.closedCount));
  const buckets = stats?.lossBuckets || {};
  return {
    p10: at(10), p50: at(50), p80: at(80), p90: at(90), p99: at(99),
    floored: true,
    basis: {
      positionsClosed: graded,
      worstClosePct: num(stats?.worstClosePct),
      lostHalf: num(buckets.below50),
      wipedOut: num(buckets.below90),
      note: `${num(buckets.below50)} dari ${graded} posisi pernah kehilangan lebih dari setengah nilainya, ${num(buckets.below90)} habis total.`,
    },
  };
}

function forecast(fund) {
  const cfg = read(resolve(DATA, fund, 'config.json'));
  const live = read(resolve(DATA, fund, 'live.json'));
  const navSeries = read(resolve(DATA, fund, 'nav.json'))?.points || [];
  if (!cfg || !live) return null;

  const nav = num(live.totalUsd);
  const history = (live.history || []).filter((h) => h?.date);
  const { at: paydayAt, days } = nextPayday();

  // Hasil harian diubah jadi persen terhadap ukuran dana pada hari itu. Untuk
  // hari yang tidak punya catatan nilai dana, dipakai nilai hari ini — dan itu
  // membuat hari-hari lama tampak lebih kecil pengaruhnya daripada seharusnya.
  const navAt = (date) => {
    const target = Date.parse(date + 'T12:00:00Z');
    let best = null;
    for (const p of navSeries) if (best == null || Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
    return best && Math.abs(best.t - target) < 3 * 86400e3 ? num(best.usd) : nav;
  };

  const daily = history.map((h) => ({ date: h.date, pct: num(h.usd) / Math.max(1, navAt(h.date)) }));
  if (daily.length < 3) return { fund, enough: false, days, paydayAt, navNow: nav, samples: daily.length };

  // Dua contoh yang berbeda, sengaja. Proyeksi tanggal 1 memakai data BULAN
  // BERJALAN saja — itu periode yang dibayarkan. Proyeksi jangka panjang
  // memakai SELURUH data, karena yang ditanya di situ adalah perilaku umum
  // botnya, bukan bagaimana bulan ini kebetulan berjalan.
  const monthKey = new Date(Date.now() + WIB).toISOString().slice(0, 7);
  const thisMonth = daily.filter((d) => d.date.slice(0, 7) === monthKey);
  const monthly = thisMonth.length >= 3 ? thisMonth : daily;

  const pcts = daily.map((d) => d.pct);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const stdev = Math.sqrt(pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, pcts.length - 1));

  // Biaya sistem hanya memotong dana yang menanggung tagihannya.
  const costs = cfg.costs?.primary === false ? 0
    : (cfg.costs?.items || []).reduce((t, c) => t + num(c.usd), 0);

  const ledger = cfg.events || [];
  const deposits = ledger.filter((e) => e.type !== 'withdraw').reduce((t, e) => t + num(e.usd), 0);
  const withdrawn = ledger.filter((e) => e.type === 'withdraw').reduce((t, e) => t + num(e.usd), 0);
  const base = deposits - withdrawn + num(cfg.dividend?.retainedUsd);

  const units = (() => {
    // Harga saham = nilai dana ÷ unit beredar. Unit dihitung sederhana di sini:
    // setoran awal pada harga $1, setoran berikutnya pada harga saat itu.
    let total = 0;
    for (const e of ledger) {
      const price = e.founding || total === 0 ? 1 : num(e.navBefore) / total;
      const u = num(e.usd) / (price || 1);
      total += e.type === 'withdraw' ? -u : u;
    }
    return total;
  })();

  const seed = `${fund}:${new Date().toISOString().slice(0, 10)}:${daily.length}:${nav.toFixed(0)}`;

  /**
   * Undi ulang `horizonDays` hari dari contoh yang diberikan.
   *
   * Untuk jangka panjang, aturan dananya ikut dijalankan — dan itu yang membuat
   * angkanya masuk akal. Tanpa ini, tujuh hari yang kebetulan bagus dibunga-
   * berbungakan 1.825 kali menghasilkan angka kuintiliun: dana yang tumbuh
   * selamanya, padahal setiap bulan 70% labanya justru dibayarkan keluar dan
   * botnya sendiri punya plafon berapa modal yang sanggup ia kelola.
   */
  /**
   * Hari "ekor gemuk".
   *
   * Contoh harian yang cuma seminggu tidak pernah memuat hari bencana, jadi
   * undian murni selalu berkata risikonya nol. Sebagian hari karena itu diambil
   * dari sebaran Student-t (derajat bebas 3) yang diskalakan ke naik-turun yang
   * teramati — sebaran berekor tebal yang lazim dipakai mengukur risiko pasar,
   * justru karena ia memberi bobot pada kejadian yang belum pernah terlihat.
   */
  function fatTail(rand) {
    const normal = () => {
      const u = Math.max(1e-9, rand()), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const z = normal();
    const chi = normal() ** 2 + normal() ** 2 + normal() ** 2;   // khi-kuadrat, df 3
    return (z / Math.sqrt(Math.max(1e-9, chi / 3))) * stdev;
  }

  function simulate(sample, horizonDays, tag, { mechanics = false } = {}) {
    const pool = sample.map((d) => d.pct);
    const rand = rng(seed + ':' + tag);
    const distributePct = pctOr(cfg.dividend?.distributePct, 70) / 100;
    const reinvestPct = pctOr(cfg.dividend?.reinvestPct, 30) / 100;
    const capacity = num(cfg.fund?.capacityUsd);
    const ends = [];

    const marks = new Set(Array.isArray(horizonDays) ? horizonDays : [horizonDays]);
    const lastDay = Math.max(...marks);

    for (let i = 0; i < PATHS; i += 1) {
      const snap = {};
      let value = nav;
      let reference = base;
      let paid = 0;
      let low = nav;                      // titik terendah sepanjang lintasan

      for (let d = 1; d <= lastDay; d += 1) {
        // Plafon membatasi berapa yang SANGGUP diputar bot, bukan berapa yang
        // boleh dimiliki dana. Modal di atas plafon tetap milik dana tapi
        // menganggur — jadi dana tetap tumbuh dari 30% yang diputar ulang tiap
        // bulan, hanya lajunya melambat setelah melewati plafon.
        const working = mechanics && capacity > 0 ? Math.min(value, capacity) : value;
        const idle = value - working;
        // 15% hari diambil dari ekor gemuk, sisanya dari hari yang benar-benar
        // tercatat. Tanpa itu tidak ada satu pun lintasan yang pernah jatuh.
        const move = rand() < 0.15 ? fatTail(rand) : pool[Math.floor(rand() * pool.length)];
        value = working * (1 + Math.max(-0.95, move)) + idle;
        if (value < 0) value = 0;



        if (value < low) low = value;

        if (mechanics && d % 30 === 0) {
          value = Math.max(0, value - costs);
          const gross = Math.max(0, value - reference);
          const distributed = gross * distributePct;
          value -= distributed;
          reference += gross * reinvestPct;
          paid += distributed;
        }

        // Titik pemeriksaan direkam di sepanjang SATU lintasan, bukan diundi
        // ulang per jangka. Dengan begitu jangka yang lebih panjang benar-benar
        // memuat jangka yang lebih pendek, dan peluang kerugiannya tidak pernah
        // mengecil saat jangkanya diperpanjang — hal yang mustahil secara logika
        // tapi muncul kalau tiap jangka punya undiannya sendiri.
        if (marks.has(d)) snap[d] = { value: Math.max(0, value), paid, low: Math.max(0, low) };
      }
      ends.push(snap);
    }

    return ends;
  }

  const ends = simulate(monthly, days, 'payday').map((e) => e[days].value).sort((a, b) => a - b);

  const scenario = (q, label) => {
    const value = quantile(ends, q);
    return {
      label,
      navUsd: Number(value.toFixed(2)),
      changeUsd: Number((value - nav).toFixed(2)),
      changePct: Number(((value / nav - 1) * 100).toFixed(2)),
      sharePrice: units > 0 ? Number((value / units).toFixed(4)) : null,
      dividend: dividendAt(value, cfg, base, costs),
    };
  };

  const recent = (n) => history.slice(-n);
  const closesPerDay = (rows) => (rows.length ? rows.reduce((t, r) => t + num(r.closes), 0) / rows.length : 0);

  return {
    fund,
    enough: true,
    generatedAt: new Date(Date.now() + WIB).toISOString().replace('T', ' ').slice(0, 16) + ' WIB',
    updatedAt: Date.now(),
    paydayAt,
    paydayDate: new Date(paydayAt + WIB).toISOString().slice(0, 10),
    days,
    navNow: nav,
    sharePriceNow: units > 0 ? Number((nav / units).toFixed(4)) : null,
    baseCapital: Number(base.toFixed(2)),
    costs,
    sample: {
      days: daily.length,
      from: daily[0].date,
      to: daily[daily.length - 1].date,
      meanDailyPct: Number((mean * 100).toFixed(3)),
      stdevDailyPct: Number((stdev * 100).toFixed(3)),
      winDays: daily.filter((d) => d.pct > 0).length,
      lossDays: daily.filter((d) => d.pct < 0).length,
    },
    activity: {
      closesPerDay7d: Number(closesPerDay(recent(7)).toFixed(1)),
      closesPerDay3d: Number(closesPerDay(recent(3)).toFixed(1)),
      openPositions: (live.positions || []).length,
      inRangePct: live.positions?.length
        ? Number(((live.positions.filter((p) => p.inRange).length / live.positions.length) * 100).toFixed(0))
        : null,
      openFeesUsd: num(live.stats?.openFeesUsd),
      winRatePct: num(live.stats?.winRate),
    },
    scenarios: {
      worst: scenario(0.10, 'Terburuk'),
      normal: scenario(0.50, 'Normal'),
      best: scenario(0.90, 'Terbaik'),
    },
    monthSample: { days: monthly.length, scope: monthly === thisMonth ? 'bulan berjalan' : 'seluruh data — bulan ini belum cukup' },
    horizons: (() => {
      const runs = simulate(daily, HORIZONS.map((h) => h.days), 'horizon', { mechanics: true });
      return HORIZONS.map(({ key, label, days: hd }) => {
      const values = runs.map((r) => r[hd].value).sort((a, b) => a - b);
      const paids = runs.map((r) => r[hd].paid).sort((a, b) => a - b);
      const at = (q) => {
        const value = quantile(values, q);
        const paid = quantile(paids, q);
        return {
          navUsd: Number(value.toFixed(2)),
          changePct: Number(((value / nav - 1) * 100).toFixed(2)),
          dividendsUsd: Number(paid.toFixed(2)),
          totalUsd: Number((value + paid).toFixed(2)),
          sharePrice: units > 0 ? Number((value / units).toFixed(4)) : null,
        };
      };
      // Titik TERENDAH tiap lintasan, bukan nilai akhirnya: dana yang sempat
      // jatuh 90% lalu pulih tetap pernah kehilangan 90%.
      const lows = runs.map((r) => r[hd].low);

      return {
        key, label, days: hd,
        // Jangka yang jauh melampaui panjang datanya disebut apa adanya.
        speculative: hd > daily.length * 12,
        worst: at(0.10), normal: at(0.50), best: at(0.90),
        risk: ruinRisk({ nav, simLows: lows, stats: live?.stats }),
        // Pertanyaan yang paling sering ditanyakan orang bukan "berapa peluang
        // modal habis", tapi "berapa peluang saya rugi". Dana di bawah modal
        // acuan berarti tepat itu: tidak ada laba, dan tanggal 1 tidak ada
        // dividen sama sekali.
        belowBase: {
          // Lantai yang sama seperti tabel Worst Case: nol tidak pernah ditulis.
          endPct: Math.max(0.001, Number(((values.filter((v) => v < base).length / values.length) * 100).toFixed(3))),
          anyPct: Math.max(0.001, Number(((lows.filter((v) => v < base).length / lows.length) * 100).toFixed(3))),
        },
      };
      });
    })(),
    // Bentuk kerugian, bukan cuma peluangnya: kalau dana turun sekian persen,
    // jadi berapa nilainya, harga sahamnya, dan dividennya. Dividen ikut aturan
    // yang sama — di bawah modal acuan hasilnya nol, bukan sekadar kecil.
    lossScenarios: [10, 50, 90].map((dropPct) => {
      const value = nav * (1 - dropPct / 100);
      return {
        dropPct,
        navUsd: Number(value.toFixed(2)),
        changeUsd: Number((value - nav).toFixed(2)),
        sharePrice: units > 0 ? Number((value / units).toFixed(4)) : null,
        dividend: dividendAt(value, cfg, base, costs),
        belowBase: value < base,
      };
    }),

    // Berapa posisi rugi yang wajar terjadi sebulan, dan berapa nilainya.
    lossProfile: (() => {
      const st = live?.stats || {};
      const graded = Math.max(1, num(st.graded) || num(st.closedCount));
      const closesPerDay = (live?.history || []).slice(-7).reduce((t, r) => t + num(r.closes), 0)
        / Math.max(1, Math.min(7, (live?.history || []).length));
      const losingShare = num(st.losersCount) / graded;
      const perMonth = closesPerDay * 30 * losingShare;
      const avgLossUsd = num(st.avgInvestedUsd) * Math.abs(num(st.avgLossPct)) / 100;
      return {
        closesPerMonth: Math.round(closesPerDay * 30),
        losingPerMonth: Math.round(perMonth),
        avgLossPct: num(st.avgLossPct),
        avgLossUsd: Number(avgLossUsd.toFixed(2)),
        monthlyLossUsd: Number((perMonth * avgLossUsd).toFixed(2)),
        winRatePct: num(st.winRate),
      };
    })(),
    stress: null,
    caveats: [],
    method: `Undian ulang ${daily.length} hari hasil nyata, ${PATHS.toLocaleString('id-ID')} lintasan, ${days} hari menuju ${new Date(paydayAt + WIB).toISOString().slice(0, 10)}.`,
  };
}

const want = process.argv[2] ? [process.argv[2]] : ['reborn', 'meridian'];
for (const fund of want) {
  const out = forecast(fund);
  if (!out) { console.error(`[analisa] ${fund}: data tidak lengkap`); continue; }

  if (out.enough) {
    const live = read(resolve(DATA, fund, 'live.json'));
    out.market = await coinMarket(live?.nativeSymbol);

    // Kehilangan total tidak pernah muncul di undian, karena belum pernah
    // terjadi. Yang bisa dihitung langsung: seandainya SELURUH pool tempat dana
    // ini berada jatuh ke nol hari ini juga, berapa yang tersisa. Itu batas
    // bawah yang nyata, bukan hasil simulasi.
    const positions = live?.positions || [];
    const lpUsd = positions.reduce((t, p) => t + num(p.valueUsd ?? p.principalUsd), 0);
    const navNow = num(live?.totalUsd);
    const daily = (live?.history || []).map((h) => num(h.usd));
    out.stress = {
      lpUsd: Number(lpUsd.toFixed(2)),
      lpSharePct: navNow > 0 ? Number(((lpUsd / navNow) * 100).toFixed(1)) : null,
      cashUsd: Number(Math.max(0, navNow - lpUsd).toFixed(2)),
      positions: positions.length,
      worstDayUsd: daily.length ? Number(Math.min(...daily).toFixed(2)) : null,
      worstDayPct: daily.length && navNow > 0 ? Number(((Math.min(...daily) / navNow) * 100).toFixed(2)) : null,
      worstClosePct: (live?.closedRecent || []).length
        ? Number(Math.min(...live.closedRecent.map((c) => num(c.netPct))).toFixed(2))
        : null,
    };

    // Peringatan ditulis dari keadaan datanya sendiri, bukan kalimat tetap.
    const c = [];
    if (out.sample.days < 14) {
      c.push(`Contohnya baru ${out.sample.days} hari. Rentang ini menyempit dan bisa berubah banyak begitu data bertambah.`);
    }
    if (out.scenarios.worst.navUsd >= out.navNow) {
      c.push('Skenario terburuk masih di atas nilai hari ini — artinya rentetan hari rugi belum pernah terjadi di dalam contoh yang dipakai, bukan berarti kerugian tidak mungkin.');
    }
    if (out.sample.lossDays === 0) {
      c.push('Belum ada satu pun hari rugi di dalam contoh; proyeksi ini belum pernah melihat bot kalah.');
    }
    if (fund === 'meridian') {
      c.push('Hasil harian Meridian dihitung dari persen hasil tiap posisi dikali ukurannya, karena bot tidak mencatat hasil dalam dolar. Angkanya perkiraan.');
    }
    c.push('Proyeksi memakai asumsi bot berperilaku seperti hari-hari yang sudah tercatat. Kalau pasar atau aturan botnya berubah, angka ini tidak berlaku.');
    c.push(`Proyeksi jangka panjang mengulang ${out.sample.days} hari yang sama ratusan kali. Semakin jauh jangkanya semakin longgar artinya — tidak ada dana yang berjalan bertahun-tahun tanpa berubah.`);
    out.caveats = c;
  }

  writeFileSync(resolve(DATA, fund, 'forecast.json'), JSON.stringify(out, null, 2) + '\n');
  if (!out.enough) { console.log(`[analisa] ${fund}: baru ${out.samples} hari data — belum cukup untuk proyeksi`); continue; }
  const s = out.scenarios;
  console.log(`[analisa] ${fund}: ${out.days} hari ke ${out.paydayDate} · sekarang $${out.navNow}`
    + ` → terburuk $${s.worst.navUsd} · normal $${s.normal.navUsd} · terbaik $${s.best.navUsd}`
    + ` (contoh ${out.sample.days} hari)`);
}
