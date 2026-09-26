/* cashood — shared wallet tracker.
 *
 * Static, no build step, no dependencies. Everything the page needs is either
 * in data/config.json (owners + ledger, edited by hand) or read live from the
 * chain's public RPC. No private key ever touches this repo.
 *
 * Share accounting uses UNITS, not "my deposit / all deposits". A latecomer
 * buys units at the price a unit is worth on the day they join, so joining a
 * wallet that already made a profit does not hand them a slice of that profit.
 */

const FUNDS_URL = 'data/funds.json';

/* ── pengambilan data: paralel, bukan berantai ───────────────────────────
 *
 * Dulu urutannya menunggu satu sama lain: funds.json -> config.json ->
 * live.json -> nav.json. Empat perjalanan bolak-balik berurutan, dan angka
 * pertama baru muncul 2,4 detik setelah halaman dibuka meski seluruh
 * berkasnya cuma 245 KB.
 *
 * Sekarang keempatnya berangkat bersamaan begitu skrip ini dibaca. Dana yang
 * ditebak dari alamat halaman hampir selalu benar; kalau meleset, permintaan
 * yang telanjur jalan cuma terbuang dan alurnya lanjut seperti biasa.
 */
const BOOT_T = Date.now();
const RAW_BASE = 'https://raw.githubusercontent.com/orelfx/cashood/data/';
const inflight = new Map();
let fundEpoch = 0, loadEpoch = 0;
const REQUEST_TIMEOUT = 12000;

/**
 * Penanda "sedang mengambil data".
 *
 * Menekan tombol dana atau tab bisa memakan satu-dua detik di jaringan yang
 * lambat, dan sebelum ini tidak ada apa pun yang berubah di layar — halaman
 * terasa mati dan orang menekan lagi. Sebatang garis tipis di atas halaman
 * cukup: ia muncul selama masih ada permintaan yang berjalan, dan hilang
 * sendiri begitu semuanya selesai.
 */
let sibuk = 0;
function tandaiSibuk(delta) {
  sibuk = Math.max(0, sibuk + delta);
  const el = typeof document !== 'undefined' ? document.body : null;
  if (el) el.classList.toggle('busy', sibuk > 0);
}

/** Satu permintaan per alamat. `fresh` melewati antrean, untuk tombol refresh. */
function getJSON(url, { fresh = false } = {}) {
  if (!fresh && inflight.has(url)) return inflight.get(url);
  const full = url + (url.includes('?') ? '&' : '?') + 't=' + (fresh ? Date.now() : BOOT_T);
  tandaiSibuk(1);
  const job = fetch(full, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) }).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).finally(() => { tandaiSibuk(-1); if (inflight.get(url) === job) inflight.delete(url); });
  if (!fresh) inflight.set(url, job);
  return job;
}

// Ditembak sekarang, dipungut nanti. Kegagalan di sini tidak boleh jadi
// unhandled rejection: yang memungut akan mencoba lagi lewat jalur normal.
(() => {
  try {
    const quiet = (pr) => { pr.catch(() => {}); return pr; };
    quiet(getJSON(FUNDS_URL));
    const guess = (location.hash || '').replace(/^#/, '').split('/')[0] || 'reborn';
    const fund = ['reborn', 'meridian', 'ferari'].includes(guess) ? guess : 'reborn';
    quiet(getJSON(`data/${fund}/config.json`));
    for (const file of ['live.json', 'nav.json']) quiet(getJSON(RAW_BASE + fund + '/' + file));
  } catch { /* konteks aneh: lewati saja, pemuatan biasa tetap jalan */ }
})();

/**
 * Satu situs, dua dana yang tidak berbagi apa pun kecuali tampilannya.
 *
 * Tiap dana punya config, buku investor, snapshot, deret nilai, dan laporan
 * botnya sendiri. Yang dipakai bersama hanya header, tombol mata uang, dan
 * domainnya — karena mencampur angkanya, sekali saja, akan menghasilkan porsi
 * saham yang salah untuk orang sungguhan.
 */
const state = { fund: null, funds: [], cfg: null, ledger: null, nav: null };

const cacheKey = (fund = state.fund) => `cashood.nav.v6.${fund || 'reborn'}`;

const $ = (sel) => document.querySelector(sel);

/**
 * Alamat file data di raw.githubusercontent, dihitung dari alamat halamannya.
 *
 * Ditulis di config, alamat ini memuat nama pemilik dan nama repo secara
 * harfiah — repo yang di-rename atau di-fork akan tetap membaca data milik
 * repo lama, diam-diam, sampai ada yang sadar angkanya tidak pernah berubah.
 * Di GitHub Pages kedua nama itu sudah ada di URL halaman, jadi lebih baik
 * dibaca dari sana. Config tetap dipakai kalau situsnya di domain sendiri.
 */
function rawDataBase(fund) {
  // Dibungkus: kalau membaca alamat halaman saja gagal (konteks aneh, iframe
  // yang dikunci), yang boleh terjadi cuma kehilangan jalan pintas ini — bukan
  // seluruh halaman gagal memuat data.
  try {
    const host = String(location?.hostname || '').match(/^([^.]+)\.github\.io$/);
    if (!host) return null;
    const repo = String(location?.pathname || '').split('/').filter(Boolean)[0];
    if (!repo) return null;
    // Ref-nya branch `data`, bukan `main`: di situlah file yang berubah tiap
    // sepuluh menit tinggal, supaya Pages tidak membangun ulang situs untuk
    // setiap angka baru.
    return `https://raw.githubusercontent.com/${host[1]}/${repo}/data/${fund}/`;
  } catch {
    return null;
  }
}

/** URL sumber data: turunan dari alamat halaman dulu, config sebagai cadangan. */
function dataUrls(cfg, file, configured, fund = state.fund || 'reborn') {
  const base = rawDataBase(fund);
  return [base ? base + file : null, configured, `data/${fund}/${file}`].filter(Boolean);
}
/* ── format ──────────────────────────────────────────────────────────── */

/**
 * Satu angka, dua satuan.
 *
 * Semua yang dihitung situs ini berdenominasi dolar — itu satuan yang dipakai
 * bot dan yang dipakai orang waktu menyetor. Tampilan ETH adalah konversi di
 * lapisan paling luar memakai harga ETH yang sama dengan yang dipakai menilai
 * wallet, jadi tidak ada angka kedua yang bisa berbeda diam-diam dari yang
 * pertama.
 */


const fmtUsd = (n, dp = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });



let lastUsdIdr = null;

/**
 * Rupiah ditulis tanpa sen. Kurs 17 ribu membuat satu sen dolar bernilai
 * seratus tujuh puluh rupiah — angka di belakang koma di sini tidak
 * menyampaikan apa pun, hanya memanjangkan kolom.
 */
function fmtIdr(n) {
  if (!lastUsdIdr) return '—';
  const v = (Number(n) || 0) * lastUsdIdr;
  return (v < 0 ? '-' : '') + 'Rp' + '\u202f'
    + Math.round(Math.abs(v)).toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

/** Ringkas, untuk sumbu grafik: puluhan juta rupiah tidak muat ditulis penuh. */
function fmtIdrText(n) {
  if (!lastUsdIdr) return '—';
  const v = (Number(n) || 0) * lastUsdIdr;
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const short = (x, unit) => sign + 'Rp' + '\u202f'
    + x.toLocaleString('id-ID', { maximumFractionDigits: x >= 100 ? 0 : 1 }) + '\u202f' + unit;
  if (a >= 1e9) return short(a / 1e9, 'M');
  if (a >= 1e6) return short(a / 1e6, 'jt');
  if (a >= 1e4) return short(a / 1e3, 'rb');
  return sign + 'Rp' + '\u202f' + Math.round(a).toLocaleString('id-ID');
}

/**
 * Daftar koin yang bisa dipakai menampilkan angka.
 *
 * Ditulis sebagai daftar, bukan percabangan per koin, supaya menambah BTC atau
 * BNB nanti cukup menambah satu baris di sini dan satu nama di `coins` pada
 * data/funds.json — tidak ada logika lain yang perlu disentuh.
 *
 * `cg` adalah nama koin di CoinGecko; harga semua koin diambil sekali jalan.
 */
const COINS = {
  eth: {
    symbol: 'ETH', cg: 'ethereum',
    mark: '<svg class="ethmark" viewBox="0 0 256 417" aria-hidden="true" focusable="false">'
      + '<path d="M127.96 0l-2.8 9.5v275.67l2.8 2.79L255.92 212.3z" fill="currentColor" opacity=".6"/>'
      + '<path d="M127.96 0L0 212.3l127.96 75.66V154.16z" fill="currentColor"/>'
      + '<path d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z" fill="currentColor" opacity=".6"/>'
      + '<path d="M127.96 416.9v-104.71L0 236.59z" fill="currentColor"/>'
      + '<path d="M127.96 287.96l127.96-75.65-127.96-58.16z" fill="currentColor" opacity=".35"/>'
      + '<path d="M0 212.31l127.96 75.65V154.15z" fill="currentColor" opacity=".8"/></svg>',
  },
  sol: {
    symbol: 'SOL', cg: 'solana',
    // Tiga bilah miring resmi Solana. Sebelumnya tiap bilah kupotong di ujung
    // dan diganti "z", yang menutup bentuknya lurus ke pangkal — kemiringannya
    // hilang dan jadinya tiga garis datar biasa.
    mark: '<svg class="ethmark solmark" viewBox="0 0 397.7 311.7" aria-hidden="true" focusable="false">'
      + '<path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" fill="currentColor"/>'
      + '<path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" fill="currentColor" opacity=".9"/>'
      + '<path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" fill="currentColor" opacity=".8"/></svg>',
  },
  btc: { symbol: 'BTC', cg: 'bitcoin', mark: '<span class="coinmark">₿</span>' },
  bnb: { symbol: 'BNB', cg: 'binancecoin', mark: '<span class="coinmark">◆</span>' },
};

let currency = (() => {
  try {
    const saved = localStorage.getItem('cashood.currency');
    return saved && (saved === 'idr' || saved in COINS) ? saved : 'usd';
  } catch { return 'usd'; }
})();

/** Harga tiap koin dalam dolar, diisi sekali ambil. */
const coinPrice = {};

function coinAmount(n, id) {
  const price = coinPrice[id] || (state.nav?.nativeSymbol === COINS[id]?.symbol ? state.nav?.nativePrice : null);
  if (!price) return null;
  const v = (Number(n) || 0) / price;
  const a = Math.abs(v);
  const dp = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return { negative: v < 0, digits: a.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) };
}

/** Dengan lambang koin. Untuk tempat yang menerima HTML. */
function fmtCoin(n, id) {
  const v = coinAmount(n, id);
  return v ? (v.negative ? '-' : '') + (COINS[id]?.mark || '') + v.digits : '—';
}

/** Tanpa lambang. Untuk <text> di dalam SVG, yang tidak bisa memuat elemen HTML. */
function fmtCoinText(n, id) {
  const v = coinAmount(n, id);
  return v ? (v.negative ? '-' : '') + v.digits + ' ' + (COINS[id]?.symbol || '') : '—';
}

const usd = (n, dp = 2) => (COINS[currency] ? fmtCoin(n, currency)
  : currency === 'idr' ? fmtIdr(n) : fmtUsd(n, dp));
const usdText = (n, dp = 2) => (COINS[currency] ? fmtCoinText(n, currency)
  : currency === 'idr' ? fmtIdrText(n) : fmtUsd(n, dp));

const pct = (n, dp = 2) => (Number(n) || 0).toFixed(dp) + '%';

const num = (n, dp = 4) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

const signed = (n) => (n > 0 ? '+' : '') + usd(n);
const signedText = (n) => (n > 0 ? '+' : '') + usdText(n);

// Kotak kalender di telepon selebar empat puluhan piksel: sen dibuang dan
// ribuan diringkas, supaya angkanya tetap utuh di dalam kotaknya.
function signedCompact(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (currency !== 'usd') return (v > 0 ? '+' : '') + usdText(v, 0);
  const a = Math.abs(v);
  return sign + '$' + (a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k' : Math.round(a));
}

const cls = (n) => (n > 0.005 ? 'pos' : n < -0.005 ? 'neg' : 'dim');

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return m + ' menit lalu';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' jam lalu';
  return Math.floor(h / 24) + ' hari lalu';
}

function banner(msg, kind = 'warn') {
  const el = $('#banner');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'banner' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
}

/* ── ledger: deposits and withdrawals become units ───────────────────── */

const buildLedger = CashoodCore.buildLedger;

/* ── nilai wallet (NAV) ──────────────────────────────────────────────── */

/**
 * Harga ETH, untuk tombol dolar/ETH.
 *
 * Ini satu-satunya panggilan jaringan yang tersisa selain mengambil snapshot:
 * halaman ini sengaja tidak lagi membaca saldo langsung dari chain, karena
 * untuk melakukannya browser harus menyebut alamat wallet yang dipantau —
 * dan alamat itu tidak boleh bocor dari sini.
 */
/**
 * Kurs ETH dan rupiah dari satu panggilan.
 *
 * CoinGecko mengembalikan harga ETH dalam dolar dan rupiah sekaligus; membagi
 * keduanya memberi kurs dolar-rupiah tanpa perlu sumber kedua. Kalau gagal,
 * baru mencari kurs rupiah ke tempat lain.
 */
