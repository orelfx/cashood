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
const CACHE_KEY = 'cashood.nav.v2';

const $ = (sel) => document.querySelector(sel);
const state = { cfg: null, ledger: null, nav: null };

/* ── format ──────────────────────────────────────────────────────────── */

const usd = (n, dp = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });

const pct = (n, dp = 2) => (Number(n) || 0).toFixed(dp) + '%';

const num = (n, dp = 4) =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

const signed = (n) => (n > 0 ? '+' : '') + usd(n);

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

async function rpcCall(urls, method, params) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      return json.result;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('semua RPC gagal');
}

async function ethPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    const p = Number(j?.ethereum?.usd);
    if (p > 0) return p;
  } catch { /* lanjut ke cadangan */ }
  try {
    const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + weth);
    const j = await r.json();
    const p = Number(j?.pairs?.[0]?.priceUsd);
    if (p > 0) return p;
  } catch { /* menyerah */ }
  return null;
}

/** Saldo token yang dipegang wallet, langsung dari RPC publik. */
async function readWallet(cfg) {
  const { address, rpc, tokens } = cfg.wallet;
  const price = await ethPrice();
  const pad = address.toLowerCase().replace('0x', '').padStart(64, '0');

  const holdings = [];
  for (const t of tokens || []) {
    let raw;
    try {
      raw = t.address === 'native'
        ? await rpcCall(rpc, 'eth_getBalance', [address, 'latest'])
        : await rpcCall(rpc, 'eth_call', [{ to: t.address, data: '0x70a08231' + pad }, 'latest']);
    } catch { continue; }

    const amount = Number(BigInt(raw || '0x0')) / 10 ** t.decimals;
    const unit = t.priceId === 'ethereum' ? price : Number(t.priceUsd ?? 0);
    if (amount <= 0) continue;
    holdings.push({ symbol: t.symbol, amount, price: unit, usd: unit == null ? null : amount * unit });
  }

  const totalUsd = holdings.reduce((s, h) => s + (h.usd || 0), 0);
  return { totalUsd, holdings, ethPrice: price };
}

