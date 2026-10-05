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
// Hasil yang baru saja diunduh dipakai ulang selama 20 detik. Tanpa ini, berkas
// yang sama diunduh dua kali dalam satu pemuatan halaman: sekali oleh prefetch,
// sekali lagi oleh bagian yang menggambarnya begitu prefetch selesai.
const recentJSON = new Map();
const RECENT_MS = 20000;
function getJSON(url, { fresh = false } = {}) {
  if (!fresh) {
    if (inflight.has(url)) return inflight.get(url);
    const hit = recentJSON.get(url);
    if (hit && Date.now() - hit.at < RECENT_MS) return Promise.resolve(hit.data);
  }
  const full = url + (url.includes('?') ? '&' : '?') + 't=' + (fresh ? Date.now() : BOOT_T);
  tandaiSibuk(1);
  const job = fetch(full, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) }).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then((data) => { recentJSON.set(url, { at: Date.now(), data }); return data; })
    .finally(() => { tandaiSibuk(-1); if (inflight.get(url) === job) inflight.delete(url); });
  if (!fresh) inflight.set(url, job);
  return job;
}

// Ditembak sekarang, dipungut nanti. Kegagalan di sini tidak boleh jadi
// unhandled rejection: yang memungut akan mencoba lagi lewat jalur normal.
(() => {
  try {
    const quiet = (pr) => { pr.catch(() => {}); return pr; };
    const first = (location.hash || '').replace(/^#/, '').split('/')[0];
    const global = ['', 'home', 'kinerja', 'pemegang', 'analisa'].includes(first);
    quiet(getJSON(FUNDS_URL).then((list) => {
      // Halaman ringkasan (beranda dll.) butuh SEMUA dana. Begitu daftarnya
      // tiba, config + snapshot + deret tiap dana diminta sekaligus — bukan
      // menunggu giliran saat bagian masing-masing mulai digambar.
      if (!global) return;
      for (const f of list.funds || []) {
        quiet(getJSON(f.configUrl).then((cfg) => {
          quiet(getJSON(dataUrls(cfg, 'live.json', cfg?.app?.snapshotUrl, f.id)[0]));
          if (!f.paper || first === '' || first === 'home') quiet(getJSON(dataUrls(cfg, 'nav.json', cfg?.app?.navUrl, f.id)[0]));
        }));
      }
      if (list.safebox?.configUrl) quiet(getJSON(list.safebox.configUrl));
      if (list.safebox) quiet(getJSON(RAW_BASE + 'safebox/live.json'));
      if (list.index) quiet(getJSON(RAW_BASE + 'index/live.json'));
    }));
    const guess = first || 'reborn';
    const fund = ['reborn', 'meridian', 'ferari', 'robsol', 'charon', 'forex', 'binance', 'dgrh', 'dgsol', 'snh'].includes(guess) ? guess : 'reborn';
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
    performance: snap.performance || null,
    trading: snap.trading || null,
    tradeDays: Array.isArray(snap.tradeDays) ? snap.tradeDays : [],
    strategy: snap.strategy || null,
    seats: snap.seats || null,                   // kursi per buku (Reborn)
    paperBooks: snap.paperBooks || null,         // buku kertas pembanding (Reborn hot potato)
    copyTrade: snap.copyTrade || null,           // segmen wallet & jejak keputusan (SnipeHunt)
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

/**
 * Profit yang dibagikan tiap tanggal 1, per pemilik. Catatan dividen di config
 * mengurangi unit pemilik sebesar `usd` (bagian laba + tanggungan biaya sistem);
 * yang benar-benar ia terima ada di `receivedUsd`, sama dengan invoice.
 */
function dividendByOwner(cfg = state.cfg) {
  const out = {};
  for (const e of (cfg?.events || []).filter((x) => x.dividend)) {
    const d = (out[e.owner] ||= { gross: 0, net: 0 });
    d.gross += Number(e.usd) || 0;
    d.net += Number(e.receivedUsd ?? e.usd) || 0;
  }
  return out;
}
const dividendTotals = (cfg = state.cfg) => Object.values(dividendByOwner(cfg)).reduce((t, d) => ({ gross: t.gross + d.gross, net: t.net + d.net }), { gross: 0, net: 0 });

function ownerValues(ledger, navUsd) {
  const div = dividendByOwner();
  const unitPrice = ledger.totalUnits > 0 ? navUsd / ledger.totalUnits : 0;
  return ledger.owners.map((o) => {
    const value = o.units * unitPrice;
    return {
      ...o,
      value,
      share: ledger.totalUnits > 0 ? (o.units / ledger.totalUnits) * 100 : 0,
      // Profit diterima = bersih sesuai invoice; "out" = penarikan modal biasa.
      received: div[o.id]?.net || 0,
      out: Math.max(0, o.withdrawn - (div[o.id]?.gross || 0)),
      pnl: value + (div[o.id]?.net || 0) + Math.max(0, o.withdrawn - (div[o.id]?.gross || 0)) - o.deposited,
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
  // Tanpa deret nilai sama sekali (saldo testnet yang dijeda), grafik tidak
  // punya apa pun untuk digambar.
  if ($('#navCard')) $('#navCard').hidden = nav?.trading?.capitalKnown === false;
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
  // MODAL = setoran + laba yang sengaja diputar kembali jadi modal. Aturan
  // pemilik untuk Meridian (2026-09-25): "$441 itu reinvest, modal masuknya
  // $5.000" — laba sesudah itu diukur dari modal yang sudah dibesarkan, jadi
  // $441 tidak dihitung dua kali sebagai modal DAN sebagai untung.
  const reinvested = Number(ledger.reinvested) || 0;
  const modal = ledger.deposited + reinvested;
  // Kartu ini menunjukkan POSISI TERHADAP MODAL: modal dikunci, dan yang sudah
  // dibagikan tiap tanggal 1 dianggap selesai (aturan pemilik 2026-10-01).
  // Total sejak awal — termasuk dividen yang sudah diterima investor — ada di
  // tab Analys.
  const divPaid = (state.cfg?.events || []).filter((e) => e.dividend).reduce((t, e) => t + (Number(e.usd) || 0), 0);
  const pnl = inBot + (ledger.withdrawn - divPaid + swept) - modal;
  const pnlPct = modal > 0 ? (pnl / modal) * 100 : 0;

  setHTML($('#kpiNav'), usd(inBot));
  setHTML($('#kpiNavSub'), nav.lpUsd > 0
    ? `${usd(nav.liveUsd ?? 0, 0)} token + ${usd(nav.lpUsd, 0)} di LP · yang dipegang bot`
    : nav.label);
  setHTML($('#kpiDeposit'), usd(modal));
  const depSub = $('#kpiDepositSub') || document.querySelector('#kpiDeposit')?.nextElementSibling;
  if (depSub) depSub.textContent = reinvested > 0
    ? `${usdText(ledger.deposited, 0)} setoran + ${usdText(reinvested, 0)} laba diputar kembali`
    : 'total setoran semua pemilik';
  // "Sudah ditarik" = pencairan investor + sapuan harian bot ke wallet tabungan.
  const sweeps = (nav.treasuryMoves || []).filter((m) => m.type === 'sweep').length;
  // Dividen yang sudah dibagikan tanggal 1 keluar dari kartu ini: kartunya
  // menghitung ulang dari nol tiap bulan, dan pembayarannya ada di invoice dan
  // riwayat transaksi. Untung/rugi tetap memasukkannya (lihat `pnl`).
  const divEvents = (state.cfg?.events || []).filter((e) => e.dividend);
  const dividendsPaid = divEvents.reduce((t, e) => t + (Number(e.usd) || 0), 0);
  const investorOut = Math.max(0, ledger.withdrawn - dividendsPaid);
  setHTML($('#kpiWithdraw'), usd(investorOut + swept));
  // Pemilik membaca ini sebagai dua bagian: uang yang sudah ada sebelum
  // hitungan baru dimulai ("early investor"), dan yang ditarik bot sesudahnya
  // ("new"). Keduanya ditulis apa adanya, bukan dijumlah jadi satu angka buta.
  const opening = Number(nav.treasuryOpeningUsd) || 0;
  const fresh = Number(nav.treasuryNewUsd) || 0;
  const openingLabel = nav.treasuryOpeningLabel || 'saldo awal';
  const lastDiv = divEvents.length ? divEvents.reduce((a, e) => (e.at > a.at ? e : a)) : null;
  const lastDivUsd = lastDiv ? divEvents.filter((e) => e.batchId === lastDiv.batchId).reduce((t, e) => t + e.usd, 0) : 0;
  setHTML($('#kpiWithdrawSub'), swept <= 0 && lastDiv
    ? (() => {
      const at = lastDiv.at, moves = (nav.treasuryMoves || []).filter((m) => m.at === at);
      const div = moves.filter((m) => m.type === 'dividend').reduce((t, m) => t + m.usd, 0);
      const cost = moves.filter((m) => m.type === 'expense').reduce((t, m) => t + m.usd, 0);
      return `${usd(lastDivUsd, 0)} keluar ${fmtDay(lastDiv.date)}${div || cost ? ` (${usd(div, 0)} profit + ${usd(cost, 0)} biaya)` : ''} · mulai dari nol lagi`;
    })()
    : swept > 0
    ? (investorOut > 0 ? `${usd(investorOut, 0)} investor + ` : '')
      + (opening > 0
        ? `${esc(openingLabel)} ${usd(opening, 0)}` + (fresh > 0 ? ` · new ${usd(fresh, 0)}` : '')
        : `${usd(swept, 0)} disapu bot · ${sweeps} transfer`)
    : 'total penarikan');
  $('#kpiWithdraw').className = 'big';
  // Dana trading simulasi: tidak ada yang ditarik dan tidak ada LP. Kartu yang
  // sama dipakai untuk kas vs posisi dan untung yang sudah dikunci.
  const tr = isTrading() ? nav.trading : null;
  if (tr && tr.capitalKnown === false) {
    setHTML($('#kpiNavSub'), 'saldo testnet terakhir yang tercatat bot');
    setHTML($('#kpiDeposit'), '—');
    if (depSub) depSub.textContent = 'modal awal testnet tidak tercatat';
    $('#lblWithdraw').textContent = 'Trade tercatat';
    setHTML($('#kpiWithdraw'), String(nav.stats?.closedCount ?? 0));
    setHTML($('#kpiWithdrawSub'), 'trade tercatat · hasil dalam persen');
    setHTML($('#kpiPnl'), '—'); $('#kpiPnl').className = 'big dim';
    $('#kpiPnlSub').textContent = 'tidak dihitung tanpa modal awal';
  } else if (tr) {
    setHTML($('#kpiNavSub'), `${usd(tr.cashUsd, 0)} kas + ${usd(tr.positionsUsd, 0)} di ${(nav.positions || []).length} posisi`);
    if (depSub) depSub.textContent = `${fundMeta(state.fund)?.money || 'modal kertas'} — bukan uang sungguhan`;
    setHTML($('#kpiWithdraw'), signed(tr.realizedUsd));
    $('#kpiWithdraw').className = 'big ' + cls(tr.realizedUsd);
    setHTML($('#kpiWithdrawSub'), `${nav.stats?.closedCount || 0} trade ditutup · berjalan ${signed(tr.unrealizedUsd)}`);
  }
  const el = $('#kpiPnl');
  if (!(tr && tr.capitalKnown === false)) {
    setHTML(el, signed(pnl));
    el.className = 'big ' + cls(pnl);
    $('#kpiPnlSub').textContent = (pnl >= 0 ? '+' : '') + pct(pnlPct) + ' dari modal'
      + (divPaid > 0 ? ` · profit dibagikan ${usdText(dividendTotals().net, 0)} · total sejak awal ${signedText(pnl + dividendTotals().net)}` : '');
  }
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
  if (isTrading()) {
    $('#stripLp').textContent = `${(nav.positions || []).length} posisi · dihitung tiap 5 menit · terakhir ${ago(nav.updatedAt)}`;
    return;
  }
  $('#stripLp').textContent = nav.positions?.length
    ? `dihitung bot tiap 5 menit · terakhir ${ago(nav.updatedAt)}`
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
      <td class="num">${r.received > 0 ? `<span class="pos">${usd(r.received)}</span>` : '<span class="dim">—</span>'}${r.out > 0 ? `<div class="sub2">+ tarik modal ${usd(r.out)}</div>` : ''}</td>
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
  const tokens = isTrading()
    ? (nav.positions || []).map((p) => ({ symbol: p.symbol, amount: p.amount, price: p.priceUsd, usd: p.principalUsd }))
    : [];
  const rows = [...(nav.holdings || []), ...tokens].sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const body = $('#holdTable').querySelector('tbody');
  const pages = Math.max(1, Math.ceil(rows.length / HOLD_PER_PAGE));
  if (holdPage >= pages) holdPage = pages - 1;

  const slice = rows.slice(holdPage * HOLD_PER_PAGE, (holdPage + 1) * HOLD_PER_PAGE);
  setHTML(body, slice.length
    ? slice.map((r) => `
      <tr>
        <td><span class="who"><span class="chip" style="background:${r.symbol === 'ETH' ? '#627eea' : '#4ade80'}"></span>${esc(r.symbol)}</span></td>
        <td class="num">${r.amount == null ? '<span class="dim">—</span>' : num(r.amount, 6)}</td>
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
  if (isTrading()) { renderTrades(nav); return; }
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
            ${entryNote(r) ? `<div class="sub2">${esc(entryNote(r))}</div>` : ''}
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

/* ── riwayat posisi ditutup: seluruh riwayat, per halaman ───────────────
 *
 * Snapshot membawa dua puluh posisi terakhir (halaman pertama, tanpa unduhan)
 * dan indeks per hari (`tradeDays`: tanggal, jumlah, hasil, menang, kalah).
 * Baris hari-hari lain ada di berkas harian yang baru diunduh saat halamannya
 * dibuka — jadi riwayat boleh puluhan ribu posisi tanpa memberatkan halaman.
 */
const CLOSED_PER_PAGE = 20;
const closedView = { fund: null, month: '', page: 0, token: 0 };
const tradeDayCache = new Map();

async function loadTradeDay(fund, day) {
  const key = `${fund}/${day}`;
  if (tradeDayCache.has(key)) return tradeDayCache.get(key);
  const file = `trades/${day}.json`;
  const urls = [(rawDataBase(fund) || RAW_BASE + fund + '/') + file, `data/${fund}/${file}`];
  for (const url of urls) {
    try {
      const j = await getJSON(url);
      if (j?.fund === fund && Array.isArray(j.rows)) { tradeDayCache.set(key, j.rows); return j.rows; }
    } catch { /* sumber berikutnya */ }
  }
  throw new Error('riwayat hari ' + day + ' tidak terbaca');
}

// Cara posisi masuk, ditulis singkat di bawah nama buku.
function entryNote(r) {
  if (r.entryVia === 'door') {
    const rate = r.door?.rate60Pct, vol = r.door?.vol60Usd;
    return 'masuk lewat pintu' + (rate != null ? ` · pool bayar ${pct(rate)}/jam` : '') + (vol != null ? ` · vol 1 jam ${usd(vol)}` : '');
  }
  if (r.entryVia === 'alarm') return 'masuk lewat alarm';
  if (r.entryVia === 'recovery') return 'masuk ulang setelah stop';
  if (r.orderedBy === 'operator') return 'dibuka atas perintah operator';
  return '';
}

function closedRowsHtml(rows, absolute) {
  // Hasil dalam dolar kalau bot mencatatnya; bot yang hanya mencatat persen
  // ditulis "—" (atau ≈ perkiraan) di kolom dolar, bukan $0.
  const tone = (r) => (r.netUsd != null ? r.netUsd : r.netPct);
  return rows.map((r) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${tone(r) >= 0 ? '#4ade80' : '#f87171'}"></span>${esc(r.symbol ?? '—')}</span></td>
      <td class="dim">${esc(r.bookLabel ?? r.strategy ?? '—')}${entryNote(r) ? `<div class="sub2">${esc(entryNote(r))}</div>` : ''}${walletChips(r.wallets)}${flagChips(r.flags)}</td>
      <td class="num dim">${r.holdMinutes == null ? '—' : dur(r.holdMinutes)}</td>
      <td class="num ${cls(r.netUsd ?? r.estUsd)}">${r.netUsd != null ? signed(r.netUsd) : r.estUsd != null ? `<span title="perkiraan: ukuran posisi × persen × harga saat dicatat">≈${signed(r.estUsd)}</span>` : '<span class="dim">—</span>'}</td>
      <td class="num ${cls(tone(r))}">${r.netPct == null ? '—' : (r.netPct > 0 ? '+' : '') + pct(r.netPct)}</td>
      <td class="dim"${r.reasonDetail ? ` title="${esc(r.reasonDetail)}"` : ''}>${esc(r.reason ?? '—')}${r.exitDetail ? `<div class="sub2 why">${esc(r.exitDetail)}</div>` : ''}${
        r.entry ? `<div class="sub2 why"><b>Masuk:</b> ${esc(r.entry)}</div>` : ''}${r.peakPct != null ? `<div class="sub2">puncak +${pct(r.peakPct, 1)}${r.ddPct != null ? ` · terdalam ${pct(r.ddPct, 1)}` : ''}</div>` : ''}</td>
      <td class="num dim nowrap">${absolute ? tglRingkas(r.closedAt) : ago(r.closedAt)}</td>
    </tr>`).join('');
}
// "1 Okt 13:14" (WIB); tahun hanya ditulis kalau bukan tahun ini.
function tglRingkas(t) {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + 7 * 3600e3), y = d.getUTCFullYear();
  return `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]}${y === new Date().getUTCFullYear() ? '' : ' ' + y} ${d.toISOString().slice(11, 16)}`;
}

function pagerHtml(page, pages) {
  const btn = (label, p, extra = '') => `<button ${extra} data-p="${p}" class="${p === page && !extra.includes('data-nav') ? 'on' : ''}">${label}</button>`;
  const nums = [];
  for (let i = 0; i < pages; i += 1) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) nums.push(btn(String(i + 1), i));
    else if (nums[nums.length - 1] !== '<span class="gap">…</span>') nums.push('<span class="gap">…</span>');
  }
  return btn('‹', Math.max(0, page - 1), `data-nav ${page === 0 ? 'disabled' : ''}`) + nums.join('')
    + btn('›', Math.min(pages - 1, page + 1), `data-nav ${page === pages - 1 ? 'disabled' : ''}`);
}

function renderClosed(nav) {
  const recent = nav.closedRecent || [];
  const days = Array.isArray(nav.tradeDays) ? nav.tradeDays : [];
  const body = $('#closedTable').querySelector('tbody');
  const ctl = $('#closedCtl'), pager = $('#closedPager');
  $('#closedCard').hidden = false;
  if (closedView.fund !== state.fund) Object.assign(closedView, { fund: state.fund, month: '', page: 0 });
  if (!recent.length && !days.length) {
    setHTML(body, '<tr><td colspan="7" class="dim">Belum ada posisi yang ditutup.</td></tr>');
    $('#closedHint').textContent = ''; ctl.hidden = true; pager.hidden = true;
    return;
  }
  // Snapshot lama tanpa indeks harian: tampilkan yang ada saja.
  if (!days.length) {
    setHTML(body, closedRowsHtml(recent, false));
    setHTML($('#closedHint'), `${recent.length} terakhir`); ctl.hidden = true; pager.hidden = true;
    return;
  }

  const months = [...new Set(days.map((x) => x.d.slice(0, 7)))].sort().reverse();
  if (closedView.month && !months.includes(closedView.month)) closedView.month = '';
  const scope = days.filter((x) => !closedView.month || x.d.startsWith(closedView.month)).slice().reverse();   // terbaru dulu
  const total = scope.reduce((t, x) => t + x.n, 0);
  const pages = Math.max(1, Math.ceil(total / CLOSED_PER_PAGE));
  closedView.page = Math.min(Math.max(0, closedView.page), pages - 1);
  const sum = (list) => ({ n: list.reduce((t, x) => t + x.n, 0), w: list.reduce((t, x) => t + x.w, 0), l: list.reduce((t, x) => t + x.l, 0),
    usd: list.some((x) => x.usd != null) ? list.reduce((t, x) => t + (x.usd || 0), 0) : null, est: list.some((x) => x.est) });
  const label = (m) => `${M_SHORT[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

  ctl.hidden = false;
  const all = sum(days);
  setHTML($('#closedMonth'), `<option value="">Semua · ${all.n} posisi</option>`
    + months.map((m) => { const s = sum(days.filter((x) => x.d.startsWith(m))); return `<option value="${m}"${m === closedView.month ? ' selected' : ''}>${label(m)} · ${s.n} posisi</option>`; }).join(''));
  const s = sum(scope);
  setHTML($('#closedSum'), `<b>${s.n}</b> posisi`
    + (s.usd == null ? '' : ` · hasil <b class="${cls(s.usd)}">${s.est ? '≈' : ''}${signed(s.usd)}</b>`)
    + ` · <span class="pos">${s.w} untung</span> · <span class="neg">${s.l} rugi</span>`
    + (s.w + s.l ? ` · win rate ${pct((s.w / (s.w + s.l)) * 100, 1)}` : ''));
  setHTML($('#closedHint'), `halaman ${closedView.page + 1} dari ${pages} · ${closedView.month ? label(closedView.month) : 'seluruh riwayat'}`);
  pager.hidden = pages < 2;
  if (pages > 1) setHTML(pager, pagerHtml(closedView.page, pages));

  // Halaman pertama tanpa filter sudah ada di snapshot — langsung tampil.
  const start = closedView.page * CLOSED_PER_PAGE;
  if (closedView.page === 0 && !closedView.month && recent.length >= Math.min(CLOSED_PER_PAGE, total)) {
    setHTML(body, closedRowsHtml(recent.slice(0, CLOSED_PER_PAGE), false));
    return;
  }
  // Hari-hari yang beririsan dengan halaman ini saja yang diunduh.
  const need = []; let off = 0, first = null;
  for (const x of scope) {
    if (off + x.n > start && off < start + CLOSED_PER_PAGE) { if (first == null) first = off; need.push(x.d); }
    off += x.n;
  }
  const token = ++closedView.token, fund = state.fund;
  if (!need.every((d) => tradeDayCache.has(`${fund}/${d}`))) setHTML(body, '<tr><td colspan="7" class="dim">memuat riwayat…</td></tr>');
  Promise.all(need.map((d) => loadTradeDay(fund, d))).then((lists) => {
    if (token !== closedView.token || fund !== state.fund) return;
    const rows = lists.flat().slice(start - first, start - first + CLOSED_PER_PAGE);
    setHTML(body, closedRowsHtml(rows, true));
  }).catch((err) => {
    if (token !== closedView.token) return;
    setHTML(body, `<tr><td colspan="7" class="miss">Riwayat tidak bisa dimuat: ${esc(err.message)}</td></tr>`);
  });
}
const tglJam = (t) => (Number.isFinite(t) ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');

/* ── dana trading (Charon RH) ──────────────────────────────────────────
 *
 * Dana LP menyediakan likuiditas; dana trading membeli token lalu menjualnya
 * lagi. Kerangka halamannya sama — ringkasan, grafik nilai, riwayat, posisi —
 * tapi judul, kolom, dan beberapa kartu berbeda. Teks bawaan tiap elemen
 * disimpan sekali dan dikembalikan begitu pindah ke dana LP.
 */
const isTrading = (id = state.fund) => fundMeta(id)?.kind === 'trading';

function swapHTML(el, trading, html) {
  if (!el) return;
  if (el.dataset.orig == null) el.dataset.orig = el.innerHTML;
  const want = trading ? html : el.dataset.orig;
  if (el.innerHTML !== want) setHTML(el, want);
}

function applyFundKind() {
  const t = isTrading();
  swapHTML($('#lpTitle'), t, 'Posisi trading');
  swapHTML($('#lpHead'), t, '<tr><th>Token</th><th>Rencana</th><th class="num">Umur</th><th class="num">Modal</th>'
    + '<th class="num">Nilai jual</th><th class="num">Stop / target</th><th class="num">Untung / rugi</th></tr>');
  swapHTML($('#closedFirst'), t, 'Token');
  swapHTML($('#holdTitle'), t, 'Kas &amp; token');
  swapHTML($('#lblDeposit'), t, 'Modal simulasi');
  swapHTML($('#lblWithdraw'), t, 'Untung terkunci');
  swapHTML($('#stripLpLabel'), t, 'Posisi');
  swapHTML($('#profitDisclaimer'), t, 'Ini hasil <strong>simulasi</strong>: harga dan biaya diambil dari quote pasar sungguhan, '
    + 'tetapi tidak ada transaksi yang dikirim ke blockchain. Pembelian nyata bisa mendapat harga lebih buruk, biaya gas '
    + 'nyata bisa berbeda dari yang dimodelkan, dan token kecil bisa saja tidak bisa dijual. Angka ini dipakai untuk '
    + 'menilai strategi, bukan janji hasil.');
  $('#shareCard').hidden = t;
  if ($('#stripShare')) $('#stripShare').hidden = t;
  $('#paperCard').hidden = !t;
  $('#copyCard').hidden = true; $('#decisionCard').hidden = true;   // dibuka renderCopyTrade kalau datanya ada
  const shareBtn = document.querySelector('#segSeries [data-s="share"]');
  if (shareBtn) shareBtn.hidden = t;
  if (t && navView.series === 'share') {
    navView.series = 'wallet';
    $('#segSeries').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-s') === 'wallet'));
  }
}

const AKSI = { WAIT: 'menunggu', BUY: 'beli', HOLD: 'tahan', EXIT: 'jual', TAKE_PARTIAL: 'jual sebagian' };

function renderPaper(nav) {
  const tr = isTrading() ? nav?.trading : null;
  if (!tr) return;
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  renderCopyTrade(nav);
  if (Array.isArray(tr.tiles)) { renderPaperGeneric(nav, tr, tile); return; }
  const hidup = tr.heartbeatAt && nav.updatedAt - tr.heartbeatAt < 10 * 60e3;
  const sehat = hidup && tr.status === 'healthy' && !tr.paused;
  setHTML($('#paperLead'), `Charon RH <strong>belum memakai uang sungguhan</strong>. Ia berdagang di atas kertas dengan modal
    ${usd(tr.initialUsd, 0)}, memakai harga pasar asli, untuk membuktikan strateginya dulu sebelum diberi dana. Berjalan sejak ${tgl(tr.startedAt)}.`);
  const act = tr.activity24h || {};
  const llm = tr.llm || {};
  setHTML($('#paperStats'), [
    tile('Kondisi bot', sehat ? 'sehat' : tr.paused ? 'dijeda' : hidup ? esc(tr.status || '—') : 'tidak aktif',
      hidup ? `tanda hidup ${ago(tr.heartbeatAt)}` : 'tidak ada tanda hidup', sehat ? 'pos' : 'neg'),
    tile('Pindai pasar', String(act.scans ?? '—'), `24 jam terakhir · terakhir ${ago(tr.lastScanAt)}`),
    tile('Keputusan AI', `${llm.calls24h ?? '—'}<span class="dim"> / ${llm.dailyBudget ?? 96}</span>`, 'panggilan 24 jam / batas harian'),
    tile('Beli · jual', `${act.buys ?? 0} · ${act.sells ?? 0}`, `24 jam · ${act.quotesRejected ?? 0} quote ditolak`),
    tile('Turun dari puncak', pct(tr.drawdownPct), `rem darurat di 12% · puncak ${usd(tr.peakUsd, 0)}`, tr.drawdownPct >= 8 ? 'neg' : ''),
  ].join(''));
  const aksi = llm.lastAction ? (AKSI[llm.lastAction] || llm.lastAction.toLowerCase()) : null;
  setHTML($('#paperDecision'), aksi ? `<div class="decision">
      <div class="decision-head"><span class="k">Keputusan AI terakhir</span>
        <span class="pill ${llm.lastAction === 'BUY' ? 'in' : llm.lastAction === 'WAIT' ? '' : 'out'}">${esc(aksi)}</span>
        <span class="dim">${ago(llm.lastDecisionAt)}${llm.model ? ' · ' + esc(llm.model) : ''}</span></div>
      ${llm.lastReason ? `<blockquote>${esc(llm.lastReason)}</blockquote><div class="n dim">catatan asli dari AI, bahasa Inggris</div>` : ''}
    </div>` : '');
}

/*
 * Copy-trade (SnipeHunt): label wallet dan tanda bahaya diberi ikon supaya
 * sekali lihat terbaca siapa yang ikut membeli. Kunci yang belum dikenal
 * tetap tampil dengan namanya apa adanya.
 */
const WALLET_KIND = {
  smart: ['🧠', 'Smart money', '#4ade80'], whale: ['🐋', 'Paus (whale)', '#60a5fa'], dolphin: ['🐬', 'Lumba-lumba', '#22d3ee'],
  kol: ['📣', 'KOL', '#c084fc'], bot: ['🤖', 'Bot', '#94a3b8'], lp: ['💧', 'LP', '#38bdf8'], fresh: ['🌱', 'Wallet baru', '#a3e635'],
  blacklist: ['💀', 'Blacklist', '#f87171'], unknown: ['❔', 'Belum dinilai', '#64748b'],
};
const FLAG_KIND = {
  blacklist: ['💀', 'wallet blacklist ikut beli'], phishing: ['🎣', 'phishing'], bundler: ['📦', 'bundler'], rat: ['🐀', 'rat / insider'],
  insider: ['🐀', 'insider'], sniper: ['🎯', 'sniper'], dev: ['👨‍💻', 'dev ikut main'], wash: ['🧼', 'volume cuci'], fresh: ['🌱', 'banyak wallet baru'],
  top10: ['🔟', '10 holder teratas >30%'], honeypot: ['🍯', 'honeypot'], tax: ['💸', 'pajak token'], mint_authority: ['🖨️', 'mint authority'],
  freeze_authority: ['🧊', 'freeze authority'], scam_warning: ['⚠️', 'peringatan scam'],
};
const kindOf = (k) => WALLET_KIND[k] || ['👛', k, '#8b95a7'];
function walletChips(o) {
  const e = Object.entries(o || {}).filter(([, n]) => n > 0);
  return e.length ? `<span class="wchips">${e.map(([k, n]) => `<span class="wchip" title="${esc(kindOf(k)[1])}">${kindOf(k)[0]} ${n} <small>${esc(kindOf(k)[1])}</small></span>`).join('')}</span>` : '';
}
function flagChips(a) {
  return (a || []).length ? `<span class="wchips">${a.map((f) => { const [ic, name] = FLAG_KIND[f.type] || ['🚩', f.type];
    return `<span class="fchip" title="${esc(f.note || name)}">${ic} ${f.count ?? ''} <small>${esc(name)}</small></span>`; }).join('')}</span>` : '';
}
const ACTION = { enter: ['masuk', 'in'], skip: ['dilewati', ''], veto: ['diveto', 'warn'], exit: ['keluar', 'out'], partial: ['jual sebagian', 'in'] };
const decView = { all: false };
function renderCopyTrade(nav) {
  const ct = nav?.copyTrade;
  const w = ct?.wallets;
  $('#copyCard').hidden = !w;
  if (w) {
    const total = w.tracked || w.byLabel.reduce((t, x) => t + x.total, 0) || 0;
    const act = w.active ?? 0, pas = w.passive ?? Math.max(0, total - act);
    setHTML($('#copyHint'), `diperbarui ${ago(nav.updatedAt)}`);
    setHTML($('#copyWallets'), `
      <div class="wl-head">
        <div><div class="k">Total wallet dipantau</div><div class="wl-big num">${total.toLocaleString('id-ID')}</div></div>
        <div class="wl-split">
          <div class="wl-bar"><i style="width:${total ? (act / total * 100).toFixed(1) : 0}%"></i></div>
          <div class="wl-leg"><span><b class="pos">${act.toLocaleString('id-ID')}</b> aktif dipantau</span><span><b>${pas.toLocaleString('id-ID')}</b> pasif dipantau</span></div>
        </div>
      </div>
      <div class="wl-grid">${w.byLabel.map((x) => { const [ic, name, c] = kindOf(x.key);
        return `<div class="wl-tile" style="--wc:${c}">
          <div class="wl-ic">${ic}</div>
          <div class="wl-name">${esc(name)}</div>
          <div class="wl-n num">${x.total.toLocaleString('id-ID')}</div>
          ${x.active != null ? `<div class="wl-sub"><span class="pos">${x.active} aktif</span> · ${x.passive} pasif</div>
          <div class="wl-mini"><i style="width:${x.total ? (x.active / x.total * 100).toFixed(1) : 0}%"></i></div>` : ''}
        </div>`; }).join('')}</div>
      ${w.definitions?.active || w.definitions?.passive ? `<details class="explain"><summary>Apa bedanya aktif dan pasif</summary>
        ${w.definitions.active ? `<p><b>Aktif:</b> ${esc(w.definitions.active)}</p>` : ''}${w.definitions.passive ? `<p><b>Pasif:</b> ${esc(w.definitions.passive)}</p>` : ''}
        ${w.definitions.label ? `<p><b>Label:</b> ${esc(w.definitions.label)}</p>` : ''}</details>` : ''}
      ${w.top?.length ? `<h3 class="sub-h">10 wallet terbaik</h3><div class="table-scroll"><table class="mcards">
        <thead><tr><th>Wallet</th><th class="num">Skor</th><th class="num">Di-copy</th><th class="num">Menang</th><th class="num">Hasil copy</th></tr></thead>
        <tbody>${w.top.map((t) => `<tr><td class="mc-head">${kindOf(t.label)[0]} ${esc(t.alias)}</td><td class="num" data-k="Skor">${t.score ?? '—'}</td>
          <td class="num" data-k="Di-copy">${t.copied ?? 0}×</td><td class="num" data-k="Menang">${t.won ?? 0}</td>
          <td class="num ${cls(t.pnlUsd ?? 0)}" data-k="Hasil copy">${t.pnlUsd ? signed(t.pnlUsd) : '<span class="dim">—</span>'}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Alamat wallet tidak pernah diterbitkan; nomornya alias tetap dari daftar bot.</p>` : ''}`);
  }
  const dec = ct?.decisions || [];
  $('#decisionCard').hidden = !dec.length && !ct?.reasonStats;
  if ($('#decisionCard').hidden) return;
  setHTML($('#decHint'), `${dec.length} keputusan terakhir · termasuk yang dilewati`);
  const RS = { skip: 'dilewati', veto: 'diveto', exit: 'keluar' };
  const SK = { chase: 'harga sudah lari', red_flag: 'red flag', round_trip_cost: 'biaya keluar-masuk mahal', basket_full: 'basket penuh', slippage: 'slippage',
    no_price: 'tanpa harga', max_open: 'posisi maksimum', day_loss: 'batas rugi harian', paused: 'bot dijeda', llm: 'LLM' };
  const rs = ct?.reasonStats || {};
  const chips = Object.entries(rs).flatMap(([g, o]) => Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `<span class="rs-chip"><b>${n}</b> ${esc(RS[g] || g)} · ${esc(SK[k] || k)}</span>`));
  setHTML($('#decStats'), `<div class="rs"><span class="k">24 jam terakhir</span>${chips.length ? chips.join('') : '<span class="dim">belum ada sinyal yang diproses</span>'}</div>`);
  const shown = decView.all ? dec : dec.slice(0, 12);
  setHTML($('#decList'), `<ol class="dec-list">${shown.map((d) => { const [a, tone] = ACTION[d.action] || [d.action, ''];
    return `<li><div class="dec-top"><span class="pill ${tone}">${esc(a)}</span><b>${esc(d.symbol || '—')}</b>${d.basket ? `<span class="dim">${esc(d.basket)}</span>` : ''}
      <span class="dim dec-t">${tglJam(d.at)}</span></div>
      ${walletChips(d.wallets)}${flagChips(d.flags)}
      ${d.reason ? `<p class="dec-r">${esc(d.reason)}</p>` : ''}</li>`; }).join('')}</ol>
    ${dec.length > 12 ? `<button class="btn ghost" id="decMore">${decView.all ? 'tampilkan lebih sedikit' : `lihat semua ${dec.length} keputusan`}</button>` : ''}`);
  if ($('#decMore')) $('#decMore').onclick = () => { decView.all = !decView.all; renderCopyTrade(nav); };
}

/** Status bot uji coba yang kartunya disusun exporter (Forex, Binance). */
function renderPaperGeneric(nav, tr, tile) {
  const label = fundMeta(state.fund)?.label || 'Bot ini';
  setHTML($('#paperLead'), `${esc(tr.lead || label + ' belum memakai uang sungguhan.')}${tr.startedAt ? ` Riwayat sejak ${tgl(tr.startedAt)}.` : ''}`);
  const base = [tile('Kondisi bot', esc(tr.status || '—'), tr.heartbeatAt ? `tanda hidup ${ago(tr.heartbeatAt)}` : 'tidak ada tanda hidup', tr.healthy ? 'pos' : 'neg')];
  if (tr.peakUsd) base.push(tile('Turun dari puncak', pct(tr.drawdownPct), `puncak ${usd(tr.peakUsd, 0)}`, tr.drawdownPct >= 10 ? 'neg' : ''));
  setHTML($('#paperStats'), base.concat(tr.tiles.map((x) => tile(esc(x.k), x.usd != null ? usd(x.usd, 0) : x.pct != null ? pct(x.pct) : esc(x.v ?? '—'),
    esc(x.n || ''), x.tone || ''))).join(''));
  const llm = tr.llm;
  setHTML($('#paperDecision'), llm?.lastReason ? `<div class="decision">
      <div class="decision-head"><span class="k">Pandangan AI terakhir</span><span class="pill">${esc(llm.lastAction || '—')}</span>
        <span class="dim">${ago(llm.lastDecisionAt)}${llm.model ? ' · ' + esc(llm.model) : ''}</span></div>
      <blockquote>${esc(llm.lastReason)}</blockquote>${nav.copyTrade ? '' : '<div class="n dim">catatan asli dari AI, bahasa Inggris</div>'}</div>` : '');
}

function renderTrades(nav) {
  const rows = nav.positions || [];
  const body = $('#lpTable').querySelector('tbody');
  $('#lpCount').textContent = rows.length ? `(${rows.length})` : '';
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  if (!rows.length) {
    setHTML(body, `<tr><td colspan="7" class="dim">${nav.trading?.paused ? 'Tidak ada posisi terbuka — bot sedang dijeda.' : 'Tidak ada posisi terbuka — bot sedang menunggu peluang yang layak.'}</td></tr>`);
    setHTML($('#lpSummary'), '');
    $('#lpHint').textContent = `diperiksa ${ago(nav.updatedAt)}`;
    return;
  }
  const value = rows.reduce((t, r) => t + (Number(r.valueUsd) || 0), 0);
  const cost = rows.reduce((t, r) => t + (Number(r.costUsd) || 0), 0);
  const pnl = rows.reduce((t, r) => t + (Number(r.pnlUsd) || 0), 0);
  const total = Number(nav.totalUsd) || 0;
  setHTML($('#lpSummary'), [
    tile('Nilai jual sekarang', usd(value), `${rows.length} posisi`),
    tile('Modal masuk', usd(cost), 'saat dibeli'),
    tile('Untung / rugi', signed(pnl), cost ? pct((pnl / cost) * 100) + ' dari modal' : '—', cls(pnl)),
    tile('Eksposur', total ? pct((value / total) * 100, 1) : '—', nav.trading?.tiles ? 'dari nilai dana' : 'dari nilai dana · batas 60%'),
  ].join(''));
  if (rows.every((r) => r.direction)) {
    setHTML($('#lpSummary'), '');
    setHTML(body, rows.map((r) => `<tr>
      <td><span class="who"><span class="chip" style="background:${r.direction === 'LONG' ? '#4ade80' : '#f87171'}"></span>${esc(r.symbol)}</span></td>
      <td>${esc(r.bookLabel || r.direction)}<div class="sub2">${r.lot ?? '—'} lot</div></td>
      <td class="num dim">${dur(r.ageMinutes)}</td>
      <td class="num">${r.entryPrice ?? '—'}</td><td class="num dim">—</td>
      <td class="num"><span class="neg">${r.slPrice ?? '—'}</span> / <span class="pos">${r.tpPrice ?? '—'}</span></td>
      <td class="num dim">di equity</td></tr>`).join(''));
    $('#lpHint').textContent = `harga masuk · SL / TP · nilai berjalan sudah termasuk di nilai akun · ${ago(nav.updatedAt)}`;
    return;
  }
  setHTML(body, [...rows].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).map((r) => `<tr>
      <td><span class="who"><span class="chip" style="background:${r.pnlUsd >= 0 ? '#4ade80' : '#f87171'}"></span>${esc(r.symbol)}</span>
        ${r.experimental ? '<div class="sub2">eksperimen</div>' : ''}${r.stale ? '<div class="sub2 neg">harga belum terverifikasi</div>' : ''}</td>
      <td>${esc(r.bookLabel || '—')}<div class="sub2">${[r.strategy && r.strategy !== r.bookLabel ? esc(r.strategy) : '', r.maxHoldHours ? `maks ${r.maxHoldHours} jam` : '', r.confidence != null ? `yakin ${r.confidence}%` : '', r.partialDone ? 'sebagian sudah dijual' : ''].filter(Boolean).join(' · ')}</div>
        ${walletChips(r.wallets)}${flagChips(r.flags)}${r.firstWallet ? `<div class="sub2">pertama beli: ${esc(r.firstWallet)}${r.llmScore != null ? ` · skor LLM ${r.llmScore}` : ''}</div>` : ''}
        ${r.thesis ? `<div class="thesis" title="${esc(r.thesis)}"><b>Alasan masuk:</b> ${esc(r.thesis)}</div>` : ''}</td>
      <td class="num dim">${dur(r.ageMinutes)}</td>
      <td class="num">${usd(r.costUsd)}</td>
      <td class="num"><strong>${usd(r.valueUsd)}</strong></td>
      <td class="num">${r.stopPct == null && r.targetPct == null ? '<span class="dim">belum diisi bot</span>'
        : `<span class="neg">${r.stopPct == null ? '—' : '−' + pct(r.stopPct, 1)}</span> / <span class="pos">${r.targetPct == null ? '—' : '+' + pct(r.targetPct, 1)}</span>`}</td>
      <td class="num ${cls(r.pnlUsd)}">${signed(r.pnlUsd)}<div class="sub2 ${cls(r.pnlUsd)}">${r.pnlPct == null ? '' : (r.pnlPct > 0 ? '+' : '') + pct(r.pnlPct)}</div></td>
    </tr>`).join(''));
  $('#lpHint').textContent = `nilai = hasil jual bersih menurut quote · dihitung ${ago(nav.updatedAt)}`
    + (rows.some((p) => p.stale) ? ' · ada harga yang belum diperbarui' : '');
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
        <td><span class="pill ${out ? 'out' : 'in'}">${e.type === 'reinvest' ? 'reinvestasi' : e.dividend ? 'profit' : out ? 'tarik' : 'setor'}</span></td>
        <td><span class="who"><span class="chip" style="background:${e.color || '#4ade80'}"></span>${esc(e.ownerName)}</span></td>
        <td class="num ${e.dividend ? 'pos' : out ? 'neg' : 'pos'}">${e.dividend ? '+' + usd(e.receivedUsd ?? e.usd) : (out ? '-' : '+') + usd(e.usd)}</td>
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
  leaveHome();
  $('#tabs').hidden = false;
  $('#tab-analisa').hidden = true;
  $('#tab-safebox').hidden = true;
  $('#tab-update').hidden = true;
  renderFundBar();
  $('#tab-portfolio').hidden = tab !== 'portfolio';
  $('#tab-investor').hidden = tab !== 'investor';
  $('#tab-bot').hidden = tab !== 'bot';
  $('#tab-tentang').hidden = tab !== 'tentang';
  $('#tab-analys').hidden = tab !== 'analys';
  if (tab === 'analys') renderAnalys();
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

/**
 * SETORAN DAN PENARIKAN BUKAN HASIL BOT. Titik lama digeser sebesar arus kas
 * yang terjadi sesudahnya, jadi garis hanya naik-turun karena hasil, dan
 * ujungnya tetap nilai sebenarnya sekarang. Dana yang dompetnya hanya dibaca
 * (arus kas pemilik tidak tercatat) tidak punya daftar arus kas: tidak digeser.
 */
const cashFlows = (cfg) => (cfg?.events || []).filter((e) => e.type === 'deposit' || e.type === 'withdraw')
  .map((e) => ({ at: CashoodCore.eventTime(e), usd: e.type === 'deposit' ? Number(e.usd) : -Number(e.usd) }))
  .filter((f) => Number.isFinite(f.at) && Number.isFinite(f.usd));
const flowsAfter = (flows, t) => flows.reduce((sum, f) => (f.at > t ? sum + f.usd : sum), 0);

async function readNavSeries(cfg, { force = false, fund = state.fund } = {}) {
  const urls = dataUrls(cfg, 'nav.json', cfg?.app?.navUrl, fund);
  for (const url of urls) {
    try {
      const j = await getJSON(url, { fresh: force });
      // Deret kosong yang terbaca utuh juga jawaban sah (dana tanpa riwayat
      // nilai); mencari ke sumber cadangan hanya menghasilkan 404.
      if (Array.isArray(j.points)) return j.points;
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
  const flows = share ? [] : cashFlows(state.cfg);
  const pts = share ? sharePriceSeries(raw) : raw.map((p) => ({ ...p, v: p.usd + flowsAfter(flows, p.t) }));

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
  const stroke = up ? 'var(--green)' : 'var(--red)';
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
  // SETORAN BUKAN HASIL BOT. Uang masuk dulu menaikkan garis ini seketika, dan
  // tanpa keterangan lompatannya terbaca seperti keuntungan sehari. Garis
  // "Nilai saham" tidak punya masalah itu — setoran membeli unit baru, harganya
  // tidak ikut melompat — jadi pembaca diarahkan ke sana.
  // Sekarang titik lamanya sudah digeser (cashFlows di atas); yang tersisa di
  // sini hanya keterangan berapa arus kas yang disesuaikan di rentang ini.
  const masuk = flows.filter((e) => e.at > first.t && e.at <= Date.now());
  const totalMasuk = masuk.reduce((t, e) => t + e.usd, 0);

  setHTML($('#navHint'), share
    ? `1 saham = ${usd(last.v, 4)} · ${(movePct >= 0 ? '+' : '') + pct(movePct)} di rentang ini`
    : `${pts.length} titik · ${signed(delta)} (${pct(movePct)}) di rentang ini`
      + (Math.abs(totalMasuk) >= 1 && !share
        ? ` · arus kas ${signed(totalMasuk)} tidak dihitung`
        : ''));

  const catatan = $('#navNote');
  if (catatan) {
    catatan.hidden = !(Math.abs(totalMasuk) >= 1 && !share);
    if (!catatan.hidden) {
      setHTML(catatan, `Ada arus kas <strong>${signed(totalMasuk)}</strong> (setoran/penarikan) di rentang ini. Supaya tidak terbaca
        sebagai untung atau rugi, titik sebelum arus kas itu digeser sebesar jumlahnya — garis hanya naik-turun karena hasil bot,
        dan titik terakhir tetap nilai wallet sebenarnya.`);
    }
  }

  // crosshair + tooltip
  const wrap = $('#navWrap');
  const tip = $('#navTip');
  const cross = svg.querySelector('#navCross');
  const hit = svg.querySelector('#navHit');
  hit.onpointermove = hit.onpointerdown = (ev) => {
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
        : near.lp == null ? ''
          : isTrading() ? `<div class="t-n">${usd(near.usd - near.lp, 0)} kas · ${usd(near.lp, 0)} posisi</div>`
          : `<div class="t-n">${usd(near.usd - near.lp, 0)} token · ${usd(near.lp, 0)} LP</div>`));
    tip.hidden = false;
    tip.style.left = (x(near.t) / ratio) + 'px';
    tip.style.top = ((y(near.v) - 10) / ratio) + 'px';
  };
  hit.onpointerleave = (ev) => { if (ev.pointerType === 'mouse') { tip.hidden = true; cross.style.display = 'none'; } };
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
      <td><div>${esc(m.periodLabel)}${m.example ? ' <span class="inv-tag">contoh</span>' : m.status === 'draft' ? ' <span class="inv-tag">draf · belum final</span>' : ''}</div><div class="inv-no">${String(m.invoiceNo || '').split('/').join('/<wbr>')}</div></td>
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
 * Performa per buku: big cap, mid cap, degen, hot potato (dan buku baru apa
 * pun yang dikirim bot — kuncinya ditulis apa adanya).
 *
 * Semuanya berbagi satu dompet, jadi tanpa dipisah tidak kelihatan mana yang
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
  // Kursi dibaca dari laporan bot sendiri, bukan diketik di situs.
  const seatOf = new Map((state.nav?.seats?.books || []).map((s) => [s.key, s]));
  setHTML($('#bookTable').querySelector('tbody'), win.books.map((b) => `<tr>
      <td><span class="who"><span class="chip" style="background:${BOOK_COLOR[b.key] || '#8b95a7'}"></span>${esc(b.label)}</span>${
        seatOf.has(b.key) ? `<div class="sub2">${seatOf.get(b.key).openNow ?? 0}/${seatOf.get(b.key).cap ?? '—'} kursi${seatOf.get(b.key).seatUsd ? ' · ' + usd(seatOf.get(b.key).seatUsd) + '/kursi' : ''}</div>` : ''}</td>
      <td class="num">${b.closes}</td>
      <td class="num ${b.winRate == null ? '' : cls(b.winRate - 50)}">${b.winRate == null ? '—' : pct(b.winRate, 1)}</td>
      <td class="num dim">${b.wins} / ${b.losses} / ${b.flat}</td>
      <td class="num ${cls(b.netUsd)}">${signed(b.netUsd)}</td>
      <td class="num ${cls(b.perCloseUsd ?? 0)}">${b.perCloseUsd == null ? '—' : signed(b.perCloseUsd)}</td>
    </tr>`).join(''));

  const total = win.books.reduce((s, b) => s + b.netUsd, 0);
  const closes = win.books.reduce((s, b) => s + b.closes, 0);
  setHTML($('#bookHint'), `${closes} posisi ditutup ${win.label} · hasil gabungan <strong class="${cls(total)}">${signed(total)}</strong>. `
    + 'Win rate dihitung dari posisi yang bergerak; kolom M / K / I adalah menang, kalah, dan impas (±0,5%, termasuk posisi yang harganya tidak pernah menyentuh rentang).'
    + (state.nav?.seats?.reserveUsd ? ` Cadangan bot ${usd(state.nav.seats.reserveUsd)}.` : ''));
  renderPaperBooks();
}

/** Hot potato di atas kertas — pembanding saja, bukan uang, tidak ikut total. */
function renderPaperBooks() {
  const box = $('#paperBooks');
  if (!box) return;
  const p = state.nav?.paperBooks;
  box.hidden = !p?.variants?.length;
  if (box.hidden) return;
  setHTML(box, `<h3>Hot potato di atas kertas <span class="pill">kertas · bukan uang</span></h3>
    <p class="hint">Simulasi pembanding dengan kursi ${usd(p.seatUsd)}, ${p.days ?? '—'} hari. Angka ini tidak dijumlahkan ke hasil asli di atas.</p>
    <div class="table-scroll"><table><thead><tr><th>Varian</th><th class="num">Kursi</th><th class="num">Ditutup</th><th class="num">Menang</th><th class="num">Hasil kertas</th><th class="num">Terbuka</th></tr></thead><tbody>
    ${p.variants.map((v) => `<tr><td>${esc(v.id)}<div class="sub2">${esc(v.label)}</div></td><td class="num">${v.seats ?? '—'}</td><td class="num">${v.closes ?? 0}</td>
      <td class="num dim">${v.wins ?? 0}</td><td class="num ${cls(v.netUsd ?? 0)}">${v.netUsd == null ? '—' : signed(v.netUsd)}</td>
      <td class="num dim">${v.open ?? 0}${v.openUsd ? ` · <span class="${cls(v.openUsd)}">${signed(v.openUsd)}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`);
}

const BOOK_COLOR = { bigcap: '#60a5fa', multi: '#4ade80', degen: '#fbbf24', hotpotato: '#fb923c' };

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
    const color = up ? 'var(--green)' : 'var(--red)';
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

  if (!rows.length && Array.isArray(state.nav?.history) && state.nav.source === 'snapshot') {
    // Snapshot sudah terbaca dan memang tidak punya riwayat harian (misalnya
    // bot yang hanya mencatat persen): kartunya disembunyikan, jangan sampai
    // kalender dana sebelumnya tertinggal di layar.
    const note = state.nav.trading?.capitalKnown === false ? null : state.nav.historyNote;
    $('#profitCard').hidden = !note;
    $('#calWrap').hidden = true; $('#chartWrap').hidden = true;
    setHTML($('#profitStats'), '');
    $('#profitHint').textContent = '';
    $('#profitNote').textContent = note ? `Belum ada riwayat harian: ${note}.` : '';
    return;
  }
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
const TABS = ['portfolio', 'investor', 'analys', 'bot', 'tentang'];
let currentTab = 'portfolio';

function fundMeta(id) {
  return state.funds.find((f) => f.id === id) || state.funds[0] || null;
}

function parseHash() {
  const parts = location.hash.replace('#', '').split('/').filter(Boolean);
  let fund = state.fund || state.funds[0]?.id;
  let tab = 'portfolio';
  if (!parts.length || parts[0] === 'home') return { home: true, tab: 'portfolio' };
  if (parts[0] === 'kinerja') return { kinerja: true, tab: 'portfolio' };
  if (parts[0] === 'pemegang') return { pemegang: true, tab: 'portfolio' };
  if (parts[0] === 'safebox') return { safebox: true, tab: 'portfolio' };
  if (parts[0] === 'index') return { index: true, tab: 'portfolio' };
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

/**
 * Menu utama: Beranda · Portofolio · Analys · [High risk ▾] [Medium risk ▾]
 * [Low risk ▾] [Dry run ▾] · Update. Tiap kelompok risiko adalah dropdown berisi
 * produknya (dibaca dari `risk` di funds.json), jadi dana baru tinggal muncul
 * di kelompoknya tanpa menambah tombol di baris menu.
 */
const NAV_GROUPS = [
  { key: 'high', label: 'High risk', color: '#fb7185' },
  { key: 'medium', label: 'Medium risk', color: '#fbbf24' },
  { key: 'low', label: 'Low risk', color: '#2dd4bf' },
  { key: 'paper', label: 'Dry run', color: '#c084fc' },
];
let navOpen = null;
function navItems(key) {
  const items = state.funds.filter((f) => (f.risk || 'paper') === key)
    .map((f) => ({ attr: `data-fund="${esc(f.id)}"`, name: f.label, sub: f.chain, accent: f.accent, on: state.view === 'fund' && f.id === state.fund }));
  if (state.safebox && (state.safebox.risk || 'low') === key) items.push({ attr: 'data-view="safebox"', name: state.safebox.label, sub: state.safebox.subtitle, accent: state.safebox.accent, on: state.view === 'safebox' });
  if (state.index && (state.index.risk || 'low') === key) items.push({ attr: 'data-view="index"', name: state.index.label, sub: state.index.subtitle, accent: state.index.accent, on: state.view === 'index' });
  return items;
}
function renderFundBar() {
  const top = (view, label, on) => `<button class="nav-top ${on ? 'on' : ''}" data-view="${view}">${label}</button>`;
  const groups = NAV_GROUPS.map((g) => {
    const items = navItems(g.key);
    if (!items.length) return '';
    const cur = items.find((i) => i.on);
    return `<div class="nav-group ${cur ? 'on' : ''} ${navOpen === g.key ? 'open' : ''}" style="--g:${g.color}">
      <button class="nav-top" data-menu="${g.key}" aria-haspopup="true" aria-expanded="${navOpen === g.key}">
        <span class="nav-dot"></span><span class="nav-lbl">${g.label}${cur ? `<small>${esc(cur.name)}</small>` : ''}</span><span class="nav-caret">▾</span></button>
      <div class="nav-menu" role="menu"${navOpen === g.key ? '' : ' hidden'}>${items.map((i) => `<button role="menuitem" ${i.attr} class="${i.on ? 'on' : ''}">
        <span class="fdot" style="background:${i.accent}"></span><span class="nav-item"><b>${esc(i.name)}</b><small>${esc(i.sub || '')}</small></span>${i.on ? '<span class="nav-check">✓</span>' : ''}</button>`).join('')}</div>
    </div>`;
  }).join('');
  setHTML($('#fundBar'), top('home', 'Beranda', state.view === 'home') + top('analisa', 'Portofolio', state.view === 'analisa')
    + top('kinerja', 'Analys', state.view === 'kinerja') + groups + top('update', 'Update', state.view === 'update'));
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
  for (const url of [...new Set(urls)]) {
    try {
      const j = await getJSON(url);
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
    // Laju harian mengikuti kinerja bot (Cashood Index), dikurung 0 sampai
    // batas harian. Tabel di bawah memakai rata-rata yang sudah terjadi dan
    // batas atasnya — laju satu hari saja bisa 0 dan tidak mewakili.
    const maxDay = Number(rate.maxMonthlyPct ?? 3) / 30 / 100;   // laju yang tepat menghabiskan jatah bulanan
    const avgDay = Number(rate.avgMonthlyPct ?? 0) / 30 / 100;

    // Satu kolom saja. Bunga di sini TIDAK diputar lagi: yang menghasilkan
    // tetap pokoknya, dan bunga yang sudah masuk berhenti di tempatnya. Kolom
    // "bunga diputar lagi" yang dulu ada di sini menjanjikan hal yang tidak
    // dilakukan Safe Box.
    const rows = [['1 hari', 1], ['1 minggu', 7], ['1 bulan', 30], ['3 bulan', 90], ['6 bulan', 180], ['1 tahun', 365]]
      .map(([label, days]) => {
        const avg = modal * avgDay * days, top = modal * maxDay * days;
        return `<tr>
          <td>${label}</td>
          <td class="num pos">${usd(avg)}</td>
          <td class="num pos">${usd(top)}</td>
          <td class="num"><strong>${usd(modal + top)}</strong></td>
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
            <div class="n">pokok ${usd(d.principalUsd)} + bunga berjalan ${usd(d.interestUsd, 2)}</div>
            <div class="sb-pill"><span class="led ${(d.earning ?? d.inRange) ? 'live' : ''}"></span>${(d.earning ?? d.inRange) ? 'sedang menghasilkan' : 'sedang tidak menghasilkan'}</div>
          </div>
          <div class="stat"><div class="k">Bunga hari ini</div>
            <div class="v pos">${usd(d.interestTodayUsd ?? rate.perDayUsd ?? 0, 2)}</div>
            <div class="n">${d.interestDay ? fmtDay(d.interestDay) : ''} · imbal hasil yang masuk hari ini</div></div>
          ${Number(d.paidUsd) > 0 ? `<div class="stat"><div class="k">Sudah ditarik</div>
            <div class="v pos">${usd(d.paidUsd, 2)}</div>
            <div class="n">bunga dibayar ke pemilik${d.lastPayout?.at ? ` · terakhir ${fmtDay(new Date(d.lastPayout.at + 7 * 3600e3).toISOString().slice(0, 10))}` : ''}</div></div>`
          : `<div class="stat"><div class="k">Total bunga</div>
            <div class="v pos">${usd(d.interestUsd, 2)}</div>
            <div class="n">${(d.days || []).length || 1} hari tercatat · menumpuk tiap hari</div></div>`}
          <div class="stat"><div class="k">Laju hari ini</div>
            <div class="v">${rate.dailyPct == null ? '—' : pct(rate.dailyPct, 2)} <span class="dim" style="font-size:.6em">/hari</span></div>
            <div class="n">jatah minggu ini ${pct(rate.weekUsedPct ?? 0, 2)} / ${pct(rate.weekQuotaPct ?? 0.75, 2)} · bulan ini ${pct(rate.monthUsedPct ?? 0, 2)} / ${pctRate(rate.maxMonthlyPct ?? 3)}${
              Number(rate.reserveUsd) > 0 ? ` · cadangan ${usd(rate.reserveUsd, 2)}` : ''}</div></div>
        </div>
        <p class="hint" style="margin-top:14px">Bunganya <strong>dihitung tiap hari mengikuti kinerja bot Cashood</strong>:
          rata-rata kenaikan <a href="#index">Cashood Index</a> selama ${rate.windowDays ?? 7} hari terakhir. Satu hari turun tidak langsung
          membuat bunga 0. Jatahnya <strong>${pct(rate.weekQuotaPct ?? 0.75, 2)} per minggu</strong>: minggu yang bagus berhenti di jatah itu dan
          kelebihannya disimpan sebagai cadangan; minggu yang rugi diisi sebagian dari cadangan itu. Sebulan
          <strong>paling banyak ${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)}</strong> dari pokok — itu batas atas, bukan janji.
          Angka hari ini masih bisa berubah sampai tengah malam WIB, lalu dikunci.
          Riwayat ini adalah pencatatan hak bunga, bukan bukti pembayaran atau jaminan hasil investasi.</p>
      </section>

      ${(d.owners || []).length ? `<section class="card">
        <div class="card-head">
          <h2>Pemilik simpanan</h2>
          <span class="hint">bunga dibagi menurut porsi pokok · ditarik tiap tanggal 1, pokok tetap</span>
        </div>
        <div class="table-scroll"><table class="mcards">
          <thead><tr><th>Pemilik</th><th class="num">Pokok</th><th class="num">Porsi</th><th class="num">Bunga hari ini</th><th class="num">Bunga berjalan</th><th class="num">Sudah ditarik</th><th class="num">Saldo</th></tr></thead>
          <tbody>${d.owners.map((o) => `<tr>
            <td class="mc-head"><span class="who"><span class="chip" style="background:${o.color || '#2dd4bf'}"></span>${esc(o.name)}</span>${o.left ? '<div class="sub2">sudah keluar · sisa bunga dibayar tanggal 1</div>' : ''}</td>
            <td class="num" data-k="Pokok">${usd(o.principalUsd)}</td>
            <td class="num" data-k="Porsi">${pct(o.sharePct)}</td>
            <td class="num pos" data-k="Bunga hari ini">${usd(o.interestTodayUsd, 2)}</td>
            <td class="num pos" data-k="Bunga berjalan">${usd(o.interestUsd, 2)}</td>
            <td class="num" data-k="Sudah ditarik">${usd(o.paidUsd || 0, 2)}</td>
            <td class="num" data-k="Saldo"><strong>${usd(o.balanceUsd)}</strong></td></tr>`).join('')}
            <tr class="mc-total"><td class="mc-head"><strong>Total</strong></td>
              <td class="num" data-k="Pokok"><strong>${usd(d.principalUsd)}</strong></td>
              <td class="num" data-k="Porsi">100,00%</td>
              <td class="num pos" data-k="Bunga hari ini"><strong>${usd(d.interestTodayUsd ?? 0, 2)}</strong></td>
              <td class="num pos" data-k="Bunga berjalan"><strong>${usd(d.interestUsd, 2)}</strong></td>
              <td class="num" data-k="Sudah ditarik"><strong>${usd(d.paidUsd || 0, 2)}</strong></td>
              <td class="num" data-k="Saldo"><strong>${usd(d.balanceUsd)}</strong></td></tr>
          </tbody>
        </table></div>
      </section>` : ''}

      <section class="card" id="sbInvoices"><div class="card-head"><h2>Invoice</h2><span class="hint">imbal hasil yang ditarik tiap tanggal 1</span></div>
        <div id="sbInvoiceList"><p class="dim">memuat…</p></div></section>

      ${(d.days || []).length > 1 ? `<section class="card">
        <div class="card-head">
          <h2>Bunga harian</h2>
          <span class="hint">imbal hasil tiap hari · berjalan ${usd(d.interestUsd, 2)}${Number(d.paidUsd) > 0 ? ` · sudah ditarik ${usd(d.paidUsd, 2)}` : ''}</span>
        </div>
        <div class="table-scroll"><table class="daily"><thead><tr><th>Tanggal</th><th class="num">Laju</th><th class="num">Bunga</th><th>Status</th></tr></thead><tbody>
          ${(() => {
            // Hari sebelum pembayaran terakhir sudah ditarik ke pemilik; sesudahnya
            // masih berjalan dan akan ditarik tanggal 1 berikutnya.
            const cut = d.lastPayout?.at ? new Date(d.lastPayout.at + 7 * 3600e3).toISOString().slice(0, 10) : null;
            return [...d.days].reverse().slice(0, 14).map((x) => {
              const paid = cut && x.date < cut;
              return `<tr><td>${fmtDay(x.date)}</td><td class="num dim">${x.ratePct == null ? '—' : pct(x.ratePct, 3)}</td><td class="num pos">${usd(x.usd, 2)}</td>
                <td class="${paid ? 'dim' : 'pos'}">${paid ? `ditarik ${fmtDay(cut)}` : 'berjalan'}${x.fromReserve > 0 ? ' · dari cadangan' : x.capped ? ' · jatah penuh' : ''}</td></tr>`;
            }).join('');
          })()}
        </tbody></table></div>
      </section>` : ''}

      <section class="card">
        <div class="card-head">
          <h2>Apa itu Safe Box</h2>
          <span class="hint">cara kerjanya, apa adanya</span>
        </div>
        <p class="lead">Safe Box bekerja seperti deposito: pokoknya disimpan pengelola, dan bunganya mengikuti kinerja
          bot-bot Cashood — <strong>0 sampai ${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)} per bulan</strong>,
          dihitung harian dan <strong>ditarik ke pemilik tiap tanggal 1</strong>. Pokoknya tetap di dalam dan terus bekerja.</p>
        <div class="two">
          <div><h3 class="sub-h">Bagaimana bunganya ditentukan</h3><ul class="plain">
            <li>Tiap hari dilihat Cashood Index — gabungan kinerja bot-bot Cashood yang memakai uang asli.</li>
            <li>Bunga hari itu = rata-rata kenaikan index ${rate.windowDays ?? 7} hari terakhir. Seminggu turun atau datar: tidak ada bunga baru dari bot.</li>
            <li>Jatah <strong>${pct(rate.weekQuotaPct ?? 0.75, 2)} per minggu</strong> (Senin–Minggu). Kalau penuh, bunga minggu itu berhenti dan
                kelebihannya <strong>disimpan sebagai cadangan</strong>.</li>
            <li>Minggu yang rugi diisi dari cadangan itu, paling banyak jatah harian normal — jadi bunga tidak langsung kosong.</li>
            <li>Sebulan paling banyak <strong>${rate.maxMonthlyPct == null ? '—' : pctRate(rate.maxMonthlyPct)}</strong> dari pokok. Itu batas atas, bukan janji:
                bulan yang buruk bisa jauh di bawahnya, karena pokoknya yang dijaga.</li>
            <li>Bunga yang sudah dicatat pada satu hari tidak pernah ditarik kembali.</li>
            <li><strong>Bunga tidak diputar ulang.</strong> Yang bekerja tetap uang pokok; bunga menumpuk di sampingnya
                dan tidak ikut menghasilkan bunga baru.</li>
          </ul></div>
          <div><h3 class="sub-h">Yang dijamin dan yang tidak</h3><ul class="plain">
            <li><strong>Pokok simpanan dijamin tidak hilang.</strong> Tidak ada margin call, tidak ada likuidasi yang bisa
                menghapus dana di dalam Safe Box.</li>
            <li><strong>Anti rugi, tapi tidak pasti untung.</strong> Hari bot rugi bunganya 0 dan bulan yang buruk bisa
                hampir tanpa bunga — yang tidak terjadi adalah saldonya berkurang.</li>
            <li>Ke instrumen mana dana ini ditempatkan bersifat rahasia dan menjadi kewenangan pengelola.</li>
            <li>Bunga dan saldo di halaman ini dihitung ulang setiap hari dari catatan yang sama; tidak ada angka
                yang ditulis tangan.</li>
          </ul></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Kalau laju bunganya bertahan</h2>
          <span class="hint">laju rata-rata yang sudah terjadi dan batas tertingginya — bukan proyeksi pasar</span>
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
          <thead><tr><th>Jangka</th><th class="num">Bunga · laju rata-rata</th><th class="num">Bunga · maksimal</th><th class="num">Pokok + bunga maks</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="hint disclaimer">Tabel ini mengalikan laju rata-rata sejauh ini dan batas ${pctRate(rate.maxMonthlyPct ?? 3)} per bulan
          ke depan — bukan ramalan. Bunga nyatanya mengikuti kinerja bot tiap hari. <strong>Bunganya tidak diputar lagi:</strong> yang menghasilkan
          tetap uang pokok, dan bunga yang sudah masuk berhenti di tempatnya — pokok ${usd(modal, 0)} yang sudah
          berbunga ${usd(100, 0)} tetap bekerja dengan ${usd(modal, 0)}, bukan ${usd(modal + 100, 0)}.</p>
      </section>`);

    renderSafeboxInvoices();
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

async function renderSafeboxInvoices() {
  const box = $('#sbInvoiceList');
  if (!box) return;
  if (!reportsCache) {
    try {
      const r = await fetch('reports/index.json?v=' + Math.floor(Date.now() / 600000), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      reportsCache = r.ok ? await r.json() : [];
    } catch { reportsCache = []; }
  }
  const mine = (Array.isArray(reportsCache) ? reportsCache : []).filter((m) => m.fund === 'safebox');
  if (!$('#sbInvoiceList')) return;
  setHTML($('#sbInvoiceList'), !mine.length ? '<p class="dim">Belum ada invoice. Invoice dibuat tiap tanggal 1 saat imbal hasil ditarik.</p>'
    : `<div class="table-scroll"><table class="reports"><thead><tr><th>Invoice</th><th>Tanggal bayar</th><th class="num">Ditarik</th><th></th></tr></thead><tbody>`
      + mine.map((m) => `<tr><td><div>${esc(m.periodLabel)}</div><div class="inv-no">${String(m.invoiceNo || '').split('/').join('/<wbr>')}</div></td>
        <td>${esc(m.payLabel)}</td><td class="num pos">${usd(m.distributedUsd, 2)}</td>
        <td class="pdf-actions"><a class="btn-pdf" href="${m.pdf}" download="${m.pdf.split('/').pop()}">Download</a>
          <a class="btn-pdf ghost" href="${m.pdf}" target="_blank" rel="noopener">Lihat</a></td></tr>`).join('') + '</tbody></table></div>');
}

function showSafebox() {
  state.view = 'safebox';
  leaveHome();
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'analys', 'bot', 'tentang'].forEach((t) => { if ($('#tab-' + t)) $('#tab-' + t).hidden = true; });
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

function renderAnalisa(body = $('#analisaBody'), fund = analisaFund || state.fund,
  stillHere = () => analisaFund === fund && state.view === 'analisa') {
  if (body === $('#analisaBody')) {
    const available = state.funds.filter(f => f.forecast !== false);
    setHTML($('#segAnalisa'), available.map(f => `<button data-af="${esc(f.id)}" class="${f.id === fund ? 'on' : ''}">${esc(f.label)}</button>`).join(''));
  }
  setHTML(body, '<p class="hint">memuat analisa…</p>');
  loadForecast(fund).then(f => {
    if (!stillHere()) return;
    if (!f || !f.enough) {
      setHTML(body, `<section class="card"><h2>Belum cukup data terverifikasi</h2><p>${esc(f?.reason || 'Analisa belum tersedia.')}</p>
        <p class="hint">${Number(f?.samples || 0)} hari memenuhi syarat. Proyeksi memerlukan sedikitnya tujuh hari selesai; setoran, penarikan, dan pembayaran harus tercatat.</p></section>`);
      return;
    }
    // Peluang sekecil apa pun tidak ditulis "0%": aturan pemilik, 2026-09-19 —
    // "kasih paling kecil pun 0.001%, jangan bener-bener 0%". Nol di simulasi
    // berarti kejadiannya tidak muncul di undian, bukan mustahil; menulisnya
    // "<0,001%" mengatakan hal yang sama tanpa terbaca sebagai jaminan.
    const peluang = v => v == null ? '—' : (v < 0.001 ? '<0,001%' : v < 0.01 ? '<0,01%' : pct(v, 2));
    const hor = key => f.horizons.find(h => h.key === key);
    const kartuRugi = (f.lossScenarios || []).map(l => {
      const sebulan = hor('m1')?.risk?.[`p${l.dropPct}`];
      const seminggu = hor('w1')?.risk?.[`p${l.dropPct}`];
      const setahun = hor('y1')?.risk?.[`p${l.dropPct}`];
      return `<div class="scen-card loss">
        <div class="scen-k">Peluang dana turun ${l.dropPct}% bulan ini</div>
        <div class="scen-v ${sebulan >= 20 ? 'neg' : ''}">${peluang(sebulan)}</div>
        <div class="scen-d">kalau terjadi, dana jadi <b>${usd(l.navUsd, 0)}</b> <span class="neg">${usd(l.changeUsd, 0)}</span></div>
        <div class="scen-rows">
          <div class="scen-row"><span>Peluang dalam seminggu</span><b>${peluang(seminggu)}</b></div>
          <div class="scen-row"><span>Peluang dalam setahun</span><b>${peluang(setahun)}</b></div>
          <div class="scen-row"><span>Harga saham jadi</span><b>${l.sharePrice ? usd(l.sharePrice, 4) : '—'}</b></div>
        </div></div>`;
    }).join('');
    // Dividen yang terkumpul, bukan total aset: modal dana dipatok, jadi yang
    // bertambah adalah dividen. Sebelum tanggal 1 pertama, uang yang sudah
    // disapu keluar ditampilkan sebagai yang menunggu dibayar — bukan nol.
    const barisDividen = f.horizons.map(h => {
      const belum = (h.best.dividendsUsd || 0) <= 0;
      const kol = q => belum ? (q.sweptUsd || 0) : q.dividendsUsd;
      return `<tr><td>${esc(h.label)}${h.speculative ? ' <span class="pill out">spekulatif</span>' : ''}</td>
        <td class="num pos"><strong>${usd(kol(h.normal), 0)}</strong>${belum ? '<div class="n dim">sudah ditarik, menunggu tanggal 1</div>' : ''}</td>
        <td class="num dim">${usd(kol(h.worst), 0)}</td><td class="num dim">${usd(kol(h.best), 0)}</td>
        <td class="num">${usd(h.normal.navUsd, 0)}</td></tr>`;
    }).join('');
    setHTML(body, `<section class="card"><div class="card-head"><h2>${esc(fundMeta(fund)?.label)} · perkiraan nilai dana pada ${esc(f.paydayDate)}</h2><span class="hint">${esc(f.generatedAt)}</span></div>
      <p>Nilai dana sekarang ${usd(f.navNow)} · harga saham ${usd(f.sharePriceNow, 4)}. Diundi ulang dari ${f.sample.days} hari hasil nyata yang sudah terverifikasi, ${esc(f.sample.from)} sampai ${esc(f.sample.to)}.</p>
      <div class="stats three">${[['Terburuk', f.scenarios.worst], ['Normal', f.scenarios.normal], ['Terbaik', f.scenarios.best]].map(([k, q]) => `<div class="stat"><div class="k">${k}</div><div class="v">${usd(q.totalUsd, 0)}</div><div class="n">total aset + dividen diterima</div></div>`).join('')}</div></section>
      <section class="card"><div class="card-head"><h2>Dividen yang terkumpul kalau bot terus berjalan</h2><span class="hint">nilai tengah, terburuk, terbaik</span></div>
        <div class="table-scroll"><table><thead><tr><th>Jangka</th><th class="num">Dividen terkumpul</th><th class="num">Terburuk</th><th class="num">Terbaik</th><th class="num">Nilai dana</th></tr></thead><tbody>${barisDividen}</tbody></table></div>
        <p class="hint">Kolom terburuk dan terbaik adalah rentang yang wajar, bukan batas — satu dari sepuluh perjalanan berakhir di luar keduanya. Uang yang sudah disapu keluar tidak ikut naik-turun lagi, jadi dana yang turun setelahnya tidak mengurangi dividen yang sudah diamankan.</p></section>
      <section class="card"><div class="card-head"><h2>Worst Case</h2><span class="hint">seberapa mungkin, dan seberapa dalam</span></div>
        <div class="scen">${kartuRugi}</div>
        <p class="hint" style="margin-top:12px">Dibaca begini: dari seluruh kemungkinan perjalanan dana ke depan yang diundi, sekian persen di antaranya pernah menyentuh penurunan sebesar itu. Angka kecil bukan berarti mustahil, dan angka besar bukan berarti pasti.</p>
        <div class="table-scroll" style="margin-top:14px"><table><thead><tr><th>Jangka</th><th class="num">Turun ≥10%</th><th class="num">Turun ≥50%</th><th class="num">Turun ≥90%</th></tr></thead><tbody>
        ${f.horizons.map(h => `<tr><td>${esc(h.label)}</td><td class="num ${h.risk.p10 > 5 ? 'neg' : ''}">${peluang(h.risk.p10)}</td><td class="num ${h.risk.p50 > 1 ? 'neg' : 'dim'}">${peluang(h.risk.p50)}</td><td class="num dim">${peluang(h.risk.p90)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h2>Batas analisa</h2><ul>${f.caveats.map(c=>`<li>${esc(c)}</li>`).join('')}</ul><p class="hint">${esc(f.method)}</p></section>`);
  }).catch(err => { if (stillHere()) setHTML(body, `<p class="miss">Analisa tidak bisa ditampilkan: ${esc(err.message)}</p>`); });
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
      // Sama dengan kartu dana: laba yang diputar kembali ikut jadi modal.
      depositedUsd: ledger.deposited + (Number(ledger.reinvested) || 0),
      pnlUsd: snap?.trading?.capitalKnown === false ? null
        : total + ledger.withdrawn - dividendTotals(cfg).gross + dividendTotals(cfg).net - ledger.deposited - (Number(ledger.reinvested) || 0),
      updatedAt: Number(snap?.updatedAt) || null,
      paper: Boolean(meta?.paper),
      risk: meta?.risk || null,
      capacityUsd: Number(cfg.fund?.capacityUsd) || 0,
      history: Array.isArray(snap?.history) ? snap.history : [],
      // Arus uang masuk/keluar dana (setoran +, penarikan & dividen −), untuk
      // memisahkan perubahan nilai karena kinerja dari perubahan karena setoran.
      flows: cashFlows(cfg),
      cfg,
      type: meta?.type || null,
      perf: snap?.performance || null,
      costsUsd: (cfg.costs?.items || []).reduce((s, i) => s + (Number(i.usd) || 0), 0),
      feePct: Number(cfg.dividend?.investorFeePct) || 0,
      feeStdPct: Number(cfg.dividend?.investorFeeStandardPct) || 0,
      openCount: Number(snap?.stats?.openCount ?? (snap?.positions || []).length) || 0,
      winRate: snap?.performance?.trades?.winRate ?? snap?.stats?.winRate ?? null,
      closedCount: Number(snap?.stats?.closedCount) || Number(snap?.performance?.trades?.count) || 0,
      owners: ledger.owners.filter((o) => o.units > 0)
        .map((o) => ({ id: o.id, name: o.name, color: o.color, share: (o.units / ledger.totalUnits) * 100, value: o.units * unit,
          deposited: o.deposited, withdrawn: o.withdrawn - (dividendByOwner(cfg)[o.id]?.gross || 0) + (dividendByOwner(cfg)[o.id]?.net || 0) }))
        .sort((a, b) => b.share - a.share),
    };
  })();
  portoCache.set(id, { job, at: Date.now() });
  job.catch(() => portoCache.delete(id));
  return job;
}

/** Angka global yang sama untuk halaman Portofolio dan Beranda. */
async function portoTotals() {
  const ids = (state.funds || []).filter((f) => !f.paper).map((f) => f.id);
  const boxJob = state.safebox ? loadSafebox().catch(() => null) : Promise.resolve(null);   // bersamaan dengan dana
  const loaded = await Promise.all(ids.map(id => loadFundBrief(id).catch(() => null)));
  const briefs = loaded.filter(Boolean);
  const box = await boxJob;
  const dana = briefs.reduce((s, b) => s + b.totalUsd, 0);
  const simpanan = Number(box?.balanceUsd) || 0;
  const setoran = briefs.reduce((s, b) => s + b.depositedUsd, 0) + (Number(box?.principalUsd) || 0);
  const untung = briefs.reduce((s, b) => s + (b.pnlUsd || 0), 0) + (Number(box?.interestUsd) || 0) + (Number(box?.paidUsd) || 0);
  const orang = new Set([...briefs.flatMap((b) => b.owners.map((o) => o.name)), ...(box?.owners || []).map((o) => o.name)]).size;
  return { ids, briefs, missing: ids.filter((id, i) => !loaded[i]), box, dana, simpanan, total: dana + simpanan, setoran, untung, orang };
}

async function renderPortofolio() {
  const card = $('#portoCard');
  if (!card) return;
  // Dana simulasi tidak memegang uang sungguhan; menjumlahkannya ke total aset
  // akan membuat total itu bohong.
  const ids = (state.funds || []).filter((f) => !f.paper).map((f) => f.id);
  const boxJob = state.safebox ? loadSafebox().catch(() => null) : Promise.resolve(null);
  const loaded = await Promise.all(ids.map(id => loadFundBrief(id).catch(() => null)));
  const missing = ids.filter((id, i) => !loaded[i]);
  const briefs = loaded.filter(Boolean);
  const box = await boxJob;

  const dana = briefs.reduce((s, b) => s + b.totalUsd, 0);
  const simpanan = Number(box?.balanceUsd) || 0;
  // Safe Box ikut dihitung sebagai modal dan laba pemiliknya: pokoknya uang
  // yang disetor, bunganya laba yang sudah jadi. Tanpa ini, "total aset"
  // memuat Safe Box tapi "modal masuk" dan "untung" tidak — tiga angka yang
  // tidak bisa dijumlahkan satu sama lain.
  const pokokBox = Number(box?.principalUsd) || 0;
  // Bunga yang sudah ditarik tetap hasil Safe Box, meski saldonya kembali ke pokok.
  const bungaBox = (Number(box?.interestUsd) || 0) + (Number(box?.paidUsd) || 0);
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
        <span class="porto-val">${usd(box.balanceUsd)}<span class="n pos">+${usd((box.interestUsd || 0) + (box.paidUsd || 0), 2)}</span></span>
      </div>
      <div class="table-scroll"><table class="porto-tbl"><tbody>
        ${(box.owners || []).map(o => `<tr><td>${esc(o.name)}</td><td class="num">${pct(o.sharePct)}</td><td class="num">${usd(o.balanceUsd)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="dim" style="margin:6px 0 0">Bunga hari ini ${usd(box.interestTodayUsd ?? 0, 2)} · laju ${box.measure?.dailyPct == null ? '—' : pct(box.measure.dailyPct, 2)}/hari (maks ${pct(box.measure?.maxMonthlyPct ?? 3, 0)}/bulan).</p>
    </div>` : ''));
}

/**
 * Analys: kinerja NYATA sebuah dana — dari posisi yang sudah ditutup dan dari
 * deret nilai dananya — lalu prediksinya di bawah. Semua angka dihitung
 * exporter (scripts/lib/performance.mjs) dari yang benar-benar terjadi; halaman
 * ini hanya menggambarnya. Angka yang datanya belum cukup ditulis "—" dengan
 * alasannya, bukan diisi perkiraan.
 */
let anSection = 'drawdown';
const durasi = (m) => {
  if (!Number.isFinite(m)) return '—';
  if (m < 60) return `${Math.round(m)} menit`;
  if (m < 1440) return `${Math.floor(m / 60)} j ${Math.round(m % 60)} m`;
  return `${(m / 1440).toFixed(1)} hari`;
};
const tgl = (ms) => (Number.isFinite(ms) ? fmtDay(new Date(ms + 7 * 3600e3).toISOString().slice(0, 10)) : '—');

function radarSvg(axes) {
  const names = [['winRate', 'Win rate'], ['profitFactor', 'Profit factor'], ['risk', 'Risiko'], ['recovery', 'Pemulihan'], ['consistency', 'Konsistensi']];
  const W = 300, H = 250, cx = 150, cy = 128, R = 88;
  const pt = (i, r) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / names.length; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const ring = (f) => names.map((_, i) => pt(i, R * f).map((v) => v.toFixed(1)).join(',')).join(' ');
  const grid = [0.25, 0.5, 0.75, 1].map((f) => `<polygon points="${ring(f)}" class="rd-grid"/>`).join('');
  const spokes = names.map((_, i) => { const [x, y] = pt(i, R); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rd-grid"/>`; }).join('');
  const shape = names.map(([k], i) => pt(i, R * ((axes?.[k] ?? 0) / 100)).map((v) => v.toFixed(1)).join(',')).join(' ');
  const labels = names.map(([k, n], i) => {
    const [x, y] = pt(i, R + 22);
    const miss = axes?.[k] == null;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" class="rd-lbl${miss ? ' rd-miss' : ''}">${n}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="radar" role="img" aria-label="DNA strategi">${grid}${spokes}<polygon points="${shape}" class="rd-shape"/>${labels}</svg>`;
}

function renderAnalys() {
  const fund = state.fund;
  const nav = state.nav || {};
  const perf = nav.performance || null;
  const cfg = state.cfg || {};
  const t = perf?.trades || null, e = perf?.equity || null, sc = perf?.score || null;
  const withheld = perf?.equityWithheld || null;
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  const pctOrDash = (v, dp = 2) => (v == null ? '—' : pct(v, dp));

  // ── ringkasan kinerja ──
  const pfNote = t?.profitFactorBasis === 'pct' ? 'dari persen per posisi' : 'laba kotor ÷ rugi kotor';
  setHTML($('#anTiles'), perf ? [
    tile('Untung / rugi dana', signed(perf.profitUsd), perf.profitPct == null ? '—' : `${perf.profitPct >= 0 ? '+' : ''}${pct(perf.profitPct)} dari modal`, cls(perf.profitUsd)),
    tile('Win rate', pctOrDash(t?.winRate), t ? `${t.wins} menang · ${t.losses} kalah · ${t.flat} impas` : 'belum ada posisi ditutup'),
    tile('Posisi per hari', t?.tradesPerDay == null ? '—' : String(t.tradesPerDay), t ? `${t.count} posisi ditutup` : '—'),
    tile('Penurunan terdalam', withheld ? '—' : pctOrDash(e?.maxDrawdownPct), withheld ? 'ditahan — arus kas belum tercatat' : (e ? `${usd(e.maxDrawdownUsd, 0)} dari puncak` : 'data belum cukup'), withheld ? '' : 'neg'),
    tile('Profit factor', t?.profitFactor == null ? '—' : String(t.profitFactor), pfNote, t?.profitFactor >= 1 ? 'pos' : 'neg'),
    tile('Recovery factor', perf.recoveryFactor == null ? '—' : String(perf.recoveryFactor), withheld ? 'ditahan — arus kas belum tercatat' : 'untung ÷ penurunan terdalam', perf.recoveryFactor >= 1 ? 'pos' : ''),
  ].join('') : '<p class="miss">Data kinerja belum tersedia untuk dana ini.</p>');
  $('#anSnapHint').textContent = t ? `sejak ${tgl(t.firstAt)} · diperbarui ${ago(perf.generatedAt)}` : '';

  // ── DNA strategi ──
  setHTML($('#anRadar'), sc ? radarSvg(sc.axes) : '');
  const axisRows = [['winRate', 'Win rate', 'win rate itu sendiri'], ['profitFactor', 'Profit factor', 'PF 1 → 0, PF 3 → 100'],
    ['risk', 'Risiko', '100 − 2,5 × penurunan terdalam'], ['recovery', 'Pemulihan', 'recovery factor 5 → 100'], ['consistency', 'Konsistensi', '% hari yang naik']];
  setHTML($('#anScore'), sc ? `
    <div class="dna-total">${sc.complete ? `<span class="dna-num">${sc.overall}</span><span class="dim">/ 100</span>` : '<span class="dna-num dim">—</span>'}
      <div class="n">${sc.complete ? 'skor keseluruhan' : 'skor keseluruhan butuh kelima sumbu'}</div></div>
    <table class="dna-tbl"><tbody>${axisRows.map(([k, n, how]) => `<tr><td>${n}<div class="n dim">${how}</div></td><td class="num">${sc.axes[k] == null ? '—' : sc.axes[k]}</td></tr>`).join('')}</tbody></table>` : '');

  // ── info sistem & tentang strategi ──
  // Buku paper bisa membawa penjelasan strateginya sendiri di snapshot.
  const fromBot = nav.strategy || null;
  const st = fromBot ? { ...(cfg.strategy || {}), ...fromBot, about: fromBot.about?.length ? fromBot.about : (cfg.strategy?.about || []),
    system: fromBot.system?.length > 1 ? fromBot.system : (cfg.strategy?.system || []), risks: cfg.strategy?.risks || [],
    requirements: fromBot.requirements?.length ? fromBot.requirements : (cfg.strategy?.requirements || []) } : (cfg.strategy || {});
  const ledger = state.ledger || {};
  const sistem = isTrading() ? [...(st.system || []), ['Modal simulasi', usdText(ledger.deposited || 0, 0)]] : [...(st.system || []),
    ['Modal masuk', usdText((ledger.deposited || 0) + (ledger.reinvested || 0), 0)],
    ['Plafon dana', cfg.fund?.capacityUsd ? usdText(cfg.fund.capacityUsd, 0) : '—'],
    ['Biaya bulanan', usdText(monthlyCosts(), 0)],
    ['Pemegang saham', String((ledger.owners || []).filter((o) => o.units > 0).length)]];
  setHTML($('#anSystemBody'), `<table class="kv"><tbody>${sistem.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`);
  $('#anAboutTitle').textContent = st.title || 'Tentang strategi';
  setHTML($('#anAboutBody'), `
    ${(st.about || []).map((x) => `<p>${esc(x)}</p>`).join('')}
    ${st.ruleList?.length ? `<h3 class="sub-h">Aturan bot</h3><ul class="plain">${st.ruleList.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="two">
      <div><h3 class="sub-h">${esc(st.requirementsTitle || 'Yang dibutuhkan')}</h3><table class="kv"><tbody>${(st.requirements || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>
      <div><h3 class="sub-h">Risiko yang harus dipahami</h3><ul class="plain">${(st.risks || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>
    <p class="hint disclaimer">Kinerja masa lalu tidak menjamin hasil ke depan. Semua angka di halaman ini dihitung dari data dana yang sebenarnya dan diperbarui otomatis; tidak ada yang ditulis tangan.</p>`);

  // ── analitik rinci ──
  $('#segAn').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-a') === anSection));
  let detail = '';
  if (anSection === 'drawdown') {
    detail = withheld ? `<p class="miss">${esc(withheld)}</p>` : e ? `
      <p class="lead">Seberapa jauh nilai dana pernah turun dari puncak sebelumnya — dihitung titik per titik tiap sepuluh menit, sesudah setoran dan penarikan dikeluarkan. Ini "floating" terdalam yang pernah dialami dana.</p>
      <div class="dd-row"><div><div class="k">Terdalam sepanjang catatan</div><div class="n">${usd(e.maxDrawdownPeakUsd, 0)} → ${usd(e.maxDrawdownTroughUsd, 0)} · ${tgl(e.maxDrawdownAt)}</div></div><div class="v neg">${pct(e.maxDrawdownPct)}</div></div>
      <div class="dd-bar"><i style="width:${Math.min(100, e.maxDrawdownPct * 2)}%"></i></div>
      <div class="dd-row"><div><div class="k">Sekarang dari puncak</div><div class="n">${e.currentDrawdownPct > 0 ? `${usd(e.currentDrawdownUsd, 0)} di bawah puncak` : 'sedang di puncak'}</div></div><div class="v ${e.currentDrawdownPct > 0 ? 'neg' : 'pos'}">${pct(e.currentDrawdownPct)}</div></div>
      <div class="dd-bar"><i style="width:${Math.min(100, e.currentDrawdownPct * 2)}%"></i></div>
      <div class="stats three" style="margin-top:14px">
        ${tile('Hari terbaik', pctOrDash(e.bestDayPct), `dari ${e.days} hari`, 'pos')}
        ${tile('Hari terburuk', pctOrDash(e.worstDayPct), `dari ${e.days} hari`, 'neg')}
        ${tile('Hari yang naik', pctOrDash(e.positiveDaysPct), 'dari seluruh hari tercatat')}
      </div>` : '<p class="miss">Belum cukup titik nilai dana untuk menghitung penurunan.</p>';
  } else if (anSection === 'risk') {
    const ratio = (name, v, how, need) => `<div class="ratio"><div><div class="ratio-name">${name}</div><div class="n dim">${how}</div></div><div class="ratio-v">${v == null ? `<span class="dim" title="${need}">—</span>` : v}</div></div>`;
    detail = withheld ? `<p class="miss">${esc(withheld)}</p>` : e ? `
      <p class="lead">Berapa hasil yang didapat untuk setiap satuan risiko. Makin tinggi makin baik. Rasio tahunan dari periode pendek mudah melebar tak masuk akal, jadi angkanya baru terbit setelah datanya cukup.</p>
      ${ratio('Sharpe ratio', e.sharpe, 'hasil untuk tiap satuan naik-turun harian', 'butuh minimal 14 hari')}
      ${ratio('Sortino ratio', e.sortino, 'seperti Sharpe, tapi hanya hari yang rugi yang dihitung sebagai risiko', 'butuh minimal 14 hari')}
      ${ratio('Calmar ratio', e.calmar, 'hasil tahunan untuk tiap satuan penurunan terdalam', 'butuh minimal 30 hari')}
      <p class="hint">${e.days} hari tercatat sejak ${tgl(e.since)}.</p>` : '<p class="miss">Belum cukup data nilai dana.</p>';
  } else {
    const money = (v) => (v == null ? '—' : usd(v));
    const both = (u, p) => (u != null ? money(u) : (p == null ? '—' : `${p >= 0 ? '+' : ''}${pct(p)}`));
    detail = t ? `
      <div class="stats three">
        ${tile('Profit factor', t.profitFactor == null ? '—' : String(t.profitFactor), pfNote, t.profitFactor >= 1 ? 'pos' : 'neg')}
        ${tile('Rata-rata per posisi', both(t.expectancyUsd, t.expectancyPct), t.usdComplete ? 'hasil bersih rata-rata' : 'dalam persen — bot tidak mencatat dolar')}
        ${tile('Lama rata-rata', durasi(t.avgHoldMinutes), 'dari buka sampai tutup')}
      </div>
      <div class="table-scroll" style="margin-top:14px"><table class="wl">
        <thead><tr><th>Ukuran</th><th class="num">Menang</th><th class="num">Kalah</th></tr></thead>
        <tbody>
          <tr><td>Rata-rata</td><td class="num pos">${both(t.avgWinUsd, t.avgWinPct)}</td><td class="num neg">${both(t.avgLossUsd, t.avgLossPct)}</td></tr>
          <tr><td>Terbaik / terburuk</td><td class="num pos">${both(t.best.usd, t.best.pct)}<div class="n dim">${esc(t.best.symbol || '')}</div></td><td class="num neg">${both(t.worst.usd, t.worst.pct)}<div class="n dim">${esc(t.worst.symbol || '')}</div></td></tr>
          <tr><td>Beruntun terpanjang</td><td class="num">${t.longestWinStreak}×</td><td class="num">${t.longestLossStreak}×</td></tr>
          <tr><td>Total kotor</td><td class="num pos">${money(t.grossProfitUsd)}</td><td class="num neg">${money(t.grossLossUsd)}</td></tr>
          <tr><td>Jumlah posisi</td><td class="num">${t.wins}</td><td class="num">${t.losses}</td></tr>
        </tbody></table></div>
      <p class="hint">Menang/kalah memakai ambang impas yang sama dengan laporan bot; ${t.flat} posisi impas tidak ikut membagi win rate.${t.usdComplete ? '' : ' Total kotor dalam dolar tidak ditampilkan karena bot tidak mencatat nilai dolar tiap posisi.'}</p>` : '<p class="miss">Belum ada posisi yang ditutup.</p>';
  }
  if (perf?.equityNote && anSection !== 'activity') detail += `<p class="hint">${esc(perf.equityNote)}</p>`;
  setHTML($('#anDetailBody'), detail);

  // ── prediksi, pindahan dari halaman Portofolio ──
  const box = $('#anForecast');
  const bolehPrediksi = state.funds.some((f) => f.id === fund && f.forecast !== false);
  if (bolehPrediksi) renderAnalisa(box, fund, () => state.fund === fund && currentTab === 'analys' && state.view === 'fund');
  else setHTML(box, '');
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
  leaveHome();
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'analys', 'bot', 'tentang'].forEach((t) => { if ($('#tab-' + t)) $('#tab-' + t).hidden = true; });
  $('#tab-safebox').hidden = true;
  $('#tab-analisa').hidden = true;
  $('#tab-update').hidden = false;
  renderFundBar();
  if (location.hash !== '#update') history.replaceState(null, '', '#update');
  renderUpdates();
}

function showAnalisa(fund) {
  state.view = 'analisa';
  leaveHome();
  analisaFund = fund || analisaFund || state.funds[0]?.id;
  $('#tabs').hidden = true;
  ['portfolio', 'investor', 'analys', 'bot', 'tentang'].forEach((t) => { if ($('#tab-' + t)) $('#tab-' + t).hidden = true; });
  $('#tab-safebox').hidden = true;
  $('#tab-update').hidden = true;
  $('#tab-analisa').hidden = false;
  renderFundBar();
  renderPortofolio().catch(() => { const c = $('#portoCard'); if (c) c.hidden = true; });
  // Prediksi tiap dana pindah ke tab "Analys" dana itu sendiri (permintaan
  // pemilik, 2026-09-26). Halaman ini tinggal ringkasan seluruh dana.
  if ($('#segAnalisa')) $('#segAnalisa').hidden = true;
  if ($('#analisaBody')) $('#analisaBody').hidden = true;
  const want = `#analisa/${analisaFund}`;
  if (location.hash !== want) history.replaceState(null, '', want);
}

/* ── beranda ─────────────────────────────────────────────────────────────
 *
 * Halaman depan perusahaan: total aset seluruh dana, produk menurut tingkat
 * risiko, dan menu. Angkanya dibaca dari snapshot yang sama dengan halaman
 * tiap dana — tidak ada angka yang ditulis tangan di sini.
 */
const ICON = {
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><path d="M20.2 20.2c2-2-.9-8.1-6.4-13.6S2.8 1.8.8 3.8"/><path d="M3.8 20.2c-2-2 .9-8.1 6.4-13.6S21.2 1.8 23.2 3.8" transform="translate(-1.6 0)"/>',
  zap: '<path d="M13 2L4 14h8l-1 8 9-12h-8l1-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 006.2 21h11.6a2 2 0 001.7-2.5L14 9V3"/><path d="M7 15h10"/>',
  vault: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5M7 20v1.5M17 20v1.5"/>',
  pie: '<path d="M21 12A9 9 0 1112 3v9z"/><path d="M15 3.5A9 9 0 0120.5 9H15z"/>',
  bell: '<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 003.4 0"/>',
  file: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18.5 20a6.5 6.5 0 00-3-5.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3"/>',
};
const FUND_ICON = { reborn: 'trend', meridian: 'orbit', ferari: 'zap', robsol: 'sun', charon: 'flask', forex: 'globe', binance: 'coins' };
const svgIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ICON.info}</svg>`;
const iconTile = (name, color) => `<span class="itile" style="--c:${color}"><i class="orb a"></i><i class="orb b"></i><i class="orb c"></i><span class="ibox">${svgIcon(name)}</span></span>`;

const RISK = [
  { key: 'high', title: 'Risiko tinggi', note: 'Hasil paling besar, naik-turun paling tajam.', color: '#fb7185' },
  { key: 'medium', title: 'Risiko menengah', note: 'Robot LP yang lebih tenang, hasil dibagi tiap tanggal 1.', color: '#fbbf24' },
  { key: 'low', title: 'Risiko rendah', note: 'Pokok dijaga, imbal hasil mengikuti pasar.', color: '#2dd4bf' },
  { key: 'paper', title: 'Uji coba · dry run', note: 'Strategi diuji dengan dana virtual atau modal kertas sebelum memakai uang sungguhan.', color: '#c084fc' },
];

function leaveHome() {
  for (const id of ['#tab-home', '#tab-kinerja', '#tab-pemegang', '#tab-index']) if ($(id)) $(id).hidden = true;
  if ($('#strip')) $('#strip').hidden = false;
  if (document.body.classList.contains('at-home')) {
    document.body.classList.remove('at-home');
    const meta = fundMeta(state.fund);
    if (meta && /^#[0-9a-f]{6}$/i.test(meta.accent)) document.documentElement.style.setProperty('--accent', meta.accent);
    $('#tagline').textContent = state.cfg?.app?.tagline || '';
    if (meta) document.title = `${meta.label} — Cashood Headfund`;
  }
}

const GLOBAL_TABS = ['portfolio', 'investor', 'analys', 'bot', 'tentang', 'analisa', 'safebox', 'update', 'home', 'kinerja', 'pemegang', 'index'];
function showGlobal(view, title) {
  state.view = view;
  $('#tabs').hidden = true;
  GLOBAL_TABS.forEach((t) => { if ($('#tab-' + t)) $('#tab-' + t).hidden = t !== view; });
  $('#strip').hidden = true;
  document.body.classList.add('at-home');
  document.title = title;
  document.documentElement.style.setProperty('--accent', '#4ade80');   // halaman ringkasan: warna netral, bukan warna dana terakhir
  $('#tagline').textContent = 'Dana kripto yang dikelola AI';
  renderFundBar();
  if (location.hash !== '#' + view && !(view === 'home' && !location.hash)) history.replaceState(null, '', '#' + view);
  window.scrollTo(0, 0);
}
/* ── Cashood Index ───────────────────────────────────────────────────────
 * Satu angka untuk seluruh dana sungguhan. Dihitung exporter (sync-index.mjs)
 * dari harga saham tiap dana; halaman ini hanya menggambarnya.
 */
async function loadIndex() {
  for (const url of [(rawDataBase('index') || RAW_BASE + 'index/') + 'live.json', 'data/index/live.json']) {
    try { const j = await getJSON(url); if (j?.fund === 'index' && Number.isFinite(j.level)) return j; } catch { /* sumber berikutnya */ }
  }
  return null;
}
async function loadIndexSeries() {
  for (const url of [(rawDataBase('index') || RAW_BASE + 'index/') + 'nav.json', 'data/index/nav.json']) {
    try { const j = await getJSON(url); if (Array.isArray(j?.points)) return j.points; } catch { /* sumber berikutnya */ }
  }
  return [];
}
function showIndex() { showGlobal('index', 'Cashood Index — Cashood Headfund'); renderIndex().catch(() => {}); }

const indexView = { hours: 168 };
const idxCalc = { capital: 1000, rate: 3 };
let indexEpoch = 0;
async function renderIndex() {
  const epoch = ++indexEpoch;
  const body = $('#indexBody');
  const [d, pts] = await Promise.all([loadIndex(), loadIndexSeries()]);
  if (epoch !== indexEpoch || state.view !== 'index') return;
  if (!d) { setHTML(body, '<section class="card"><p class="miss">Data index belum tersedia.</p></section>'); return; }
  const sign = (v, dp = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${pct(v, dp)}`);
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  const lvl = (v) => Number(v).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setHTML(body, `
    <section class="card idx-hero">
      <div class="card-head"><h2>Cashood Index</h2><span class="pill sim">${esc(d.status || 'belum dibuka')}</span></div>
      <div class="idx-top">
        <div class="idx-level"><div class="k">Level index</div><div class="v">${lvl(d.level)}</div>
          <div class="n">mulai ${lvl(d.baseLevel)} pada ${tgl(d.baseAt)} · diperbarui ${ago(d.updatedAt)}</div></div>
        <div class="stats three">
          ${tile('Sejak awal', sign(d.changePct), `dari level ${lvl(d.baseLevel)}`, cls(d.changePct))}
          ${tile('24 jam', sign(d.change24hPct), 'perubahan level', cls(d.change24hPct || 0))}
          ${tile('7 hari', sign(d.change7dPct), 'perubahan level', cls(d.change7dPct || 0))}
        </div>
      </div>
      <div class="controls"><div class="seg" id="segIndex" role="group" aria-label="Rentang grafik index">
        <button data-h="24" class="${indexView.hours === 24 ? 'on' : ''}">24 jam</button><button data-h="168" class="${indexView.hours === 168 ? 'on' : ''}">7 hari</button><button data-h="0" class="${indexView.hours === 0 ? 'on' : ''}">semua</button></div></div>
      <div class="hg-chart chart-wrap"><svg id="idxChart" viewBox="0 0 720 220" role="img" aria-label="Level Cashood Index"></svg></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Isi index</h2><span class="hint">${d.components.length} dana · bobot mengikuti besar dana</span></div>
      <div class="alloc idx-alloc">${d.components.map((c) => `<i style="width:${c.weightPct}%;background:${c.accent}" title="${esc(c.label)} ${c.weightPct}%"></i>`).join('')}</div>
      <div class="table-scroll"><table class="mcards">
        <thead><tr><th>Dana</th><th class="num">Bobot</th><th class="num">Harga saham</th><th class="num">Sejak masuk index</th><th class="num">Nilai dana</th></tr></thead>
        <tbody>${d.components.map((c) => `<tr>
          <td class="mc-head"><a class="who idx-link" href="#${esc(c.id)}/portfolio"><span class="chip" style="background:${c.accent}"></span>${esc(c.label)} <small class="dim">${esc(c.chain || '')}</small></a></td>
          <td class="num" data-k="Bobot"><b>${pct(c.weightPct, 1)}</b></td>
          <td class="num" data-k="Harga saham">${usd(c.unitPrice, 4)}</td>
          <td class="num ${cls(c.changePct)}" data-k="Sejak masuk index">${sign(c.changePct)}</td>
          <td class="num" data-k="Nilai dana">${usd(c.fundUsd, 0)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    ${(d.holders || []).length ? `<section class="card">
      <div class="card-head"><h2>Pemegang index</h2><span class="hint">modal tetap bekerja · kelebihannya jadi dividen</span></div>
      <div class="table-scroll"><table class="mcards">
        <thead><tr><th>Pemegang</th><th class="num">Modal</th><th class="num">Nilai sekarang</th><th class="num">Dividen berjalan</th><th class="num">Dividen diterima</th><th class="num">Untung / rugi</th></tr></thead>
        <tbody>${d.holders.map((h) => `<tr>
          <td class="mc-head"><span class="who"><span class="chip" style="background:${h.color || '#f59e0b'}"></span>${esc(h.name)}${h.test ? ' <span class="pill sim">uji coba</span>' : ''}</span></td>
          <td class="num" data-k="Modal">${usd(h.capitalUsd)}</td>
          <td class="num" data-k="Nilai sekarang"><b>${usd(h.valueUsd)}</b></td>
          <td class="num pos" data-k="Dividen berjalan">${usd(h.accruedDividendUsd)}</td>
          <td class="num" data-k="Dividen diterima">${usd(h.receivedUsd)}</td>
          <td class="num ${cls(h.pnlUsd)}" data-k="Untung / rugi">${signed(h.pnlUsd)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint">Nilai = unit index × level sekarang, jadi ikut naik dan turun. "Dividen berjalan" adalah kelebihan nilai di atas modal saat ini — itu yang dibagikan kalau bertahan sampai tanggal pembagian.</p>
    </section>` : ''}

    ${d.dividend ? `<section class="card">
      <div class="card-head"><h2>Dividen</h2><span class="hint">dibagikan tiap tanggal ${d.dividend.payDayOfMonth} · berikutnya ${fmtDay(d.dividend.nextPayDate)}</span></div>
      <div class="stats three">
        ${tile('Dividen berjalan', usd(d.dividend.accruedUsd), 'kalau dibagikan hari ini', d.dividend.accruedUsd > 0 ? 'pos' : '')}
        ${tile('Sudah dibagikan', usd(d.dividend.paidUsd), 'sejak index dimulai')}
        ${tile('Laju nyata index', d.dividend.monthlyRatePct == null ? '—' : sign(d.dividend.monthlyRatePct) , d.dividend.monthlyRatePct == null ? 'data belum cukup' : `per bulan · dari ${d.dividend.rateSpanDays} hari data`, cls(d.dividend.monthlyRatePct || 0))}
      </div>
      <div class="two" style="margin-top:14px">
        <div><h3 class="sub-h">Aturannya</h3><ul class="plain">
          <li><strong>Modal tetap bekerja.</strong> Yang dibagikan hanya kelebihan nilai di atas modal.</li>
          <li>Contoh: modal $1.000 naik jadi $1.030 → dividen $30, saldo kembali $1.000.</li>
          <li><strong>Dividen tidak pernah memotong saldo di bawah modal.</strong></li>
          <li>Kalau nilai di bawah modal (misalnya $950), tidak ada dividen sampai nilainya kembali di atas modal.</li>
        </ul></div>
        <div><h3 class="sub-h">Riwayat dividen</h3>
          <div class="table-scroll"><table><thead><tr><th>Periode</th><th>Pemegang</th><th class="num">Dividen</th></tr></thead><tbody>
            ${(d.dividend.history || []).length ? d.dividend.history.slice().reverse().map((p) => `<tr><td>${esc(p.period || tgl(p.at))}</td><td>${esc(p.name)}</td><td class="num pos">${usd(p.usd)}</td></tr>`).join('')
              : `<tr><td>${fmtDay(d.dividend.nextPayDate)} <span class="dim">(berjalan)</span></td><td class="dim">semua pemegang</td><td class="num">${usd(d.dividend.accruedUsd)}</td></tr>
                 <tr><td colspan="3" class="dim">Belum ada dividen yang dibagikan: $0.</td></tr>`}
          </tbody></table></div></div>
      </div>
    </section>

    <section class="card" id="idxCalcCard">
      <div class="card-head"><h2>Simulasi dividen</h2><span class="hint">asumsi, bukan janji</span></div>
      <div class="calc">
        <label class="field"><span>Modal (USD)</span><input type="number" id="idxCap" min="0" step="any" value="${idxCalc.capital}"></label>
        <label class="field"><span>Asumsi hasil per bulan (%)</span><input type="number" id="idxRate" step="any" value="${idxCalc.rate}"></label>
        <div class="field quick"><span>Isi cepat</span><div class="seg" id="idxQuick">
          ${d.dividend.monthlyRatePct == null ? '' : `<button data-v="${d.dividend.monthlyRatePct}">laju nyata</button>`}<button data-v="2">2%</button><button data-v="4">4%</button><button data-v="6">6%</button></div></div>
      </div>
      <div id="idxCalcOut"></div>
      <p class="hint disclaimer">Simulasi ini mengalikan asumsi yang kamu pilih; hasil sebenarnya bisa lebih kecil, nol, atau minus. Laju nyata index dihitung dari data yang masih pendek (${d.dividend.rateSpanDays} hari), jadi belum bisa dijadikan patokan. Dividen dibayarkan, tidak diputar ulang, sehingga setahun = 12 × sebulan.</p>
    </section>` : ''}

    <section class="card">
      <div class="card-head"><h2>Apa itu Cashood Index</h2><span class="hint">cara kerjanya, apa adanya</span></div>
      <p class="lead">Cashood Index adalah <strong>satu produk berisi seluruh dana Cashood</strong>. Daripada memilih satu bot,
        pemegang index ikut semuanya sekaligus: kalau satu bot sedang turun, bot lain bisa menahannya.</p>
      <div class="two">
        <div><h3 class="sub-h">Cara kerjanya</h3><ul class="plain">
          <li>Level index mulai dari 100 dan bergerak mengikuti <strong>rata-rata tertimbang</strong> hasil semua dana di dalamnya.</li>
          <li>Dana yang lebih besar bobotnya lebih besar.</li>
          <li>Yang diukur adalah harga saham tiap dana, jadi setoran baru dan pembagian profit tidak dihitung sebagai naik-turun.</li>
          <li>Bot baru yang lulus uji coba (dry run) otomatis masuk ke index.</li>
          <li>Safe Box dan dana uji coba tidak termasuk.</li>
        </ul></div>
        <div><h3 class="sub-h">Yang perlu dipahami</h3><ul class="plain">
          <li><strong>Index bisa turun.</strong> Isinya bot yang sama dengan produk lain; menggabungkannya menyebar risiko, bukan menghilangkannya.</li>
          <li>Tidak ada jaminan pokok dan tidak ada janji persentase hasil.</li>
          <li>Hasil masa lalu tidak menjamin hasil ke depan.</li>
          <li>Produk ini masih <strong>uji coba</strong>: pemegang yang tampil adalah setoran uji, bukan uang sungguhan.</li>
        </ul></div>
      </div>
    </section>`);
  // ── simulasi dividen ──
  const calc = () => {
    const out = $('#idxCalcOut'); if (!out) return;
    const cap = Math.max(0, Number(idxCalc.capital) || 0), rate = Number(idxCalc.rate) || 0;
    const today = new Date(Date.now() + 7 * 3600e3), dim = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    const left = Math.max(0, dim - today.getUTCDate() + 1) / dim;        // sisa bulan ini
    const perMonth = Math.max(0, cap * rate / 100), first = Math.max(0, cap * rate / 100 * left);
    const row = (k, v, n) => `<tr><td>${k}<div class="n dim">${n}</div></td><td class="num ${v > 0 ? 'pos' : ''}"><b>${usd(v)}</b></td></tr>`;
    setHTML(out, `<div class="table-scroll"><table><thead><tr><th>Perkiraan</th><th class="num">Dividen</th></tr></thead><tbody>
      ${row(`Dividen ${fmtDay(d.dividend.nextPayDate)}`, first, 'sisa bulan ini saja')}
      ${row('Dividen per bulan', perMonth, 'bulan penuh')}
      ${row('Dividen per tahun', perMonth * 12, `${pct(Math.max(0, rate) * 12, 1)} dari modal, tanpa diputar ulang`)}
    </tbody></table></div>`
      + (rate < 0 ? `<p class="miss">Dengan asumsi ${pct(rate)} per bulan tidak ada dividen, dan saldo ikut turun: ${usd(cap)} menjadi sekitar ${usd(cap * (1 + rate / 100))} setelah sebulan.</p>` : ''));
  };
  if ($('#idxCap')) {
    calc();
    $('#idxCap').oninput = (e) => { idxCalc.capital = e.target.value; calc(); };
    $('#idxRate').oninput = (e) => { idxCalc.rate = e.target.value; calc(); };
    $('#idxQuick').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; idxCalc.rate = b.getAttribute('data-v'); $('#idxRate').value = idxCalc.rate; calc(); };
  }

  const draw = () => {
    const now = Date.now(), from = indexView.hours ? now - indexView.hours * 3600e3 : 0;
    const list = pts.filter((p) => p.t >= from).map((p) => ({ t: p.t, v: p.usd }));
    drawIndexChart($('#idxChart'), list.length > 1 ? list : pts.map((p) => ({ t: p.t, v: p.usd })), lvl);
  };
  draw();
  $('#segIndex').onclick = (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    indexView.hours = Number(btn.getAttribute('data-h'));
    $('#segIndex').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
    draw();
  };
}

function drawIndexChart(svg, pts, fmt) {
  if (!svg || pts.length < 2) { if (svg) setHTML(svg, ''); return; }
  const small = narrow();
  const W = small ? 420 : 720, H = small ? 240 : 220, m = { t: 16, r: 58, b: 26, l: 6 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.12 || 1;
  const y0 = lo - pad, y1 = hi + pad, t0 = pts[0].t, t1 = pts.at(-1).t;
  const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const up = pts.at(-1).v >= pts[0].v, color = up ? '#4ade80' : '#f87171';
  const span = t1 - t0, tick = (t) => { const d = new Date(t + 7 * 3600e3); return span <= 36 * 3600e3 ? d.toISOString().slice(11, 16) : `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]}`; };
  setHTML(svg, `<defs><linearGradient id="idxFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${[hi, (hi + lo) / 2, lo].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="g-grid"/><text x="${W - m.r + 6}" y="${(y(v) + 4).toFixed(1)}" class="g-lbl">${fmt(v)}</text>`).join('')}
    <line x1="${m.l}" x2="${W - m.r}" y1="${y(pts[0].v).toFixed(1)}" y2="${y(pts[0].v).toFixed(1)}" class="g-base"/>
    <path d="${line}L${x(t1).toFixed(1)},${H - m.b}L${x(t0).toFixed(1)},${H - m.b}Z" fill="url(#idxFill)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="${x(t1).toFixed(1)}" cy="${y(pts.at(-1).v).toFixed(1)}" r="4.5" fill="${color}"/>
    ${[t0, t0 + span / 2, t1].map((t, i) => `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="g-lbl">${tick(t)}</text>`).join('')}`);
}

function showKinerja() { showGlobal('kinerja', 'Analys seluruh bot — Cashood Headfund'); renderKinerja().catch(() => {}); }
function showPemegang() { showGlobal('pemegang', 'Data investor — Cashood Headfund'); renderPemegang().catch(() => {}); }

function showHome() {
  state.view = 'home';
  $('#tabs').hidden = true;
  GLOBAL_TABS.forEach((t) => { if ($('#tab-' + t)) $('#tab-' + t).hidden = t !== 'home'; });
  $('#tab-home').hidden = false;
  $('#strip').hidden = true;
  document.body.classList.add('at-home');
  document.title = 'Cashood Headfund — dana kripto yang dikelola AI';
  document.documentElement.style.setProperty('--accent', '#4ade80');
  $('#tagline').textContent = 'Dana kripto yang dikelola AI';
  renderFundBar();
  if (location.hash && location.hash !== '#home') history.replaceState(null, '', '#home');
  renderHome().catch(() => {});
}

/**
 * Kuota investor: setoran (modal masuk) dibanding plafon produk. Diukur dari
 * setoran, bukan nilai sekarang — dana yang turun karena rugi tidak membuka
 * kuota baru (aturan pemilik 2026-10-01). Dana uji coba: kuotanya = modal
 * yang sedang dipakai, jadi selalu penuh.
 */
function quota(used, cap, paper) {
  if (!(cap > 0) || used == null) return '';
  const fill = Math.min(100, (used / cap) * 100), sisa = Math.max(0, cap - used);
  return `<div class="quota${sisa <= 0 ? ' full' : ''}">
    <div class="q-top"><span>${paper ? 'Modal uji coba' : 'Kuota investor'}</span><b>${usd(Math.min(used, cap), 0)} / ${usd(cap, 0)}</b></div>
    <div class="q-bar"><i style="width:${fill.toFixed(1)}%"></i></div>
    <div class="q-n">${paper ? 'uji coba — belum menerima investor' : sisa > 0 ? `sisa kuota ${usd(sisa, 0)}` : 'kuota penuh'}</div></div>`;
}
let sbCapacity = null;

/* ── perkembangan total dana (beranda) ─────────────────────────────────── */
const homeView = { hours: 24 };
const seriesCache = new Map();
async function loadFundSeries(b) {
  const hit = seriesCache.get(b.id);
  if (hit && Date.now() - hit.at < 60000) return hit.points;
  const pts = (await readNavSeries(b.cfg, { fund: b.id })).map((p) => ({ t: Number(p.t), usd: Number(p.usd) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.usd)).sort((a, b2) => a.t - b2.t);
  seriesCache.set(b.id, { at: Date.now(), points: pts });
  return pts;
}
const valueAt = (pts, t) => { let lo = 0, hi = pts.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t) { ans = pts[m]; lo = m + 1; } else hi = m - 1; } return ans; };
/** Perubahan nilai dalam jendela waktu, tanpa setoran/penarikan/dividen. */
function fundChange(pts, flows, nowUsd, ms, now = Date.now()) {
  if (!pts.length) return null;
  const base = valueAt(pts, now - ms) || pts[0];
  if (!(base.usd > 0) || now - base.t < ms * 0.25) return null;
  const flow = flows.filter((f) => f.at > base.t && f.at <= now).reduce((t, f) => t + f.usd, 0);
  const delta = nowUsd - base.usd - flow;
  return { delta, pct: (delta / base.usd) * 100, from: base.t, base: base.usd };
}
const chgBadge = (c, label = '24 jam') => (!c ? '' : `<span class="chg ${c.delta >= 0 ? 'up' : 'down'}">${c.delta >= 0 ? '▲' : '▼'} ${pct(Math.abs(c.pct), 2)}<small>${label}</small></span>`);

// Naik-turun tiap dana di daftar total aset: persen dan nominalnya, dalam
// mata uang yang sedang dipilih.
const homeChg = new Map();
function paintLegendChg() {
  document.querySelectorAll('.leg-chg').forEach((el) => {
    const c = homeChg.get(el.getAttribute('data-leg'));
    if (!c) { setHTML(el, '<span class="dim">—</span>'); el.className = 'leg-chg'; return; }
    el.className = `leg-chg ${c.delta >= 0 ? 'up' : 'down'}`;
    el.title = c.label;
    setHTML(el, `${c.delta >= 0 ? '▲' : '▼'} ${c.delta >= 0 ? '+' : '−'}${pct(Math.abs(c.pct), 2)} <span class="leg-usd">${signed(c.delta)}</span>`);
  });
}
let growthEpoch = 0;
async function renderGrowth(g, paper = []) {
  const epoch = ++growthEpoch;
  const briefs = g.briefs;
  const series = await Promise.all(briefs.map((b) => loadFundSeries(b).catch(() => [])));
  const paperSeries = await Promise.all(paper.map((b) => loadFundSeries(b).catch(() => [])));
  if (epoch !== growthEpoch || state.view !== 'home') return;
  const now = Date.now(), box = g.box;
  const boxStart = Date.parse(`${state.safebox?.startedAt || '2026-09-12'}T00:00:00+07:00`);

  // Tanda naik-turun 24 jam per dana dan untuk total.
  let totalDelta = 0, totalBase = 0;
  const todayIso = new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
  homeChg.clear();
  const badge = (b, pts) => {
    // Dompet yang hanya dibaca (setoran/penarikan pemilik tidak tercatat):
    // perubahan nilainya bisa karena uang dipindah, bukan kinerja. Untuk dana
    // seperti itu yang dipakai profit posisi yang ditutup hari ini.
    const external = b.cfg?.fund?.cashFlowsRecorded === false;
    let c, label = '24 jam';
    if (external) {
      const today = Number((b.history || []).find((r) => r.date === todayIso)?.usd) || 0;
      c = b.totalUsd > 0 ? { delta: today, pct: (today / b.totalUsd) * 100, base: b.totalUsd } : null;
      label = 'hari ini';
    } else c = fundChange(pts, b.flows, b.totalUsd, 86400e3, now);
    const el = document.querySelector(`[data-chg="${CSS.escape(b.id)}"]`);
    if (el) setHTML(el, chgBadge(c, label));
    if (c && !b.paper) homeChg.set(b.id, { ...c, label });
    return c;
  };
  briefs.forEach((b, i) => { const c = badge(b, series[i]); if (c) { totalDelta += c.delta; totalBase += c.base; } });
  paper.forEach((b, i) => badge(b, paperSeries[i]));
  if (box) {
    totalDelta += Number(box.interestTodayUsd) || 0; totalBase += Number(box.principalUsd) || 0;
    if (box.principalUsd > 0) homeChg.set('safebox', { delta: Number(box.interestTodayUsd) || 0, pct: ((Number(box.interestTodayUsd) || 0) / box.principalUsd) * 100, label: 'hari ini' });
  }
  paintLegendChg();
  const tc = totalBase > 0 ? { delta: totalDelta, pct: (totalDelta / totalBase) * 100 } : null;
  if ($('#aumChg')) setHTML($('#aumChg'), tc ? `${chgBadge(tc)} <span class="aum-chg-usd ${cls(tc.delta)}">${signed(tc.delta)}</span>` : '');

  // Grafik total: nilai tiap dana dibawa maju dari titik terakhirnya, dijumlah.
  const earliest = Math.min(...series.filter((p) => p.length).map((p) => p[0].t), box ? boxStart : now);
  const from = homeView.hours ? Math.max(earliest, now - homeView.hours * 3600e3) : earliest;
  const step = homeView.hours === 24 ? 15 * 60e3 : homeView.hours === 168 ? 2 * 3600e3 : 6 * 3600e3;
  const pts = [];
  const partsAt = (t, latest) => {
    // Titik lama digeser sebesar setoran/penarikan sesudahnya (lihat cashFlows):
    // setoran tidak tergambar sebagai lonjakan untung.
    const parts = briefs.map((b, i) => {
      const at = latest ? null : valueAt(series[i], t);
      return { name: b.label, color: b.accent, usd: latest ? b.totalUsd : (at ? at.usd + flowsAfter(b.flows, at.t) : 0) };   // arus kas sesudah titik itu diamati
    });
    if (box && t >= boxStart) parts.push({ name: state.safebox?.label || 'Safe Box', color: state.safebox?.accent || '#2dd4bf', usd: Number(box.balanceUsd) || 0 });
    return parts.filter((p) => p.usd > 0);
  };
  for (let t = from; t <= now; t += step) {
    const parts = partsAt(t, false);
    pts.push({ t, v: parts.reduce((a, p) => a + p.usd, 0), parts });
  }
  pts.push({ t: now, v: g.total, parts: partsAt(now, true) });
  const flowIn = briefs.flatMap((b) => b.flows).filter((f) => f.at > from && f.at <= now).reduce((t, f) => t + f.usd, 0);
  const first = pts[0]?.v || 0;
  // 24 jam memakai jumlah perubahan per dana (sama dengan tanda di kartu
  // produk dan kartu total aset); rentang panjang memakai deret gabungan.
  const rangeDelta = homeView.hours === 24 && tc ? tc.delta : g.total - first;   // titik awal sudah memuat arus kas sesudahnya
  const rangeBase = homeView.hours === 24 && tc ? totalBase : first;
  setHTML($('#hgSum'), pts.length > 1 ? `<b class="num">${usd(g.total, 0)}</b>
    <span class="chg ${rangeDelta >= 0 ? 'up' : 'down'}">${rangeDelta >= 0 ? '▲' : '▼'} ${pct(Math.abs(rangeBase ? rangeDelta / rangeBase * 100 : 0), 2)}</span>
    <span class="${cls(rangeDelta)} num">${signed(rangeDelta)}</span><span class="dim">${homeView.hours === 24 ? '24 jam terakhir' : homeView.hours === 168 ? '7 hari terakhir' : 'sejak awal'}${Math.abs(flowIn) >= 1 ? ` · tanpa arus kas ${signedText(flowIn)}` : ''}</span>` : '<span class="dim">belum cukup data</span>');
  const marks = briefs.flatMap((b) => b.flows.map((f) => ({ ...f, fund: b.label }))).filter((f) => f.at > from && f.at <= now);
  const grouped = [];
  for (const f of marks.sort((a, b) => a.at - b.at)) {
    const last = grouped.at(-1);
    if (last && f.at - last.at < step * 2) last.usd += f.usd; else grouped.push({ at: f.at, usd: f.usd });
  }
  drawGrowth($('#hgChart'), pts, rangeDelta >= 0);
  const shown = grouped.filter((f) => Math.abs(f.usd) >= 50);
  $('#hgFlows').hidden = !shown.length;
  setHTML($('#hgFlows'), shown.length ? `<span class="hg-fl">Arus kas di rentang ini — grafik sudah disesuaikan, tidak dihitung sebagai naik-turun:</span>`
    + shown.map((f) => `<span class="hg-fi"><b>${tglJam(f.at)}</b> ${f.usd < 0 ? 'profit dibagikan / penarikan' : 'setoran masuk'} <b class="num">${signed(f.usd)}</b></span>`).join('') : '');

  // Hasil harian: profit posisi tertutup semua dana + imbal hasil Safe Box.
  const days = new Map();
  const put = (date, usdv, closes) => { const r = days.get(date) || { date, usd: 0, closes: 0 }; r.usd += usdv; r.closes += closes; days.set(date, r); };
  for (const b of briefs) for (const r of b.history || []) put(r.date, Number(r.usd) || 0, Number(r.closes) || 0);
  for (const d of box?.days || []) put(d.date, Number(d.usd) || 0, 0);
  homeCal.rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const today = homeCal.rows.find((r) => r.date === new Date(now + 7 * 3600e3).toISOString().slice(0, 10));
  setHTML($('#hgDailyHint'), `hari ini <b class="${cls(today?.usd || 0)}">${signed(today?.usd || 0)}</b>`);
  renderHomeCalendar();
}

const homeCal = { month: null, rows: [] };
function renderHomeCalendar() {
  const rows = homeCal.rows;
  if (!$('#hgCalGrid')) return;
  const map = new Map(rows.map((r) => [r.date, r]));
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
  if (!homeCal.month || !months.includes(homeCal.month)) homeCal.month = months.at(-1) || new Date().toISOString().slice(0, 7);
  const [yy, mm] = homeCal.month.split('-').map(Number);
  const first = new Date(Date.UTC(yy, mm - 1, 1)), ndays = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const peak = Math.max(1, ...rows.filter((r) => r.date.startsWith(homeCal.month)).map((r) => Math.abs(r.usd)));
  $('#hgCalTitle').textContent = `${M_SHORT[mm - 1]} ${yy}`;
  setHTML($('#hgCalDow'), D_SHORT.map((d) => `<span>${d}</span>`).join(''));
  $('#hgCalPrev').disabled = months.indexOf(homeCal.month) <= 0;
  $('#hgCalNext').disabled = months.indexOf(homeCal.month) >= months.length - 1;
  let cells = '', total = 0, closes = 0;
  for (let i = 0; i < first.getUTCDay(); i += 1) cells += '<div class="cell void"></div>';
  for (let d = 1; d <= ndays; d += 1) {
    const r = map.get(`${homeCal.month}-${String(d).padStart(2, '0')}`);
    if (!r) { cells += `<div class="cell void"><span class="d">${d}</span></div>`; continue; }
    total += r.usd; closes += r.closes;
    const a = 0.12 + 0.42 * (Math.abs(r.usd) / peak), rgb = r.usd >= 0 ? '74,222,128' : '248,113,113';
    cells += `<div class="cell" style="background:rgba(${rgb},${a.toFixed(3)});border-color:rgba(${rgb},.4)">
      <span class="d">${d}</span><span class="a ${cls(r.usd)}">${narrow() ? signedCompact(r.usd) : signed(r.usd)}</span>
      <span class="c">${r.closes ? `${r.closes} tutup` : 'bunga'}</span></div>`;
  }
  setHTML($('#hgCalGrid'), cells);
  setHTML($('#hgCalFoot'), `<span>${closes} posisi ditutup bulan ini</span><span>Total <b class="${cls(total)}">${signed(total)}</b></span>`);
}

function drawGrowth(svg, pts, up, marks = []) {
  if (!svg) return;
  if (pts.length < 2) { setHTML(svg, ''); return; }
  // Layar sempit: kanvas dengan proporsi HP, supaya label tidak mengecil.
  const small = narrow();
  const W = small ? 420 : 720, H = small ? 240 : 220, m = { t: 16, r: small ? 66 : 64, b: 26, l: 6 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.12 || hi * 0.01 || 1;
  const y0 = lo - pad, y1 = hi + pad, t0 = pts[0].t, t1 = pts.at(-1).t;
  const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const color = up ? '#4ade80' : '#f87171';
  const last = pts.at(-1);
  const fmtT = (t) => { const d = new Date(t + 7 * 3600e3); return homeView.hours === 24 ? d.toISOString().slice(11, 16) : `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
  const ticks = [t0, t0 + (t1 - t0) / 2, t1];
  setHTML(svg, `<defs><linearGradient id="hgFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${[hi, (hi + lo) / 2, lo].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="g-grid"/><text x="${W - m.r + 6}" y="${(y(v) + 4).toFixed(1)}" class="g-lbl">${usdText(v, 0)}</text>`).join('')}
    <line x1="${m.l}" x2="${W - m.r}" y1="${y(pts[0].v).toFixed(1)}" y2="${y(pts[0].v).toFixed(1)}" class="g-base"/>
    <path d="${line}L${x(t1).toFixed(1)},${H - m.b}L${x(t0).toFixed(1)},${H - m.b}Z" fill="url(#hgFill)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
    ${marks.map((f) => `<line x1="${x(f.at).toFixed(1)}" x2="${x(f.at).toFixed(1)}" y1="${m.t}" y2="${H - m.b}" class="g-flow"/>
      <text x="${(x(f.at) + 4).toFixed(1)}" y="${m.t + 10}" class="g-flow-lbl">${f.usd < 0 ? 'profit dibagikan' : 'setoran'} ${signedCompact(f.usd)}</text>`).join('')}
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5" fill="${color}"/>
    ${ticks.map((t, i) => `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="g-lbl">${fmtT(t)}</text>`).join('')}
    <line id="hgCross" class="g-cross" y1="${m.t}" y2="${H - m.b}" style="display:none"/>
    <circle id="hgDot" r="5" fill="${color}" stroke="#0b0e13" stroke-width="2" style="display:none"/>
    <rect id="hgHit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/>`);
  // Ditekan (HP) atau diarahkan kursor: tanggal, total, dan rincian tiap dana.
  const wrap = $('#hgWrap'), tip = $('#hgTip'), cross = svg.querySelector('#hgCross'), dot = svg.querySelector('#hgDot'), hit = svg.querySelector('#hgHit');
  if (!wrap || !tip || !hit) return;
  const when = (t) => { const d = new Date(t + 7 * 3600e3); return `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]} · ${d.toISOString().slice(11, 16)} WIB`; };
  const show = (ev) => {
    const box = wrap.getBoundingClientRect(), ratio = W / (box.width || W);
    const sx = (ev.clientX - box.left) * ratio;
    let near = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - sx) < Math.abs(x(near.t) - sx)) near = p;
    cross.setAttribute('x1', x(near.t)); cross.setAttribute('x2', x(near.t)); cross.style.display = '';
    dot.setAttribute('cx', x(near.t)); dot.setAttribute('cy', y(near.v)); dot.style.display = '';
    const parts = [...(near.parts || [])].sort((a, b) => b.usd - a.usd);
    setHTML(tip, `<div class="t-d">${when(near.t)}</div><div class="t-v">${usd(near.v)}</div>`
      + `<div class="t-n">total seluruh dana · termasuk token, LP, dan kas</div>`
      + (parts.length ? `<div class="t-parts">${parts.map((p) => `<div class="t-row"><span><i style="background:${p.color}"></i>${esc(p.name)}</span><b>${usd(p.usd, 0)}</b></div>`).join('')}</div>` : ''));
    tip.hidden = false;
    // Layar lebar: tooltip di SAMPING titik (kiri atau kanan, mana yang lapang),
    // menempel di atas grafik. Layar sempit: jadi panel di bawah grafik. Di
    // keduanya titik yang ditunjuk tidak pernah tertutup.
    if (narrow()) { tip.classList.add('dock'); tip.style.cssText = ''; return; }
    tip.classList.remove('dock');
    const px = x(near.t) / ratio, wTip = tip.offsetWidth, gap = 14;
    tip.style.transform = 'none';
    tip.style.top = '0px';
    tip.style.left = (px + gap + wTip <= box.width - 2 ? px + gap : Math.max(2, px - gap - wTip)) + 'px';
  };
  const hide = () => { tip.hidden = true; cross.style.display = 'none'; dot.style.display = 'none'; };
  hit.onpointermove = show;
  hit.onpointerdown = show;
  hit.onpointerleave = (ev) => { if (ev.pointerType === 'mouse') hide(); };
  if (!wrap.dataset.tapAway) {
    wrap.dataset.tapAway = '1';
    document.addEventListener('pointerdown', (ev) => { if (!wrap.contains(ev.target)) hide(); });
  }
}

let homeEpoch = 0;
async function renderHome() {
  const epoch = ++homeEpoch;
  // Dana sungguhan, dana uji coba, dan config Safe Box dimuat bersamaan.
  const paperJob = Promise.all(state.funds.filter((f) => f.paper).map((f) => loadFundBrief(f.id).catch(() => null)));
  const sbJob = sbCapacity == null && state.safebox?.configUrl
    ? getJSON(state.safebox.configUrl).then((c) => { sbCapacity = Number(c?.display?.capacityUsd) || 0; state.safebox.startedAt = c?.startedAt; }).catch(() => { sbCapacity = 0; })
    : Promise.resolve();
  const [g, paper] = await Promise.all([portoTotals(), paperJob, sbJob]);
  if (epoch !== homeEpoch || state.view !== 'home') return;
  const byId = Object.fromEntries([...g.briefs, ...paper.filter(Boolean)].map((b) => [b.id, b]));
  const box = g.box;

  // ── total aset + alokasi ──
  const parts = [...g.briefs.map((b) => ({ id: b.id, name: b.label, color: b.accent, usd: b.totalUsd })),
    ...(box ? [{ id: 'safebox', name: state.safebox.label, color: state.safebox.accent, usd: g.simpanan }] : [])]
    .filter((p) => p.usd > 0).sort((a, b) => b.usd - a.usd);
  const pnlPct = g.setoran ? (g.untung / g.setoran) * 100 : 0;
  const tua = Math.min(...g.briefs.map((b) => b.updatedAt || Date.now()), box?.updatedAt || Date.now());
  setHTML($('#homeAum'), `
    <div class="aum-k"><span class="live-dot"></span>Total aset dikelola${g.missing.length ? ' <span class="dim">(sebagian)</span>' : ''}</div>
    <div class="aum-v">${usd(g.total, 0)}</div>
    <div class="aum-rows">
      <div class="aum-row"><span class="aum-l">24 jam terakhir</span><span class="aum-chg" id="aumChg"><span class="dim">menghitung…</span></span></div>
      <div class="aum-row"><span class="aum-l">Sejak awal</span><span><b class="${cls(g.untung)} num">${signed(g.untung)}</b>
        <span class="dim"> · ${pnlPct >= 0 ? '+' : ''}${pct(pnlPct)} dari modal ${usd(g.setoran, 0)}</span></span></div>
    </div>
    <div class="alloc">${parts.map((p) => `<i style="width:${g.total ? (p.usd / g.total) * 100 : 0}%;background:${p.color}" title="${esc(p.name)}"></i>`).join('')}</div>
    <ul class="alloc-legend">${parts.map((p) => `<li>
      <span class="chip" style="background:${p.color}"></span>
      <span class="leg-l"><span class="nm">${esc(p.name)}</span><span class="leg-w">${g.total ? pct((p.usd / g.total) * 100, 1) : '—'} dari total</span></span>
      <span class="leg-r"><span class="v">${usd(p.usd, 0)}</span><span class="leg-chg" data-leg="${esc(p.id)}"></span></span></li>`).join('')}</ul>
    <div class="aum-foot">diperbarui ${ago(tua)} · tidak termasuk dana simulasi</div>`);

  // ── angka singkat ──
  const tile = (k, v, n) => `<div class="hs"><div class="hs-v">${v}</div><div class="hs-k">${k}</div><div class="hs-n">${n}</div></div>`;
  const posisi = g.briefs.reduce((s, b) => s + b.openCount, 0);
  setHTML($('#homeStats'), [
    tile('Dana berjalan', String(g.briefs.length), `+ Safe Box${paper.length ? ` · ${paper.length} uji coba` : ''}`),
    tile('Pemegang saham', String(g.orang), 'di seluruh produk'),
    tile('Posisi terbuka', String(posisi), 'sedang bekerja sekarang'),
    tile('Modal masuk', usd(g.setoran, 0), 'setoran + laba diputar'),
  ].join(''));

  // ── produk per tingkat risiko ──
  const card = (f) => {
    const b = byId[f.id];
    const pnlP = b && b.depositedUsd ? (b.pnlUsd / b.depositedUsd) * 100 : null;
    const pnlCell = b && b.pnlUsd == null ? '<span class="dim">tidak dihitung</span>' : b ? `${signed(b.pnlUsd)}<small>${pnlP == null ? '' : `${pnlP >= 0 ? '+' : ''}${pct(pnlP, 1)}`}</small>` : '—';
    // Fee protokol: biaya sistem per bulan + fee dari laba. Fee yang sedang
    // digratiskan ditulis dicoret, supaya investor tahu tarif normalnya.
    const fee = !b ? '—' : `${b.costsUsd ? usd(b.costsUsd, 0) + '<small>/bln</small> · ' : ''}${b.feePct > 0
      ? `${b.feePct}%` : b.feeStdPct > 0 ? `<s>${b.feeStdPct}%</s> <em class="free">free</em>` : '<em class="free">free</em>'}`;
    const nums = f.paper
      ? [['Nilai simulasi', b ? usd(b.totalUsd, 0) : '—', ''], ['Hasil', pnlCell, b ? cls(b.pnlUsd) : ''], ['Win rate', b?.winRate == null ? '—' : pct(b.winRate, 0), ''],
        ['Trade ditutup', b ? String(b.closedCount) : '—', ''], ['Jenis', esc(f.type || '—'), 'txt'], ['Dana', esc(f.money || 'virtual'), 'txt']]
      : [['Nilai dana', b ? usd(b.totalUsd, 0) : '—', ''], ['Untung / rugi', pnlCell, b ? cls(b.pnlUsd) : ''], ['Win rate', b?.winRate == null ? '—' : pct(b.winRate, 0), ''],
        ['Posisi ditutup', b ? String(b.closedCount) : '—', ''], ['Jenis', esc(f.type || '—'), 'txt'], ['Fee protokol', fee, 'txt']];
    return `<a class="prod" href="#${esc(f.id)}/portfolio" style="--c:${f.accent}">
      <div class="prod-top">${iconTile(FUND_ICON[f.id] || 'pulse', f.accent)}
        <div class="prod-id"><div class="prod-name">${esc(f.label)}</div><div class="prod-sub">${esc(f.chain)}${f.venue ? ' · ' + esc(f.venue) : ''}</div></div>
        <span class="chg" data-chg="${esc(f.id)}"></span></div>
      <p class="prod-desc">${esc(f.blurb || '')}</p>
      <div class="prod-nums">${nums.map(([k, v, c]) => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join('')}</div>
      ${quota(b ? (f.paper ? b.depositedUsd : b.depositedUsd) : null, f.paper ? (b?.depositedUsd || 0) : (b?.capacityUsd || 0), f.paper)}
      <span class="prod-go">Buka ${esc(f.label)} <b>→</b></span></a>`;
  };
  const safeCard = () => {
    const sb = state.safebox || {};
    const today = box && box.principalUsd ? ((Number(box.interestTodayUsd) || 0) / box.principalUsd) * 100 : null;
    return `<a class="prod" href="#safebox" style="--c:${sb.accent || '#2dd4bf'}">
      <div class="prod-top">${iconTile('vault', sb.accent || '#2dd4bf')}
        <div class="prod-id"><div class="prod-name">${esc(sb.label || 'Safe Box')}</div><div class="prod-sub">simpanan · bunga ikut kinerja bot, jatah per minggu, maks 3%/bulan</div></div>
        ${today == null ? '' : `<span class="chg up">▲ ${pct(today, 3)}<small>hari ini</small></span>`}</div>
      <p class="prod-desc">${esc(sb.blurb || '')}</p>
      <div class="prod-nums">
        <div><span class="k">Simpanan</span><span class="v">${box ? usd(box.balanceUsd, 0) : '—'}</span></div>
        <div><span class="k">Bunga hari ini</span><span class="v pos">${box?.measure?.dailyPct == null ? '—' : pct(box.measure.dailyPct, 2) + '<small>/hari</small>'}</span></div>
        <div><span class="k">Sudah ditarik</span><span class="v pos">${box ? usd(box.paidUsd || 0, 2) : '—'}</span></div>
        <div><span class="k">Pemilik</span><span class="v">${box ? String((box.owners || []).filter((o) => !o.left).length) : '—'}</span></div>
        <div><span class="k">Jenis</span><span class="v txt">${esc(sb.type || 'Simpanan')}</span></div>
        <div><span class="k">Pokok</span><span class="v txt">dijaga, tanpa fee</span></div>
      </div>
      ${quota(box ? Number(box.principalUsd) : null, sbCapacity || 0, false)}
      <span class="prod-go">Buka Safe Box <b>→</b></span></a>`;
  };
  const idx = state.index ? await loadIndex().catch(() => null) : null;
  if (epoch !== homeEpoch || state.view !== 'home') return;
  const indexCard = () => {
    const ix = state.index, s2 = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${pct(v, 2)}`);
    return `<a class="prod" href="#index" style="--c:${ix.accent}">
      <div class="prod-top">${iconTile('pie', ix.accent)}
        <div class="prod-id"><div class="prod-name">${esc(ix.label)}</div><div class="prod-sub">${esc(ix.subtitle || '')} · ${idx.components.length} dana</div></div>
        ${idx.change24hPct == null ? '' : `<span class="chg ${idx.change24hPct >= 0 ? 'up' : 'down'}">${idx.change24hPct >= 0 ? '▲' : '▼'} ${pct(Math.abs(idx.change24hPct), 2)}<small>24 jam</small></span>`}</div>
      <p class="prod-desc">${esc(ix.blurb || '')}</p>
      <div class="prod-nums">
        <div><span class="k">Level index</span><span class="v">${Number(idx.level).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div><span class="k">Sejak awal</span><span class="v ${cls(idx.changePct)}">${s2(idx.changePct)}</span></div>
        <div><span class="k">7 hari</span><span class="v ${cls(idx.change7dPct || 0)}">${s2(idx.change7dPct)}</span></div>
        <div><span class="k">Isi</span><span class="v txt">${idx.components.length} dana</span></div>
        <div><span class="k">Jenis</span><span class="v txt">${esc(ix.type || 'Index')}</span></div>
        <div><span class="k">Status</span><span class="v txt">${esc(idx.status || 'belum dibuka')}</span></div>
      </div>
      <span class="prod-go">Buka Cashood Index <b>→</b></span></a>`;
  };
  setHTML($('#homeProducts'), '<div class="risk-wrap">' + RISK.map((r) => {
    const items = r.key === 'low' ? [...(state.safebox ? [safeCard()] : []), ...(state.index && idx ? [indexCard()] : [])] : state.funds.filter((f) => f.risk === r.key).map(card);
    if (!items.length) return '';
    return `<div class="risk-group" style="--rc:${r.color}">
      <div class="rg-head"><span class="rg-badge">${r.title}</span><span class="rg-note">${r.note}</span></div>
      <div class="prod-grid">${items.join('')}</div></div>`;
  }).join('') + '</div>');

  // ── menu ──
  const first = state.funds[0]?.id || 'reborn';
  const menu = [
    ['pie', '#fbbf24', 'Portofolio global', 'Total aset & pemegang saham', '#analisa'],
    ['vault', '#2dd4bf', 'Safe Box', 'Simpanan 0–3% per bulan', '#safebox'],
    ['file', '#60a5fa', 'Invoice & dividen', 'Laporan PDF tiap tanggal 1', `#${first}/investor`],
    ['pulse', '#f472b6', 'Analys', 'Kinerja & arah seluruh bot', '#kinerja'],
    ['bell', '#38bdf8', 'Update', 'Catatan perubahan sistem', '#update'],
    ['users', '#a78bfa', 'Data investor', 'Porsi tiap orang di semua dana', '#pemegang'],
    ['flask', '#c084fc', 'Uji coba', 'Bot baru dengan modal kertas', '#charon/portfolio'],
    ['info', '#94a3b8', 'Cara kerja', 'Saham, dividen, risiko', `#${first}/tentang`],
  ];
  setHTML($('#homeMenu'), menu.map(([ic, c, t, n, href]) => `<a class="menu-tile" href="${href}">${iconTile(ic, c)}<b>${t}</b><span>${n}</span></a>`).join(''));
  lastHomeTotals = g; lastHomePaper = paper.filter(Boolean);
  renderGrowth(g, lastHomePaper).catch(() => {});
}
let lastHomeTotals = null, lastHomePaper = [];

/* ── analys seluruh bot ─────────────────────────────────────────────────
 *
 * Satu halaman untuk membandingkan semua bot: kinerja nyata (dari posisi yang
 * ditutup dan deret nilai dana) lalu arah ke depan dari proyeksi masing-masing.
 * Proyeksi baru terbit setelah tujuh hari data terverifikasi; sebelum itu yang
 * ditampilkan kemajuannya, bukan angka karangan.
 */
const RISK_LABEL = { high: 'Risiko tinggi', medium: 'Risiko menengah', low: 'Risiko rendah', paper: 'Uji coba' };
const RISK_COLOR = { high: '#fb7185', medium: '#fbbf24', low: '#2dd4bf', paper: '#c084fc' };
let kinerjaEpoch = 0;
async function renderKinerja() {
  const epoch = ++kinerjaEpoch;
  const body = $('#kinerjaBody');
  const funds = state.funds || [];
  const briefs = await Promise.all(funds.map((f) => loadFundBrief(f.id).catch(() => null)));
  const casts = await Promise.all(funds.map((f) => (f.forecast === false ? Promise.resolve(null) : loadForecast(f.id).catch(() => null))));
  if (epoch !== kinerjaEpoch || state.view !== 'kinerja') return;
  const real = briefs.filter((b) => b && !b.paper);
  const wins = real.reduce((s, b) => s + (b.perf?.trades?.wins || 0), 0);
  const graded = real.reduce((s, b) => s + (b.perf?.trades?.wins || 0) + (b.perf?.trades?.losses || 0), 0);
  const closed = real.reduce((s, b) => s + b.closedCount, 0);
  const pnl = real.reduce((s, b) => s + b.pnlUsd, 0);
  const best = real.filter((b) => b.perf?.score?.complete && b.perf.score.overall != null).sort((a, b) => b.perf.score.overall - a.perf.score.overall)[0];
  const tile = (k, v, n, c = '') => `<div class="hs"><div class="hs-v ${c}">${v}</div><div class="hs-k">${k}</div><div class="hs-n">${n}</div></div>`;
  const ring = (score, color) => {
    const v = Math.max(0, Math.min(100, Number(score) || 0)), C = 2 * Math.PI * 26;
    return `<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" class="ring-bg"/>
      <circle cx="32" cy="32" r="26" class="ring-fg" style="stroke:${color}" stroke-dasharray="${(v / 100) * C} ${C}" transform="rotate(-90 32 32)"/>
      <text x="32" y="36" text-anchor="middle">${score == null ? '—' : Math.round(v)}</text></svg>`;
  };
  const cards = funds.map((f, i) => {
    const b = briefs[i], p = b?.perf, t = p?.trades, e = p?.equity, fc = casts[i];
    const dd = p?.equityWithheld ? 'ditahan' : e?.maxDrawdownPct == null ? '—' : pct(e.maxDrawdownPct, 1);
    const m = [
      ['Untung / rugi', b && b.pnlUsd != null ? signed(b.pnlUsd) : '—', b ? cls(b.pnlUsd) : ''],
      ['Win rate', t?.winRate == null ? '—' : pct(t.winRate, 0), ''],
      ['Profit factor', t?.profitFactor == null ? '—' : String(t.profitFactor), t?.profitFactor >= 1 ? 'pos' : t ? 'neg' : ''],
      ['Turun terdalam', dd, dd !== '—' && dd !== 'ditahan' ? 'neg' : ''],
      ['Posisi / hari', t?.tradesPerDay == null ? '—' : String(t.tradesPerDay), ''],
      ['Posisi ditutup', b ? String(b.closedCount) : '—', ''],
    ];
    let ahead;
    if (f.forecast === false) ahead = `<div class="ahead dim">Uji coba dengan modal kertas — tidak diproyeksikan.</div>`;
    else if (fc?.enough) {
      const m1 = fc.horizons?.find((h) => h.key === 'm1');
      ahead = m1 ? `<div class="ahead"><div class="ahead-h">Perkiraan 1 bulan ke depan</div>
        <div class="ahead-row"><span>Normal</span><b>${usd(m1.normal.navUsd, 0)}</b></div>
        <div class="ahead-row"><span>Terburuk · terbaik</span><b>${usd(m1.worst.navUsd, 0)} · ${usd(m1.best.navUsd, 0)}</b></div>
        <div class="ahead-row"><span>Peluang turun ≥10%</span><b>${m1.risk?.p10 == null ? '—' : m1.risk.p10 < 0.001 ? '<0,001%' : pct(m1.risk.p10, 1)}</b></div></div>`
        : '<div class="ahead dim">Proyeksi belum tersedia.</div>';
    } else {
      const n = Math.min(7, Number(fc?.samples) || 0);
      ahead = `<div class="ahead"><div class="ahead-h">Arah ke depan</div>
        <div class="ahead-row"><span>Data terverifikasi</span><b>${n} / 7 hari</b></div>
        <div class="dd-bar"><i style="width:${(n / 7) * 100}%;background:${f.accent}"></i></div>
        <div class="n dim">Proyeksi terbit otomatis setelah tujuh hari penuh tercatat.</div></div>`;
    }
    return `<article class="kin" style="--c:${f.accent}">
      <div class="kin-top">${iconTile(FUND_ICON[f.id] || 'pulse', f.accent)}
        <div class="prod-id"><div class="prod-name">${esc(f.label)}</div><div class="prod-sub">${esc(f.type || '')} · ${esc(f.chain)}</div>
          <span class="rg-badge sm" style="--rc:${RISK_COLOR[f.risk] || '#94a3b8'}">${RISK_LABEL[f.risk] || '—'}</span></div>
        <div class="kin-score">${ring(p?.score?.complete ? p.score.overall : null, f.accent)}<span>skor DNA</span></div></div>
      <div class="prod-nums">${m.map(([k, v, c]) => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join('')}</div>
      ${ahead}
      <a class="prod-go" href="#${esc(f.id)}/analys">Analisa lengkap ${esc(f.label)} <b>→</b></a></article>`;
  }).join('');
  setHTML(body, `
    <div class="home-stats">${[
      tile('Untung / rugi seluruh bot', signed(pnl), 'tanpa dana uji coba', cls(pnl)),
      tile('Win rate gabungan', graded ? pct((wins / graded) * 100, 1) : '—', `${wins} menang dari ${graded}`),
      tile('Posisi ditutup', String(closed), 'di seluruh bot'),
      tile('Skor tertinggi', best ? esc(best.label) : '—', best ? `DNA ${best.perf.score.overall} / 100` : 'butuh data lima sumbu'),
    ].join('')}</div>
    <div class="kin-grid">${cards}</div>
    <p class="hint disclaimer">Kinerja masa lalu tidak menjamin hasil ke depan. Proyeksi diundi ulang dari hasil harian yang sudah terverifikasi, bukan janji.</p>`);
}

/* ── data investor global ─────────────────────────────────────────────── */
let pemegangEpoch = 0;
async function renderPemegang() {
  const epoch = ++pemegangEpoch;
  const g = await portoTotals();
  if (epoch !== pemegangEpoch || state.view !== 'pemegang') return;
  const people = new Map();
  const add = (id, name, color, row) => {
    const key = id || name;
    const p = people.get(key) || { name, color, rows: [], value: 0, modal: 0, out: 0 };
    p.rows.push(row); p.value += row.value; p.modal += row.modal; p.out += row.out;
    people.set(key, p);
  };
  for (const b of g.briefs) {
    for (const o of b.owners) add(o.id, o.name, o.color, { fund: b.label, accent: b.accent, share: o.share, value: o.value, modal: Number(o.deposited) || 0, out: Number(o.withdrawn) || 0 });
  }
  for (const o of g.box?.owners || []) {
    add(o.id, o.name, null, { fund: state.safebox?.label || 'Safe Box', accent: state.safebox?.accent || '#2dd4bf', share: Number(o.sharePct) || 0,
      value: Number(o.balanceUsd) || 0, modal: Number(o.principalUsd) || 0, out: Number(o.paidUsd) || 0 });
  }
  const list = [...people.values()].sort((a, b) => b.value - a.value);
  const total = list.reduce((s, p) => s + p.value, 0);
  const tile = (k, v, n) => `<div class="hs"><div class="hs-v">${v}</div><div class="hs-k">${k}</div><div class="hs-n">${n}</div></div>`;
  setHTML($('#pemegangBody'), `
    <div class="home-stats">${[
      tile('Pemegang', String(list.length), 'di seluruh produk'),
      tile('Nilai dipegang', usd(total, 0), 'dana + Safe Box'),
      tile('Modal masuk', usd(list.reduce((s, p) => s + p.modal, 0), 0), 'total setoran'),
      tile('Produk', String(g.briefs.length + (g.box ? 1 : 0)), 'tanpa dana uji coba'),
    ].join('')}</div>
    <div class="inv-grid">${list.map((p) => {
      const pnl = p.value + p.out - p.modal;
      return `<article class="inv">
        <div class="inv-head"><span class="inv-av" style="--c:${p.color || '#94a3b8'}">${esc(p.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?')}</span>
          <div class="inv-id"><div class="prod-name">${esc(p.name)}</div><div class="prod-sub">${p.rows.length} produk · ${total ? pct((p.value / total) * 100, 1) : '—'} dari seluruh aset</div></div>
          <div class="inv-tot"><b>${usd(p.value, 0)}</b><span class="${cls(pnl)}">${signed(pnl)}</span></div></div>
        <div class="inv-rows">${p.rows.sort((a, b) => b.value - a.value).map((r) => `<div class="inv-row">
          <span class="who"><span class="chip" style="background:${r.accent}"></span>${esc(r.fund)}</span>
          <span class="inv-share"><i style="width:${Math.min(100, r.share)}%;background:${r.accent}"></i></span>
          <span class="num">${pct(r.share, 1)}</span><span class="num"><b>${usd(r.value, 0)}</b></span></div>`).join('')}</div>
        <div class="inv-foot">modal ${usd(p.modal, 0)}${p.out > 0 ? ` · sudah ditarik ${usd(p.out, 0)}` : ''}</div></article>`;
    }).join('')}</div>`);
}

/* ── boot ────────────────────────────────────────────────────────────── */

function renderAll() {
  const rows = ownerValues(state.ledger, state.nav.totalUsd);
  applyFundKind();
  hideEmptyCards(state.nav);
  renderSummary(state.ledger, state.nav);
  renderPaper(state.nav);
  // Tab Analys membaca blok kinerja dari snapshot; kalau tab itu yang sedang
  // terbuka saat data tiba, ia harus digambar ulang — bukan tertinggal kosong.
  if (currentTab === 'analys' && state.view === 'fund') renderAnalys();
  // Dana trading uji coba tidak punya tab investor: dividen, kalkulator, dan
  // buku pemegang saham tidak digambar (dan tidak boleh menggagalkan sisanya).
  const trading = isTrading();
  if (!trading) { renderDonut(rows); renderOwners(rows); }
  renderHoldings(state.nav);
  renderLp(state.nav);
  renderClosed(state.nav);
  renderCosts(state.cfg);
  if (!trading) { renderDividend(); renderRules(); renderTreasury(); renderBooks(); renderReports(); renderAbout(); }
  renderNavChart();
  renderProfit();
  if (!trading) { renderHistory(state.ledger); renderCalc(); }
}

async function load({ force = false } = {}) {
  const fund = state.fund, epoch = fundEpoch, request = ++loadEpoch;
  const valid = () => fund === state.fund && epoch === fundEpoch && request === loadEpoch;
  const btn = $('#refreshBtn'); btn.disabled = true; btn.textContent = 'memuat…';
  if (force) { recentJSON.clear(); portoCache.clear(); seriesCache.clear(); safeboxData = null; for (const k of Object.keys(forecastCache)) delete forecastCache[k]; reportsCache = null; updatesCache = null; }
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
  if (state.view === 'home') renderHome().catch(() => {});
  else if (state.view === 'kinerja') renderKinerja().catch(() => {});
  else if (state.view === 'pemegang') renderPemegang().catch(() => {});
  else if (state.view === 'index') renderIndex().catch(() => {});
  else if (state.view === 'safebox') renderSafebox();
  else if (state.view === 'analisa') { renderPortofolio().catch(() => {}); }
  else if (state.view === 'update') renderUpdates();
  else if (state.nav && state.ledger) renderAll();
}

async function init() {
  try {
    const list = await getJSON(FUNDS_URL);
    state.funds = list.funds || [];
    state.coins = list.coins || ['eth'];
    state.safebox = list.safebox || null;
    state.index = list.index || null;
    if (!state.funds.length) throw new Error('daftar dana kosong');
    await loadFundConfig(parseHash().fund || list.active || state.funds[0].id);
  } catch (err) {
    banner('daftar dana tidak terbaca: ' + (err.message || err), 'err');
    return;
  }

  $('#fundBar').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const menu = btn.getAttribute('data-menu');
    if (menu) { navOpen = navOpen === menu ? null : menu; renderFundBar(); return; }
    navOpen = null;
    const view = btn.getAttribute('data-view');
    if (view === 'home') { showHome(); return; }
    if (view === 'kinerja') { showKinerja(); return; }
    if (view === 'index') { showIndex(); return; }
    if (view === 'analisa') { showAnalisa(); return; }
    if (view === 'safebox') { showSafebox(); return; }
    if (view === 'update') { showUpdate(); return; }
    const id = btn.getAttribute('data-fund');
    if (state.view === 'analisa' && id === state.fund) { showTab(currentTab); return; }
    switchFund(id);
  };

  // Dropdown menu tertutup saat menekan di luar atau menekan Escape.
  document.addEventListener('pointerdown', (e) => { if (navOpen && !e.target.closest('#fundBar')) { navOpen = null; renderFundBar(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && navOpen) { navOpen = null; renderFundBar(); } });

  const calStep = (dir) => {
    const months = [...new Set(homeCal.rows.map((r) => r.date.slice(0, 7)))].sort();
    const i = months.indexOf(homeCal.month) + dir;
    if (i >= 0 && i < months.length) { homeCal.month = months[i]; renderHomeCalendar(); }
  };
  $('#hgCalPrev').onclick = () => calStep(-1);
  $('#hgCalNext').onclick = () => calStep(1);

  $('#segHome').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    homeView.hours = Number(btn.getAttribute('data-h'));
    $('#segHome').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    if (lastHomeTotals) renderGrowth(lastHomeTotals, lastHomePaper).catch(() => {});
  };

  $('#segAn').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    anSection = btn.getAttribute('data-a');
    renderAnalys();
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
  const brand = $('#brandHome');
  if (brand) {
    brand.onclick = () => showHome();
    brand.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showHome(); } };
  }
  wireProfitControls();

  $('#closedMonth').onchange = (e) => { closedView.month = e.target.value; closedView.page = 0; renderClosed(state.nav); };
  $('#closedPager').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    closedView.page = Number(btn.getAttribute('data-p')) || 0;
    renderClosed(state.nav);
    $('#closedCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

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
    if (state.view === 'home') renderHome().catch(() => {});
    else if (state.view === 'kinerja') renderKinerja().catch(() => {});
    else if (state.view === 'pemegang') renderPemegang().catch(() => {});
    else if (state.view === 'index') renderIndex().catch(() => {});
    else if (state.view === 'analisa') { renderPortofolio().catch(() => {}); }
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
    if (route.home) { showHome(); return; }
    if (route.kinerja) { showKinerja(); return; }
    if (route.pemegang) { showPemegang(); return; }
    if (route.safebox) { showSafebox(); return; }
    if (route.index) { showIndex(); return; }
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
      if (state.view === 'home' && lastHomeTotals) renderGrowth(lastHomeTotals, lastHomePaper).catch(() => {});
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