async function fxRates() {
  const ids = [...new Set(Object.values(COINS).map((c) => c.cg))].join(',');
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,idr`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('kurs tidak tersedia');
    const j = await r.json();
    for (const [id, coin] of Object.entries(COINS)) {
      const usdPrice = Number(j?.[coin.cg]?.usd);
      if (usdPrice > 0) coinPrice[id] = usdPrice;
      const idrPrice = Number(j?.[coin.cg]?.idr);
      if (usdPrice > 0 && idrPrice > 0) lastUsdIdr = idrPrice / usdPrice;
    }
  } catch { /* lanjut ke cadangan */ }

  if (!lastUsdIdr) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      const i = Number(j?.rates?.IDR);
      if (i > 0) lastUsdIdr = i;
    } catch { /* tanpa kurs, tampilan rupiah menampilkan tanda pisah */ }
  }
  return { coinPrice, idr: lastUsdIdr };
}

/**
 * Snapshot dari bot (scripts/sync.mjs) — nilai tiap posisi LP.
 *
 * Dicoba dari `snapshotUrl` dulu (raw.githubusercontent) karena file di sana
 * ikut berubah begitu di-push, tanpa nunggu GitHub Pages build ulang. Kalau
 * gagal, jatuh ke salinan yang ikut ke-deploy bareng situsnya.
 */
async function readSnapshot(cfg, { force = false, fund = state.fund } = {}) {
  const urls = dataUrls(cfg, 'live.json', cfg?.app?.snapshotUrl, fund);
  let lastErr;
  for (const url of urls) {
    try {
      const j = await getJSON(url, { fresh: force });
      CashoodCore.validateSnapshot(j);
      if (j.fund && j.fund !== fund) throw new Error('Identitas dana pada snapshot berbeda');
      return j;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('tidak ada snapshot');
}

async function resolveNav(cfg, { force = false, fund = state.fund } = {}) {
  // 1. angka manual selalu menang
  const manual = Number(cfg.navOverrideUsd);
  if (Number.isFinite(manual) && manual > 0) {
    return { totalUsd: manual, source: 'manual', label: 'angka manual dari config.json', fetchedAt: Date.now(), holdings: [], positions: [] };
  }

  // 2. cache pendek — menahan reload beruntun, bukan menunda data
  const ttl = (Number(cfg.app?.refreshMinutes) || 5) * 60000;
  if (!force) {
    try {
      const hit = JSON.parse(localStorage.getItem(cacheKey(fund)) || 'null');
      if (hit && Date.now() - hit.fetchedAt < ttl) return { ...hit, cached: true };
    } catch { /* cache rusak, abaikan */ }
  }

  // 3. Satu sumber: snapshot yang ditulis bot.
  //
  //    Versi sebelumnya membaca saldo token langsung dari chain supaya angkanya
  //    bergerak tiap menit. Untuk itu browser harus mengirim alamat wallet ke
  //    RPC publik — alamat yang lalu terbaca siapa pun yang membuka panel
  //    jaringan. Kesegaran sepuluh menit ditukar dengan alamat yang tidak
  //    pernah meninggalkan server.
  const [snap] = await Promise.all([readSnapshot(cfg, { force, fund })]);

  const positions = snap?.positions || [];
  const history = snap?.history || [];
  const stats = snap?.stats || null;
  const closedRecent = snap?.closedRecent || [];
  // Snapshot membawa harga koin asli dananya; dipakai kalau CoinGecko tidak
  // bisa dihubungi dari browser pengunjung.
  const nativeId = Object.keys(COINS).find((k) => COINS[k].symbol === snap?.nativeSymbol);
  if (nativeId && Number(snap?.nativePrice) > 0 && !coinPrice[nativeId]) {
    coinPrice[nativeId] = Number(snap.nativePrice);
  }

  const lpUsd = positions.reduce((s, p) => s + (Number(p.principalUsd) || 0) + (Number(p.feesUsd) || 0), 0);
  const holdings = snap.holdings || [];
  const liveUsd = holdings.reduce((sum, h) => sum + (Number(h.usd) || 0), 0);
  const age = Date.now() - (Number(snap.updatedAt) || 0);

  const out = {
    totalUsd: Number(snap.totalUsd),
    source: 'snapshot',
    label: `dihitung bot ${ago(Number(snap.updatedAt))}`,
    holdings,
    positions,
    history,
    stats,
    closedRecent,
    lpUsd,
    liveUsd,
    treasuryUsd: Number(snap.treasuryUsd) || 0,
    bookStats: snap.bookStats || null,
    historyNote: snap.historyNote || null,
    treasuryMoves: Array.isArray(snap.treasuryMoves) ? snap.treasuryMoves : [],
    treasuryOpeningUsd: Number(snap.treasuryOpeningUsd) || 0,
    treasuryOpeningLabel: snap.treasuryOpeningLabel || null,
    treasuryNewUsd: Number(snap.treasuryNewUsd) || 0,
    treasuryCountFrom: snap.treasuryCountFrom || null,
    fixedCapitalUsd: Number(snap.fixedCapitalUsd) || 0,
    sweepStepUsd: Number(snap.sweepStepUsd) || 100,
    sweepDueUsd: Number(snap.sweepDueUsd) || 0,
    costsShareUsd: Number.isFinite(Number(snap.costsShareUsd)) ? Number(snap.costsShareUsd) : null,
    costsTotalUsd: Number(snap.costsTotalUsd) || null,
    nativeSymbol: snap.nativeSymbol || null,
    nativePrice: Number(snap.nativePrice) || null,
    usdIdr: Number(snap.usdIdr) || null,
    botWalletUsd: Number(snap.totalUsd) - Number(snap.treasuryUsd || 0),
    costsPaidUsd: Number(snap.costsPaidUsd || 0),
    quality: snap.quality || { complete: false, reasons: ['snapshot lama belum memiliki verifikasi kelengkapan'] },
    treasuryDistributableUsd: snap.treasuryDistributableUsd ?? snap.treasuryUsd ?? 0,
    dividendLayers: snap.dividendLayers,
    stalePositions: snap.stalePositions || 0,
    ethPrice: Number(snap.ethPrice) || null,
    updatedAt: Number(snap.updatedAt) || null,
    lpStale: age > 45 * 60e3,
    partial: snap.quality?.complete !== true || positions.some(p => p.stale || p.unreadable),
    fetchedAt: Date.now(),
  };

  try { localStorage.setItem(cacheKey(fund), JSON.stringify(out)); } catch { /* mode privat */ }
  return out;
}

/* ── render ──────────────────────────────────────────────────────────── */

function ownerValues(ledger, navUsd) {
  const unitPrice = ledger.totalUnits > 0 ? navUsd / ledger.totalUnits : 0;
  return ledger.owners.map((o) => {
    const value = o.units * unitPrice;
    return {
      ...o,
      value,
      share: ledger.totalUnits > 0 ? (o.units / ledger.totalUnits) * 100 : 0,
      pnl: value + o.withdrawn - o.deposited,
    };
  });
}

/**
 * Kartu yang tidak punya isi disembunyikan.
 *
 * Dana yang dibaca dari dompet orang lain tidak punya catatan posisi tertutup
 * maupun riwayat harian — bot yang menutup posisinya bukan bot kita. Sebelum
 * ini, dua kartunya berdiri kosong dengan tulisan "mengambil riwayat dari
 * snapshot…" yang tidak akan pernah selesai.
 */
function hideEmptyCards(nav) {
  const punyaRiwayat = Array.isArray(nav?.history) && nav.history.length > 0;
  const punyaTutup = Array.isArray(nav?.closedRecent) && nav.closedRecent.length > 0;
  const siap = nav?.source === 'snapshot';
  const card = (id, ada) => { const el = $(id); if (el) el.hidden = siap && !ada; };
  card('#profitCard', punyaRiwayat);
  card('#closedCard', punyaTutup);
}

function renderSummary(ledger, nav) {
  // Tiga kartu yang harus bisa dijumlah dengan mata:
  //   nilai di bot + sudah ditarik − modal masuk = untung/rugi
  // Kas cadangan (hasil sapuan) masuk "Sudah ditarik", jadi TIDAK ikut lagi di
  // "Nilai sekarang" — dulu ia tampil di dua kartu dan kelihatan dobel.
  // Hasilnya sama persis dengan rumus lama (nav.totalUsd sudah memuat kas);
  // yang berubah hanya di kartu mana uang itu ditampilkan. Nilai saham tiap
  // pemilik tetap memakai nav.totalUsd, karena kas cadangan tetap milik dana.
  const swept = Number(nav.treasuryUsd) || 0;
  const inBot = Math.max(0, nav.totalUsd - swept);
  const pnl = inBot + (ledger.withdrawn + swept) - ledger.deposited;
  const pnlPct = ledger.deposited > 0 ? (pnl / ledger.deposited) * 100 : 0;

  setHTML($('#kpiNav'), usd(inBot));
  setHTML($('#kpiNavSub'), nav.lpUsd > 0
    ? `${usd(nav.liveUsd ?? 0, 0)} token + ${usd(nav.lpUsd, 0)} di LP · yang dipegang bot`
    : nav.label);
  setHTML($('#kpiDeposit'), usd(ledger.deposited));
  // "Sudah ditarik" = pencairan investor + sapuan harian bot ke wallet tabungan.
  const sweeps = (nav.treasuryMoves || []).length;
  setHTML($('#kpiWithdraw'), usd(ledger.withdrawn + swept));
  // Pemilik membaca ini sebagai dua bagian: uang yang sudah ada sebelum
  // hitungan baru dimulai ("early investor"), dan yang ditarik bot sesudahnya
  // ("new"). Keduanya ditulis apa adanya, bukan dijumlah jadi satu angka buta.
  const opening = Number(nav.treasuryOpeningUsd) || 0;
  const fresh = Number(nav.treasuryNewUsd) || 0;
  const openingLabel = nav.treasuryOpeningLabel || 'saldo awal';
  setHTML($('#kpiWithdrawSub'), swept > 0
    ? (ledger.withdrawn > 0 ? `${usd(ledger.withdrawn, 0)} investor + ` : '')
      + (opening > 0
        ? `${esc(openingLabel)} ${usd(opening, 0)}` + (fresh > 0 ? ` · new ${usd(fresh, 0)}` : '')
        : `${usd(swept, 0)} disapu bot · ${sweeps} transfer`)
    : 'total penarikan');
  const el = $('#kpiPnl');
  setHTML(el, signed(pnl));
  el.className = 'big ' + cls(pnl);
  $('#kpiPnlSub').textContent = (pnl >= 0 ? '+' : '') + pct(pnlPct) + ' dari modal';
  setHTML($('#donutVal'), usd(nav.totalUsd, 0));
  $('#footSrc').textContent = nav.source === 'manual' ? 'config manual' : 'snapshot bot';
  $('#footTime').textContent = 'data sumber ' + ago(nav.updatedAt || nav.fetchedAt);

  // Kurs yang ditampilkan mengikuti koin yang sedang dipilih; kalau sedang
  // dolar atau rupiah, yang ditampilkan koin asli dana yang sedang dibuka.
  const coinId = COINS[currency] ? currency
    : Object.keys(COINS).find((k) => COINS[k].symbol === nav.nativeSymbol) || 'eth';
  const price = coinPrice[coinId];
  $('#ethRate').textContent = price
    ? `1 ${COINS[coinId].symbol} = ${fmtUsd(price)}`
    : `kurs ${COINS[coinId].symbol} belum terbaca`;
  $('#idrRate').textContent = lastUsdIdr
    ? `$1 = Rp\u202f${Math.round(lastUsdIdr).toLocaleString('id-ID')}`
    : 'kurs Rp belum terbaca';
  // Salinan untuk layar sempit; yang di header disembunyikan di sana.
  const ethTeks = $('#ethRate').textContent;
  const idrTeks = $('#idrRate').textContent;
  if ($('#stripEth')) $('#stripEth').textContent = ethTeks;
  if ($('#stripIdr')) $('#stripIdr').textContent = idrTeks;

  const every = Number(state.cfg?.app?.refreshMinutes) || 5;
  $('#stripToken').textContent = nav.source === 'manual'
    ? 'dikunci manual di config.json'
    : `dihitung bot, halaman cek ulang tiap ${every} menit`;
  $('#stripLp').textContent = nav.positions?.length
    ? `dihitung bot tiap 10 menit · terakhir ${ago(nav.updatedAt)}`
    : 'belum ada snapshot — LP belum terhitung';
}

function renderDonut(rows) {
  const svg = $('#donut');
  const R = 78, C = 100, W = 22, circ = 2 * Math.PI * R;
  let offset = 0;
  const parts = rows.filter((r) => r.share > 0);
  const bg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#1a1f27" stroke-width="${W}"/>`;
  const arcs = parts.map((r) => {
    const len = (r.share / 100) * circ;
    const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${r.color || '#4ade80'}"
        stroke-width="${W}" stroke-dasharray="${len - 1.5} ${circ - len + 1.5}"
        stroke-dashoffset="${-offset}" transform="rotate(-90 ${C} ${C})" stroke-linecap="butt"><title>${esc(r.name)} ${pct(r.share, 1)}</title></circle>`;
    offset += len;
    return seg;
  }).join('');
  setHTML(svg, bg + arcs);
}

function renderOwners(rows) {
  setHTML($('#ownerTable').querySelector('tbody'), rows.map((r) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${r.color || '#4ade80'}"></span>${esc(r.name)}</span></td>
      <td class="num">${pct(r.share)}</td>
      <td class="num">${usd(r.deposited)}</td>
      <td class="num">${r.withdrawn > 0 ? usd(r.withdrawn) : '<span class="dim">—</span>'}</td>
      <td class="num"><strong>${usd(r.value)}</strong></td>
      <td class="num ${cls(r.pnl)}">${signed(r.pnl)}</td>
    </tr>`).join(''));
  setHTML($('#unitHint'), `${num(state.ledger.totalUnits, 2)} unit beredar · 1 unit = ${usd(state.ledger.totalUnits > 0 ? state.nav.totalUsd / state.ledger.totalUnits : 0, 4)}`);
}

const dur = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  return `${Math.floor(h / 24)}h ${h % 24}j`;
};

let holdPage = 0;
const HOLD_PER_PAGE = 5;

function renderHoldings(nav) {
  const rows = [...(nav.holdings || [])].sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const body = $('#holdTable').querySelector('tbody');
  const pages = Math.max(1, Math.ceil(rows.length / HOLD_PER_PAGE));
  if (holdPage >= pages) holdPage = pages - 1;

  const slice = rows.slice(holdPage * HOLD_PER_PAGE, (holdPage + 1) * HOLD_PER_PAGE);
  setHTML(body, slice.length
    ? slice.map((r) => `
      <tr>
        <td><span class="who"><span class="chip" style="background:${r.symbol === 'ETH' ? '#627eea' : '#4ade80'}"></span>${esc(r.symbol)}</span></td>
        <td class="num">${num(r.amount, 6)}</td>
        <td class="num">${r.price == null ? '<span class="dim">—</span>' : usd(r.price, r.price < 10 ? 4 : 2)}</td>
        <td class="num">${r.usd == null ? '<span class="dim">?</span>' : usd(r.usd)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="dim">Tidak ada saldo token terbaca.</td></tr>');

  // Halaman baru muncul kalau tokennya lebih dari lima; di bawah itu tidak ada
  // yang perlu digeser dan pagernya cuma jadi hiasan.
  const pager = $('#holdPager');
  pager.hidden = pages < 2;
  if (pages > 1) {
    const btn = (label, page, extra = '') =>
      `<button ${extra} data-p="${page}" class="${page === holdPage ? 'on' : ''}">${label}</button>`;
    const nums = [];
    for (let i = 0; i < pages; i += 1) {
      if (i === 0 || i === pages - 1 || Math.abs(i - holdPage) <= 1) nums.push(btn(String(i + 1), i));
      else if (nums[nums.length - 1] !== '<span class="gap">…</span>') nums.push('<span class="gap">…</span>');
    }
    setHTML(pager, btn('‹', Math.max(0, holdPage - 1), holdPage === 0 ? 'disabled' : '')
      + nums.join('')
      + btn('›', Math.min(pages - 1, holdPage + 1), holdPage === pages - 1 ? 'disabled' : ''));
  }

  const total = rows.reduce((sum, r) => sum + (r.usd || 0), 0);
  setHTML($('#holdHint'), nav.source === 'manual'
    ? 'NAV dikunci manual di config.json'
    : `${rows.length} token · ${usd(total)} · dihitung bot ${ago(nav.updatedAt)}`);
}

/**
 * Posisi LP.
 *
 * Fee yang ditampilkan adalah fee yang BELUM dipanen. Fee yang sudah dipanen
 * tidak dicatat per posisi oleh bot, jadi menjumlahkannya jadi satu kolom
 * "total fee" akan mengarang angka yang tidak ada sumbernya — kolomnya diberi
 * nama apa adanya.
 *
 * Untung/rugi di sini nilai sekarang dikurangi modal yang masuk ke posisi itu,
 * dan belum memperhitungkan biaya keluar.
 */
function renderLp(nav) {
  const rows = nav.positions || [];
  const body = $('#lpTable').querySelector('tbody');
  $('#lpCount').textContent = rows.length ? `(${rows.length})` : '';

  if (!rows.length) {
    setHTML(body, '<tr><td colspan="7" class="dim">Tidak ada posisi terbuka.</td></tr>');
    setHTML($('#lpSummary'), '');
    $('#lpHint').textContent = nav.positions ? 'kosong' : 'butuh snapshot bot';
    return;
  }

  const sum = (key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
  const value = sum('valueUsd');
  const invested = sum('investedUsd');
  const fees = sum('feesUsd');
  const collected = sum('collectedFeesUsd');
  const sinceAll = rows.map((r) => Number(r.feesTrackedSince) || 0).filter(Boolean);
  const trackedSince = sinceAll.length ? Math.min(...sinceAll) : null;
  const pnl = rows.reduce((t, r) => t + (Number(r.pnlUsd) || 0), 0);
  const inRange = rows.filter((r) => r.inRange).length;

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  setHTML($('#lpSummary'), [
    tile('Nilai posisi', usd(value), `${rows.length} posisi`),
    tile('Modal masuk', usd(invested), 'saat dibuka'),
    tile('Fee terkumpul', usd(fees + collected),
      collected > 0 ? `${usd(collected)} sudah dipanen · ${usd(fees)} belum` : 'semuanya masih di dalam posisi', 'pos'),
    tile('Untung / rugi', signed(pnl), invested ? pct((pnl / invested) * 100) + ' dari modal' : '—', cls(pnl)),
    tile('Di dalam range', `${inRange}/${rows.length}`, inRange === rows.length ? 'semua earning' : `${rows.length - inRange} tidak earning`,
      inRange === rows.length ? 'pos' : 'neg'),
  ].join(''));

  setHTML(body, [...rows]
    .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))
    .map((r) => {
      const band = r.throughBandPct == null ? '' : `<span class="band">${r.throughBandPct.toFixed(0)}%</span>`;
      return `<tr>
        <td><span class="who"><span class="chip" style="background:${r.inRange ? '#4ade80' : '#f87171'}"></span>${esc(r.symbol ?? r.tokenId)}</span>
            <div class="sub2">${esc(r.bookLabel ?? r.strategy ?? '')}${r.feePct ? ' · fee ' + r.feePct + '%' : ''}</div>
            <div class="sub2 m-only ${r.inRange ? 'pos' : 'neg'}">${r.inRange ? 'di dalam range' : 'di luar range'}${
              r.throughBandPct == null ? '' : ' · ' + r.throughBandPct.toFixed(0) + '%'}</div></td>
        <td><span class="pill ${r.inRange ? 'in' : 'out2'}">${r.inRange ? 'di dalam range' : 'di luar range'}</span> ${band}</td>
        <td class="num dim">${dur(r.ageMinutes)}</td>
        <td class="num">${r.investedUsd == null ? '<span class="dim">—</span>' : usd(r.investedUsd)}</td>
        <td class="num"><strong>${r.valueUsd == null ? '—' : usd(r.valueUsd)}</strong></td>
        <td class="num pos">${usd((r.totalFeesUsd ?? r.feesUsd) || 0)}<div class="sub2">${
          r.collectedFeesUsd > 0 ? `${usd(r.collectedFeesUsd)} dipanen` : 'belum dipanen'
        }</div></td>
        <td class="num ${cls(r.pnlUsd)}">${r.pnlUsd == null ? '—' : signed(r.pnlUsd)}<div class="sub2 ${cls(r.pnlUsd)}">${r.pnlPct == null ? '' : (r.pnlPct > 0 ? '+' : '') + pct(r.pnlPct)}</div></td>
      </tr>`;
    }).join(''));

  $('#lpHint').textContent = `dihitung bot ${ago(nav.updatedAt)}`
    + (rows.some(p => p.stale || p.unreadable) ? ' · ada posisi belum terverifikasi' : '')
    + (trackedSince ? ` · estimasi fee dipanen sejak ${ago(trackedSince)}` : '');
}

function renderClosed(nav) {
  const rows = nav.closedRecent || [];
  const body = $('#closedTable').querySelector('tbody');
  $('#closedCard').hidden = false;
  if (!rows.length) {
    setHTML(body, '<tr><td colspan="7" class="dim">Belum ada posisi yang ditutup.</td></tr>');
    $('#closedHint').textContent = '';
    return;
  }
  setHTML(body, rows.map((r) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${r.netUsd >= 0 ? '#4ade80' : '#f87171'}"></span>${esc(r.symbol ?? '—')}</span></td>
      <td class="dim">${esc(r.strategy ?? '—')}</td>
      <td class="num dim">${r.holdMinutes == null ? '—' : dur(r.holdMinutes)}</td>
      <td class="num ${cls(r.netUsd)}">${signed(r.netUsd)}</td>
      <td class="num ${cls(r.netUsd)}">${r.netPct == null ? '—' : (r.netPct > 0 ? '+' : '') + pct(r.netPct)}</td>
      <td class="dim">${esc(r.reason ?? '—')}</td>
      <td class="num dim">${ago(r.closedAt)}</td>
    </tr>`).join(''));
  const net = rows.reduce((t, r) => t + (Number(r.netUsd) || 0), 0);
  setHTML($('#closedHint'), `${rows.length} terakhir · jumlahnya ${signed(net)}`);
}

