/*
 * Hasil dikoreksi arus dana: Modified Dietz harian yang dirangkai (linked),
 * dalam USD. Dipakai sync-gm untuk menghitung kolom "Meridian asli" sendiri
 * dari data dana Meridian di Cashood — angka pembanding tidak boleh datang dari
 * mesin Grok yang sedang dinilai.
 *
 *   r_hari = (EMV − BMV − F) / (BMV + Σ w_i·F_i),  w_i = (akhir − t_i) / (akhir − awal)
 *   hasil  = Π (1 + r_hari) − 1
 *
 * Hari dipotong di tengah malam WIB (UTC+7), sama seperti seluruh situs. Hari
 * pertama mulai di T0, hari terakhir berakhir di titik NAV terakhir.
 * points: [{ t, usd }] urut waktu (NAV dana); flows: [{ t, usd }] (+masuk, −keluar).
 */
const WIB = 7 * 3600e3, DAY = 86400e3;
const dayStart = (t) => Math.floor((t + WIB) / DAY) * DAY - WIB;

/** NAV pada waktu t: titik terakhir ≤ t (null kalau belum ada titik). */
export function navAt(points, t) {
  let v = null;
  for (const p of points) { if (p.t <= t) v = p; else break; }
  return v;
}

export function linkedDietz({ points, flows = [], t0 }) {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.usd) && p.usd > 0).sort((a, b) => a.t - b.t);
  const start = navAt(pts, t0);
  const last = pts.at(-1);
  if (!start || !last || last.t <= t0) return null;
  const fl = flows.filter((f) => Number.isFinite(f.t) && Number.isFinite(f.usd) && f.usd !== 0 && f.t > t0 && f.t <= last.t).sort((a, b) => a.t - b.t);
  let index = 1, peak = 1, maxDd = 0, bmv = start.usd, from = t0;
  const days = [];
  while (from < last.t) {
    const to = Math.min(dayStart(from) + DAY, last.t);
    const end = navAt(pts, to);
    const inDay = fl.filter((f) => f.t > from && f.t <= to);
    const F = inDay.reduce((s, f) => s + f.usd, 0);
    const span = Math.max(1, to - from);
    const W = inDay.reduce((s, f) => s + ((to - f.t) / span) * f.usd, 0);
    const denom = bmv + W;
    const r = denom > 0 ? (end.usd - bmv - F) / denom : 0;
    index *= 1 + r;
    peak = Math.max(peak, index); maxDd = Math.min(maxDd, index / peak - 1);
    days.push({ from, to, bmv, emv: end.usd, flowsUsd: F, r });
    bmv = end.usd; from = to;
  }
  const netFlowsUsd = fl.reduce((s, f) => s + f.usd, 0);
  return {
    startNavUsd: start.usd, startNavAt: start.t, endNavUsd: last.usd, asOf: last.t,
    pctSinceStart: (index - 1) * 100,
    rawPctSinceStart: (last.usd / start.usd - 1) * 100,
    netFlowsUsd, maxDrawdownPct: maxDd * 100, days,
  };
}

/**
 * Arus dana dompet Meridian dari data Cashood: event setoran/penarikan di
 * config.json (reinvest bukan uang baru, jadi dilewati) dan kenaikan
 * outflowTotalUsd antar titik NAV (uang yang keluar dari dompet ke kas).
 */
export function meridianFlows(config, navPoints) {
  const flows = [];
  for (const e of config?.events || []) {
    if (e.type !== 'deposit' && e.type !== 'withdraw') continue;
    const usd = Number(e.usd);
    const t = Number.isFinite(Number(e.at)) && e.at ? Number(e.at) : Date.parse(`${e.date}T00:00:00+07:00`);
    if (!Number.isFinite(usd) || !Number.isFinite(t)) continue;
    flows.push({ t, usd: e.type === 'deposit' ? usd : -usd, kind: e.type });
  }
  let prev = null;
  for (const p of [...(navPoints || [])].sort((a, b) => a.t - b.t)) {
    const o = Number(p.outflowTotalUsd);
    if (!Number.isFinite(o)) continue;
    if (prev != null && o > prev) flows.push({ t: p.t, usd: -(o - prev), kind: 'outflow' });
    prev = o;
  }
  return flows;
}
