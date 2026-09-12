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

const CONFIG_URL = 'data/config.json';
const LIVE_URL = 'data/live.json';
const CACHE_KEY = 'cashood.nav.v4';

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
function rawDataBase() {
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
    return `https://raw.githubusercontent.com/${host[1]}/${repo}/data/`;
  } catch {
    return null;
  }
}

/** URL sumber data: turunan dari alamat halaman dulu, config sebagai cadangan. */
function dataUrls(cfg, file, configured) {
  const base = rawDataBase();
  return [base ? base + file : null, configured, 'data/' + file].filter(Boolean);
}
const state = { cfg: null, ledger: null, nav: null };

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
let currency = (() => {
  try {
    const saved = localStorage.getItem('cashood.currency');
    return ['eth', 'idr'].includes(saved) ? saved : 'usd';
  } catch { return 'usd'; }
})();

const fmtUsd = (n, dp = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });

let lastEthPrice = null;

// Lambang Ether, digambar di tempat — bukan huruf Yunani Ξ, yang kebetulan
// mirip dan bukan lambang apa pun di sini. Diwarnai currentColor supaya ikut
// merah/hijau baris yang memuatnya.
const ETH_MARK = '<svg class="ethmark" viewBox="0 0 256 417" aria-hidden="true" focusable="false">'
  + '<path d="M127.96 0l-2.8 9.5v275.67l2.8 2.79L255.92 212.3z" fill="currentColor" opacity=".6"/>'
  + '<path d="M127.96 0L0 212.3l127.96 75.66V154.16z" fill="currentColor"/>'
  + '<path d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z" fill="currentColor" opacity=".6"/>'
  + '<path d="M127.96 416.9v-104.71L0 236.59z" fill="currentColor"/>'
  + '<path d="M127.96 287.96l127.96-75.65-127.96-58.16z" fill="currentColor" opacity=".35"/>'
  + '<path d="M0 212.31l127.96 75.65V154.15z" fill="currentColor" opacity=".8"/></svg>';

function ethAmount(n) {
  const price = state.nav?.ethPrice || lastEthPrice;
  if (!price) return null;
  const v = (Number(n) || 0) / price;
  const a = Math.abs(v);
  const dp = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return { negative: v < 0, digits: a.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) };
}

/** Dengan lambang. Untuk tempat yang menerima HTML. */
function fmtEth(n) {
  const v = ethAmount(n);
  return v ? (v.negative ? '-' : '') + ETH_MARK + v.digits : '—';
}

/** Tanpa lambang. Untuk <text> di dalam SVG, yang tidak bisa memuat elemen HTML. */
function fmtEthText(n) {
  const v = ethAmount(n);
  return v ? (v.negative ? '-' : '') + v.digits + ' ETH' : '—';
}

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

const usd = (n, dp = 2) => (currency === 'eth' ? fmtEth(n) : currency === 'idr' ? fmtIdr(n) : fmtUsd(n, dp));
const usdText = (n, dp = 2) => (currency === 'eth' ? fmtEthText(n) : currency === 'idr' ? fmtIdrText(n) : fmtUsd(n, dp));

const pct = (n, dp = 2) => (Number(n) || 0).toFixed(dp) + '%';

const num = (n, dp = 4) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

const signed = (n) => (n > 0 ? '+' : '') + usd(n);
const signedText = (n) => (n > 0 ? '+' : '') + usdText(n);

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

function buildLedger(cfg) {
  const owners = new Map(
    (cfg.owners || []).map((o) => [o.id, {
      ...o, units: 0, deposited: 0, withdrawn: 0,
    }])
  );

  const events = [...(cfg.events || [])]
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a._i - b._i);

  const rows = [];
  const warnings = [];
  let totalUnits = 0;
  let cashBasis = 0;           // dipakai kalau navBefore tidak diisi

  // Transaksi yang terjadi barengan — mis. penarikan pro-rata yang dibagi ke
  // beberapa orang di hari yang sama dengan navBefore yang sama — harus dinilai
  // pada harga unit YANG SAMA. Kalau dihitung satu per satu, transaksi kedua
  // memakai jumlah unit yang sudah berkurang oleh transaksi pertama, dan porsi
  // sahamnya ikut bergeser padahal seharusnya tetap.
  const batches = [];
  for (const e of events) {
    const key = e.founding ? 'founding' : `${e.date}|${e.navBefore ?? ''}`;
    const last = batches[batches.length - 1];
    if (last && last.key === key) last.items.push(e);
    else batches.push({ key, items: [e], founding: !!e.founding, date: e.date, navBefore: e.navBefore });
  }

  for (const batch of batches) {
    // Harga satu unit saat transaksi terjadi.
    let unitPrice;
    if (batch.founding || totalUnits === 0) {
      unitPrice = 1;
    } else if (Number.isFinite(Number(batch.navBefore)) && Number(batch.navBefore) > 0) {
      unitPrice = Number(batch.navBefore) / totalUnits;
    } else {
      unitPrice = cashBasis > 0 ? cashBasis / totalUnits : 1;
      warnings.push(`transaksi ${batch.date} tidak punya "navBefore" — dihitung tanpa untung/rugi, angkanya bisa meleset`);
    }

    for (const e of batch.items) {
      const who = owners.get(e.owner);
      const amount = Number(e.usd) || 0;
      if (!who) { warnings.push(`event ${e.date} memakai owner "${e.owner}" yang tidak terdaftar — dilewati`); continue; }
      if (amount <= 0) { warnings.push(`event ${e.date} (${e.owner}) jumlahnya 0 — dilewati`); continue; }

      const units = amount / unitPrice;

      if (e.type === 'withdraw') {
        const cap = Math.min(units, who.units);
        if (units - who.units > 1e-9) {
          warnings.push(`penarikan ${e.date} (${who.name}) lebih besar dari jatahnya — dipotong ke jatah maksimum`);
        }
        who.units -= cap;
        totalUnits -= cap;
        who.withdrawn += cap * unitPrice;
        cashBasis -= cap * unitPrice;
        rows.push({ ...e, unitPrice, units: -cap, ownerName: who.name, color: who.color, usd: cap * unitPrice });
      } else {
        who.units += units;
        totalUnits += units;
        who.deposited += amount;
        cashBasis += amount;
        rows.push({ ...e, unitPrice, units, ownerName: who.name, color: who.color, usd: amount });
      }
    }
  }

  const list = [...owners.values()];
  return {
    owners: list,
    totalUnits,
    events: rows.reverse(),                                  // terbaru di atas
    deposited: list.reduce((s, o) => s + o.deposited, 0),
    withdrawn: list.reduce((s, o) => s + o.withdrawn, 0),
    warnings,
  };
}

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
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,idr');
    const j = await r.json();
    const u = Number(j?.ethereum?.usd);
    const i = Number(j?.ethereum?.idr);
    if (u > 0) lastEthPrice = u;
    if (u > 0 && i > 0) lastUsdIdr = i / u;
  } catch { /* lanjut ke cadangan */ }

  if (!lastUsdIdr) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const j = await r.json();
      const i = Number(j?.rates?.IDR);
      if (i > 0) lastUsdIdr = i;
    } catch { /* tanpa kurs, tampilan rupiah menampilkan tanda pisah */ }
  }
  return { eth: lastEthPrice, idr: lastUsdIdr };
}