/** Biaya langganan bulanan. Dibayar dari luar wallet, jadi tidak masuk NAV. */
function renderCosts(cfg) {
  const items = cfg?.costs?.items || [];
  const table = $('#costTable');
  $('#costCard').hidden = !items.length;
  if (!items.length) return;

  setHTML(table.querySelector('tbody'), items
    .map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${usd(c.usd)}</td></tr>`).join(''));

  const bill = items.reduce((t, c) => t + (Number(c.usd) || 0), 0);
  const total = monthlyCosts();
  const shared = Math.abs(total - bill) > 0.01;
  setHTML(table.querySelector('tfoot'), (shared
      ? `<tr><td class="dim">Tagihan penuh, dipakai bersama semua dana</td><td class="num dim">${usd(bill)}</td></tr>`
      : '')
    + `<tr class="total"><td><strong>${shared ? 'Bagian dana ini' : 'Total'}</strong></td><td class="num"><strong>${usd(total)}</strong></td></tr>`
    + `<tr><td class="dim">Per hari</td><td class="num dim">${usd(total / 30)}</td></tr>`);

  const navUsd = state.nav?.totalUsd || 0;
  $('#costHint').textContent = cfg.costs.note
    + (navUsd ? ` · ${pct((total / navUsd) * 100)} dari nilai wallet per bulan` : '');
}

function renderHistory(ledger) {
  const body = $('#histTable').querySelector('tbody');
  if (!ledger.events.length) {
    setHTML(body, `<tr><td colspan="6" class="dim">Belum ada transaksi.</td></tr>`);
  } else {
    setHTML(body, ledger.events.map((e) => {
      const out = e.type === 'withdraw';
      return `<tr>
        <td>${e.date || '—'}</td>
        <td><span class="pill ${out ? 'out' : 'in'}">${e.type === 'reinvest' ? 'reinvestasi' : out ? 'tarik' : 'setor'}</span></td>
        <td><span class="who"><span class="chip" style="background:${e.color || '#4ade80'}"></span>${esc(e.ownerName)}</span></td>
        <td class="num ${out ? 'neg' : 'pos'}">${out ? '-' : '+'}${usd(e.usd)}</td>
        <td class="num dim">${usd(e.unitPrice, 4)}</td>
        <td class="dim">${esc(e.note || '—')}</td>
      </tr>`;
    }).join(''));
  }
  $('#histHint').textContent = `${ledger.events.length} transaksi`;
}

/* ── kalkulator penarikan ────────────────────────────────────────────── */

function renderCalc() {
  const rows = ownerValues(state.ledger, state.nav.totalUsd);
  const amount = Math.max(0, Number($('#wdAmount').value) || 0);
  const mode = $('#wdMode').value;
  const target = $('#wdOwner').value;
  $('#wdOwnerField').hidden = mode !== 'single';

  const unitPrice = state.ledger.totalUnits > 0 ? state.nav.totalUsd / state.ledger.totalUnits : 0;
  const cuts = rows.map((r) => {
    let take = mode === 'single'
      ? (r.id === target ? amount : 0)
      : amount * (r.share / 100);
    take = Math.min(take, r.value);                          // tidak bisa tarik lebih dari jatah
    return { ...r, take, left: r.value - take, unitsLeft: unitPrice > 0 ? (r.value - take) / unitPrice : 0 };
  });

  const unitsLeft = cuts.reduce((s, c) => s + c.unitsLeft, 0);
  setHTML($('#wdTable').querySelector('tbody'), cuts.map((c) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${c.color || '#4ade80'}"></span>${esc(c.name)}</span></td>
      <td class="num ${c.take > 0 ? 'pos' : 'dim'}">${c.take > 0 ? usd(c.take) : '—'}</td>
      <td class="num">${usd(c.left)}</td>
      <td class="num">${pct(unitsLeft > 0 ? (c.unitsLeft / unitsLeft) * 100 : 0)}</td>
    </tr>`).join(''));

}




/* ── laporan bot ─────────────────────────────────────────────────────────
 *
 * Teksnya diambil apa adanya dari laporan yang bot kirim ke Telegram tiap jam.
 * Yang dilakukan di sini cuma memecahnya jadi bagian-bagian dan mewarnai baris
 * per baris — tidak ada angka yang dihitung ulang, tidak ada kalimat yang
 * ditulis ulang, supaya yang dibaca orang di sini sama dengan yang dibaca
 * operatornya di Telegram.
 */

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function lineClass(line) {
  const t = line.trim();
  if (/^🟢/.test(t)) return 'hb-in';
  if (/^(⏳|⚠️)/.test(t)) return 'hb-wait';
  if (/^(💀|🔴)/.test(t)) return 'hb-bad';
  if (/^🏆/.test(t)) return 'hb-good';
  if (/^\s+/.test(line)) return 'hb-det';
  return '';
}

/** Pecah laporan jadi bagian: judul diapit garis ━ di atas dan di bawahnya. */
function splitSections(text) {
  const lines = text.split('\n');
  const rule = (l) => /^━+$/.test(l.trim());
  const lead = [];
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    if (rule(lines[i]) && lines[i + 1] && !rule(lines[i + 1]) && rule(lines[i + 2] || '')) {
      current = { title: lines[i + 1].trim(), lines: [] };
      sections.push(current);
      i += 2;
      continue;
    }
    if (rule(lines[i])) continue;                       // garis penutup tanpa judul
    (current ? current.lines : lead).push(lines[i]);
  }
  return { lead, sections };
}

/**
 * Baris lanjutan digabung ke barisnya sendiri.
 *
 * Satu posisi ditulis bot dalam empat baris: judul, nilai, tick, lalu alasan.
 * Di Telegram itu enak dibaca karena lebarnya tetap; di halaman yang bisa
 * selebar apa saja, empat baris menjorok itu jadi tangga yang berantakan dan
 * memaksa scroll ke samping. Digabung jadi satu kalimat, teksnya membungkus
 * sendiri mengikuti lebar layar.
 */
function foldEntries(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && out.length) out[out.length - 1] += ' · ' + line.trim();
    else out.push(line.trim());
  }
  return out;
}

function rowsHtml(lines) {
  return foldEntries(lines)
    .map((l) => `<div class="hb-row ${lineClass(l)}">${esc(l)}</div>`)
    .join('');
}

function reportHtml(text) {
  const { lead, sections } = splitSections(text);
  const head = lead.filter((l) => l.trim());
  const title = head.shift() || '💓 REBORN-RICH HEARTBEAT';
  const uptime = head.find((l) => /Uptime/.test(l)) || '';
  const subs = head.filter((l) => l !== uptime);

  // Baris terakhir laporan adalah ringkasan jadwal, bukan isi bagian mana pun.
  const lastSection = sections[sections.length - 1];
  const tail = lastSection?.lines.filter((l) => l.trim()).slice(-1)[0];
  const foot = tail && /position\(s\) active/.test(tail)
    ? lastSection.lines.splice(lastSection.lines.lastIndexOf(tail), 1)[0]
    : null;

  return `<div class="hb-lead">
      <div class="t">${esc(title)}</div>
      ${subs.map((l) => `<div class="s">${esc(l)}</div>`).join('')}
      ${uptime ? `<div class="u">${esc(uptime.trim())}</div>` : ''}
    </div>`
    + sections.map((sec) => {
      const rows = rowsHtml(sec.lines);
      return rows ? `<div class="hb-sec"><h3>${esc(sec.title)}</h3><div class="hb-body">${rows}</div></div>` : '';
    }).join('')
    + (foot ? `<div class="hb-foot">${esc(foot.trim())}</div>` : '');
}

function renderHeartbeat(hb) {
  const body = $('#hbBody');
  if (!hb?.text) {
    setHTML(body, '<p class="hint">Belum ada laporan. Jalankan <code>scripts/heartbeat.mjs</code>.</p>');
    $('#hbHint').textContent = 'belum ada data';
    return;
  }

  const archive = (hb.archive || []).filter((r) => r?.text).slice(0, 10);

  setHTML(body, reportHtml(hb.text)
    + (archive.length
      ? `<details class="hb-arsip"><summary>Laporan sebelumnya (${archive.length})</summary>`
        + archive.map((r) => `<details class="hb-old"><summary>${esc(r.generatedAt || '—')}</summary>`
            + `<div class="hb-body">${rowsHtml(r.text.split('\n').filter((l) => !/^━+$/.test(l.trim())))}</div>`
            + '</details>').join('')
        + '</details>'
      : ''));

  const when = hb.generatedAt || '—';
  $('#hbHint').textContent = `${when} · diambil ${ago(hb.updatedAt)}`
    + (hb.source === 'rendered' ? ' · disusun ulang di luar proses bot (uptime & mode tidak ikut)' : '');
}

let hbLoaded = false;
let hbLoading = null;

async function refreshHeartbeat({ force = false } = {}) {
  if (hbLoading) return hbLoading;
  if (hbLoaded && !force) return null;
  const epoch = fundEpoch;
  hbLoading = loadHeartbeat(state.cfg)
    .then((hb) => { if (epoch !== fundEpoch) return null; hbLoaded = true; renderHeartbeat(hb); return hb; })
    .catch(() => { if (epoch === fundEpoch) $('#hbHint').textContent = 'laporan tidak bisa diambil'; return null; })
    .finally(() => { if (epoch === fundEpoch) hbLoading = null; });
  return hbLoading;
}

async function loadHeartbeat(cfg) {
  const urls = dataUrls(cfg, 'heartbeat.json', cfg?.app?.heartbeatUrl);
  for (const url of urls) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j?.text) return j;
    } catch { /* coba sumber berikutnya */ }
  }
  return null;
}

/* ── tab ─────────────────────────────────────────────────────────────── */

/** Tab yang dimiliki dana ini; tanpa daftar di funds.json, semuanya. */
function tabsOf(fundId) {
  const listed = fundMeta(fundId)?.tabs;
  return Array.isArray(listed) && listed.length ? listed.filter((t) => TABS.includes(t)) : TABS;
}

function showTab(name) {
  // Dana dengan satu pemilik tidak punya buku investor atau halaman
  // pengenalan; memintanya lewat alamat pun jatuh ke Portofolio.
  const allowed = tabsOf(state.fund);
  const tab = allowed.includes(name) ? name : allowed[0] || 'portfolio';
  currentTab = tab;
  state.view = 'fund';
  $('#tabs').hidden = false;
  $('#tab-analisa').hidden = true;
  $('#tab-safebox').hidden = true;
  $('#tab-update').hidden = true;
  renderFundBar();
  $('#tab-portfolio').hidden = tab !== 'portfolio';
  $('#tab-investor').hidden = tab !== 'investor';
  $('#tab-bot').hidden = tab !== 'bot';
  $('#tab-tentang').hidden = tab !== 'tentang';
  const bot = tab === 'bot';
  document.querySelectorAll('#tabs button').forEach((b) => {
    const t = b.getAttribute('data-tab');
    b.hidden = !allowed.includes(t);
    const on = t === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  // Satu tab saja: barisnya tidak perlu ditampilkan sama sekali.
  $('#tabs').hidden = allowed.length < 2;
  // Alamat selalu memuat nama dananya, supaya link yang dibagikan membuka dana
  // yang dimaksud dan bukan dana bawaan.
  const want = `#${state.fund}/${tab}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  if (bot) refreshHeartbeat();
}

/* ── nilai wallet dari waktu ke waktu ────────────────────────────────────
 *
 * Deret ini dikumpulkan sendiri oleh scripts/sync.mjs, satu titik tiap kali
 * dia jalan. Tidak ada sumber lain yang menyimpannya: chain tahu saldo hari
 * ini, bukan saldo kemarin, dan menghitung ulang nilai posisi LP di ratusan
 * blok yang lewat jauh lebih mahal daripada mencatat angkanya sambil jalan.
 */

const navView = { hours: 24, series: 'wallet' };

/**
 * Layar sempit butuh grafik yang berbeda, bukan grafik yang sama diperkecil.
 *
 * SVG diskalakan mengikuti lebar wadahnya, jadi label 11px pada kanvas 720 unit
 * mendarat sebagai enam piksel di telepon. Tulisannya dibesarkan lewat kelas
 * `small`, dan karena tulisan yang lebih besar butuh ruang lebih, marginnya
 * ikut melebar dan jumlah tanda sumbunya dikurangi — kalau tidak, labelnya
 * saling menimpa.
 */
const narrow = () => (typeof window !== 'undefined' ? (window.innerWidth || 900) : 900) < 640;
let navPoints = [];

async function readNavSeries(cfg, { force = false, fund = state.fund } = {}) {
  const urls = dataUrls(cfg, 'nav.json', cfg?.app?.navUrl, fund);
  for (const url of urls) {
    try {
      const j = await getJSON(url, { fresh: force });
      if (Array.isArray(j.points) && j.points.length) return j.points;
    } catch { /* coba sumber berikutnya */ }
  }
  return [];
}

function renderNavChart() {
  const svg = $('#navChart');
  const small = narrow();
  const W = 720, H = 240, m = { t: 16, r: small ? 72 : 54, b: small ? 38 : 30, l: small ? 104 : 60 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const cut = navView.hours ? Date.now() - navView.hours * 3600e3 : 0;
  const raw = navPoints.filter((p) => p.t >= cut).sort((a, b) => a.t - b.t);
  const share = navView.series === 'share';
  const pts = share ? sharePriceSeries(raw) : raw.map((p) => ({ ...p, v: p.usd }));

  // Harga saham bergerak dalam sen. Dibulatkan ke dolar penuh, grafiknya jadi
  // garis datar yang tidak mengatakan apa pun.
  const fmt = (n) => (share ? usdText(n, 4) : usdText(n, 0));

  const need = 2 - pts.length;
  if (need > 0) {
    $('#navHint').textContent = 'baru mulai mengumpulkan — satu titik tiap 10 menit';
    setHTML(svg, `<text x="${W / 2}" y="${H / 2 - 6}" text-anchor="middle" class="g-lbl">Grafiknya kebentuk setelah beberapa titik terkumpul.</text>`
      + `<text x="${W / 2}" y="${H / 2 + 14}" text-anchor="middle" class="g-lbl">Sekarang ada ${navPoints.length} titik · 6 titik per jam.</text>`);
    return;
  }

  const modal = share ? 1 : (state.ledger ? state.ledger.deposited - state.ledger.withdrawn : 0);
  const vals = pts.map((p) => p.v);
  const span = Math.max(...vals) - Math.min(...vals);
  // Padding harus ikut besaran angkanya. Batas bawah $8 masuk akal untuk nilai
  // wallet yang ribuan dolar, tapi pada harga saham yang bergerak di sekitar
  // $0,95 ia menelan seluruh grafik — sumbunya melar ke minus tujuh dolar dan
  // garisnya jadi datar tak berarti.
  const scale = Math.max(Math.abs(Math.max(...vals)), Math.abs(Math.min(...vals)), 1e-9);
  const padY = Math.max(span * 0.15, scale * 0.004);
  let lo = Math.min(...vals) - padY;
  let hi = Math.max(...vals) + padY;
  if (modal > 0 && modal > lo && modal < hi) { /* garis modal sudah kelihatan */ }
  else if (modal > 0 && Math.abs(modal - (lo + hi) / 2) < span * 3) { lo = Math.min(lo, modal - padY); hi = Math.max(hi, modal + padY); }

  const x = (t) => m.l + ((t - pts[0].t) / ((pts[pts.length - 1].t - pts[0].t) || 1)) * pw;
  const y = (v) => m.t + ((hi - v) / ((hi - lo) || 1)) * ph;

  let grid = '';
  const ySteps = small ? 2 : 3;
  for (let i = 0; i <= ySteps; i += 1) {
    const v = lo + ((hi - lo) / ySteps) * i;
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="g-grid"/>`
      + `<text x="${m.l - 9}" y="${y(v) + 3.5}" text-anchor="end" class="g-lbl">${fmt(v)}</text>`;
  }

  // Garis modal: pembanding yang sebenarnya. Di atas garis = untung.
  let ref = '';
  if (modal > 0 && modal >= lo && modal <= hi) {
    ref = `<line x1="${m.l}" x2="${W - m.r}" y1="${y(modal)}" y2="${y(modal)}" stroke="#8b97a8" stroke-width="1" stroke-dasharray="4 4"/>`
      + `<text x="${W - m.r + 6}" y="${y(modal) + 3.5}" class="g-lbl">${share ? 'awal' : 'modal'}</text>`;
  }

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const up = last.v >= modal;
  const stroke = up ? 'var(--accent)' : 'var(--red)';
  const area = `${line} L${x(last.t).toFixed(1)},${y(lo)} L${x(pts[0].t).toFixed(1)},${y(lo)} Z`;

  const fmtT = (t) => {
    const d = new Date(t + 7 * 3600e3);                       // tampil dalam WIB
    return navView.hours && navView.hours <= 48
      ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
      : `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]}`;
  };

  let ticks = '';
  const xSteps = small ? 2 : 4;
  for (let i = 0; i <= xSteps; i += 1) {
    const t = pts[0].t + ((last.t - pts[0].t) / xSteps) * i;
    const anchor = i === 0 ? 'start' : i === xSteps ? 'end' : 'middle';
    ticks += `<text x="${x(t)}" y="${H - m.b + 18}" text-anchor="${anchor}" class="g-lbl">${fmtT(t)}</text>`;
  }

  svg.setAttribute('class', small ? 'small' : '');
  setHTML(svg, `<defs><linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${up ? '#4ade80' : '#f87171'}" stop-opacity=".22"/>
      <stop offset="100%" stop-color="${up ? '#4ade80' : '#f87171'}" stop-opacity="0"/>
    </linearGradient></defs>`
    + grid + ref
    + `<path d="${area}" fill="url(#navFill)"/>`
    + `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="4.5" fill="${stroke}" stroke="var(--card)" stroke-width="2"/>`
    + `<text x="${x(last.t)}" y="${y(last.v) - 12}" text-anchor="end" class="g-cap">${fmt(last.v)}</text>`
    + ticks
    + `<line id="navCross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" stroke="#3a4552" stroke-width="1" style="display:none"/>`
    + `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" id="navHit"/>`);

  const first = pts[0];
  const delta = last.v - first.v;
  const movePct = first.v ? (delta / first.v) * 100 : 0;
  // SETORAN BUKAN HASIL BOT. Uang masuk menaikkan garis ini seketika, dan
  // tanpa keterangan lompatannya terbaca seperti keuntungan sehari. Garis
  // "Nilai saham" tidak punya masalah itu — setoran membeli unit baru, harganya
  // tidak ikut melompat — jadi pembaca diarahkan ke sana.
  const masuk = (state.cfg?.events || [])
    .filter((e) => e.type === 'deposit')
    .map((e) => ({ at: Number(e.at) || Date.parse(`${e.date}T00:00:00+07:00`), usd: Number(e.usd) || 0 }))
    .filter((e) => e.at >= first.t && e.at <= last.t && e.usd > 0);
  const totalMasuk = masuk.reduce((t, e) => t + e.usd, 0);

  setHTML($('#navHint'), share
    ? `1 saham = ${usd(last.v, 4)} · ${(movePct >= 0 ? '+' : '') + pct(movePct)} di rentang ini`
    : `${pts.length} titik · ${signed(delta)} (${pct(movePct)}) di rentang ini`
      + (totalMasuk > 0 && !share
        ? ` · termasuk ${usd(totalMasuk, 0)} setoran masuk`
        : ''));

  const catatan = $('#navNote');
  if (catatan) {
    catatan.hidden = !(totalMasuk > 0 && !share);
    if (!catatan.hidden) {
      setHTML(catatan, `Lompatan tegak pada garis ini <strong>${usd(totalMasuk, 0)} setoran modal yang masuk</strong>, bukan hasil bot.
        Untuk melihat kinerja bot tanpa pengaruh setoran, pakai <strong>Nilai saham</strong> — setoran membeli unit baru,
        jadi harga per saham tidak ikut melompat.`);
    }
  }

  // crosshair + tooltip
  const wrap = $('#navWrap');
  const tip = $('#navTip');
  const cross = svg.querySelector('#navCross');
  const hit = svg.querySelector('#navHit');
  hit.onmousemove = (ev) => {
    const box = wrap.getBoundingClientRect();
    const ratio = W / (box.width || W);
    const sx = (ev.clientX - box.left) * ratio;
    let near = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - sx) < Math.abs(x(near.t) - sx)) near = p;
    cross.setAttribute('x1', x(near.t));
    cross.setAttribute('x2', x(near.t));
    cross.style.display = '';
    setHTML(tip, `<div class="t-d">${fmtT(near.t)} WIB</div>`
      + `<div class="t-v">${share ? usd(near.v, 4) : usd(near.v)}</div>`
      + (share
        ? `<div class="t-n">nilai wallet ${usd(near.usd, 0)}</div>`
        : `<div class="t-n">${usd(near.usd - (near.lp ?? 0), 0)} token · ${usd(near.lp ?? 0, 0)} LP</div>`));
    tip.hidden = false;
    tip.style.left = (x(near.t) / ratio) + 'px';
    tip.style.top = ((y(near.v) - 10) / ratio) + 'px';
  };
  hit.onmouseleave = () => { tip.hidden = true; cross.style.display = 'none'; };
}


