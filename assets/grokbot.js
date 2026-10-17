/*
 * Devil Greed · dashboard paper (cashood.id/grokbot/...).
 * Satu halaman = satu buku (dgsol atau dgrh); dua buku tidak pernah digabung.
 * Semua angka dibaca dari snapshot yang diterbitkan di branch `data`
 * (live.json, nav.json, trades/<hari>.json). Tidak ada angka simulasi:
 * kalau data tidak ada, kartu menulis "belum ada data".
 */
(function () {
  'use strict';
  const RAW = 'https://raw.githubusercontent.com/orelfx/cashood/data/';
  const STALE_MS = 15 * 60e3, HOT_MS = 5 * 60e3, WIB = 7 * 3600e3;
  const BIG_USD = 20, BIG_PCT = 30;
  const TRAIL_KEEP = 0.75;   // sama dengan watcher desk: keluar di max(harga isi, puncak × 0,75)
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const usd = (v, dp = 2) => (num(v) == null ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const sgn = (v, dp = 2) => (num(v) == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const pct = (v, dp = 1) => (num(v) == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp) + '%');
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const wibDate = (t) => new Date(t + WIB);
  const hhmm = (t) => wibDate(t).toISOString().slice(11, 16);
  const dayKey = (t) => wibDate(t).toISOString().slice(0, 10);
  const stamp = (t) => (dayKey(t) === dayKey(Date.now()) ? hhmm(t) : wibDate(t).toISOString().slice(8, 10) + '/' + wibDate(t).toISOString().slice(5, 7) + ' ' + hhmm(t));
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60e3)); return m < 1 ? 'baru saja' : m < 60 ? `${m} mnt lalu` : m < 1440 ? `${Math.floor(m / 60)} jam ${m % 60} mnt lalu` : `${Math.floor(m / 1440)} hari lalu`; };
  const dur = (min) => (min == null ? '—' : min < 60 ? `${min} mnt` : min < 1440 ? `${Math.floor(min / 60)} jam ${min % 60} mnt` : `${Math.floor(min / 1440)} hr ${Math.floor((min % 1440) / 60)} jam`);
  const get = async (path) => { const r = await fetch(`${RAW}${path}?t=${Math.floor(Date.now() / 60e3)}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); };
  // Fakta desk diterbitkan sebagai pasangan kunci–nilai di strategy.system.
  const fact = (live, key) => { const row = (live?.strategy?.system || []).find((x) => Array.isArray(x) && x[0] === key); return row ? String(row[1]) : null; };
  const leadNum = (s) => { const m = s && s.match(/^\s*(\d+)/); return m ? Number(m[1]) : null; };

  // ── halaman indeks: dua kartu, masing-masing bukunya sendiri ──
  if (document.body.dataset.fund === 'index') {
    document.querySelectorAll('[data-idx]').forEach(async (a) => {
      try {
        const live = await get(`${a.dataset.idx}/live.json`);
        const pnl = num(live.trading?.pnlUsd);
        a.querySelector('.v').textContent = usd(live.totalUsd);
        a.querySelector('.n').innerHTML = `<span class="${cls(pnl)}">${esc(sgn(pnl))}</span> sejak mulai · ${esc((live.positions || []).length)} posisi · ${esc(ago(live.updatedAt))}`;
      } catch { a.querySelector('.n').textContent = 'data belum bisa dimuat'; }
    });
    return;
  }

  const FUND = document.body.dataset.fund;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === FUND));
  const tradeCache = new Map();   // hari lampau tidak berubah lagi; hari ini dimuat ulang

  async function loadTrades(live) {
    const days = (live.tradeDays || []).map((x) => x.d);
    const today = dayKey(Date.now());
    const rows = [];
    await Promise.all(days.map(async (d) => {
      if (!tradeCache.has(d) || d >= today) { try { tradeCache.set(d, (await get(`${FUND}/trades/${d}.json`)).rows || []); } catch { if (!tradeCache.has(d)) tradeCache.set(d, []); } }
    }));
    days.forEach((d) => rows.push(...(tradeCache.get(d) || [])));
    return rows.filter((r) => num(r.closedAt) != null).sort((a, b) => a.closedAt - b.closedAt);
  }

  const isPartial = (c) => /^jual separuh/i.test(c.reasonDetail || '');
  const isTrail = (c) => /trailing stop setelah/i.test(c.reasonDetail || '');
  const closeKind = (c) => (isPartial(c) ? ['TP1', 'tp'] : isTrail(c) ? ['TRAIL', 'tp'] : c.reason === 'take_profit' ? ['TP', 'tp'] : c.reason === 'stop_loss' ? ['STOP', 'skip']
    : c.reason === 'time_exit' ? ['TIME EXIT', 'close'] : ['CLOSE', 'close']);
  const SKIPTXT = [[/^full_book/i, 'buku penuh'], [/^already holding/i, 'sudah pegang'], [/^safety:\s*/i, 'cek aman: '], [/^fact cut:\s*/i, 'fact cut: '],
    [/^judge\s*(\d+)/i, 'judge skor $1'], [/too small/i, 'beli leader terlalu kecil'], [/cooldown|24h|24 jam/i, 'jeda 24 jam'], [/full/i, 'buku penuh']];
  const skipWhy = (r) => { const s = String(r || ''); for (const [re, t] of SKIPTXT) if (re.test(s)) return t.includes('$1') ? s.replace(/^judge\s*(\d+).*/i, t) : (t.endsWith(': ') ? t + s.replace(re, '').slice(0, 70) : t); return s.slice(0, 70) || 'dilewati'; };
  const symOf = (s) => (!s || s === 'tanpa simbol' ? 'token baru' : '$' + s);

  function trailPct(p) {
    if (p.stopPct != null || num(p.peakPct) == null || !/\btrailing\b/.test(p.strategy || '')) return null;
    return Math.max(0, ((1 + p.peakPct / 100) * TRAIL_KEEP - 1) * 100);
  }

  function renderHeader(live) {
    const dec = fact(live, 'keputusan copydesk');
    const m = dec && dec.match(/(\d+)\s*copy\s*·\s*(\d+)\s*skip/);
    $('#decCount').textContent = m ? String(Number(m[1]) + Number(m[2])) : '—';
    $('#decCount').title = dec || 'belum ada data';
    const fresh = Date.now() - live.updatedAt < STALE_MS;
    const pill = $('#livePill');
    pill.className = 'gb-pill ' + (fresh ? 'live' : 'stale');
    pill.querySelector('span').textContent = fresh ? 'LIVE' : 'STALE';
    $('#updated').textContent = `diperbarui ${ago(live.updatedAt)}`;
  }

  function renderMetrics(live, closes) {
    const tr = live.trading || {};
    const init = num(tr.initialUsd) ?? 1000, eq = num(live.totalUsd), pnl = num(tr.pnlUsd) ?? (eq - init);
    $('#mBal').textContent = usd(eq);
    $('#mBalN').textContent = `started at ${usd(init, 0)} · kas ${usd(tr.cashUsd)}`;
    const p = $('#mPnl'); p.textContent = sgn(pnl); p.className = 'v ' + cls(pnl);
    $('#mPnlN').textContent = `${pct((pnl / init) * 100, 2)} sejak mulai · terealisasi ${sgn(tr.realizedUsd)}`;
    const wins = closes.filter((c) => num(c.netUsd) > 0);
    if (wins.length) {
      const best = wins.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
      $('#mWin').innerHTML = `<span class="pos">${esc(sgn(best.netUsd))}</span>`;
      $('#mWinN').textContent = `${symOf(best.symbol)} ${pct(best.netPct)}${best.firstWallet ? ' · by ' + best.firstWallet : ''}${isPartial(best) ? ' · TP1' : ''}`;
    } else { $('#mWin').textContent = '—'; $('#mWinN').textContent = 'scanning...'; }
    const st = live.stats || {}, w = num(st.wins) ?? 0, l = num(st.losses) ?? 0, wr = w + l ? (w / (w + l)) * 100 : null;
    $('#mWr').textContent = wr == null ? '—' : wr.toFixed(1) + '%';
    $('#mWrN').textContent = `${w} wins / ${l} losses`;
    const C = 2 * Math.PI * 16, f = wr == null ? 0 : wr / 100;
    $('#donut').innerHTML = `<circle cx="21" cy="21" r="16" fill="none" stroke="#3a2e23" stroke-width="5"/>
      <circle cx="21" cy="21" r="16" fill="none" stroke="#4ade80" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 21 21)"/>`;
    const rug = fact(live, 'diblok cek aman');
    $('#mRug').textContent = rug == null ? '—' : String(leadNum(rug) ?? '—');
    const last = rug && rug.match(/terakhir\s+(\S+)\s+([\d/]+\s+[\d:]+)\s+WIB:\s*(.*)$/);
    $('#mRugN').textContent = rug == null ? 'belum ada data' : last ? `last: $${last[1]} - ${last[3]}` : 'belum ada yang diblok';
  }

  function renderChart(nav, closes, live) {
    const svg = $('#chart');
    const pts = (nav.points || []).filter((p) => num(p.usd) != null && num(p.t) != null).sort((a, b) => a.t - b.t);
    if (live && num(live.totalUsd) != null && (!pts.length || live.updatedAt > pts.at(-1).t)) pts.push({ t: live.updatedAt, usd: live.totalUsd });
    const W = svg.clientWidth || 800, H = svg.clientHeight || 320, padL = 54, padR = 70, padT = 18, padB = 26;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (pts.length < 2) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#8c7a64" text-anchor="middle" font-size="13">belum cukup snapshot ekuitas</text>`; return; }
    const t0 = pts[0].t, t1 = pts.at(-1).t;
    let lo = Math.min(...pts.map((p) => p.usd), 1000), hi = Math.max(...pts.map((p) => p.usd), 1000);
    const padY = (hi - lo) * 0.12 || 10; lo -= padY; hi += padY;
    const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    // Jeda lebih dari 6 jam tanpa snapshot digambar putus-putus: tidak ada data di antaranya.
    const GAP = 6 * 3600e3;
    const line = pts.map((p, i) => `${i && p.t - pts[i - 1].t <= GAP ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.usd).toFixed(1)}`).join('');
    const gaps = pts.slice(1).map((p, i) => [pts[i], p]).filter(([a, b]) => b.t - a.t > GAP)
      .map(([a, b]) => `<line x1="${x(a.t).toFixed(1)}" y1="${y(a.usd).toFixed(1)}" x2="${x(b.t).toFixed(1)}" y2="${y(b.usd).toFixed(1)}" stroke="#8c7a64" stroke-dasharray="4 4"><title>tidak ada snapshot ${esc(stamp(a.t))} – ${esc(stamp(b.t))} WIB</title></line>`).join('');
    const areaLine = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.usd).toFixed(1)}`).join('');
    const area = `${areaLine}L${x(t1).toFixed(1)},${H - padB}L${x(t0).toFixed(1)},${H - padB}Z`;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
    const grid = ticks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#3a2e23" stroke-dasharray="3 4"/><text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" fill="#8c7a64" font-size="10" text-anchor="end">$${Math.round(v).toLocaleString('en-US')}</text>`).join('');
    const xt = [0, 0.5, 1].map((f) => t0 + f * (t1 - t0)).map((t, i) => `<text x="${x(t).toFixed(1)}" y="${H - 8}" fill="#8c7a64" font-size="10" text-anchor="${['start', 'middle', 'end'][i]}">${esc(stamp(t))}</text>`).join('');
    const base = `<line x1="${padL}" x2="${W - padR}" y1="${y(1000).toFixed(1)}" y2="${y(1000).toFixed(1)}" stroke="#b8a48a" stroke-opacity=".45"/><text x="${W - padR + 4}" y="${(y(1000) + 4).toFixed(1)}" fill="#8c7a64" font-size="10">modal</text>`;
    const peak = pts.reduce((a, b) => (b.usd > a.usd ? b : a));
    const peakMk = `<g><circle cx="${x(peak.t).toFixed(1)}" cy="${y(peak.usd).toFixed(1)}" r="4" fill="#facc15"/><text x="${x(peak.t).toFixed(1)}" y="${(y(peak.usd) - 8).toFixed(1)}" fill="#facc15" font-size="10" text-anchor="middle">puncak ${esc(usd(peak.usd))}</text></g>`;
    // Titik trade ditutup diletakkan di garis ekuitas pada waktu tutupnya.
    const at = (t) => { let i = pts.findIndex((p) => p.t >= t); if (i <= 0) return pts[Math.max(0, i)].usd; const a = pts[i - 1], b = pts[i]; return a.usd + (b.usd - a.usd) * ((t - a.t) / Math.max(1, b.t - a.t)); };
    const marks = closes.filter((c) => c.closedAt >= t0 && c.closedAt <= t1).map((c) => `<circle cx="${x(c.closedAt).toFixed(1)}" cy="${y(at(c.closedAt)).toFixed(1)}" r="3" fill="${c.netUsd >= 0 ? '#4ade80' : '#f87171'}" stroke="#14100c"><title>${esc(`${stamp(c.closedAt)} WIB ${c.symbol} ${closeKind(c)[0]} ${sgn(c.netUsd)}`)}</title></circle>`).join('');
    const last = pts.at(-1), lx = x(last.t), ly = y(last.usd), up = last.usd >= 1000;
    const col = up ? '#4ade80' : '#f87171';
    svg.innerHTML = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".38"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      ${grid}${base}<path d="${area}" fill="url(#g)"/>${gaps}<path d="${line}" fill="none" stroke="${col}" stroke-width="2"/>${marks}${peakMk}
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5" fill="${col}"/><rect x="${(lx + 6).toFixed(1)}" y="${(ly - 10).toFixed(1)}" width="62" height="20" rx="5" fill="${col}"/>
      <text x="${(lx + 37).toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="#14100c" font-size="11" font-weight="700" text-anchor="middle">${esc(usd(last.usd, 0))}</text>${xt}`;
    $('#chartNote').textContent = `${pts.length} snapshot ekuitas nyata · titik = ${closes.filter((c) => c.closedAt >= t0).length} trade ditutup`;
  }

  function renderLog(live, closes) {
    const ev = [];
    for (const d of live.copyTrade?.decisions || []) {
      const t = num(d.at); if (t == null) continue;
      if (d.action === 'enter') {
        const m = String(d.reason || '').match(/beli paper \$([\d.,]+)/);
        ev.push({ t, html: `<span class="a copy">COPY/BUY</span>${esc(symOf(d.symbol))}${d.basket ? ` <span class="why">· ${esc(d.basket)}</span>` : ''}${m ? ` <span class="pos">$${esc(m[1])}</span>` : ''}` });
      } else {
        ev.push({ t, html: `<span class="a skip">SKIP</span>${esc(symOf(d.symbol))}${d.basket ? ` <span class="why">· ${esc(d.basket)}</span>` : ''} <span class="neg">-&gt; ${esc(skipWhy(d.reason))}</span>` });
      }
    }
    for (const c of closes) {
      const [k, tone] = closeKind(c);
      ev.push({ t: c.closedAt, html: `<span class="a ${tone}">SELL/${esc(k)}</span>${esc(symOf(c.symbol))} <span class="${cls(c.netUsd)}">${esc(sgn(c.netUsd))} (${esc(pct(c.netPct))})</span>` });
    }
    ev.sort((a, b) => b.t - a.t);
    $('#log').innerHTML = ev.slice(0, 80).map((e) => `<li><span class="t">[${esc(stamp(e.t))} WIB]</span>${e.html}</li>`).join('') || '<li class="why">belum ada aktivitas</li>';
  }

  function renderPositions(live) {
    const rows = [...(live.positions || [])].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    $('#posCount').textContent = `(${rows.length})`;
    const lag = Math.max(0, Math.round((Date.now() - live.updatedAt) / 60e3));
    $('#posNote').textContent = `nilai = jual bersih menurut harga mark · ${ago(live.updatedAt)}`;
    $('#pos').innerHTML = rows.map((p) => {
      const tp = trailPct(p);
      const stop = tp != null ? `<span class="pos" title="TP1 sudah jual separuh; sisa keluar kalau harga turun 25% dari puncak, tidak di bawah harga isi">trail +${tp.toFixed(1)}%</span>`
        : p.stopPct == null && p.targetPct == null ? '<span class="sub">—</span>'
        : `<span class="neg">−${esc(Number(p.stopPct).toFixed(0))}%</span> / <span class="pos">+${esc(Number(p.targetPct).toFixed(0))}%</span>`;
      const plan = [p.bookLabel, p.firstWallet ? `via ${p.firstWallet}` : '', tp != null ? 'TP1 selesai' : ''].filter(Boolean).join(' · ');
      return `<tr><td><span class="sym ${cls(p.pnlUsd)}">●</span> <span class="sym">${esc(p.symbol)}</span>${p.stale ? '<div class="sub neg">harga belum terverifikasi</div>' : ''}</td>
        <td>${esc(plan)}</td><td class="num">${esc(dur(num(p.ageMinutes) == null ? null : p.ageMinutes + lag))}</td>
        <td class="num">${esc(usd(p.costUsd))}</td><td class="num"><b>${esc(usd(p.valueUsd))}</b></td>
        <td class="num ${cls(p.pnlUsd)}">${esc(sgn(p.pnlUsd))}<div class="sub">${esc(pct(p.pnlPct, 2))}</div></td><td class="num">${stop}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="sub">Belum ada posisi terbuka.</td></tr>';
  }

  function renderAgents(live, closes) {
    const dec = (live.copyTrade?.decisions || []).filter((d) => num(d.at) != null);
    const latest = (arr) => arr.reduce((m, d) => Math.max(m, d), 0);
    const now = Date.now(), today = dayKey(now);
    const closesToday = closes.filter((c) => dayKey(c.closedAt) === today);
    const sig = fact(live, 'sinyal masuk'), lead = fact(live, 'leader aktif'), rug = fact(live, 'diblok cek aman'), judge = fact(live, 'keputusan copydesk'), rej = fact(live, 'ditolak judge');
    const jm = judge && judge.match(/(\d+)\s*copy\s*·\s*(\d+)\s*skip/);
    const leadNames = lead && (lead.match(/\(([^)]*)\)/) || [])[1];
    const cards = [
      { name: 'Scout', ac: '#38bdf8', v: sig ? String(leadNum(sig)) : '—', n: sig ? 'sinyal masuk · ' + sig.replace(/^\d+\s*·\s*/, '') : 'belum ada data',
        hot: latest(dec.filter((d) => d.basket && d.basket !== 'manual').map((d) => d.at)) },
      { name: 'Cek Aman', ac: '#f87171', v: rug ? String(leadNum(rug)) : '—', n: rug ? 'token diblok gerbang keamanan' : 'belum ada data',
        hot: latest(dec.filter((d) => /^safety/i.test(d.reason || '')).map((d) => d.at)) },
      { name: 'Wallet Mix', ac: '#a78bfa', v: lead ? String(leadNum(lead)) : '—', n: lead ? `leader aktif${leadNames ? ' · ' + leadNames : ''}${/sementara/.test(lead) ? ' · tier sementara' : ''}` : 'belum ada data',
        hot: latest(dec.filter((d) => /^Leader /.test(d.basket || '')).map((d) => d.at)) },
      { name: 'Judge', ac: '#facc15', v: jm ? `${jm[1]} / ${jm[2]}` : '—', n: jm ? `copy / skip${rej ? ' · ' + leadNum(rej) + ' ditolak skor' : ''}` : 'belum ada data',
        hot: latest(dec.map((d) => d.at)) },
      { name: 'Watcher', ac: '#4ade80', v: String(closesToday.length), n: `tutup hari ini${closes.length ? ' · terakhir ' + stamp(closes.at(-1).closedAt) + ' WIB' : ''}`,
        hot: latest(closes.map((c) => c.closedAt)) },
      { name: 'Jurnal', ac: '#f5a524', v: String(live.stats?.closedCount ?? closes.length), n: `trade tercatat · snapshot ${stamp(live.updatedAt)} WIB`, hot: live.updatedAt },
    ];
    $('#agents').innerHTML = cards.map((c) => `<div class="gb-card gb-agent${c.hot && now - c.hot < HOT_MS ? ' hot' : ''}" style="--ac:${c.ac}">
      <div class="k">${esc(c.name)}</div><div class="v">${esc(c.v)}</div><div class="n">${esc(c.n)}</div></div>`).join('');
  }

  function bigClose(closes) {
    const key = `gb-seen-${FUND}`;
    let seen = num(localStorage.getItem(key));
    if (seen == null) seen = Date.now() - 6 * 3600e3;   // kunjungan pertama: hanya tutup besar 6 jam terakhir
    const big = closes.filter((c) => c.closedAt > seen && (num(c.netUsd) >= BIG_USD || num(c.netPct) >= BIG_PCT) && c.netUsd > 0);
    const box = $('#bigClose');
    const mark = () => { localStorage.setItem(key, String(Math.max(seen, ...closes.map((c) => c.closedAt)))); box.hidden = true; };
    if (!big.length) { if (closes.length && localStorage.getItem(key) == null) localStorage.setItem(key, String(Date.now())); return; }
    const c = big.at(-1);
    box.innerHTML = `<div class="t">BIG CLOSE · ${esc(closeKind(c)[0])}</div><div class="b pos">${esc(symOf(c.symbol))} ${esc(sgn(c.netUsd))}</div><div class="gb-muted">${esc(pct(c.netPct))}${c.firstWallet ? ' · by ' + esc(c.firstWallet) : ''} · ${esc(stamp(c.closedAt))} WIB</div>`;
    box.hidden = false;
    box.onclick = mark;
    setTimeout(mark, 9000);
  }

  let state = null, busy = false;
  async function refresh() {
    if (busy) return; busy = true;
    try {
      const [live, nav] = await Promise.all([get(`${FUND}/live.json`), get(`${FUND}/nav.json`).catch(() => ({ points: [] }))]);
      const closes = await loadTrades(live);
      state = { live, nav, closes };
      renderHeader(live); renderMetrics(live, closes); renderChart(nav, closes, live); renderLog(live, closes); renderPositions(live); renderAgents(live, closes);
      if ($('#bigClose').hidden) bigClose(closes);
    } catch (e) {
      const pill = $('#livePill'); pill.className = 'gb-pill stale'; pill.querySelector('span').textContent = 'STALE';
      $('#updated').textContent = 'feed belum bisa dimuat';
    } finally { busy = false; }
  }
  refresh();
  setInterval(refresh, 60e3);
  setInterval(() => { if (state) renderHeader(state.live); }, 15e3);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state && renderChart(state.nav, state.closes, state.live), 150); });
})();
