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
const CACHE_KEY = 'cashood.nav.v3';

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

/**
 * Snapshot dari bot (scripts/sync.mjs) — nilai tiap posisi LP.
 *
 * Dicoba dari `snapshotUrl` dulu (raw.githubusercontent) karena file di sana
 * ikut berubah begitu di-push, tanpa nunggu GitHub Pages build ulang. Kalau
 * gagal, jatuh ke salinan yang ikut ke-deploy bareng situsnya.
 */
async function readSnapshot(cfg) {
  const urls = [cfg?.app?.snapshotUrl, LIVE_URL].filter(Boolean);
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

  // 2. cache pendek — cuma buat nahan reload beruntun, bukan buat nunda data
  const ttl = (Number(cfg.app?.refreshMinutes) || 5) * 60000;
  if (!force) {
    try {
      const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (hit && Date.now() - hit.fetchedAt < ttl) return { ...hit, cached: true };
    } catch { /* cache rusak, abaikan */ }
  }

  // 3. Dua sumber, digabung.
  //
  //    Saldo token dibaca LANGSUNG dari chain tiap kali halaman dibuka — itu
  //    yang bikin angkanya ikut wallet detik itu juga. Yang tidak bisa dibaca
  //    browser adalah nilai posisi LP: hitungannya butuh tick math + quoter
  //    per posisi, jadi bagian itu diambil dari snapshot yang ditulis bot.
  const [live, snap] = await Promise.all([
    readWallet(cfg).catch(() => null),
    readSnapshot(cfg).catch(() => null),
  ]);

  if (!live && !snap) throw new Error('RPC dan snapshot dua-duanya tidak bisa dibaca');

  const positions = snap?.positions || [];
  const history = snap?.history || [];
  const stats = snap?.stats || null;
  const lpUsd = positions.reduce((s, p) => s + (Number(p.principalUsd) || 0) + (Number(p.feesUsd) || 0), 0);
  const snapAge = snap ? Date.now() - (Number(snap.updatedAt) || 0) : null;

  let out;
  if (live) {
    out = {
      totalUsd: live.totalUsd + lpUsd,
      source: positions.length ? 'live+lp' : 'rpc',
      label: positions.length
        ? `token live dari chain + ${positions.length} posisi LP dari snapshot`
        : 'token live dari chain — tidak ada posisi LP terbaca',
      holdings: live.holdings,
      positions,
      history,
      stats,
      lpUsd,
      liveUsd: live.totalUsd,
      updatedAt: snap ? Number(snap.updatedAt) : null,
      lpStale: snapAge != null && snapAge > 45 * 60e3,
      partial: !positions.length,
      fetchedAt: Date.now(),
    };
  } else {
    // RPC lagi ngambek — pakai snapshot apa adanya
    out = {
      totalUsd: Number(snap.totalUsd),
      source: 'snapshot',
      label: 'RPC tidak jalan — pakai snapshot bot',
      holdings: snap.holdings || [],
      positions,
      history,
      stats,
      lpUsd,
      updatedAt: Number(snap.updatedAt) || null,
      lpStale: snapAge != null && snapAge > 45 * 60e3,
      fetchedAt: Date.now(),
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
  $('#kpiNavSub').textContent = nav.lpUsd > 0
    ? `${usd(nav.liveUsd ?? 0, 0)} token + ${usd(nav.lpUsd, 0)} di LP`
    : nav.label;
  $('#kpiDeposit').textContent = usd(ledger.deposited);
  $('#kpiWithdraw').textContent = usd(ledger.withdrawn);
  const el = $('#kpiPnl');
  el.textContent = signed(pnl);
  el.className = 'big ' + cls(pnl);
  $('#kpiPnlSub').textContent = (pnl >= 0 ? '+' : '') + pct(pnlPct) + ' dari modal';
  $('#donutVal').textContent = usd(nav.totalUsd, 0);
  $('#footSrc').textContent = {
    'live+lp': 'RPC publik (live) + snapshot LP',
    rpc: 'RPC publik (live)',
    snapshot: 'snapshot bot',
    manual: 'config manual',
  }[nav.source] || 'RPC publik';
  $('#footTime').textContent = 'diperbarui ' + ago(nav.fetchedAt);

  const every = Number(state.cfg?.app?.refreshMinutes) || 5;
  $('#stripToken').textContent = nav.source === 'manual'
    ? 'dikunci manual di config.json'
    : nav.source === 'snapshot'
      ? 'RPC tidak jalan — ikut snapshot'
      : `live dari chain, cek ulang tiap ${every} menit`;
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
  $('#holdHint').textContent = nav.source === 'manual'
    ? 'NAV dikunci manual di config.json'
    : nav.partial
      ? 'token dibaca live dari chain — posisi LP belum terhitung'
      : `token live dari chain · nilai LP dihitung ${ago(nav.updatedAt)}`;
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

const view = { mode: 'chart', bucket: 'day', rangeDays: 7, month: null };

const D_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const M_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const parseDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDay = (iso) => { const d = parseDay(iso); return `${d.getUTCDate()} ${M_SHORT[d.getUTCMonth()]}`; };

function history() {
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
      + `<text x="${m.l - 9}" y="${yy + 3.5}" text-anchor="end" class="g-lbl">${v === 0 ? '0' : usd(v, 0)}</text>`;
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
      caps += `<text x="${x + bw / 2}" y="${up ? yv - 7 : yv + 14}" text-anchor="middle" class="g-cap">${signed(b.usd)}</text>`;
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
  const rows = history();
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
  const rows = history();
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
  $('#profitHint').textContent = `${rows.length} hari ada transaksi · sumber: buku posisi bot`;
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
      renderProfit();
    };
  };
  pick('#segView', 'data-v', (v) => { view.mode = v; });
  pick('#segBucket', 'data-b', (v) => { view.bucket = v; });
  pick('#segRange', 'data-r', (v) => { view.rangeDays = Number(v); });

  const hop = (dir) => {
    const months = [...new Set(history().map((r) => r.date.slice(0, 7)))].sort();
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
  renderProfit();
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
  wireProfitControls();
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
globalThis.cashood = { state, buildLedger, ownerValues, load, renderProfitProbe: renderProfit };

if (typeof document !== 'undefined') init();