/* ── harga satu saham ────────────────────────────────────────────────────
 *
 * Nilai wallet naik karena bot untung ATAU karena ada orang menyetor. Dua
 * sebab yang sangat berbeda, dan grafik nilai wallet tidak bisa membedakannya:
 * garis yang melompat $1.000 terlihat seperti hari yang hebat padahal cuma ada
 * investor baru masuk. Harga satu unit membagi nilai wallet dengan jumlah unit
 * beredar saat itu, jadi setoran tidak menggerakkannya sama sekali — yang
 * tersisa di grafik itu murni kinerja.
 */
function unitsAt(ts) {
  return (state.ledger?.events || []).reduce(
    // `at` adalah jam transaksi benar-benar mendarat; `date` hanya tanggalnya.
    // Tanpa jam, unit bertambah sejak 00:00 padahal uangnya baru masuk sore —
    // dan harga saham tampak jatuh beberapa jam tanpa sebab.
    (sum, e) => {
      const when = CashoodCore.eventTime(e);
      return sum + (when <= ts ? (Number(e.units) || 0) : 0);
    }, 0);
}

function sharePriceSeries(points) {
  return points
    .map((p) => {
      const units = unitsAt(p.t);
      return units > 0 ? { ...p, v: p.usd / units } : null;
    })
    .filter(Boolean);
}

/* ── dividen ─────────────────────────────────────────────────────────────
 *
 * Aturan dari pengelola, diterapkan apa adanya setiap tanggal 1:
 *
 *   laba kotor   = saldo − modal acuan
 *   laba bersih  = laba kotor − biaya sistem bulan itu
 *   30%          kembali ke dana (menaikkan harga saham)
 *   70%          dibagikan menurut porsi saham
 *   fee investor dipotong dari bagian tiap orang (sekarang 0%)
 *
 * Modal acuan = setoran bersih + seluruh bagian 30% dari pembagian yang sudah
 * dijalankan. Tanpa suku kedua, uang yang diputar lagi bulan lalu akan terbaca
 * sebagai laba baru bulan ini dan dibagikan untuk kedua kalinya.
 */
/**
 * Biaya bulanan yang ditanggung dana ini.
 *
 * Tagihannya dipakai bersama semua dana, dan bagian tiap dana dihitung saat
 * penerbitan menurut ukurannya — angka itu ikut di snapshot. Kalau belum ada,
 * jatuh ke tagihan penuh, karena melaporkan biaya terlalu kecil membuat
 * dividen tampak lebih besar dari yang sebenarnya.
 */
function monthlyCosts() { return CashoodCore.monthlyCosts(state.cfg, state.nav || {}); }
function dividendPlan(navUsd) { return CashoodCore.distribution(state.cfg, state.nav, { nav: navUsd }).plan; }

function nextPayDate(day) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day));
  return `${next.getUTCDate()} ${M_SHORT[next.getUTCMonth()]} ${next.getUTCFullYear()}`;
}

/** Plafon kapasitas: strategi ini punya batas, dan batasnya diumumkan. */
function renderRules() {
  const f = state.cfg?.fund || {};
  const d = state.cfg?.dividend || {};
  const cap = Number(f.capacityUsd) || 0;
  const nav = state.nav?.totalUsd || 0;
  const used = cap > 0 ? (nav / cap) * 100 : 0;

  const fill = $('#capFill');
  fill.style.width = Math.min(100, used).toFixed(1) + '%';
  fill.className = 'meter-fill' + (used >= 100 ? ' over' : used >= 85 ? ' full' : '');

  $('#capHint').textContent = used >= 100 ? 'plafon tercapai' : `${pct(used, 1)} terpakai`;
  setHTML($('#capLegend'), `<span>terisi <b>${usd(nav, 0)}</b></span>`
    + `<span>${used >= 100 ? 'kelebihan ' + usd(nav - cap, 0) : 'ruang tersisa <b>' + usd(cap - nav, 0) + '</b>'}</span>`
    + `<span>plafon <b>${usd(cap, 0)}</b></span>`);
  $('#capNote').textContent = used >= 100
    ? 'Dana sudah penuh. Investor baru masuk dengan membeli saham pemegang lama, bukan dengan setoran baru — supaya ukuran posisi tidak melebihi kedalaman pool.'
    : `Selama masih ada ruang, setoran baru mencetak unit baru. ${f.note || ''}`;

  const costs = monthlyCosts();
  const rules = [
    ['Minimum setoran', usd(Number(f.minDepositUsd) || 0, 0), 'Di bawah ini, biaya gas untuk masuk dan keluar memakan porsi yang terlalu besar dari setorannya sendiri.'],
    ['Plafon dana', usd(cap, 0), 'Bot menaruh $600–900 per posisi mengikuti kedalaman pool. Dana yang terlalu besar memaksa posisi membesar, dan price impact naik untuk semua orang.'],
    ['Masuk & keluar', `${Number(f.noticeHours) || 24} jam`, 'Modal terpasang di posisi likuiditas. Bot perlu waktu menutup posisi di harga yang wajar, bukan panik di harga buruk.'],
    ['Biaya operasional', `${usd(costs, 0)}/bln`, `Dipotong dari dana menurut porsi saham — ${pct(nav ? (costs / nav) * 100 : 0, 2)} dari modal masing-masing per bulan. Tidak ada yang perlu transfer apa pun.`],
    ['Fee investor', Number(d.investorFeePct) > 0 ? d.investorFeePct + '%' : 'GRATIS',
      Number(d.investorFeePct) > 0
        ? 'Dipotong dari bagian dividen tiap investor sebelum dibayarkan.'
        : `Normalnya ${d.investorFeeStandardPct || 10}% dari bagian dividen tiap investor. Selama masa perkenalan tidak dipungut — bagiannya diterima penuh.`],
    ['Dividen', `tiap tanggal ${Number(d.payDayOfMonth) || 1}`,
      Number(d.reinvestPct) > 0
        ? `Laba dikurangi biaya sistem. Dari laba bersihnya ${d.distributePct ?? 70}% dibagikan menurut porsi saham, ${d.reinvestPct}% kembali ke dana dan menaikkan harga saham.`
        : `Uang yang ditarik bot sebulan dikurangi biaya sistem, lalu ${d.distributePct ?? 100}% dibagikan menurut porsi saham — tidak ada bagian yang mengendap.`],
  ];
  setHTML($('#rulesTable').querySelector('tbody'), rules
    .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join(''));
}

/**
 * Laporan pembagian dividen (PDF satu lembar) yang dibuat scripts/statement.mjs.
 * Daftarnya dibaca dari reports/index.json di situs ini sendiri, bukan dari
 * cabang data — laporan dibuat sebulan sekali, bukan tiap sepuluh menit.
 */