/**
 * Snapshot dari bot (scripts/sync.mjs) — nilai tiap posisi LP.
 *
 * Dicoba dari `snapshotUrl` dulu (raw.githubusercontent) karena file di sana
 * ikut berubah begitu di-push, tanpa nunggu GitHub Pages build ulang. Kalau
 * gagal, jatuh ke salinan yang ikut ke-deploy bareng situsnya.
 */
async function readSnapshot(cfg) {
  const urls = dataUrls(cfg, 'live.json', cfg?.app?.snapshotUrl);
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!Number.isFinite(Number(j.totalUsd))) throw new Error('snapshot tanpa totalUsd');
      return j;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('tidak ada snapshot');
}

async function resolveNav(cfg, { force = false } = {}) {
  // 1. angka manual selalu menang
  const manual = Number(cfg.navOverrideUsd);
  if (Number.isFinite(manual) && manual > 0) {
    return { totalUsd: manual, source: 'manual', label: 'angka manual dari config.json', fetchedAt: Date.now(), holdings: [], positions: [] };
  }

  // 2. cache pendek — menahan reload beruntun, bukan menunda data
  const ttl = (Number(cfg.app?.refreshMinutes) || 5) * 60000;
  if (!force) {
    try {
      const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
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
  const [snap] = await Promise.all([readSnapshot(cfg)]);

  const positions = snap?.positions || [];
  const history = snap?.history || [];
  const stats = snap?.stats || null;
  const closedRecent = snap?.closedRecent || [];
  if (Number(snap?.ethPrice) > 0) lastEthPrice = Number(snap.ethPrice);

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
    usdIdr: Number(snap.usdIdr) || null,
    botWalletUsd: Number(snap.botWalletUsd) || Number(snap.totalUsd),
    ethPrice: Number(snap.ethPrice) || null,
    updatedAt: Number(snap.updatedAt) || null,
    lpStale: age > 45 * 60e3,
    partial: !positions.length,
    fetchedAt: Date.now(),
  };

  try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch { /* mode privat */ }
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

function renderSummary(ledger, nav) {
  const pnl = nav.totalUsd + ledger.withdrawn - ledger.deposited;
  const pnlPct = ledger.deposited > 0 ? (pnl / ledger.deposited) * 100 : 0;

  $('#kpiNav').innerHTML = usd(nav.totalUsd);
  $('#kpiNavSub').innerHTML = nav.lpUsd > 0
    ? `${usd(nav.liveUsd ?? 0, 0)} token + ${usd(nav.lpUsd, 0)} di LP`
      + (nav.treasuryUsd > 0 ? ` + ${usd(nav.treasuryUsd, 0)} kas cadangan` : '')
    : nav.label;
  $('#kpiDeposit').innerHTML = usd(ledger.deposited);
  $('#kpiWithdraw').innerHTML = usd(ledger.withdrawn);
  const el = $('#kpiPnl');
  el.innerHTML = signed(pnl);
  el.className = 'big ' + cls(pnl);
  $('#kpiPnlSub').textContent = (pnl >= 0 ? '+' : '') + pct(pnlPct) + ' dari modal';
  $('#donutVal').innerHTML = usd(nav.totalUsd, 0);
  $('#footSrc').textContent = nav.source === 'manual' ? 'config manual' : 'snapshot bot';
  $('#footTime').textContent = 'diperbarui ' + ago(nav.fetchedAt);

  const eth = nav.ethPrice || lastEthPrice;
  $('#ethRate').textContent = eth ? `1 ETH = ${fmtUsd(eth)}` : 'kurs ETH belum terbaca';
  $('#idrRate').textContent = lastUsdIdr
    ? `$1 = Rp\u202f${Math.round(lastUsdIdr).toLocaleString('id-ID')}`
    : 'kurs Rp belum terbaca';

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
        stroke-dashoffset="${-offset}" transform="rotate(-90 ${C} ${C})" stroke-linecap="butt"><title>${r.name} ${pct(r.share, 1)}</title></circle>`;
    offset += len;
    return seg;
  }).join('');
  svg.innerHTML = bg + arcs;
}

function renderOwners(rows) {
  $('#ownerTable').querySelector('tbody').innerHTML = rows.map((r) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${r.color || '#4ade80'}"></span>${r.name}</span></td>
      <td class="num">${pct(r.share)}</td>
      <td class="num">${usd(r.deposited)}</td>
      <td class="num">${r.withdrawn > 0 ? usd(r.withdrawn) : '<span class="dim">—</span>'}</td>
      <td class="num"><strong>${usd(r.value)}</strong></td>
      <td class="num ${cls(r.pnl)}">${signed(r.pnl)}</td>
    </tr>`).join('');
  $('#unitHint').innerHTML =
    `${num(state.ledger.totalUnits, 2)} unit beredar · 1 unit = ${usd(state.ledger.totalUnits > 0 ? state.nav.totalUsd / state.ledger.totalUnits : 0, 4)}`;
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
  body.innerHTML = slice.length
    ? slice.map((r) => `
      <tr>
        <td><span class="who"><span class="chip" style="background:${r.symbol === 'ETH' ? '#627eea' : '#4ade80'}"></span>${r.symbol}</span></td>
        <td class="num">${num(r.amount, 6)}</td>
        <td class="num">${r.price == null ? '<span class="dim">—</span>' : usd(r.price, r.price < 10 ? 4 : 2)}</td>
        <td class="num">${r.usd == null ? '<span class="dim">?</span>' : usd(r.usd)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="dim">Tidak ada saldo token terbaca.</td></tr>';

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
    pager.innerHTML = btn('‹', Math.max(0, holdPage - 1), holdPage === 0 ? 'disabled' : '')
      + nums.join('')
      + btn('›', Math.min(pages - 1, holdPage + 1), holdPage === pages - 1 ? 'disabled' : '');
  }

  const total = rows.reduce((sum, r) => sum + (r.usd || 0), 0);
  $('#holdHint').innerHTML = nav.source === 'manual'
    ? 'NAV dikunci manual di config.json'
    : `${rows.length} token · ${usd(total)} · dihitung bot ${ago(nav.updatedAt)}`;
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
    body.innerHTML = '<tr><td colspan="7" class="dim">Tidak ada posisi terbuka.</td></tr>';
    $('#lpSummary').innerHTML = '';
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
  const pnl = value - invested;
  const inRange = rows.filter((r) => r.inRange).length;

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  $('#lpSummary').innerHTML = [
    tile('Nilai posisi', usd(value), `${rows.length} posisi`),
    tile('Modal masuk', usd(invested), 'saat dibuka'),
    tile('Fee terkumpul', usd(fees + collected),
      collected > 0 ? `${usd(collected)} sudah dipanen · ${usd(fees)} belum` : 'semuanya masih di dalam posisi', 'pos'),
    tile('Untung / rugi', signed(pnl), invested ? pct((pnl / invested) * 100) + ' dari modal' : '—', cls(pnl)),
    tile('Di dalam range', `${inRange}/${rows.length}`, inRange === rows.length ? 'semua earning' : `${rows.length - inRange} tidak earning`,
      inRange === rows.length ? 'pos' : 'neg'),
  ].join('');

  body.innerHTML = [...rows]
    .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))
    .map((r) => {
      const band = r.throughBandPct == null ? '' : `<span class="band">${r.throughBandPct.toFixed(0)}%</span>`;
      return `<tr>
        <td><span class="who"><span class="chip" style="background:${r.inRange ? '#4ade80' : '#f87171'}"></span>${r.symbol ?? r.tokenId}</span>
            <div class="sub2">${r.strategy ?? ''}${r.feePct ? ' · fee ' + r.feePct + '%' : ''}</div></td>
        <td><span class="pill ${r.inRange ? 'in' : 'out2'}">${r.inRange ? 'di dalam range' : 'di luar range'}</span> ${band}</td>
        <td class="num dim">${dur(r.ageMinutes)}</td>
        <td class="num">${r.investedUsd == null ? '<span class="dim">—</span>' : usd(r.investedUsd)}</td>
        <td class="num"><strong>${r.valueUsd == null ? '—' : usd(r.valueUsd)}</strong></td>
        <td class="num pos">${usd((r.totalFeesUsd ?? r.feesUsd) || 0)}<div class="sub2">${
          r.collectedFeesUsd > 0 ? `${usd(r.collectedFeesUsd)} dipanen` : 'belum dipanen'
        }</div></td>
        <td class="num ${cls(r.pnlUsd)}">${r.pnlUsd == null ? '—' : signed(r.pnlUsd)}<div class="sub2 ${cls(r.pnlUsd)}">${r.pnlPct == null ? '' : (r.pnlPct > 0 ? '+' : '') + pct(r.pnlPct)}</div></td>
      </tr>`;
    }).join('');

  $('#lpHint').textContent = `dihitung bot ${ago(nav.updatedAt)}`
    + (trackedSince ? ` · fee dipanen dihitung sejak ${ago(trackedSince)}` : '');
}

function renderClosed(nav) {
  const rows = nav.closedRecent || [];
  const body = $('#closedTable').querySelector('tbody');
  $('#closedCard').hidden = false;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="dim">Belum ada posisi yang ditutup.</td></tr>';
    $('#closedHint').textContent = '';
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${r.netUsd >= 0 ? '#4ade80' : '#f87171'}"></span>${r.symbol ?? '—'}</span></td>
      <td class="dim">${r.strategy ?? '—'}</td>
      <td class="num dim">${r.holdMinutes == null ? '—' : dur(r.holdMinutes)}</td>
      <td class="num ${cls(r.netUsd)}">${signed(r.netUsd)}</td>
      <td class="num ${cls(r.netUsd)}">${r.netPct == null ? '—' : (r.netPct > 0 ? '+' : '') + pct(r.netPct)}</td>
      <td class="dim">${r.reason ?? '—'}</td>
      <td class="num dim">${ago(r.closedAt)}</td>
    </tr>`).join('');
  const net = rows.reduce((t, r) => t + (Number(r.netUsd) || 0), 0);
  $('#closedHint').innerHTML = `${rows.length} terakhir · jumlahnya ${signed(net)}`;
}

/** Biaya langganan bulanan. Dibayar dari luar wallet, jadi tidak masuk NAV. */
function renderCosts(cfg) {
  const items = cfg?.costs?.items || [];
  const table = $('#costTable');
  $('#costCard').hidden = !items.length;
  if (!items.length) return;

  table.querySelector('tbody').innerHTML = items
    .map((c) => `<tr><td>${c.name}</td><td class="num">${usd(c.usd)}</td></tr>`).join('');

  const total = items.reduce((t, c) => t + (Number(c.usd) || 0), 0);
  table.querySelector('tfoot').innerHTML =
    `<tr class="total"><td><strong>Total</strong></td><td class="num"><strong>${usd(total)}</strong></td></tr>`
    + `<tr><td class="dim">Per hari</td><td class="num dim">${usd(total / 30)}</td></tr>`;

  const navUsd = state.nav?.totalUsd || 0;
  $('#costHint').textContent = cfg.costs.note
    + (navUsd ? ` · ${pct((total / navUsd) * 100)} dari nilai wallet per bulan` : '');
}

function renderHistory(ledger) {
  const body = $('#histTable').querySelector('tbody');
  if (!ledger.events.length) {
    body.innerHTML = `<tr><td colspan="6" class="dim">Belum ada transaksi.</td></tr>`;
  } else {
    body.innerHTML = ledger.events.map((e) => {
      const out = e.type === 'withdraw';
      return `<tr>
        <td>${e.date || '—'}</td>
        <td><span class="pill ${out ? 'out' : 'in'}">${out ? 'tarik' : 'setor'}</span></td>
        <td><span class="who"><span class="chip" style="background:${e.color || '#4ade80'}"></span>${e.ownerName}</span></td>
        <td class="num ${out ? 'neg' : 'pos'}">${out ? '-' : '+'}${usd(e.usd)}</td>
        <td class="num dim">${usd(e.unitPrice, 4)}</td>
        <td class="dim">${e.note || '—'}</td>
      </tr>`;
    }).join('');
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
  $('#wdTable').querySelector('tbody').innerHTML = cuts.map((c) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${c.color || '#4ade80'}"></span>${c.name}</span></td>
      <td class="num ${c.take > 0 ? 'pos' : 'dim'}">${c.take > 0 ? usd(c.take) : '—'}</td>
      <td class="num">${usd(c.left)}</td>
      <td class="num">${pct(unitsLeft > 0 ? (c.unitsLeft / unitsLeft) * 100 : 0)}</td>
    </tr>`).join('');

}




/* ── laporan bot ─────────────────────────────────────────────────────────
 *
 * Teksnya diambil apa adanya dari laporan yang bot kirim ke Telegram tiap jam.
 * Yang dilakukan di sini cuma memecahnya jadi bagian-bagian dan mewarnai baris
 * per baris — tidak ada angka yang dihitung ulang, tidak ada kalimat yang
 * ditulis ulang, supaya yang dibaca orang di sini sama dengan yang dibaca
 * operatornya di Telegram.
 */

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
    body.innerHTML = '<p class="hint">Belum ada laporan. Jalankan <code>scripts/heartbeat.mjs</code>.</p>';
    $('#hbHint').textContent = 'belum ada data';
    return;
  }

  const archive = (hb.archive || []).filter((r) => r?.text).slice(0, 10);

  body.innerHTML = reportHtml(hb.text)
    + (archive.length
      ? `<details class="hb-arsip"><summary>Laporan sebelumnya (${archive.length})</summary>`
        + archive.map((r) => `<details class="hb-old"><summary>${esc(r.generatedAt || '—')}</summary>`
            + `<div class="hb-body">${rowsHtml(r.text.split('\n').filter((l) => !/^━+$/.test(l.trim())))}</div>`
            + '</details>').join('')
        + '</details>'
      : '');

  const when = hb.generatedAt || '—';
  $('#hbHint').textContent = `${when} · diambil ${ago(hb.updatedAt)}`
    + (hb.source === 'rendered' ? ' · disusun ulang di luar proses bot (uptime & mode tidak ikut)' : '');
}

let hbLoaded = false;
let hbLoading = null;

async function refreshHeartbeat({ force = false } = {}) {
  if (hbLoading) return hbLoading;
  if (hbLoaded && !force) return null;
  hbLoading = loadHeartbeat(state.cfg)
    .then((hb) => { hbLoaded = true; renderHeartbeat(hb); return hb; })
    .catch(() => { $('#hbHint').textContent = 'laporan tidak bisa diambil'; return null; })
    .finally(() => { hbLoading = null; });
  return hbLoading;
}

async function loadHeartbeat(cfg) {
  const urls = dataUrls(cfg, 'heartbeat.json', cfg?.app?.heartbeatUrl);
  for (const url of urls) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (j?.text) return j;
    } catch { /* coba sumber berikutnya */ }
  }
  return null;
}

/* ── tab ─────────────────────────────────────────────────────────────── */

function showTab(name) {
  const known = ['portfolio', 'investor', 'bot', 'tentang'];
  const tab = known.includes(name) ? name : 'portfolio';
  $('#tab-portfolio').hidden = tab !== 'portfolio';
  $('#tab-investor').hidden = tab !== 'investor';
  $('#tab-bot').hidden = tab !== 'bot';
  $('#tab-tentang').hidden = tab !== 'tentang';
  const bot = tab === 'bot';
  document.querySelectorAll('#tabs button').forEach((b) => {
    const on = b.getAttribute('data-tab') === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (location.hash.slice(1) !== tab) {
    history.replaceState(null, '', tab === 'portfolio' ? location.pathname : '#' + tab);
  }
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
let navPoints = [];

async function readNavSeries(cfg) {
  const urls = dataUrls(cfg, 'nav.json', cfg?.app?.navUrl);
  for (const url of urls) {
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (Array.isArray(j.points) && j.points.length) return j.points;
    } catch { /* coba sumber berikutnya */ }
  }
  return [];
}

function renderNavChart() {
  const svg = $('#navChart');
  const W = 720, H = 240, m = { t: 16, r: 54, b: 30, l: 60 };
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
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2 - 6}" text-anchor="middle" class="g-lbl">Grafiknya kebentuk setelah beberapa titik terkumpul.</text>`
      + `<text x="${W / 2}" y="${H / 2 + 14}" text-anchor="middle" class="g-lbl">Sekarang ada ${navPoints.length} titik · 6 titik per jam.</text>`;
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
  for (let i = 0; i <= 3; i += 1) {
    const v = lo + ((hi - lo) / 3) * i;
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
  for (let i = 0; i <= 4; i += 1) {
    const t = pts[0].t + ((last.t - pts[0].t) / 4) * i;
    ticks += `<text x="${x(t)}" y="${H - m.b + 18}" text-anchor="middle" class="g-lbl">${fmtT(t)}</text>`;
  }

  svg.innerHTML = `<defs><linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
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
    + `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" id="navHit"/>`;

  const first = pts[0];
  const delta = last.v - first.v;
  const movePct = first.v ? (delta / first.v) * 100 : 0;
  $('#navHint').innerHTML = share
    ? `1 saham = ${usd(last.v, 4)} · ${(movePct >= 0 ? '+' : '') + pct(movePct)} di rentang ini`
    : `${pts.length} titik · ${signed(delta)} (${pct(movePct)}) di rentang ini`;

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
    tip.innerHTML = `<div class="t-d">${fmtT(near.t)} WIB</div>`
      + `<div class="t-v">${share ? usd(near.v, 4) : usd(near.v)}</div>`
      + (share
        ? `<div class="t-n">nilai wallet ${usd(near.usd, 0)}</div>`
        : `<div class="t-n">${usd(near.usd - (near.lp ?? 0), 0)} token · ${usd(near.lp ?? 0, 0)} LP</div>`);
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
      const when = Number(e.at) > 0 ? Number(e.at) : parseDay(e.date).getTime();
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
 * Dihitung dari kenaikan HARGA SAHAM di atas rekor tertinggi, bukan dari
 * selisih nilai wallet terhadap total setoran. Bedanya menentukan: nilai
 * wallet ikut naik saat ada investor baru masuk, dan dividen yang dihitung
 * dari situ akan membagikan uang yang baru saja disetor orang. Harga saham
 * tidak bergerak oleh setoran, jadi yang terbagi benar-benar hasil kerja bot.
 *
 * Rekor tertinggi mencegah laba yang sama dibayar dua kali: dana yang naik,
 * membayar dividen, jatuh, lalu naik lagi ke titik yang sama tidak menghasilkan
 * apa-apa yang baru untuk dibagi.
 */
function dividendPlan(navUsd) {
  const d = state.cfg?.dividend || {};
  const units = state.ledger?.totalUnits || 0;
  const hwm = Number(d.highWaterMarkPerUnit) > 0 ? Number(d.highWaterMarkPerUnit) : 1;
  const feePct = Number(d.performanceFeePct) || 0;
  const profitSharePct = Number.isFinite(Number(d.profitSharePct)) ? Number(d.profitSharePct) : 50;

  const navPerUnit = units > 0 ? (Number(navUsd) || 0) / units : 0;
  const locked = hwm * units;                       // modal terkunci = rekor × unit beredar
  const gain = Math.max(0, (navPerUnit - hwm) * units);

  const fee = gain * (feePct / 100);
  const pool = (gain - fee) * (profitSharePct / 100);
  const reserve = Math.min(Number(d.reserveUsd) || 0, pool);
  const distributed = Math.max(0, pool - reserve);

  // Cadangan tetap di dalam dana; dividen dan fee performa keluar.
  const navAfter = (Number(navUsd) || 0) - distributed - fee;

  return { locked, hwm, navPerUnit, units, profit: gain, pool, reserve, fee, distributed, navAfter,
    profitSharePct, feePct,
    standardFeePct: Number(d.performanceFeeStandardPct) || 0,
    feeNote: d.performanceFeeNote || '',
    retained: Math.max(0, gain - fee - pool) + reserve,
    hwmAfter: units > 0 ? navAfter / units : hwm,
    payDay: Number(d.payDayOfMonth) || 1 };
}

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
  $('#capLegend').innerHTML = `<span>terisi <b>${usd(nav, 0)}</b></span>`
    + `<span>${used >= 100 ? 'kelebihan ' + usd(nav - cap, 0) : 'ruang tersisa <b>' + usd(cap - nav, 0) + '</b>'}</span>`
    + `<span>plafon <b>${usd(cap, 0)}</b></span>`;
  $('#capNote').textContent = used >= 100
    ? 'Dana sudah penuh. Investor baru masuk dengan membeli saham pemegang lama, bukan dengan setoran baru — supaya ukuran posisi tidak melebihi kedalaman pool.'
    : `Selama masih ada ruang, setoran baru mencetak unit baru. ${f.note || ''}`;

  const costs = (state.cfg?.costs?.items || []).reduce((t, c) => t + (Number(c.usd) || 0), 0);
  const rules = [
    ['Minimum setoran', usd(Number(f.minDepositUsd) || 0, 0), 'Di bawah ini, biaya gas untuk masuk dan keluar memakan porsi yang terlalu besar dari setorannya sendiri.'],
    ['Plafon dana', usd(cap, 0), 'Bot menaruh $600–900 per posisi mengikuti kedalaman pool. Dana yang terlalu besar memaksa posisi membesar, dan price impact naik untuk semua orang.'],
    ['Masuk & keluar', `${Number(f.noticeHours) || 24} jam`, 'Modal terpasang di posisi likuiditas. Bot perlu waktu menutup posisi di harga yang wajar, bukan panik di harga buruk.'],
    ['Biaya operasional', `${usd(costs, 0)}/bln`, `Dipotong dari dana menurut porsi saham — ${pct(nav ? (costs / nav) * 100 : 0, 2)} dari modal masing-masing per bulan. Tidak ada yang perlu transfer apa pun.`],
    ['Fee performa', Number(d.performanceFeePct) > 0 ? d.performanceFeePct + '%' : 'GRATIS',
      Number(d.performanceFeePct) > 0
        ? 'Diambil dari laba di atas rekor harga saham. Tidak ada laba, tidak ada fee.'
        : `Tarif normal ${d.performanceFeeStandardPct || 15}% dari laba di atas rekor, tapi selama masa perkenalan pengelola tidak mengambil apa pun.`],
    ['Dividen', `tiap tanggal ${Number(d.payDayOfMonth) || 1}`, `${d.profitSharePct ?? 50}% dari laba di atas rekor tertinggi, dibagi menurut porsi saham. Sisanya diputar lagi dan menaikkan harga saham.`],
  ];
  $('#rulesTable').querySelector('tbody').innerHTML = rules
    .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');
}

/** Kas cadangan: uang yang sudah dipindah keluar dari wallet kerja bot. */
function renderTreasury() {
  const t = state.cfg?.treasury || {};
  const moved = Number(t.movedUsd) || 0;
  const step = Number(t.stepUsd) || 100;
  const nav = state.nav?.totalUsd || 0;
  const inBot = Math.max(0, nav - moved);

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  $('#treSummary').innerHTML = [
    tile('Sudah dipindahkan', usd(moved), 'ke wallet terpisah', moved > 0 ? 'pos' : ''),
    tile('Masih dipakai bot', usd(inBot), 'terpasang di posisi dan token'),
    tile('Dipindah setiap', usd(step, 0), 'kelipatan laba'),
    tile('Porsi saham', 'tidak berubah', 'perpindahan tidak menyentuh kepemilikan'),
  ].join('');

  $('#treHint').textContent = moved > 0
    ? `${usd(moved)} sudah diamankan · ${pct(nav ? (moved / nav) * 100 : 0, 1)} dari dana`
    : 'belum ada yang dipindahkan';

  $('#treRule').innerHTML = `
    <p><strong>Wallet yang dipakai bot menandatangani transaksi ratusan kali sehari.</strong>
       Itu permukaan serangan, dan permukaan serangan tidak boleh menyimpan seluruh dana. Setiap
       kelipatan ${usd(step, 0)} laba dipindahkan ke wallet terpisah yang tidak pernah
       menandatangani apa pun.</p>
    <p><strong>Dividen dan pencairan dibayar dari kas ini</strong>, bukan dari posisi yang sedang
       berjalan. Membayar dari posisi berarti membongkarnya di waktu yang belum tentu tepat, dan
       ongkos pembongkaran itu ditanggung semua orang.</p>
    <p><strong>Uang yang dipindahkan tetap milik dana.</strong> Ia tetap dihitung penuh dalam nilai
       saham — kalau tidak, memindahkannya akan terbaca sebagai kerugian sebesar uang yang
       dipindahkan, dan harga saham semua orang turun karena tindakan yang justru mengamankan uang
       mereka. Porsi kepemilikan tidak berubah sedikit pun.</p>
    <p class="dim">Alasan kedua: bot punya batas kapasitas. Modal di atas batas itu tidak menambah
       hasil, hanya menambah risiko. Memindahkan laba menjaga ukuran yang dipegang bot tetap di
       ukuran yang memang sanggup dikelolanya.</p>`;
}

/** Halaman pengenalan — angkanya ikut data hidup, bukan ditulis tangan. */
function renderAbout() {
  const f = state.cfg?.fund || {};
  const d = state.cfg?.dividend || {};
  const t = state.cfg?.treasury || {};
  const nav = state.nav?.totalUsd || 0;
  const units = state.ledger?.totalUnits || 0;
  const perUnit = units > 0 ? nav / units : 0;
  const costs = (state.cfg?.costs?.items || []).reduce((a, c) => a + (Number(c.usd) || 0), 0);

  const big = (v, k, c = '') => `<div class="hero-stat"><div class="hv ${c}">${v}</div><div class="hk">${k}</div></div>`;
  $('#heroStats').innerHTML = [
    big(usd(nav, 0), 'dana kelolaan'),
    big(usd(perUnit, 4), 'harga satu saham', perUnit >= 1 ? 'pos' : 'neg'),
    big(String((state.ledger?.owners || []).length), 'pemegang saham'),
    big(String((state.nav?.positions || []).length), 'posisi berjalan'),
  ].join('');

  $('#aboutFacts').innerHTML = [
    ['Harga satu saham', usd(perUnit, 4)],
    ['Unit beredar', num(units, 2)],
    ['Harga saat dibuka', usd(1, 4)],
    ['Sejak dibuka', `${perUnit >= 1 ? '+' : ''}${pct((perUnit - 1) * 100)}`],
  ].map(([k, v]) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`).join('');

  $('#aboutRules').querySelector('tbody').innerHTML = [
    ['Minimum setoran', usd(Number(f.minDepositUsd) || 0, 0)],
    ['Plafon dana', `${usd(Number(f.capacityUsd) || 0, 0)} — di atas itu, investor baru membeli saham pemegang lama`],
    ['Masuk & keluar', `pemberitahuan ${Number(f.noticeHours) || 24} jam`],
    ['Biaya operasional', `${usd(costs, 0)} per bulan, dibagi menurut porsi saham`],
    ['Fee performa', Number(d.performanceFeePct) > 0
      ? `${d.performanceFeePct}% dari laba di atas rekor harga saham`
      : `${d.performanceFeeStandardPct || 15}% dari laba di atas rekor — gratis selama masa perkenalan`],
    ['Dividen', `${d.profitSharePct ?? 50}% dari laba di atas rekor, dibayar tiap tanggal ${Number(d.payDayOfMonth) || 1}`],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  $('#aboutTreHint').textContent = Number(t.movedUsd) > 0
    ? `${usd(Number(t.movedUsd))} sudah dipindahkan` : 'belum ada yang dipindahkan';
  $('#aboutRisk1').innerHTML = `Harga satu saham hari ini ${usd(perUnit, 4)}, dibanding ${usd(1, 4)} saat dana dibuka — `
    + `${perUnit >= 1 ? 'naik' : 'turun'} ${pct(Math.abs(perUnit - 1) * 100)}. Dana ini pernah turun dan bisa turun lagi.`;
  $('#aboutRisk3').innerHTML = `Biaya ${usd(costs, 0)} per bulan atas dana ${usd(nav, 0)} adalah `
    + `${pct(nav ? (costs / nav) * 100 : 0)} sebulan. Bot harus melewati angka itu dulu sebelum ada laba yang bisa dibagi.`;
}

function renderDividend() {
  if (!state.ledger || !state.nav) return;
  const input = $('#divNav');
  if (!input.value) input.value = (state.nav.totalUsd || 0).toFixed(2);

  const navUsd = Math.max(0, Number(input.value) || 0);
  const plan = dividendPlan(navUsd);
  const owners = ownerValues(state.ledger, plan.navAfter);

  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  $('#divSummary').innerHTML = [
    tile('Rekor harga saham', usd(plan.hwm, 4), `modal terkunci ${usd(plan.locked, 0)}`),
    tile('Harga saham', usd(plan.navPerUnit, 4),
      plan.navPerUnit >= plan.hwm ? 'di atas rekor' : 'masih di bawah rekor',
      plan.navPerUnit >= plan.hwm ? 'pos' : 'neg'),
    tile('Laba di atas rekor', usd(plan.profit),
      plan.profit > 0 ? 'dasar perhitungan dividen' : 'belum ada laba — belum ada dividen', cls(plan.profit)),
    tile('Fee performa', plan.feePct > 0 ? usd(plan.fee) : 'GRATIS',
      plan.feePct > 0 ? `${plan.feePct}% dari laba` : `masa perkenalan · normal ${plan.standardFeePct}%`,
      plan.feePct > 0 ? '' : 'pos'),
    tile('Dibayarkan', usd(plan.distributed),
      plan.profit > 0 ? `${plan.profitSharePct}% dari laba, dikurangi cadangan ${usd(plan.reserve, 0)}` : 'ke seluruh investor',
      plan.distributed > 0 ? 'pos' : ''),
  ].join('');

  $('#divTable').querySelector('tbody').innerHTML = owners.map((o) => `
    <tr>
      <td><span class="who"><span class="chip" style="background:${o.color || '#4ade80'}"></span>${o.name}</span></td>
      <td class="num">${pct(o.share)}</td>
      <td class="num ${plan.distributed > 0 ? 'pos' : 'dim'}">${usd(plan.distributed * (o.share / 100))}</td>
      <td class="num">${usd(o.value)}</td>
    </tr>`).join('');

  const real = Math.abs(navUsd - (state.nav.totalUsd || 0)) < 0.01;
  $('#divHint').textContent = `dibayar tiap tanggal ${plan.payDay} · berikutnya ${nextPayDate(plan.payDay)}`
    + (real ? '' : ' · memakai angka andaian');

  $('#divRule').innerHTML = `
    <p><strong>Yang dibagi adalah kenaikan harga saham, bukan kenaikan nilai wallet.</strong>
       Nilai wallet ikut naik setiap ada investor baru menyetor — dividen yang dihitung dari situ
       akan membagikan uang yang baru saja masuk. Harga saham tidak bergerak oleh setoran, jadi
       yang terbagi benar-benar hasil kerja bot.</p>
    <p><strong>Rekor tertinggi ${usd(plan.hwm, 4)}</strong> adalah harga saham tertinggi yang pernah
       dibayarkan dividennya. Selama harga di bawah angka itu, tidak ada dividen — dana yang turun
       lalu naik lagi ke titik yang sama tidak menghasilkan apa pun yang baru untuk dibagi.</p>
    <p><strong>Fee performa ${plan.feePct > 0 ? plan.feePct + '%' : '0% — ' + plan.feeNote}.</strong>
       ${plan.feePct > 0
        ? 'Diambil dari laba di atas rekor, sebelum sisanya dibagi.'
        : `Tarif normalnya ${plan.standardFeePct}% dari laba di atas rekor. Selama masa perkenalan pengelola tidak mengambil apa pun; seluruh laba masuk ke investor.`}</p>
    <p>Dari laba ${usd(plan.profit)}, sebanyak <strong>${plan.profitSharePct}%</strong> masuk kantong
       dividen, ${usd(plan.reserve, 0)} ditahan sebagai saldo mengendap untuk gas dan biaya
       keluar-masuk posisi, dan sisanya <strong>${usd(plan.distributed)}</strong> dibagi menurut
       porsi saham. Laba yang tidak dibagikan tetap bekerja di dana dan menaikkan harga saham.</p>
    <p class="dim">Contoh: harga saham naik dari rekor $1,0000 ke $1,0750 dengan 9.337 unit → laba
       $700 → dividen $325 dibagikan, $50 mengendap, $325 diputar lagi. Pemegang 10% saham
       menerima $32,50, dan sisa unitnya ikut naik nilainya.</p>`;
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
  const W = 720, H = 280, m = { t: 18, r: 16, b: 36, l: 60 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  if (!buckets.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="g-lbl">Belum ada posisi yang ditutup di rentang ini.</text>`;
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

    const every = Math.ceil(buckets.length / 8);
    if (i % every === 0 || i === buckets.length - 1) {
      bars += `<text x="${x + bw / 2}" y="${H - m.b + 18}" text-anchor="middle" class="g-lbl">${b.label}</text>`;
    }

    hits += `<rect x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ph}" fill="transparent" data-i="${i}"/>`;
  });

  svg.innerHTML = grid + bars + caps + `<g id="hits">${hits}</g>`;

  const wrap = $('#chartWrap');
  const tip = $('#chartTip');
  svg.querySelectorAll('#hits rect').forEach((rect) => {
    rect.onmouseenter = () => {
      const b = buckets[Number(rect.getAttribute('data-i'))];
      const ratio = (wrap.clientWidth || W) / W;
      tip.innerHTML = `<div class="t-d">${b.label}</div>`
        + `<div class="t-v ${cls(b.usd)}">${signed(b.usd)}</div>`
        + `<div class="t-n">${b.closes} posisi ditutup</div>`;
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
  $('#calDow').innerHTML = D_SHORT.map((d) => `<span>${d}</span>`).join('');
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
      <span class="a ${cls(row.usd)}">${signed(row.usd)}</span>
      <span class="c">${row.closes} tutup</span>
    </div>`;
  }

  $('#calGrid').innerHTML = cells;
  $('#calFoot').innerHTML = `<span>${monthCloses} posisi ditutup bulan ini</span>`
    + `<span>Total <b class="${cls(monthTotal)}">${signed(monthTotal)}</b></span>`;
}

function renderStats() {
  const st = state.nav?.stats;
  const box = $('#profitStats');
  if (!st) { box.innerHTML = ''; return; }
  const tile = (k, v, n, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="n">${n}</div></div>`;
  box.innerHTML = [
    tile('Profit terkunci', signed(st.realisedUsd), 'dari posisi yang sudah ditutup', cls(st.realisedUsd)),
    tile('Win rate', st.winRate == null ? '—' : pct(st.winRate, 1), `${st.wins} untung · ${st.losses} rugi`),
    tile('Posisi ditutup', String(st.closedCount), `${st.openCount} masih jalan`),
    tile('Rata-rata modal', st.avgInvestedUsd == null ? '—' : usd(st.avgInvestedUsd, 0), 'per posisi'),
    st.bestDay
      ? tile('Hari terbaik', signed(st.bestDay.usd), fmtDay(st.bestDay.date), cls(st.bestDay.usd))
      : tile('Hari terbaik', '—', 'belum ada data'),
  ].join('');
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
      readSnapshot(state.cfg).then((snap) => {
        if (!snap?.history?.length) return;
        state.nav.history = snap.history;
        state.nav.stats = snap.stats || state.nav.stats;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.nav)); } catch { /* mode privat */ }
        renderProfit();
      }).catch(() => {});
    }
    $('#profitHint').textContent = 'mengambil riwayat dari snapshot…';
    $('#profitStats').innerHTML = '';
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
  $('#profitHint').textContent = `${rows.length} hari ada transaksi · batas hari pakai jam WIB · sumber: buku posisi bot`;
  $('#profitNote').textContent = st
    ? `Yang dihitung di kartu ini cuma profit yang sudah terkunci. Untung/rugi ${st.openCount} posisi yang masih jalan belum masuk sini — bagian itu sudah ikut di "Nilai sekarang" paling atas.`
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

/* ── boot ────────────────────────────────────────────────────────────── */

function renderAll() {
  const rows = ownerValues(state.ledger, state.nav.totalUsd);
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
  renderAbout();
  renderNavChart();
  renderProfit();
  renderHistory(state.ledger);
  renderCalc();
}

async function load({ force = false } = {}) {
  const btn = $('#refreshBtn');
  historyRetried = false;
  btn.disabled = true;
  btn.textContent = 'memuat…';
  try {
    const [nav, series] = await Promise.all([
      resolveNav(state.cfg, { force }),
      readNavSeries(state.cfg),
      fxRates(),
    ]);
    if (!lastUsdIdr && Number(nav?.usdIdr) > 0) lastUsdIdr = Number(nav.usdIdr);
    state.nav = nav;
    if (series.length) navPoints = series;

    // Laporan bot dengan arsipnya berukuran puluhan kilobyte dan cuma dipakai
    // di satu tab. Diambil waktu tabnya dibuka, bukan tiap halaman dimuat.
    if (hbLoaded) refreshHeartbeat({ force });
    const msgs = [...state.ledger.warnings];
    if (state.nav.partial) msgs.push('Nilai posisi LP belum ikut dihitung — yang tampil cuma token di dalam wallet. Jalankan scripts/sync.mjs biar lengkap.');
    if (state.nav.lpStale) msgs.push(`Nilai posisi LP terakhir dihitung ${ago(state.nav.updatedAt)} — bagian itu bisa ketinggalan. Saldo token tetap live.`);
    banner(msgs.join(' · '));
    renderAll();
  } catch (err) {
    banner('Gagal ambil data: ' + (err.message || err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'refresh';
  }
}

async function init() {
  try {
    const res = await fetch(CONFIG_URL + '?t=' + Date.now(), { cache: 'no-store' });
    state.cfg = await res.json();
  } catch (err) {
    banner('data/config.json tidak terbaca: ' + (err.message || err), 'err');
    return;
  }

  const cfg = state.cfg;
  document.title = `${cfg.app?.name || 'cashood'} — shared wallet tracker`;
  $('#tagline').textContent = cfg.app?.tagline || '';
  // Alamat wallet tidak ditampilkan dan tidak disimpan di config.
  $('#addrText').textContent = cfg.wallet?.chainName || 'Robinhood Chain';

  state.ledger = buildLedger(cfg);
  $('#wdOwner').innerHTML = state.ledger.owners.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');

  $('#refreshBtn').onclick = () => load({ force: true });
  wireProfitControls();

  $('#holdPager').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    holdPage = Number(btn.getAttribute('data-p')) || 0;
    renderHoldings(state.nav);
  };

  $('#segCur').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    // Daftar mata uang dibaca dari tombolnya sendiri. Versi sebelumnya menulis
    // ulang daftar itu di sini — "eth atau usd" — jadi tombol rupiah menyala
    // tapi angkanya tetap dolar, dan tidak ada yang error untuk menandainya.
    const want = btn.getAttribute('data-c');
    currency = ['eth', 'idr'].includes(want) ? want : 'usd';
    try { localStorage.setItem('cashood.currency', currency); } catch { /* mode privat */ }
    $('#segCur').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderAll();
  };
  $('#segCur').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-c') === currency));

  $('#tabs').onclick = (e) => {
    const btn = e.target.closest('button');
    if (btn) showTab(btn.getAttribute('data-tab'));
  };
  const fromHash = () => showTab(location.hash.replace('#', '') || 'portfolio');
  window.addEventListener('hashchange', fromHash);
  fromHash();

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
  $('#wdAmount').oninput = renderCalc;
  $('#wdMode').onchange = renderCalc;
  $('#wdOwner').onchange = renderCalc;

  await load();

  // auto-refresh diam-diam selama tab dibiarkan terbuka
  const every = (Number(cfg.app?.refreshMinutes) || 60) * 60000;
  setInterval(() => load({ force: true }), every);
}

// Diekspos untuk debugging di console browser (dan untuk tes di node).
globalThis.cashood = { state, buildLedger, ownerValues, load, renderProfitProbe: renderProfit };

if (typeof document !== 'undefined') init();