/** Snapshot dari bot (scripts/sync.mjs). Sudah termasuk posisi LP. */
async function readSnapshot() {
  const res = await fetch(LIVE_URL + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('tidak ada snapshot');
  const j = await res.json();
  if (!Number.isFinite(Number(j.totalUsd))) throw new Error('snapshot tanpa totalUsd');
  return j;
}

async function resolveNav(cfg, { force = false } = {}) {
  // 1. angka manual selalu menang
  const manual = Number(cfg.navOverrideUsd);
  if (Number.isFinite(manual) && manual > 0) {
    return { totalUsd: manual, source: 'manual', label: 'angka manual dari config.json', fetchedAt: Date.now(), holdings: [], positions: [] };
  }

  // 2. cache — supaya buka-tutup halaman tidak menghajar rate limit
  const ttl = (Number(cfg.app?.refreshMinutes) || 60) * 60000;
  if (!force) {
    try {
      const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (hit && Date.now() - hit.fetchedAt < ttl) return { ...hit, cached: true };
    } catch { /* cache rusak, abaikan */ }
  }

  // 3. snapshot bot, kalau ada dan masih segar
  let out = null;
  try {
    const snap = await readSnapshot();
    const age = Date.now() - (Number(snap.updatedAt) || 0);
    out = {
      totalUsd: Number(snap.totalUsd),
      source: 'snapshot',
      label: 'snapshot bot (termasuk posisi LP)',
      updatedAt: Number(snap.updatedAt) || null,
      stale: age > 6 * 3600e3,
      holdings: snap.holdings || [],
      positions: snap.positions || [],
      fetchedAt: Date.now(),
    };
  } catch { /* jatuh ke RPC */ }

  // 4. baca langsung dari chain
  if (!out) {
    const live = await readWallet(cfg);
    out = {
      totalUsd: live.totalUsd,
      source: 'rpc',
      label: 'RPC publik — hanya saldo token di wallet',
      holdings: live.holdings,
      positions: [],
      fetchedAt: Date.now(),
      partial: true,
    };
  }

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

  $('#kpiNav').textContent = usd(nav.totalUsd);
  $('#kpiNavSub').textContent = nav.label + (nav.cached ? ' · dari cache' : '');
  $('#kpiDeposit').textContent = usd(ledger.deposited);
  $('#kpiWithdraw').textContent = usd(ledger.withdrawn);
  const el = $('#kpiPnl');
  el.textContent = signed(pnl);
  el.className = 'big ' + cls(pnl);
  $('#kpiPnlSub').textContent = (pnl >= 0 ? '+' : '') + pct(pnlPct) + ' dari modal';
  $('#donutVal').textContent = usd(nav.totalUsd, 0);
  $('#footSrc').textContent = nav.source === 'snapshot' ? 'snapshot bot' : nav.source === 'manual' ? 'config manual' : 'RPC publik';
  $('#footTime').textContent = 'diperbarui ' + ago(nav.fetchedAt);
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
  $('#unitHint').textContent =
    `${num(state.ledger.totalUnits, 2)} unit beredar · 1 unit = ${usd(state.ledger.totalUnits > 0 ? state.nav.totalUsd / state.ledger.totalUnits : 0, 4)}`;
}

function renderHoldings(nav) {
  const rows = [
    ...(nav.holdings || []).map((h) => ({ ...h, kind: 'token' })),
    ...(nav.positions || []).map((p) => ({
      symbol: 'LP ' + (p.symbol || p.tokenId || '?'), amount: null, price: null,
      usd: (Number(p.principalUsd) || 0) + (Number(p.feesUsd) || 0), kind: 'lp',
    })),
  ];
  const body = $('#holdTable').querySelector('tbody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="4" class="dim">Tidak ada saldo terbaca.</td></tr>`;
  } else {
    body.innerHTML = rows.map((r) => `
      <tr>
        <td><span class="who"><span class="chip" style="background:${r.kind === 'lp' ? '#60a5fa' : '#4ade80'}"></span>${r.symbol}</span></td>
        <td class="num">${r.amount == null ? '<span class="dim">—</span>' : num(r.amount, 6)}</td>
        <td class="num">${r.price == null ? '<span class="dim">—</span>' : usd(r.price, r.price < 10 ? 4 : 2)}</td>
        <td class="num">${r.usd == null ? '<span class="dim">?</span>' : usd(r.usd)}</td>
      </tr>`).join('');
  }
  $('#holdHint').textContent = nav.partial
    ? 'hanya token di wallet — posisi LP belum terhitung'
    : nav.source === 'manual' ? 'NAV dikunci manual di config.json' : 'wallet + posisi LP';
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

  const taken = cuts.filter((c) => c.take > 0);
  const today = new Date().toISOString().slice(0, 10);
  $('#wdJson').textContent = taken.length
    ? taken.map((c) => JSON.stringify({
        date: today, type: 'withdraw', owner: c.id,
        usd: Number(c.take.toFixed(2)), navBefore: Number(state.nav.totalUsd.toFixed(2)), note: '',
      })).join(',\n')
    : '—';
}

/* ── boot ────────────────────────────────────────────────────────────── */

function renderAll() {
  const rows = ownerValues(state.ledger, state.nav.totalUsd);
  renderSummary(state.ledger, state.nav);
  renderDonut(rows);
  renderOwners(rows);
  renderHoldings(state.nav);
  renderHistory(state.ledger);
  renderCalc();
}

async function load({ force = false } = {}) {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.textContent = 'memuat…';
  try {
    state.nav = await resolveNav(state.cfg, { force });
    const msgs = [...state.ledger.warnings];
    if (state.nav.partial) msgs.push('Nilai yang tampil hanya token di dalam wallet — posisi LP belum ikut dihitung. Jalankan scripts/sync.mjs biar angkanya lengkap.');
    if (state.nav.stale) msgs.push('Snapshot bot sudah lebih dari 6 jam. Angka bisa ketinggalan.');
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
  $('#addrText').textContent = short(cfg.wallet.address);
  $('#addrLink').href = `${cfg.wallet.explorer}/address/${cfg.wallet.address}`;

  state.ledger = buildLedger(cfg);
  $('#wdOwner').innerHTML = state.ledger.owners.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');

  $('#copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(cfg.wallet.address); $('#copyBtn').textContent = 'tersalin'; }
    catch { $('#copyBtn').textContent = 'gagal'; }
    setTimeout(() => { $('#copyBtn').textContent = 'salin'; }, 1400);
  };
  $('#refreshBtn').onclick = () => load({ force: true });
  $('#wdAmount').oninput = renderCalc;
  $('#wdMode').onchange = renderCalc;
  $('#wdOwner').onchange = renderCalc;
  $('#wdCopyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('#wdJson').textContent); $('#wdCopyBtn').textContent = 'tersalin'; }
    catch { $('#wdCopyBtn').textContent = 'gagal'; }
    setTimeout(() => { $('#wdCopyBtn').textContent = 'salin JSON'; }, 1400);
  };

  await load();

  // auto-refresh diam-diam selama tab dibiarkan terbuka
  const every = (Number(cfg.app?.refreshMinutes) || 60) * 60000;
  setInterval(() => load({ force: true }), every);
}

// Diekspos untuk debugging di console browser (dan untuk tes di node).
globalThis.cashood = { state, buildLedger, ownerValues, load };

if (typeof document !== 'undefined') init();