let reportsCache = null;
async function renderReports() {
  const card = $('#reportsCard');
  if (!card) return;
  if (!reportsCache) {
    try {
      const r = await fetch('reports/index.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      reportsCache = r.ok ? await r.json() : [];
    } catch { reportsCache = []; }
  }
  const mine = (Array.isArray(reportsCache) ? reportsCache : []).filter((m) => m.fund === state.fund);
  // Tab Invoice selalu ada; dana yang belum punya invoice bilang begitu,
  // bukan menampilkan halaman kosong.
  card.hidden = false;
  if (!mine.length) {
    setHTML($('#reportsList'), '<p class="dim">Belum ada invoice untuk dana ini. Invoice dibuat tiap tanggal 1 saat dividen dibagikan.</p>');
    return;
  }
  setHTML($('#reportsList'), `<div class="table-scroll"><table class="reports"><thead><tr>
      <th>Invoice</th><th>Rencana bayar</th><th>Ditarik</th><th>Biaya</th><th>Dibagikan</th><th></th></tr></thead><tbody>`
    + mine.map((m) => `<tr>
      <td><div>${esc(m.periodLabel)}${m.example ? ' <span class="inv-tag">contoh</span>' : ''}</div><div class="inv-no">${String(m.invoiceNo || '').split('/').join('/<wbr>')}</div></td>
      <td>${esc(m.payLabel)}</td>
      <td class="num">${usd(m.withdrawnUsd, 0)}</td>
      <td class="num neg">−${usd(m.costsUsd, 0)}</td>
      <td class="num pos">${usd(m.distributedUsd, 0)}</td>
      <td class="pdf-actions">
        <a class="btn-pdf" href="${m.pdf}" download="${m.pdf.split('/').pop()}">Download</a>
        <a class="btn-pdf ghost" href="${m.pdf}" target="_blank" rel="noopener">Lihat</a></td></tr>`).join('')
    + '</tbody></table></div>');
}

/**
 * Performa per buku: big cap, mid cap, degen.
 *
 * Ketiganya berbagi satu dompet, jadi tanpa dipisah tidak kelihatan mana yang
 * benar-benar menghasilkan. Win rate-nya memakai definisi yang sama dengan
 * laporan bot: menang dibanding posisi yang bergerak, impas dihitung terpisah.
 */
let bookWindow = 'd30';
function renderBooks() {
  const card = $('#bookCard');
  if (!card) return;
  const all = state.nav?.bookStats || null;
  const win = all?.[bookWindow];
  card.hidden = !win || !win.books?.some((b) => b.closes > 0);
  if (card.hidden) return;

  $('#segBook').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-w') === bookWindow));
  setHTML($('#bookTable').querySelector('tbody'), win.books.map((b) => `<tr>
      <td><span class="who"><span class="chip" style="background:${BOOK_COLOR[b.key] || '#8b95a7'}"></span>${esc(b.label)}</span></td>
      <td class="num">${b.closes}</td>
      <td class="num ${b.winRate == null ? '' : cls(b.winRate - 50)}">${b.winRate == null ? '—' : pct(b.winRate, 1)}</td>
      <td class="num dim">${b.wins} / ${b.losses} / ${b.flat}</td>
      <td class="num ${cls(b.netUsd)}">${signed(b.netUsd)}</td>
      <td class="num ${cls(b.perCloseUsd ?? 0)}">${b.perCloseUsd == null ? '—' : signed(b.perCloseUsd)}</td>
    </tr>`).join(''));

  const total = win.books.reduce((s, b) => s + b.netUsd, 0);
  const closes = win.books.reduce((s, b) => s + b.closes, 0);
  setHTML($('#bookHint'), `${closes} posisi ditutup ${win.label} · hasil gabungan <strong class="${cls(total)}">${signed(total)}</strong>. `
    + 'Win rate dihitung dari posisi yang bergerak; kolom M / K / I adalah menang, kalah, dan impas (±0,5%, termasuk posisi yang harganya tidak pernah menyentuh rentang).');
}

const BOOK_COLOR = { bigcap: '#60a5fa', multi: '#4ade80', degen: '#fbbf24' };

/** Kas cadangan: uang yang sudah dipindah keluar dari wallet kerja bot. */
function renderTreasury() {
  const nav = state.nav || {};
  const cfgT = state.cfg?.treasury || {};
  // Angkanya datang dari snapshot (jumlah transfer yang benar-benar terjadi),
  // bukan dari config — config cuma menyimpan aturannya.
  const moved = Number(nav.treasuryUsd) || 0;
  const step = Number(nav.sweepStepUsd) || Number(cfgT.stepUsd) || 100;
  const fixed = Number(nav.fixedCapitalUsd) || Number(state.cfg?.fund?.fixedCapitalUsd) || 0;
  const used = moved > 0 || fixed > 0;
  $('#treasuryCard').hidden = !used;
  if (!used) return;

  const total = Number(nav.totalUsd) || 0;
  const inBot = Number(nav.botWalletUsd) || Math.max(0, total - moved);
  const due = Number(nav.sweepDueUsd) || 0;
  const above = Math.max(0, inBot - fixed);

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  setHTML($('#treSummary'), [
    tile('Modal kerja bot', usd(fixed, 0), 'dipatok — tidak ikut naik saat dana bertambah'),
    tile('Dipegang bot sekarang', usd(inBot), above > 0 ? `${usd(above)} di atas modal` : 'di bawah atau pas di modal',
      above > 0 ? 'pos' : ''),
    tile('Sudah dipindahkan', usd(moved), Number(nav.treasuryOpeningUsd) > 0
      ? `${nav.treasuryOpeningLabel || 'saldo awal'} ${usd(Number(nav.treasuryOpeningUsd), 0)}`
        + (Number(nav.treasuryNewUsd) > 0 ? ` · new ${usd(Number(nav.treasuryNewUsd), 0)}` : '')
      : `${(nav.treasuryMoves || []).length} transfer ke wallet terpisah`, moved > 0 ? 'pos' : ''),
    tile('Antre keluar', due > 0 ? usd(due, 0) : '—',
      due > 0 ? 'dikirim pada sapuan berikutnya' : `belum genap ${usd(step, 0)}`, due > 0 ? 'pos' : ''),
  ].join(''));

  $('#treHint').textContent = moved > 0
    ? `${usd(moved)} sudah diamankan · ${pct(total ? (moved / total) * 100 : 0, 1)} dari dana`
    : 'belum ada yang dipindahkan';

  // Hari WIB, sama seperti riwayat profit — bukan hari UTC, atau transfer jam
  // 06:00 pagi di sini akan tercatat di tanggal sebelumnya.
  const hariWib = (ms) => new Date(Number(ms) + 7 * 3600e3).toISOString().slice(0, 10);
  const opening = Number(nav.treasuryOpeningUsd) || 0;
  const moves = [...(nav.treasuryMoves || [])].reverse().slice(0, 8);
  setHTML($('#treMoves'), moves.length
    ? `<table class="table tre-moves"><thead><tr><th>Tanggal</th><th>Jumlah</th><th>Aset</th></tr></thead><tbody>`
      + moves.map((m) => `<tr><td>${fmtDay(hariWib(m.at))}</td><td class="pos">${usd(m.usd)}</td><td>${m.asset || 'USDG'}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p class="dim">Belum ada sapuan yang tercatat.</p>');
  if (opening > 0) {
    setHTML($('#treMoves'), `<p class="dim">${esc(nav.treasuryOpeningLabel || 'Saldo awal')} ${usd(opening, 0)}`
      + (Number(nav.treasuryNewUsd) > 0
        ? ` · new ${usd(Number(nav.treasuryNewUsd), 0)} dari ${(nav.treasuryMoves || []).length} sapuan bot`
        : ' · sapuan bot berikutnya ditambahkan sebagai "new"') + '.</p>', true);
  }

  setHTML($('#treRule'), `
    <p><strong>Bot bekerja dengan modal tetap ${usd(fixed, 0)}.</strong> Dana boleh tumbuh melewati
       angka itu, ukuran posisinya tidak. Bot menghitung besar tiap posisi dari ${usd(fixed, 0)},
       bukan dari saldo hari ini — jadi laba tidak otomatis dipertaruhkan lagi.</p>
    <p><strong>Kelebihannya dipindahkan tiap hari, dalam kelipatan ${usd(step, 0)}.</strong>
       Saldo ${usd(fixed + 550, 0)} mengirim ${usd(500, 0)} dan menyisakan ${usd(fixed + 50, 0)};
       sisa ${usd(50, 0)} itu belum genap satu kelipatan, jadi ia menunggu hari berikutnya. Di bawah
       ${usd(fixed, 0)} tidak ada yang keluar sama sekali, sebagus apa pun kemarin.</p>
    <p><strong>Wallet yang dipakai bot menandatangani transaksi ratusan kali sehari.</strong>
       Itu permukaan serangan, dan permukaan serangan tidak boleh menyimpan seluruh dana. Wallet
       tujuannya tidak pernah menandatangani apa pun.</p>
    <p><strong>Uang yang dipindahkan tetap milik dana.</strong> Ia tetap dihitung penuh dalam nilai
       saham — kalau tidak, memindahkannya akan terbaca sebagai kerugian sebesar uang yang
       dipindahkan, dan harga saham semua orang turun karena tindakan yang justru mengamankan uang
       mereka. Porsi kepemilikan tidak berubah sedikit pun.</p>
    <p class="dim">Dividen dan pencairan dibayar dari kas ini, bukan dari posisi yang sedang
       berjalan. Membayar dari posisi berarti membongkarnya di waktu yang belum tentu tepat, dan
       ongkos pembongkaran itu ditanggung semua orang.</p>`);
}

/**
 * Isi halaman pengenalan yang berbeda per dana.
 *
 * Dua bot ini bekerja di rantai, bursa, dan bentuk posisi yang berbeda. Satu
 * teks yang dipakai keduanya akan benar untuk satu dana dan menyesatkan untuk
 * satu lagi — jadi bagian yang menjelaskan cara kerjanya ditulis terpisah.
 */
const FUND_COPY = {
  reborn: {
    lead: 'Reborn Rich menaruh modal sebagai likuiditas di pool Uniswap pada jaringan Robinhood dan memanen fee perdagangan. Yang menjalankannya bot otomatis 24 jam — membuka posisi pada rentang harga tertentu, mengawasinya, dan menutup saat aturannya terpenuhi. Beberapa orang menaruh uang di dana yang sama, dan masing-masing memegang saham sesuai porsinya.',
    how: [
      ['Menyaring pool', 'Bot memindai ratusan pool tiap setengah jam dan menolak yang terlalu kecil, terlalu sepi, atau tidak punya likuiditas yang bisa dimasuki.'],
      ['Membuka posisi', 'Modal ditaruh pada rentang harga tertentu di Uniswap v3 atau v4. Selama harga bergerak di dalam rentang itu, posisi menerima fee dari setiap perdagangan yang lewat.'],
      ['Mengawasi', 'Tiap lima menit tiap posisi diperiksa: masih di dalam rentang, seberapa banyak fee terkumpul, apakah kerugian sudah menyentuh batas.'],
      ['Menutup', 'Ditutup saat untungnya cukup, saat harga keluar rentang dan berhenti menghasilkan, atau saat kerugian menyentuh batas yang sudah ditetapkan.'],
    ],
    risk: 'Pool memecoin di jaringan Robinhood itu dangkal. Likuiditas bisa menguap dalam hitungan menit, dan impermanent loss adalah kejadian harian di sini.',
  },
  meridian: {
    lead: 'Meridian menaruh modal sebagai likuiditas di pool DLMM Meteora pada Solana dan memanen fee perdagangan. Berbeda dengan Uniswap, likuiditas DLMM ditaruh dalam kotak-kotak harga yang disebut bin — posisi hanya menghasilkan saat harga berada di dalam rentang bin yang dipilih. Botnya berjalan otomatis 24 jam, memilih pool, menentukan rentang bin, dan menutup posisi sesuai aturannya.',
    how: [
      ['Menyaring pool', 'Bot memindai pool Meteora dan menilai rasio fee terhadap likuiditas, umur token, volatilitas, serta jejak dompet-dompet besar sebelum memutuskan masuk.'],
      ['Membuka posisi', 'Modal SOL disebar ke rentang bin di sekitar harga berjalan. Strategi penyebarannya dipilih bot — merata, condong ke bawah, atau terpusat — mengikuti bentuk pasarnya.'],
      ['Mengawasi', 'Tiap beberapa menit posisi diperiksa: harga masih di dalam rentang bin, berapa fee terkumpul, seberapa lama di luar rentang, dan apakah kerugiannya menembus batas.'],
      ['Menutup', 'Ditutup saat untungnya cukup, saat harga meninggalkan rentang terlalu lama, atau saat pola rugi berlanjut. Fee yang sudah terkumpul dipanen lebih dulu.'],
    ],
    risk: 'Pool memecoin di Solana bergerak sangat cepat. Harga bisa meninggalkan rentang bin dalam hitungan menit dan posisi berhenti menghasilkan, sementara nilai tokennya ikut turun.',
  },
};

/** Halaman pengenalan — angkanya ikut data hidup, bukan ditulis tangan. */
function renderAbout() {
  const f = state.cfg?.fund || {};
  const d = state.cfg?.dividend || {};
  const nav = state.nav?.totalUsd || 0;
  const units = state.ledger?.totalUnits || 0;
  const perUnit = units > 0 ? nav / units : 0;
  const costs = monthlyCosts();

  const copy = FUND_COPY[state.fund] || FUND_COPY.reborn;
  $('#aboutLead').textContent = copy.lead;
  setHTML($('#aboutHow'), copy.how.map(([title, body], i) => `
    <div class="how-item"><div class="how-n">${i + 1}</div><h3>${title}</h3><p>${body}</p></div>`).join(''));
  $('#aboutTreasury').hidden = !(Number(state.nav?.treasuryUsd) > 0 || Number(state.nav?.fixedCapitalUsd) > 0);

  const big = (v, k, c = '') => `<div class="hero-stat"><div class="hv ${c}">${v}</div><div class="hk">${k}</div></div>`;
  setHTML($('#heroStats'), [
    big(usd(nav, 0), 'dana kelolaan'),
    big(usd(perUnit, 4), 'harga satu saham', perUnit >= 1 ? 'pos' : 'neg'),
    big(String((state.ledger?.owners || []).length), 'pemegang saham'),
    big(String((state.nav?.positions || []).length), 'posisi berjalan'),
  ].join(''));

  setHTML($('#aboutFacts'), [
    ['Harga satu saham', usd(perUnit, 4)],
    ['Unit beredar', num(units, 2)],
    ['Harga saat dibuka', usd(1, 4)],
    ['Sejak dibuka', `${perUnit >= 1 ? '+' : ''}${pct((perUnit - 1) * 100)}`],
  ].map(([k, v]) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`).join(''));

  setHTML($('#aboutRules').querySelector('tbody'), [
    ['Minimum setoran', usd(Number(f.minDepositUsd) || 0, 0)],
    ['Plafon dana', `${usd(Number(f.capacityUsd) || 0, 0)} — di atas itu, investor baru membeli saham pemegang lama`],
    ['Masuk & keluar', `pemberitahuan ${Number(f.noticeHours) || 24} jam`],
    ['Biaya operasional', `${usd(costs, 0)} per bulan, dibagi menurut porsi saham`],
    ['Fee investor', Number(d.investorFeePct) > 0
      ? `${d.investorFeePct}% dari bagian dividen tiap investor`
      : `${d.investorFeeStandardPct || 10}% dari bagian dividen tiap investor — gratis selama masa perkenalan`],
    ['Dividen', Number(d.reinvestPct) > 0
      ? `tiap tanggal ${Number(d.payDayOfMonth) || 1} — laba dikurangi biaya sistem, ${d.distributePct ?? 70}% dibagikan menurut porsi saham, ${d.reinvestPct}% kembali ke dana`
      : `tiap tanggal ${Number(d.payDayOfMonth) || 1} — yang ditarik sebulan dikurangi biaya sistem, ${d.distributePct ?? 100}% dibagikan menurut porsi saham`],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join(''));

  $('#aboutTreHint').textContent = Number(state.nav?.treasuryUsd) > 0
    ? `${usd(Number(state.nav.treasuryUsd))} sudah dipindahkan` : 'belum ada yang dipindahkan';
  const risk2 = document.querySelector('#tab-tentang .risk:nth-child(2) p');
  if (risk2) risk2.textContent = copy.risk;
  setHTML($('#aboutRisk1'), `Harga satu saham hari ini ${usd(perUnit, 4)}, dibanding ${usd(1, 4)} saat dana dibuka — `
    + `${perUnit >= 1 ? 'naik' : 'turun'} ${pct(Math.abs(perUnit - 1) * 100)}. Dana ini pernah turun dan bisa turun lagi.`);
  setHTML($('#aboutRisk3'), `Biaya ${usd(costs, 0)} per bulan atas dana ${usd(nav, 0)} adalah `
    + `${pct(nav ? (costs / nav) * 100 : 0)} sebulan. Bot harus melewati angka itu dulu sebelum ada laba yang bisa dibagi.`);
}

function renderDividend() {
  if (!state.ledger || !state.nav) return;
  const input = $('#divNav');
  const treasury = state.cfg.dividend?.basis === 'treasury';
  input.disabled = treasury;
  if (!input.value || treasury) input.value = state.nav.totalUsd.toFixed(2);
  const { plan, rows } = CashoodCore.distribution(state.cfg, state.nav, { nav: Math.max(0, Number(input.value) || 0) });
  const row = (label, value, note, kind = '') => `<div class="flow-row ${kind}"><div class="fl">${label}<span>${esc(note)}</span></div><div class="fv">${value}</div></div>`;
  setHTML($('#divFlow'), [
    row(treasury ? 'Kas laba tersedia' : 'Kenaikan di atas modal acuan', usd(plan.gross), treasury ? 'kas yang sudah dipindahkan, dikurangi pengeluaran tercatat' : 'modal acuan termasuk reinvestasi dan setoran bersih'),
    row('Biaya sistem', '−' + usd(plan.costs), plan.costsFromFund > 0 ? `${usdText(plan.costsFromFund)} kekurangan biaya perlu dibayar dari dana` : 'biaya periode sebelum pembagian'),
    row('Laba bersih', usd(plan.net), 'setelah biaya', 'sub'),
    row(`Kembali ke dana (${plan.reinvestPct}%)`, usd(plan.reinvest), 'tidak dibayarkan kepada investor'),
    row(`Dibagikan (${plan.distributePct}%)`, usd(plan.distributed), 'hak dihitung menurut lapisan laba', 'sub'),
    row(`Fee investor (${plan.feePct}%)`, usd(plan.fee), plan.feeNote),
    row('Diterima seluruh investor', usd(plan.received), 'jumlah baris penerima cocok sampai sen', 'total'),
  ].join(''));
  setHTML($('#divTable').querySelector('tbody'), rows.map(o => `<tr><td>${esc(o.name)}</td>
    <td class="num">${pct(plan.distributed ? o.gross / plan.distributed * 100 : 0)}</td>
    <td class="num">${usd(o.gross)}</td><td class="num">${usd(o.feeUsd)}</td><td class="num"><strong>${usd(o.netUsd)}</strong></td></tr>`).join(''));
  $('#divHint').textContent = `Simulasi periode ${plan.period} · berikutnya ${nextPayDate(plan.payDay)}`
    + (state.nav.partial || state.nav.lpStale ? ' · data belum layak menjadi dasar pembayaran' : '')
    + ' · belum berarti pembayaran sudah dilakukan';
  setHTML($('#divRule'), `<p>Dasar pembagian dana ini: <strong>${treasury ? 'kas laba tersedia' : 'kenaikan NAV di atas modal acuan'}</strong>.
    Biaya ${usd(plan.costs)} dipotong sebelum ${plan.distributePct}% dibagikan dan ${plan.reinvestPct}% diinvestasikan kembali.
    Fee investor ${plan.feePct}% (standar ${plan.standardFeePct}%). Hak laba lama mengikuti kepemilikan pada lapisan laba tersebut.
    Invoice dan dashboard memakai mesin yang sama. Pembayaran nyata tetap harus dicatat agar kas tidak dihitung ulang.</p>`);
}

/* ── riwayat profit ──────────────────────────────────────────────────────
 *
 * Angka di sini datang dari posisi yang SUDAH ditutup — profit yang terkunci.
 * Untung/rugi posisi yang masih jalan sengaja tidak dicampur: itu masih bisa
 * berubah tiap menit, dan sudah terwakili di "Nilai sekarang" paling atas.
 *
 * Warna hijau/merah cuma penegas. Tandanya dibawa oleh arah batang (naik/turun)
 * dan oleh tanda +/− di angkanya, jadi tetap kebaca kalau matanya susah bedain
 * merah-hijau.
 */

const view = { mode: 'cal', bucket: 'day', rangeDays: 7, month: null };

const D_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const M_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const parseDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDay = (iso) => { const d = parseDay(iso); return `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]}`; };

// Namanya bukan `history` karena itu nama milik browser — fungsi dengan nama
// itu menutupi window.history di seluruh berkas, dan tab bar yang memanggil
// history.replaceState akan mati tanpa suara.
function profitDays() {
  return (state.nav?.history || []).filter((r) => r && r.date);
}

function inRange(rows) {
  if (!view.rangeDays) return rows;
  const cut = Date.now() - view.rangeDays * 86400e3;
  return rows.filter((r) => parseDay(r.date).getTime() >= cut - 86400e3);
}

function bucketize(rows) {
  if (view.bucket === 'day') {
    return rows.map((r) => ({ key: r.date, label: fmtDay(r.date), usd: r.usd, closes: r.closes, days: [r.date] }));
  }
  const out = new Map();
  for (const r of rows) {
    const d = parseDay(r.date);
    let key, label;
    if (view.bucket === 'week') {
      const shift = (d.getUTCDay() + 6) % 7;                 // minggu mulai Senin
      const start = new Date(d.getTime() - shift * 86400e3);
      key = start.toISOString().slice(0, 10);
      label = fmtDay(key);
    } else {
      key = r.date.slice(0, 7);
      label = `${M_SHORT[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    }
    const row = out.get(key) || { key, label, usd: 0, closes: 0, days: [] };
    row.usd += r.usd;
    row.closes += r.closes;
    row.days.push(r.date);
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Batas sumbu yang jatuh di angka bulat, bukan di angka sisa pembagian. */
function niceBounds(lo, hi) {
  const span = (hi - lo) || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / 3)));
  const mult = [1, 2, 2.5, 5, 10].find((m) => span / (step * m) <= 4) ?? 10;
  const s = step * mult;
  return { lo: Math.floor(lo / s) * s, hi: Math.ceil(hi / s) * s, step: s };
}

function renderChart(buckets) {
  const svg = $('#profitChart');
  const small = narrow();
  const W = 720, H = 280, m = { t: 18, r: 16, b: small ? 44 : 36, l: small ? 104 : 60 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  if (!buckets.length) {
    setHTML(svg, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="g-lbl">Belum ada posisi yang ditutup di rentang ini.</text>`);
    return;
  }

  const vals = buckets.map((b) => b.usd);
  const { lo, hi, step } = niceBounds(Math.min(0, ...vals), Math.max(0, ...vals));
  const y = (v) => m.t + ((hi - v) / (hi - lo || 1)) * ph;
  const y0 = y(0);

  // garis bantu
  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const yy = y(v);
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="${Math.abs(v) < 1e-9 ? 'g-zero' : 'g-grid'}"/>`
      + `<text x="${m.l - 9}" y="${yy + 3.5}" text-anchor="end" class="g-lbl">${v === 0 ? '0' : usdText(v, 0)}</text>`;
  }

  // batang: ujung datanya dibulatkan, pangkalnya nempel garis nol
  const slot = pw / buckets.length;
  const gap = Math.min(10, Math.max(2, slot * 0.22));
  const bw = Math.max(3, slot - gap);
  const maxI = vals.indexOf(Math.max(...vals));
  const minI = vals.indexOf(Math.min(...vals));

  let bars = '', hits = '', caps = '';
  buckets.forEach((b, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    const yv = y(b.usd);
    const up = b.usd >= 0;
    const h = Math.abs(yv - y0);
    const r = Math.min(4, bw / 2, h);
    const color = up ? 'var(--accent)' : 'var(--red)';
    const path = up
      ? `M${x},${y0} L${x},${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} L${x + bw - r},${y0 - h} Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r} L${x + bw},${y0} Z`
      : `M${x},${y0} L${x},${y0 + h - r} Q${x},${y0 + h} ${x + r},${y0 + h} L${x + bw - r},${y0 + h} Q${x + bw},${y0 + h} ${x + bw},${y0 + h - r} L${x + bw},${y0} Z`;
    bars += `<path d="${path}" fill="${color}"/>`;

    if ((i === maxI && b.usd > 0) || (i === minI && b.usd < 0)) {
      caps += `<text x="${x + bw / 2}" y="${up ? yv - 7 : yv + 14}" text-anchor="middle" class="g-cap">${signedText(b.usd)}</text>`;
    }

    const every = Math.ceil(buckets.length / (small ? 3 : 8));
    if (i % every === 0 || i === buckets.length - 1) {
      bars += `<text x="${x + bw / 2}" y="${H - m.b + 18}" text-anchor="middle" class="g-lbl">${esc(b.label)}</text>`;
    }

    hits += `<rect x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ph}" fill="transparent" data-i="${i}"/>`;
  });

  svg.setAttribute('class', small ? 'small' : '');
  setHTML(svg, grid + bars + caps + `<g id="hits">${hits}</g>`);

  const wrap = $('#chartWrap');
  const tip = $('#chartTip');
  svg.querySelectorAll('#hits rect').forEach((rect) => {
    rect.onmouseenter = () => {
      const b = buckets[Number(rect.getAttribute('data-i'))];
      const ratio = (wrap.clientWidth || W) / W;
      setHTML(tip, `<div class="t-d">${esc(b.label)}</div>`
        + `<div class="t-v ${cls(b.usd)}">${signed(b.usd)}</div>`
        + `<div class="t-n">${b.closes} posisi ditutup</div>`);
      tip.hidden = false;
      tip.style.left = ((m.l + (Number(rect.getAttribute('data-i')) + 0.5) * slot) * ratio) + 'px';
      tip.style.top = ((Math.min(y(b.usd), y0) - 8) * ratio) + 'px';
    };
    rect.onmouseleave = () => { tip.hidden = true; };
  });
}

function renderCalendar() {
  const rows = profitDays();
  const map = new Map(rows.map((r) => [r.date, r]));
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  if (!view.month || !months.includes(view.month)) view.month = months[months.length - 1] || new Date().toISOString().slice(0, 7);

  const [yy, mm] = view.month.split('-').map(Number);
  const first = new Date(Date.UTC(yy, mm - 1, 1));
  const days = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.usd)));

  $('#calTitle').textContent = `${M_SHORT[mm - 1]} ${yy}`;
  setHTML($('#calDow'), D_SHORT.map((d) => `<span>${d}</span>`).join(''));
  $('#calPrev').disabled = months.indexOf(view.month) <= 0;
  $('#calNext').disabled = months.indexOf(view.month) >= months.length - 1;

  let cells = '';
  for (let i = 0; i < first.getUTCDay(); i += 1) cells += '<div class="cell void"></div>';

  let monthTotal = 0, monthCloses = 0;
  for (let d = 1; d <= days; d += 1) {
    const iso = `${view.month}-${String(d).padStart(2, '0')}`;
    const row = map.get(iso);
    if (!row) { cells += `<div class="cell void"><span class="d">${d}</span></div>`; continue; }
    monthTotal += row.usd;
    monthCloses += row.closes;
    const a = 0.12 + 0.42 * (Math.abs(row.usd) / peak);
    const rgb = row.usd >= 0 ? '74,222,128' : '248,113,113';
    cells += `<div class="cell" style="background:rgba(${rgb},${a.toFixed(3)});border-color:rgba(${rgb},.4)">
      <span class="d">${d}</span>
      <span class="a ${cls(row.usd)}">${narrow() ? signedCompact(row.usd) : signed(row.usd)}</span>
      <span class="c">${row.closes} tutup</span>
    </div>`;
  }

  setHTML($('#calGrid'), cells);
  setHTML($('#calFoot'), `<span>${monthCloses} posisi ditutup bulan ini</span>`
    + `<span>Total <b class="${cls(monthTotal)}">${signed(monthTotal)}</b></span>`);
}

function renderStats() {
  const st = state.nav?.stats;
  const box = $('#profitStats');
  if (!st) { setHTML(box, ''); return; }
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  setHTML(box, [
    tile('Profit terkunci', signed(st.realisedUsd), 'dari posisi yang sudah ditutup', cls(st.realisedUsd)),
    tile('Win rate', st.winRate == null ? '—' : pct(st.winRate, 1), `${st.wins} untung · ${st.losses} rugi`),
    // Dana yang snapshot-nya tidak menyertakan jumlah posisi terbuka dihitung
    // dari daftar posisinya sendiri; sebelumnya barisnya berbunyi "undefined
    // masih jalan".
    tile('Posisi ditutup', String(st.closedCount ?? 0),
      `${st.openCount ?? (state.nav?.positions || []).length} masih jalan`),
    tile('Rata-rata modal', st.avgInvestedUsd == null ? '—' : usd(st.avgInvestedUsd, 0), 'per posisi'),
    st.bestDay
      ? tile('Hari terbaik', signed(st.bestDay.usd), fmtDay(st.bestDay.date), cls(st.bestDay.usd))
      : tile('Hari terbaik', '—', 'belum ada data'),
  ].join(''));
}

let historyRetried = false;

function renderProfit() {
  const rows = profitDays();
  $('#profitCard').hidden = false;

  if (!rows.length) {
    // NAV bisa datang dari cache lama yang belum kenal riwayat profit. Daripada
    // menyuruh orang jalanin script yang sebenarnya sudah jalan, ambil sendiri
    // snapshotnya sekali lalu gambar ulang.
    if (!historyRetried) {
      historyRetried = true;
      const epoch = fundEpoch;
      readSnapshot(state.cfg).then((snap) => {
        if (epoch !== fundEpoch || !state.nav || !snap?.history?.length) return;
        state.nav.history = snap.history;
        state.nav.stats = snap.stats || state.nav.stats;
        try { localStorage.setItem(cacheKey(), JSON.stringify(state.nav)); } catch { /* mode privat */ }
        renderProfit();
      }).catch(() => {});
    }
    $('#profitHint').textContent = 'mengambil riwayat dari snapshot…';
    setHTML($('#profitStats'), '');
    $('#chartWrap').hidden = true;
    $('#profitNote').textContent = '';
    return;
  }

  renderStats();
  const chartOn = view.mode === 'chart';
  $('#chartWrap').hidden = !chartOn;
  $('#calWrap').hidden = chartOn;
  $('#segBucket').hidden = !chartOn;
  $('#segRange').hidden = !chartOn;

  if (chartOn) renderChart(bucketize(inRange(rows)));
  else renderCalendar();

  const st = state.nav?.stats;
  // Dana yang dibaca dari dompet orang lain menyertakan peringatannya sendiri:
  // hasil posisi di sana tidak sama dengan perubahan nilai dananya.
  $('#profitHint').textContent = state.nav?.historyNote
    ? `${rows.length} hari ada transaksi · ${state.nav.historyNote}`
    : `${rows.length} hari ada transaksi · batas hari pakai jam WIB · sumber: buku posisi bot`;
  $('#profitNote').textContent = st
    ? `Yang dihitung di kartu ini cuma profit yang sudah terkunci. Untung/rugi ${st.openCount ?? (state.nav?.positions || []).length} posisi yang masih jalan belum masuk sini — bagian itu sudah ikut di "Nilai sekarang" paling atas.`
    : '';
}

function wireProfitControls() {
  const pick = (sel, attr, fn) => {
    $(sel).onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      $(sel).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      fn(btn.getAttribute(attr));
      renderNavChart();
      renderProfit();
    };
  };
  pick('#segNavRange', 'data-h', (v) => { navView.hours = Number(v); });
  pick('#segView', 'data-v', (v) => { view.mode = v; });
  pick('#segBucket', 'data-b', (v) => { view.bucket = v; });
  pick('#segRange', 'data-r', (v) => { view.rangeDays = Number(v); });

  const hop = (dir) => {
    const months = [...new Set(profitDays().map((r) => r.date.slice(0, 7)))].sort();
    const i = months.indexOf(view.month) + dir;
    if (i >= 0 && i < months.length) { view.month = months[i]; renderCalendar(); }
  };
  $('#calPrev').onclick = () => hop(-1);
  $('#calNext').onclick = () => hop(1);
}

/**
 * Tombol mata uang dibangun dari daftar koin yang diaktifkan di funds.json.
 * Menambah koin baru tidak menyentuh berkas ini selain daftar itu.
 */
function renderCurrencyButtons() {
  const ids = (state.coins || ['eth']).filter((id) => COINS[id]);
  setHTML($('#segCur'), [
    `<button data-c="usd" title="Tampilkan dalam dolar">$</button>`,
    ...ids.map((id) => `<button data-c="${id}" title="Tampilkan dalam ${COINS[id].symbol}" aria-label="${COINS[id].symbol}">${COINS[id].mark}</button>`),
    `<button data-c="idr" title="Tampilkan dalam rupiah">Rp</button>`,
  ].join(''));
  $('#segCur').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-c') === currency));
}

/* ── dana aktif ──────────────────────────────────────────────────────────
 *
 * Berpindah dana berarti mengganti SELURUH isi halaman: config, buku investor,
 * snapshot, deret nilai, laporan bot. Semua keadaan per-dana direset di satu
 * tempat ini — kalau ada yang tertinggal, angka dana lama akan muncul sekejap
 * di bawah nama dana baru, dan itu jenis kesalahan yang tidak disadari orang.
 */
const TABS = ['portfolio', 'investor', 'bot', 'tentang'];
let currentTab = 'portfolio';

function fundMeta(id) {
  return state.funds.find((f) => f.id === id) || state.funds[0] || null;
}

function parseHash() {
  const parts = location.hash.replace('#', '').split('/').filter(Boolean);
  let fund = state.fund || state.funds[0]?.id;
  let tab = 'portfolio';
  if (parts[0] === 'safebox') return { safebox: true, tab: 'portfolio' };
  if (parts[0] === 'update') return { update: true, tab: 'portfolio' };
  if (parts[0] === 'analisa') {
    return { analisa: true, fund: state.funds.some((f) => f.id === parts[1]) ? parts[1] : (state.fund || state.funds[0]?.id), tab: 'portfolio' };
  }
  if (parts.length) {
    if (state.funds.some((f) => f.id === parts[0])) {
      fund = parts[0];
      if (TABS.includes(parts[1])) tab = parts[1];
    } else if (TABS.includes(parts[0])) {
      tab = parts[0];                       // alamat lama tanpa nama dana
    }
  }
  return { fund, tab };
}

function renderFundBar() {
  const analisa = state.view === 'analisa';
  // Dana hanya disorot saat tampilan dana yang sedang dibuka. Versi sebelumnya
  // hanya mengecualikan tampilan analisa, jadi membuka Safe Box menyalakan dua
  // tombol sekaligus: Safe Box dan dana yang terakhir dilihat.
  const diDana = !state.view || state.view === 'fund';
  setHTML($('#fundBar'), state.funds.map((f) => `
    <button data-fund="${f.id}" class="${diDana && f.id === state.fund ? 'on' : ''}" style="--fund-accent:${f.accent}">
      <span class="fdot" style="background:${f.accent}"></span>
      <span class="fmeta"><span class="fname">${esc(f.label)}</span><span class="fchain">${esc(f.chain)}</span></span>
    </button>`).join('')
    + (state.safebox ? `<button data-view="safebox" class="${state.view === 'safebox' ? 'on' : ''}" style="--fund-accent:${state.safebox.accent}">
        <span class="fdot" style="background:${state.safebox.accent}"></span>
        <span class="fmeta"><span class="fname">${state.safebox.label}</span><span class="fchain">${state.safebox.subtitle}</span></span>
      </button>` : '')
    + `<button data-view="analisa" class="analysis ${analisa ? 'on' : ''}" style="--fund-accent:#fbbf24">
        <span class="fdot" style="background:#fbbf24"></span>
        <span class="fmeta"><span class="fname">Portofolio</span></span>
      </button>`
    + `<button data-view="update" class="analysis ${state.view === 'update' ? 'on' : ''}" style="--fund-accent:#38bdf8">
        <span class="fdot" style="background:#38bdf8"></span>
        <span class="fmeta"><span class="fname">Update</span></span>
      </button>`);
}

async function loadFundConfig(id, epoch = fundEpoch) {
  const meta = fundMeta(id);
  if (!meta) throw new Error('daftar dana kosong');
  const cfg = await getJSON(meta.configUrl);
  const ledger = buildLedger(cfg);
  if (epoch !== fundEpoch) return false;
  state.cfg = cfg; state.ledger = ledger; state.fund = meta.id;
  document.title = `${meta.label} — Cashood Headfund`;
  $('#tagline').textContent = cfg.app?.tagline || '';
  $('#addrText').textContent = cfg.wallet?.chainName || meta.chain;
  document.documentElement.style.setProperty('--accent', /^#[0-9a-f]{6}$/i.test(meta.accent) ? meta.accent : '#4ade80');
  setHTML($('#wdOwner'), ledger.owners.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join(''));
  renderFundBar(); return true;
}
async function switchFund(id) {
  if (id === state.fund && state.nav) { showTab(currentTab); return; }
  const epoch = ++fundEpoch; ++loadEpoch;
  tandaiSibuk(1);
  state.nav = null; navPoints = []; hbLoaded = false; hbLoading = null;
  holdPage = 0; historyRetried = false; view.month = null; $('#divNav').value = '';
  try {
    if (!await loadFundConfig(id, epoch)) return;
    showTab(currentTab); await load({ force: true });
  } catch (err) { if (epoch === fundEpoch) banner('Dana tidak bisa dimuat: ' + err.message, 'err'); }
  finally { tandaiSibuk(-1); }
}

/* ── safe box ────────────────────────────────────────────────────────────
 *
 * Satu simpanan, bukan dana bersama: tidak ada pemilik saham, tidak ada
 * dividen. Yang ditampilkan nilai simpanan, bunga yang sudah dihasilkan, dan
 * laju bunganya — diukur dari fee yang benar-benar tercatat, bukan angka tetap.
 */
let safeboxData = null, safeboxAt = 0;
let sbCapital = null;

async function loadSafebox() {
  if (safeboxData && Date.now() - safeboxAt < 60000) return safeboxData;
  const urls = [rawDataBase('safebox') ? rawDataBase('safebox') + 'live.json' : null,
    'https://raw.githubusercontent.com/orelfx/cashood/data/safebox/live.json',
    'data/safebox/live.json'].filter(Boolean);
  for (const url of urls) {
    try {
      const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.valueUsd != null && Number.isFinite(Number(j.valueUsd))) { safeboxData = j; safeboxAt = Date.now(); return j; }
    } catch { /* sumber berikutnya */ }
  }
  return null;
}

function renderSafebox() {
  const body = $('#tab-safebox');
  setHTML(body, '<p class="hint">memuat simpanan…</p>');

  loadSafebox().then((d) => {
    if (state.view !== 'safebox') return;
    if (!d) {
      setHTML(body, '<section class="card"><p class="miss">Data simpanan belum tersedia.</p></section>');
      return;
    }

    const rate = d.measure || {};
    // 0,1% tidak boleh dibulatkan jadi "0%" — itu justru batas bawahnya.
    const pctRate = (v) => pct(v, Number.isInteger(Number(v)) ? 0 : 1);
    // POKOK, bukan saldo. Bunga tidak ikut diputar (aturan pemilik,
    // 2026-09-21): yang bekerja tetap uang pokoknya, bunganya menumpuk di
    // sampingnya. Memakai saldo di sini membuat bunga berbunga diam-diam.
    const modal = sbCapital == null ? d.principalUsd : sbCapital;
    const perDayRate = d.principalUsd > 0 ? rate.perDayUsd / d.principalUsd : 0;

    // Satu kolom saja. Bunga di sini TIDAK diputar lagi: yang menghasilkan
    // tetap pokoknya, dan bunga yang sudah masuk berhenti di tempatnya. Kolom
    // "bunga diputar lagi" yang dulu ada di sini menjanjikan hal yang tidak
    // dilakukan Safe Box.
    const rows = [['1 hari', 1], ['1 minggu', 7], ['1 bulan', 30], ['3 bulan', 90], ['6 bulan', 180], ['1 tahun', 365]]
      .map(([label, days]) => {
        const bunga = modal * perDayRate * days;
        return `<tr>
          <td>${label}</td>
          <td class="num pos">${usd(bunga)}</td>
          <td class="num"><strong>${usd(modal + bunga)}</strong></td>
        </tr>`;
      }).join('');

    setHTML(body, `
      <section class="card">
        <div class="card-head">
          <h2>Safe Box</h2>
          <span class="hint">${esc(d.venue || '')} · diperbarui ${ago(d.updatedAt)}${Date.now()-d.updatedAt > 45*60000 ? ' · data terlambat' : ''}</span>
        </div>
        <div class="sb-head">
          <div class="sb-main">
            <div class="k">Saldo simpanan</div>
            <div class="v">${usd(d.balanceUsd)}</div>
            <div class="n">pokok ${usd(d.principalUsd)} + bunga ${usd(d.interestUsd, 2)}</div>
            <div class="sb-pill"><span class="led ${d.inRange ? 'live' : ''}"></span>${d.inRange ? 'sedang menghasilkan' : 'sedang tidak menghasilkan'}</div>
          </div>
          <div class="stat"><div class="k">Bunga hari ini</div>
            <div class="v pos">${usd(d.interestTodayUsd ?? rate.perDayUsd ?? 0, 2)}</div>
            <div class="n">${d.interestDay ? fmtDay(d.interestDay) : ''} · fee yang masuk hari ini</div></div>
          <div class="stat"><div class="k">Total bunga</div>
            <div class="v pos">${usd(d.interestUsd, 2)}</div>
            <div class="n">${(d.days || []).length || 1} hari tercatat · menumpuk tiap hari</div></div>
          <div class="stat"><div class="k">Bunga per bulan</div>
            <div class="v">${rate.monthlyPct == null ? '—' : pct(rate.monthlyPct)}</div>
            <div class="n">setara ${rate.apyPct == null ? '—' : pct(rate.apyPct)} setahun</div></div>
        </div>
        <p class="hint" style="margin-top:14px">Bunganya <strong>tidak tetap</strong>, tapi selalu di antara
          <strong>${pctRate(rate.minMonthlyPct ?? 0)} dan ${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)} per bulan</strong>.
          Bunga dihitung dari perubahan fee yang teramati, dengan batas bawah dan atas sesuai aturan simpanan.
          ${(d.quality?.feesEstimated || d.quality?.allocationEstimated) ? 'Sebagian penghitungan memakai estimasi; jeda pengamatan dibagi menurut waktu yang berlalu.' : 'Angka hari ini masih dapat bertambah sampai tengah malam WIB.'}
          Riwayat ini adalah pencatatan hak bunga, bukan bukti pembayaran atau jaminan hasil investasi.</p>
      </section>

      ${(d.owners || []).length ? `<section class="card">
        <div class="card-head">
          <h2>Pemilik simpanan</h2>
          <span class="hint">bunga dibagi menurut porsi pokok</span>
        </div>
        <div class="table-scroll"><table>
          <thead><tr><th>Pemilik</th><th class="num">Pokok</th><th class="num">Porsi</th><th class="num">Bunga hari ini</th><th class="num">Total bunga</th><th class="num">Saldo</th></tr></thead>
          <tbody>${d.owners.map((o) => `<tr>
            <td><span class="who"><span class="chip" style="background:${o.color || '#2dd4bf'}"></span>${esc(o.name)}</span></td>
            <td class="num">${usd(o.principalUsd)}</td>
            <td class="num">${pct(o.sharePct)}</td>
            <td class="num pos">${usd(o.interestTodayUsd, 2)}</td>
            <td class="num pos">${usd(o.interestUsd, 2)}</td>
            <td class="num"><strong>${usd(o.balanceUsd)}</strong></td></tr>`).join('')}
            <tr><td><strong>Total</strong></td>
              <td class="num"><strong>${usd(d.principalUsd)}</strong></td>
              <td class="num">100,00%</td>
              <td class="num pos"><strong>${usd(d.interestTodayUsd ?? 0, 2)}</strong></td>
              <td class="num pos"><strong>${usd(d.interestUsd, 2)}</strong></td>
              <td class="num"><strong>${usd(d.balanceUsd)}</strong></td></tr>
          </tbody>
        </table></div>
      </section>` : ''}

      ${(d.days || []).length > 1 ? `<section class="card">
        <div class="card-head">
          <h2>Bunga harian</h2>
          <span class="hint">fee yang masuk tiap hari · total ${usd(d.interestUsd, 2)}</span>
        </div>
        <div class="table-scroll"><table class="daily"><thead><tr><th>Tanggal</th><th class="num">Bunga</th><th class="num">Total berjalan</th></tr></thead><tbody>
          ${(() => { let run = 0; return [...d.days].reverse().map((x) => { return x; }).reverse()
            .map((x) => { run += Number(x.usd) || 0; return { ...x, run }; }).reverse().slice(0, 14)
            .map((x) => `<tr><td>${fmtDay(x.date)}</td><td class="num pos">${usd(x.usd, 2)}</td><td class="num">${usd(x.run, 2)}</td></tr>`).join(''); })()}
        </tbody></table></div>
      </section>` : ''}

      <section class="card">
        <div class="card-head">
          <h2>Apa itu Safe Box</h2>
          <span class="hint">cara kerjanya, apa adanya</span>
        </div>
        <p class="lead">Safe Box bekerja seperti deposito: dana yang masuk dikelola ke berbagai instrumen investasi,
          di dalam maupun di luar Cashood, dan mengembalikan bunga <strong>${pctRate(rate.minMonthlyPct ?? 0)}–${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)} per bulan</strong>
          yang dihitung dan dibayarkan harian.</p>
        <div class="two">
          <div><h3 class="sub-h">Bagaimana bunganya ditentukan</h3><ul class="plain">
            <li>Besarnya mengikuti hasil perdagangan yang benar-benar terjadi hari itu, bukan janji persentase tetap.</li>
            <li>Karena itu bunganya naik-turun: hari yang ramai membayar lebih besar, hari yang sepi lebih kecil.</li>
            <li>Sekecil apa pun hasilnya, bunga tidak pernah di bawah ${pctRate(rate.minMonthlyPct ?? 0)} per bulan, dan sebesar apa pun
                tidak melebihi ${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)} per bulan.</li>
            <li>Bunga yang sudah dicatat pada satu hari tidak pernah ditarik kembali.</li>
            <li><strong>Bunga tidak diputar ulang.</strong> Yang bekerja tetap uang pokok; bunga menumpuk di sampingnya
                dan tidak ikut menghasilkan bunga baru.</li>
          </ul></div>
          <div><h3 class="sub-h">Yang dijamin dan yang tidak</h3><ul class="plain">
            <li><strong>Pokok simpanan dijamin tidak hilang.</strong> Tidak ada margin call, tidak ada likuidasi yang bisa
                menghapus dana di dalam Safe Box.</li>
            <li><strong>Anti rugi, tapi tidak pasti untung.</strong> Pada bulan yang buruk bunganya bisa mendekati nol —
                yang tidak terjadi adalah saldonya berkurang.</li>
            <li>Ke instrumen mana dana ini ditempatkan bersifat rahasia dan menjadi kewenangan pengelola.</li>
            <li>Bunga dan saldo di halaman ini dihitung ulang setiap hari dari catatan yang sama; tidak ada angka
                yang ditulis tangan.</li>
          </ul></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Kalau laju bunganya bertahan</h2>
          <span class="hint">hitungan lurus dari laju hari ini, bukan proyeksi pasar</span>
        </div>
        <div class="calc">
          <label class="field">
            <span>Andai modalnya (USD)</span>
            <input type="number" id="sbCapital" min="0" step="any" value="${modal.toFixed(2)}">
          </label>
          <div class="field quick">
            <span>Isi cepat</span>
            <div class="seg" id="sbQuick"><button data-v="now">simpanan sekarang</button><button data-v="1000">$1.000</button><button data-v="10000">$10.000</button></div>
          </div>
        </div>
        <div class="table-scroll"><table>
          <thead><tr><th>Jangka</th><th class="num">Bunga terkumpul</th><th class="num">Pokok + bunga</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="hint disclaimer">Tabel ini mengalikan laju bunga hari ini ke depan — bukan ramalan. Laju itu naik
          dan turun mengikuti perdagangan di pool. <strong>Bunganya tidak diputar lagi:</strong> yang menghasilkan
          tetap uang pokok, dan bunga yang sudah masuk berhenti di tempatnya — pokok ${usd(modal, 0)} yang sudah
          berbunga ${usd(100, 0)} tetap bekerja dengan ${usd(modal, 0)}, bukan ${usd(modal + 100, 0)}.</p>
      </section>`);

    $('#sbCapital').oninput = (e) => {
      sbCapital = Math.max(0, Number(e.target.value) || 0);
      const keep = e.target.value;
      renderSafebox();
      setTimeout(() => { const el = $('#sbCapital'); if (el) { el.value = keep; el.focus(); } }, 0);
    };
    $('#sbQuick').onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const v = btn.getAttribute('data-v');
      sbCapital = v === 'now' ? d.balanceUsd : Number(v);
      renderSafebox();
    };
  });
}

function showSafebox() {
  state.view = 'safebox';
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'bot', 'tentang'].forEach((t) => { $('#tab-' + t).hidden = true; });
  $('#tab-analisa').hidden = true;
  $('#tab-update').hidden = true;
  $('#tab-safebox').hidden = false;
  renderFundBar();
  if (location.hash !== '#safebox') history.replaceState(null, '', '#safebox');
  renderSafebox();
}

/* ── analisa: proyeksi sampai tanggal pembagian ──────────────────────────
 *
 * Angkanya tidak dihitung di halaman ini. Semuanya datang dari
 * data/<dana>/forecast.json yang ditulis sekali sehari oleh scripts/forecast.mjs,
 * supaya siapa pun bisa membuka berkasnya dan menghitung ulang sendiri.
 */
let analisaFund = null;
const forecastCache = {};

async function loadForecast(fund) {
  if (forecastCache[fund] && Date.now() - forecastCache[fund].loadedAt < 60000) return forecastCache[fund].data;
  const base = rawDataBase(fund);
  const urls = [base ? base + 'forecast.json' : null,
    `https://raw.githubusercontent.com/orelfx/cashood/data/${fund}/forecast.json`,
    `data/${fund}/forecast.json`].filter(Boolean);
  for (const url of urls) {
    try {
      const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.fund === fund) { forecastCache[fund] = { data: j, loadedAt: Date.now() }; return j; }
    } catch { /* sumber berikutnya */ }
  }
  return null;
}

function scenarioCard(s, kind) {
  const naik = s.changeUsd >= 0;
  return `<div class="scen-card ${kind}">
    <div class="scen-k">${s.label}</div>
    <div class="scen-v ${cls(s.changeUsd)}">${usd(s.navUsd, 0)}</div>
    <div class="scen-d ${cls(s.changeUsd)}">${naik ? '+' : ''}${usd(s.changeUsd, 0)} · ${naik ? '+' : ''}${pct(s.changePct)}</div>
    <div class="scen-rows">
      <div class="scen-row"><span>Harga saham</span><b>${s.sharePrice == null ? '—' : usd(s.sharePrice, 4)}</b></div>
      <div class="scen-row"><span>Laba di atas modal</span><b>${usd(s.dividend.gross, 0)}</b></div>
      <div class="scen-row"><span>Dividen dibagikan</span><b class="${s.dividend.distributed > 0 ? 'pos' : ''}">${usd(s.dividend.distributed, 0)}</b></div>
    </div>
  </div>`;
}

function renderAnalisa() {
  const body = $('#analisaBody');
  const fund = analisaFund || state.fund;
  const available = state.funds.filter(f => f.forecast !== false);
  setHTML($('#segAnalisa'), available.map(f => `<button data-af="${esc(f.id)}" class="${f.id === fund ? 'on' : ''}">${esc(f.label)}</button>`).join(''));
  setHTML(body, '<p class="hint">memuat analisa…</p>');
  loadForecast(fund).then(f => {
    if (analisaFund !== fund || state.view !== 'analisa') return;
    if (!f || !f.enough) {
      setHTML(body, `<section class="card"><h2>Belum cukup data terverifikasi</h2><p>${esc(f?.reason || 'Analisa belum tersedia.')}</p>
        <p class="hint">${Number(f?.samples || 0)} hari memenuhi syarat. Proyeksi memerlukan sedikitnya tujuh hari selesai; setoran, penarikan, dan pembayaran harus tercatat.</p></section>`);
      return;
    }
    const riskPct = v => v === 0 ? '0% dalam simulasi' : pct(v, 3);
    setHTML(body, `<section class="card"><div class="card-head"><h2>${esc(fundMeta(fund)?.label)} · proyeksi</h2><span class="hint">${esc(f.generatedAt)}</span></div>
      <p>Nilai dana sekarang ${usd(f.navNow)} · harga saham ${usd(f.sharePriceNow, 4)}. Sampel ${f.sample.days} hari selesai, ${esc(f.sample.from)} sampai ${esc(f.sample.to)}.</p>
      <div class="stats three">${[f.scenarios.worst,f.scenarios.normal,f.scenarios.best].map(q=>`<div class="stat"><div class="k">${esc(q.label)}</div><div class="v">${usd(q.totalUsd)}</div><div class="n">total aset + dividen diterima pada ${esc(f.paydayDate)}</div></div>`).join('')}</div></section>
      <section class="card"><h2>Nilai dana dan pembayaran</h2><div class="table-scroll"><table><thead><tr><th>Jangka</th><th>Total P10</th><th>Total median</th><th>Total P90</th><th>Dana median</th><th>Dividen median</th></tr></thead><tbody>
      ${f.horizons.map(h=>`<tr><td>${esc(h.label)}${h.speculative?' · spekulatif':''}</td><td>${usd(h.worst.totalUsd)}</td><td>${usd(h.normal.totalUsd)}</td><td>${usd(h.best.totalUsd)}</td><td>${usd(h.normal.navUsd)}</td><td>${usd(h.normal.dividendsUsd)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint">Setiap skenario memakai komponen dari satu lintasan yang sama. Total mencakup dana, kas cadangan, dan dividen diterima. Kas tidak dihitung dua kali. P10/P90 bukan batas kerugian atau keuntungan.</p></section>
      <section class="card"><h2>Frekuensi penurunan total aset dalam simulasi</h2><div class="table-scroll"><table><thead><tr><th>Jangka</th><th>Turun 10%</th><th>Turun 50%</th><th>Turun 90%</th></tr></thead><tbody>
      ${f.horizons.map(h=>`<tr><td>${esc(h.label)}</td><td>${riskPct(h.risk.p10)}</td><td>${riskPct(h.risk.p50)}</td><td>${riskPct(h.risk.p90)}</td></tr>`).join('')}</tbody></table></div>
      <p>0% berarti kejadian tidak muncul dalam lintasan yang diundi. Itu bukan jaminan kejadian tersebut mustahil. Sapuan dan pembayaran dividen tidak dianggap uang hilang.</p></section>
      <section class="card"><h2>Batas analisa</h2><ul>${f.caveats.map(c=>`<li>${esc(c)}</li>`).join('')}</ul><p class="hint">${esc(f.method)}</p></section>`);
  }).catch(err => { if (analisaFund === fund) setHTML(body, `<p class="miss">Analisa tidak bisa ditampilkan: ${esc(err.message)}</p>`); });
}

/**
 * Ringkasan seluruh dana, di atas prediksi.
 *
 * Tiap dana punya halamannya sendiri, dan sampai sekarang tidak ada satu pun
 * tempat yang menjawab "totalnya berapa, siapa saja yang pegang". Ini
 * tempatnya: satu kartu, seluruh dana, plus Safe Box.
 */
const portoCache = new Map();
async function loadFundBrief(id) {
  if (portoCache.has(id) && Date.now() - portoCache.get(id).at < 60000) return portoCache.get(id).job;
  const job = (async () => {
    const meta = fundMeta(id);
    const [cfg, snap] = await Promise.all([
      getJSON(meta?.configUrl || `data/${id}/config.json`),
      getJSON(meta?.configUrl || `data/${id}/config.json`).then(cfg => readSnapshot(cfg, { fund: id })),
    ]);
    const ledger = buildLedger(cfg);
    const total = Number(snap?.totalUsd) || 0;
    const unit = ledger.totalUnits > 0 ? total / ledger.totalUnits : 0;
    return {
      id,
      label: meta?.label || id,
      chain: meta?.chain || '',
      accent: meta?.accent || '#8b95a7',
      totalUsd: total,
      depositedUsd: ledger.deposited,
      pnlUsd: total + ledger.withdrawn - ledger.deposited,
      updatedAt: Number(snap?.updatedAt) || null,
      owners: ledger.owners.filter((o) => o.units > 0)
        .map((o) => ({ name: o.name, color: o.color, share: (o.units / ledger.totalUnits) * 100, value: o.units * unit }))
        .sort((a, b) => b.share - a.share),
    };
  })();
  portoCache.set(id, { job, at: Date.now() });
  job.catch(() => portoCache.delete(id));
  return job;
}

async function renderPortofolio() {
  const card = $('#portoCard');
  if (!card) return;
  const ids = (state.funds || []).map((f) => f.id);
  const loaded = await Promise.all(ids.map(id => loadFundBrief(id).catch(() => null)));
  const missing = ids.filter((id, i) => !loaded[i]);
  const briefs = loaded.filter(Boolean);
  const box = state.safebox ? await loadSafebox().catch(() => null) : null;

  const dana = briefs.reduce((s, b) => s + b.totalUsd, 0);
  const simpanan = Number(box?.balanceUsd) || 0;
  // Safe Box ikut dihitung sebagai modal dan laba pemiliknya: pokoknya uang
  // yang disetor, bunganya laba yang sudah jadi. Tanpa ini, "total aset"
  // memuat Safe Box tapi "modal masuk" dan "untung" tidak — tiga angka yang
  // tidak bisa dijumlahkan satu sama lain.
  const pokokBox = Number(box?.principalUsd) || 0;
  const bungaBox = Number(box?.interestUsd) || 0;
  const setoran = briefs.reduce((s, b) => s + b.depositedUsd, 0) + pokokBox;
  const untung = briefs.reduce((s, b) => s + b.pnlUsd, 0) + bungaBox;
  const orang = new Set(briefs.flatMap((b) => b.owners.map((o) => o.name))).size;

  // Safe Box milik pemilik dana; namanya diambil dari pemegang saham terbesar
  // supaya tidak ada nama yang ditulis tangan di kode.
  const pemilikBox = briefs.flatMap((b) => b.owners).sort((a, b) => b.value - a.value)[0]?.name || 'Pemilik';

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  setHTML($('#portoTotals'), [
    tile(missing.length || (state.safebox && !box) ? 'Total aset terbaca (parsial)' : 'Total seluruh aset', usd(dana + simpanan, 0),
      simpanan > 0 ? `${usd(dana, 0)} dana + ${usd(simpanan, 0)} Safe Box` : `${briefs.length} dana berjalan`),
    tile('Modal masuk', usd(setoran, 0), `${orang} pemegang saham${pokokBox > 0 ? ` · termasuk ${usd(pokokBox, 0)} Safe Box` : ''}`),
    tile('Untung / rugi', signed(untung), setoran ? pct((untung / setoran) * 100) + ' dari modal' : '—', cls(untung)),
  ].join(''));
  $('#portoHint').textContent = `${briefs.length} dana${box ? ' + Safe Box' : ''}${missing.length ? ' · gagal: ' + missing.join(', ') : ''} · sumber tertua ${ago(Math.min(...briefs.map((b) => b.updatedAt || 0), ...(box ? [box.updatedAt || 0] : [])))}`;

  setHTML($('#portoList'), briefs.map((b) => `
    <div class="porto-fund">
      <div class="porto-head">
        <span class="who"><span class="chip" style="background:${b.accent}"></span><strong>${esc(b.label)}</strong>
          <span class="dim">${b.chain}</span></span>
        <span class="porto-val">${usd(b.totalUsd)}<span class="n ${cls(b.pnlUsd)}">${signed(b.pnlUsd)}</span></span>
      </div>
      <div class="table-scroll"><table class="porto-tbl"><tbody>
        ${b.owners.map((o) => `<tr>
          <td><span class="who"><span class="chip" style="background:${o.color || '#4ade80'}"></span>${esc(o.name)}</span></td>
          <td class="num">${pct(o.share)}</td>
          <td class="num">${usd(o.value)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`).join('')
    + (box ? `<div class="porto-fund">
      <div class="porto-head">
        <span class="who"><span class="chip" style="background:${state.safebox?.accent || '#2dd4bf'}"></span><strong>${state.safebox?.label || 'Safe Box'}</strong>
          <span class="dim">simpanan</span></span>
        <span class="porto-val">${usd(box.balanceUsd)}<span class="n pos">+${usd(box.interestUsd, 2)}</span></span>
      </div>
      <div class="table-scroll"><table class="porto-tbl"><tbody>
        ${(box.owners || []).map(o => `<tr><td>${esc(o.name)}</td><td class="num">${pct(o.sharePct)}</td><td class="num">${usd(o.balanceUsd)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="dim" style="margin:6px 0 0">Bunga hari ini ${usd(box.interestTodayUsd ?? 0, 2)} · ${box.measure?.monthlyPct == null ? '—' : pct(box.measure.monthlyPct)} per bulan.</p>
    </div>` : ''));
}

/**
 * Catatan pembaruan.
 *
 * Ditulis tangan di data/updates.json — bukan diturunkan dari riwayat commit.
 * Yang penting bagi pembaca bukan berkas apa yang berubah, melainkan apa yang
 * berbeda bagi uangnya.
 */
let updateFilter = 'semua';
let updatesCache = null;
const UPDATE_TYPE = {
  fitur: { label: 'fitur', color: '#4ade80' },
  perbaikan: { label: 'perbaikan', color: '#fbbf24' },
  sistem: { label: 'sistem', color: '#60a5fa' },
  data: { label: 'data', color: '#a78bfa' },
  keamanan: { label: 'keamanan', color: '#f87171' },
};

async function renderUpdates() {
  const list = $('#updateList');
  if (!list) return;
  if (!updatesCache) {
    try { updatesCache = (await getJSON('data/updates.json')).updates || []; }
    catch { updatesCache = []; }
  }
  const semua = [...updatesCache].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!semua.length) {
    setHTML(list, '<p class="miss">Belum ada catatan pembaruan.</p>');
    return;
  }

  const jenis = [...new Set(semua.map((u) => u.type))];
  setHTML($('#segUpdate'), ['semua', ...jenis]
    .map((t) => `<button data-u="${t}" class="${t === updateFilter ? 'on' : ''}">${t}</button>`).join(''));

  const tampil = updateFilter === 'semua' ? semua : semua.filter((u) => u.type === updateFilter);
  $('#updateHint').textContent = `${tampil.length} catatan · terbaru ${fmtDay(semua[0].date)}`;

  // Dikelompokkan per tanggal: orang membaca "apa yang berubah hari itu",
  // bukan daftar panjang yang tanggalnya berulang-ulang.
  const perHari = new Map();
  for (const u of tampil) {
    if (!perHari.has(u.date)) perHari.set(u.date, []);
    perHari.get(u.date).push(u);
  }

  setHTML(list, [...perHari.entries()].map(([tanggal, isi]) => `
    <div class="upd-day">
      <div class="upd-date">${fmtDay(tanggal)} ${String(tanggal).slice(0, 4)}</div>
      ${isi.map((u) => {
        const t = UPDATE_TYPE[u.type] || { label: u.type || 'lainnya', color: '#8b95a7' };
        return `<article class="upd">
          <div class="upd-head">
            <span class="upd-tag" style="--tag:${t.color}">${t.label}</span>
            <span class="upd-sys">${u.system || ''}</span>
          </div>
          <h3 class="upd-title">${u.title || ''}</h3>
          ${u.detail ? `<p class="upd-detail">${u.detail}</p>` : ''}
        </article>`;
      }).join('')}
    </div>`).join(''));
}

function showUpdate() {
  state.view = 'update';
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'bot', 'tentang'].forEach((t) => { $('#tab-' + t).hidden = true; });
  $('#tab-safebox').hidden = true;
  $('#tab-analisa').hidden = true;
  $('#tab-update').hidden = false;
  renderFundBar();
  if (location.hash !== '#update') history.replaceState(null, '', '#update');
  renderUpdates();
}

function showAnalisa(fund) {
  state.view = 'analisa';
  analisaFund = fund || analisaFund || state.funds[0]?.id;
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'bot', 'tentang'].forEach((t) => { $('#tab-' + t).hidden = true; });
  $('#tab-safebox').hidden = true;
  $('#tab-update').hidden = true;
  $('#tab-analisa').hidden = false;
  renderFundBar();
  renderPortofolio().catch(() => { const c = $('#portoCard'); if (c) c.hidden = true; });
  const want = `#analisa/${analisaFund}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  renderAnalisa();
}

/* ── boot ────────────────────────────────────────────────────────────── */

function renderAll() {
  const rows = ownerValues(state.ledger, state.nav.totalUsd);
  hideEmptyCards(state.nav);
  renderSummary(state.ledger, state.nav);
  renderDonut(rows);
  renderOwners(rows);
  renderHoldings(state.nav);
  renderLp(state.nav);
  renderClosed(state.nav);
  renderCosts(state.cfg);
  renderDividend();
  renderRules();
  renderTreasury();
  renderBooks();
  renderReports();
  renderAbout();
  renderNavChart();
  renderProfit();
  renderHistory(state.ledger);
  renderCalc();
}

async function load({ force = false } = {}) {
  const fund = state.fund, epoch = fundEpoch, request = ++loadEpoch;
  const valid = () => fund === state.fund && epoch === fundEpoch && request === loadEpoch;
  const btn = $('#refreshBtn'); btn.disabled = true; btn.textContent = 'memuat…';
  if (force) { portoCache.clear(); safeboxData = null; for (const k of Object.keys(forecastCache)) delete forecastCache[k]; reportsCache = null; updatesCache = null; }
  try {
    let cfg = state.cfg;
    if (force) {
      cfg = await getJSON(fundMeta(fund).configUrl, { fresh: true });
      const ledger = buildLedger(cfg); if (!valid()) return;
      state.cfg = cfg; state.ledger = ledger;
    }
    const seriesJob = readNavSeries(cfg, { force, fund });
    fxRates().then(() => { if (valid() && state.nav) renderVisible(); }).catch(() => {});
    const nav = await resolveNav(cfg, { force, fund });
    if (!valid()) return;
    state.nav = nav;
    if (!lastUsdIdr && nav.usdIdr > 0) lastUsdIdr = nav.usdIdr;
    const msgs = [...state.ledger.warnings];
    if (nav.partial) msgs.push('Data belum lengkap atau belum terverifikasi. Jangan gunakan sebagai dasar transaksi.');
    if (nav.lpStale) msgs.push(`Snapshot sumber sudah ${ago(nav.updatedAt)}. Semua saldo memakai snapshot, bukan saldo live.`);
    banner(msgs.join(' · ')); renderVisible();
    seriesJob.then(series => { if (valid()) { navPoints = series; if (state.view === 'fund') renderNavChart(); } });
    if (hbLoaded) refreshHeartbeat({ force });
  } catch (err) { if (valid()) banner('Gagal ambil data: ' + err.message, 'err'); }
  finally { if (valid()) { btn.disabled = false; btn.textContent = 'refresh'; } }
}
function renderVisible() {
  if (state.view === 'safebox') renderSafebox();
  else if (state.view === 'analisa') { renderPortofolio().catch(() => {}); renderAnalisa(); }
  else if (state.view === 'update') renderUpdates();
  else if (state.nav && state.ledger) renderAll();
}

async function init() {
  try {
    const list = await getJSON(FUNDS_URL);
    state.funds = list.funds || [];
    state.coins = list.coins || ['eth'];
    state.safebox = list.safebox || null;
    if (!state.funds.length) throw new Error('daftar dana kosong');
    await loadFundConfig(parseHash().fund || list.active || state.funds[0].id);
  } catch (err) {
    banner('daftar dana tidak terbaca: ' + (err.message || err), 'err');
    return;
  }

  $('#fundBar').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const view = btn.getAttribute('data-view');
    if (view === 'analisa') { showAnalisa(); return; }
    if (view === 'safebox') { showSafebox(); return; }
    if (view === 'update') { showUpdate(); return; }
    const id = btn.getAttribute('data-fund');
    if (state.view === 'analisa' && id === state.fund) { showTab(currentTab); return; }
    switchFund(id);
  };

  $('#segUpdate').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    updateFilter = btn.getAttribute('data-u');
    renderUpdates();
  };

  $('#segAnalisa').onclick = (e) => {
    const btn = e.target.closest('button');
    if (btn) showAnalisa(btn.getAttribute('data-af'));
  };

  $('#refreshBtn').onclick = () => load({ force: true });
  wireProfitControls();

  $('#holdPager').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    holdPage = Number(btn.getAttribute('data-p')) || 0;
    renderHoldings(state.nav);
  };

  renderCurrencyButtons();
  $('#segCur').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    // Daftar mata uang dibaca dari tombolnya sendiri. Versi sebelumnya menulis
    // ulang daftar itu di sini — "eth atau usd" — jadi tombol rupiah menyala
    // tapi angkanya tetap dolar, dan tidak ada yang error untuk menandainya.
    const want = btn.getAttribute('data-c');
    currency = (want === 'idr' || want in COINS) ? want : 'usd';
    try { localStorage.setItem('cashood.currency', currency); } catch { /* mode privat */ }
    $('#segCur').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    // Tampilan analisa digambar terpisah dan tidak ikut renderAll; tanpa baris
    // ini angkanya tetap dolar setelah tombol rupiah ditekan.
    if (state.view === 'analisa') { renderPortofolio().catch(() => {}); renderAnalisa(); }
    else if (state.view === 'safebox') renderSafebox();
    else if (state.view === 'update') renderUpdates();
    else if (state.nav) renderAll();
  };
  $('#segCur').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-c') === currency));

  $('#tabs').onclick = (e) => {
    const btn = e.target.closest('button');
    if (btn) showTab(btn.getAttribute('data-tab'));
  };
  const fromHash = () => {
    const route = parseHash();
    if (route.safebox) { showSafebox(); return; }
    if (route.update) { showUpdate(); return; }
    if (route.analisa) { showAnalisa(route.fund); return; }
    if (route.fund && route.fund !== state.fund) { switchFund(route.fund).then(() => showTab(route.tab)); return; }
    showTab(route.tab);
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();

  $('#segBook').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    bookWindow = btn.getAttribute('data-w');
    renderBooks();
  };

  // sub-bagian di dalam tab investor
  $('#segInv').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const want = btn.getAttribute('data-i');
    $('#segInv').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('[data-inv]').forEach((el) => { el.hidden = el.getAttribute('data-inv') !== want; });
  };

  // dua deret di kartu nilai
  $('#segSeries').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    navView.series = btn.getAttribute('data-s') === 'share' ? 'share' : 'wallet';
    $('#segSeries').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderNavChart();
  };

  $('#divNav').oninput = renderDividend;
  $('#divQuick').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const v = btn.getAttribute('data-v');
    $('#divNav').value = v === 'now' ? (state.nav?.totalUsd || 0).toFixed(2) : v;
    renderDividend();
  };

  // Memutar telepon mengubah lebar, dan grafik yang digambar untuk lebar lama
  // ikut terbawa — marginnya kelebaran atau labelnya bertumpuk.
  let resizeTimer = null;
  let lastNarrow = narrow();
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (narrow() === lastNarrow) return;
      lastNarrow = narrow();
      if (state.nav) { renderNavChart(); renderProfit(); }
    }, 200);
  });
  $('#wdAmount').oninput = renderCalc;
  $('#wdMode').onchange = renderCalc;
  $('#wdOwner').onchange = renderCalc;

  await load();

  // auto-refresh diam-diam selama tab dibiarkan terbuka
  const every = (Number(state.cfg?.app?.refreshMinutes) || 5) * 60000;
  setInterval(() => { if (!document.hidden) load({ force: true }); }, every);
}

// Diekspos untuk debugging di console browser (dan untuk tes di node).
globalThis.cashood = { state, buildLedger, ownerValues, load, renderProfitProbe: renderProfit };

if (typeof document !== 'undefined') init();
