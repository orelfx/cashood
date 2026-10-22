#!/usr/bin/env node
/*
 * GMSOL — Grok Meridian LIVE (UANG ASLI), HIGH RISK, modal buku $1.200 (v3.2).
 * Terpisah total dari arsip dry run Grok Meridian (data/gm): angka tidak digabung.
 *
 * Sumber: HANYA /root/cashood-inbox/gmsol-live.json, ditulis mesin gmsol-live
 * gmsol-live-v3 (spec v3.2 r2) di server ini, mode LIVE saja. HANYA DIBACA.
 * Kinerja = equityLedgerUsd (buku GMSOL: 1200 + PnL realisasi + belum realisasi
 * posisi engine), BUKAN saldo wallet. walletSolShared hanya info sekunder
 * (saldo wallet GMSOL). Berkas v2.x (tanpa equityLedgerUsd) → menunggu.
 * Berkas belum ada / rusak / bukan mode live / basi (>15 menit) → status tanpa
 * angka ("menunggu data on-chain"). Hanya field allowlist yang terbit; teks bebas
 * dibersihkan dari string mirip alamat.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assertPublic, lock, readJSON } from './lib/io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.CASHOOD_DATA_DIR || resolve(HERE, '..', 'data'), 'gmsol');
const SRC = process.env.GMSOL_SRC || '/root/cashood-inbox/gmsol-live.json';
const ENGINE = process.env.GMSOL_ENGINE_DIR || '/root/grok-meridian-live-v3'; // HANYA DIBACA
let CAPITAL = null; // r4.1: modal dikunci mesin saat deploy (state.capital), dibaca dari sumber; bukan lagi $1.200
const STALE_MS = 15 * 60e3;
const release = lock(resolve(DIR, 'sync.lock.local'));
const now = Number(process.env.GMSOL_NOW) || Date.now();
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(2)));
const r3 = (v) => (num(v) == null ? null : Number(Number(v).toFixed(3)));
const time = (v) => { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const ADDR = /0x[0-9a-fA-F]{16,}|[1-9A-HJ-NP-Za-km-z]{32,}/g;
const text = (v, max = 160) => (v == null || typeof v === 'object' ? null : String(v).replace(ADDR, '…').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
const base = { fund: 'gmsol', system: 'GMSOL', realMoney: true, risk: 'high', capitalUsd: null, checkedAt: now };

function out(o) {
  const s = JSON.stringify(o);
  if (/[1-9A-HJ-NP-Za-km-z]{32,}/.test(s)) throw new Error('string mirip alamat di keluaran');
  assertPublic(o);
  atomicJSON(resolve(DIR, 'live.json'), o);
}
// Riwayat ekuitas (satu titik per pembaruan sumber, 30 hari terakhir) untuk grafik
// dan perubahan 24 jam di beranda; disimpan lokal, terbit di dalam live.json.
function curve(asOf, eq) {
  const f = resolve(DIR, 'nav.local.json'), h = readJSON(f, { points: [] });
  const lockT = CAP_LOCK; // titik sebelum kunci modal r4.1 (buku lama $1.200) diarsip, tidak dicampur
  if (lockT && h.points.some((p) => p.t < lockT)) { atomicJSON(resolve(DIR, `nav-pre-r4-${lockT}.local.json`), { archivedAt: now, before: lockT, points: h.points.filter((p) => p.t < lockT) }); h.points = h.points.filter((p) => p.t >= lockT); }
  if (!h.points.length || asOf > h.points.at(-1).t) h.points.push({ t: asOf, usd: eq });
  h.points = h.points.filter((p) => p.t > now - 30 * 86400e3).slice(-4000);
  atomicJSON(f, h);
  const step = Math.max(1, Math.ceil(h.points.length / 400));
  return h.points.filter((_, i) => i % step === 0 || i === h.points.length - 1);
}
function wait(reason, asOf = null) { out({ ...base, status: 'waiting', reason, asOf }); console.log(`[gmsol] waiting: ${reason}`); release(); process.exit(0); }

// Ringkasan screening dari scan terakhir logs/screen-*.jsonl (baris satu scan berbagi ts).
// Hanya simbol pasangan + jumlah; teks alasan dibersihkan dari string mirip alamat.
function tailText(f, max = 3e6) { const fd = openSync(f, 'r'); try { const n = fstatSync(fd).size, len = Math.min(n, max), b = Buffer.alloc(len); readSync(fd, b, 0, len, n - len); return b.toString('utf8'); } finally { closeSync(fd); } }
function screening(dir = resolve(ENGINE, 'logs')) {
  try {
    const f = readdirSync(dir).filter((x) => /^screen-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().at(-1); if (!f) return null;
    const rows = []; for (const l of tailText(resolve(dir, f)).split('\n')) { try { const o = JSON.parse(l); if (o && o.ts) rows.push(o); } catch { /* baris terpotong */ } }
    const lastTs = rows.at(-1)?.ts; if (!lastTs) return null;
    const scan = rows.filter((r) => r.ts === lastTs), sum = scan.find((r) => r.pool_symbol === '*'), pools = scan.filter((r) => r.pool_symbol !== '*');
    const m = /sol_dlmm=(\d+) inactive_1h=(\d+)/.exec(sum?.reasons?.[0] || '');
    const key = (s) => String(s).split(/[ =!<>]/)[0];
    const cnt = {}; for (const p of pools) for (const k of new Set((p.reasons || []).map(key))) cnt[k] = (cnt[k] || 0) + 1;
    const rejected = pools.filter((p) => (p.reasons || []).length).length;
    return { scannedAt: time(lastTs), solPools: m ? Number(m[1]) : null, inactive1h: m ? Number(m[2]) : null, checked: pools.length, passed: pools.length - rejected,
      topReasons: Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ reason: text(k, 60), pools: n })),
      closest: pools.filter((p) => (p.reasons || []).length).sort((a, b) => a.reasons.length - b.reasons.length).slice(0, 5).map((p) => ({ symbol: text(p.pool_symbol, 24), binStep: num(p.bs), reasons: p.reasons.slice(0, 4).map((x) => text(x, 90)) })) };
  } catch { return null; }
}
let CAP_LOCK = null;
// ---- Wallet GMSOL (seluruh isi wallet = aset GMSOL; instruksi Orel 22 Okt), TANPA .env / key / CLI bot.
// Pubkey wallet diturunkan dari akun posisi DLMM publik (field owner) yang alamatnya ada di state non-rahasia
// (state mesin GMSOL atau state.json meridian2), lalu di-cache lokal (owner.local.json, tidak terbit).
// Saldo + posisi dibaca lewat RPC publik + SDK DLMM (node_modules mesin, hanya di-require), harga via Jupiter publik.
// Pubkey, pool, mint, tx, URL RPC tidak pernah terbit.
const M2 = process.env.MERIDIAN2_HOME || '/root/meridian2/main/meridian2';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const WSOL = 'So11111111111111111111111111111111111111112';
async function walletShared(engineState) {
  try {
    const req = createRequire(resolve(ENGINE, 'package.json'));
    const { Connection, PublicKey } = req('@solana/web3.js'); const dm = req('@meteora-ag/dlmm'); const DLMM = dm.DLMM || dm.default || dm;
    const c = new Connection(PUBLIC_RPC, 'confirmed');
    const m2s = readJSON(resolve(M2, 'state.json'), {})?.positions || {};
    const cacheF = resolve(DIR, 'owner.local.json'); let owner = readJSON(cacheF, {})?.owner || null;
    if (!owner) {
      const cands = [...Object.keys(engineState?.positions || {}), ...Object.values(m2s).filter((x) => !x.closed).map((x) => x.position)].filter(Boolean);
      for (const k of cands) { const ai = await c.getAccountInfo(new PublicKey(k)); if (ai?.data?.length >= 72) { owner = new PublicKey(ai.data.slice(40, 72)).toBase58(); break; } }
      if (!owner) throw new Error('pubkey wallet belum bisa diturunkan (tidak ada posisi terlacak)');
      atomicJSON(cacheF, { owner, note: 'pubkey publik, dari field owner akun posisi; jangan terbit' });
    }
    const ow = new PublicKey(owner);
    const solBal = (await c.getBalance(ow)) / 1e9;
    const map = await DLMM.getAllLbPairPositionsByUser(c, ow);
    const rows = []; for (const [, v] of map) for (const p of v.lbPairPositionsData) rows.push({ v, p });
    const mints = [...new Set(rows.flatMap(({ v }) => [String(v.tokenX.publicKey), String(v.tokenY.publicKey)]).concat([WSOL]))];
    const pr = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    const price = (m) => num(pr?.[m]?.usdPrice);
    const solPx = price(WSOL); if (solPx == null) throw new Error('harga SOL tidak terbaca');
    const mine = new Set(Object.keys(engineState?.positions || {}));
    const pos = rows.slice(0, 20).map(({ v, p }) => {
      const k = String(p.publicKey), d = p.positionData, xm = String(v.tokenX.publicKey), ym = String(v.tokenY.publicKey);
      const dx = 10 ** (v.tokenX.mint?.decimals ?? 0), dy = 10 ** (v.tokenY.mint?.decimals ?? 0), px = price(xm), py = price(ym);
      const usdOf = (ax, ay) => (px == null || py == null ? null : (Number(ax) / dx) * px + (Number(ay) / dy) * py);
      const value = usdOf(d.totalXAmount, d.totalYAmount), unc = usdOf(d.feeX, d.feeY);
      const own = 'gmsol', st = m2s[k] || null, eng = engineState?.positions?.[k] || null;
      const opener = mine.has(k) ? 'engine' : 'manual'; const clm = usdOf(d.totalClaimedFeeXAmount ?? NaN, d.totalClaimedFeeYAmount ?? NaN); // on-chain, kedua sisi, harga sekarang
      const invested = eng ? r2(eng?.openSpentUsd) : r2(st?.initial_value_usd);
      const opened = eng ? time(eng?.openedAt) : time(st?.deployed_at);
      const upnl = invested == null || value == null || unc == null || clm == null ? null : value + unc + clm - invested;
      const upnlEx = invested == null || value == null ? null : value - invested;
      const sx = text(v.tokenX.mint?.symbol || st?.pool_name?.split('-')[0] || eng?.name?.split('-')[0], 16), sym = st?.pool_name || eng?.name || (sx ? `${sx}-SOL` : null);
      return { symbol: text(sym, 24), protocol: 'DLMM', owner: own, openedBy: opener, ageH: opened ? r2((now - opened) / 3600e3) : null, investedUsd: invested, valueUsd: r2(value),
        unclaimedFeesUsd: r2(unc), claimedFeesUsd: r2(clm), feesUsd: unc == null || clm == null ? null : r2(unc + clm), uPnlUsd: r2(upnl), pct: upnl == null || !invested ? null : r3(upnl / invested * 100), uPnlExclFeesUsd: r2(upnlEx), pctExclFees: upnlEx == null || !invested ? null : r3(upnlEx / invested * 100),
        inRange: Number.isFinite(v.lbPair?.activeId) ? v.lbPair.activeId >= d.lowerBinId && v.lbPair.activeId <= d.upperBinId : null };
    });
    const sum = (k) => (pos.some((p) => p[k] == null) ? null : r2(pos.reduce((a, p) => a + p[k], 0)));
    const lp = sum('valueUsd'), unc = sum('unclaimedFeesUsd'), solUsd = r2(solBal * solPx);
    const m2closed = Object.values(m2s).filter((x) => x.closed);
    return { label: 'Aset GMSOL (wallet)', note: 'Seluruh isi wallet GMSOL: SOL bebas + posisi LP + fee belum diklaim. Angka utama (headline) GMSOL.',
      asOf: now, source: 'RPC publik + SDK DLMM + harga Jupiter publik (tanpa key)', solPriceUsd: r2(solPx), freeSol: Number(solBal.toFixed(4)), freeSolUsd: solUsd,
      lpValueUsd: lp, unclaimedFeesUsd: unc, claimedFeesUsd: sum('claimedFeesUsd'), uPnlUsd: sum('uPnlUsd'), uPnlExclFeesUsd: sum('uPnlExclFeesUsd'),
      definitions: { uPnlUsd: 'valueUsd + unclaimedFeesUsd + claimedFeesUsd - investedUsd (fee ikut; konvensi utama yang diaudit)', uPnlExclFeesUsd: 'valueUsd - investedUsd (tanpa fee; konvensi uPnL tracker)', investedUsd: 'openedBy engine: openSpentUsd mesin; openedBy manual: nilai USD awal saat posisi dibuka (state pembuka posisi)', valueUsd: 'jumlah token X+Y posisi on-chain x harga Jupiter sekarang', unclaimedFeesUsd: 'fee X+Y belum diklaim on-chain x harga sekarang', claimedFeesUsd: 'totalClaimedFeeX/YAmount on-chain (kedua sisi) x harga SEKARANG, bukan harga saat klaim' },
      totalAssetsUsd: solUsd == null || lp == null || unc == null ? null : r2(solUsd + lp + unc),
      openCount: pos.length, positions: pos,
      closedCount: { manualTracked: m2closed.length, engine: Array.isArray(engineState?.closes) ? engineState.closes.length : null },
      winRatePct: null, pnlHistory: null, gaps: 'posisi DAMM v2 dan token SPL lain di wallet tidak dibaca → tidak dihitung. Fee klaim kini dari on-chain kedua sisi (dulu $4,66 = hanya sisi SOL); dinilai harga sekarang sehingga bisa beda dari tracker yang menilai saat klaim.' };
  } catch (e) { return { label: 'Aset GMSOL (wallet)', asOf: now, totalAssetsUsd: null, positions: [], error: text(e.message, 80) }; }
}
const goLive = (j) => time(j.capitalUsdAtDeploy?.lockedAt) ?? time(j.t0At) ?? time(readJSON(resolve(ENGINE, 'state', 'live.json'), {})?.created);
const v3Fields = (j) => {
  const b = j.brakes || {};
  return {
    t0At: goLive(j), spec: text(j.spec, 40), specStatus: /draft/i.test(String(j.specStatus || '')) ? null : text(j.specStatus, 30), // status draft tidak diterbitkan specHash: j.spec12 && typeof j.spec12 === 'object' ? Object.fromEntries(Object.entries(j.spec12).slice(0, 5).map(([k, v]) => [text(k, 40), text(v, 16)])) : null,
    capitalUsd: CAPITAL, capitalUsdAtDeploy: num(j.capitalUsdAtDeploy?.usd) == null ? null : r2(j.capitalUsdAtDeploy.usd), capitalLockedAt: j.capitalUsdAtDeploy?.lockedAt && time(j.capitalUsdAtDeploy.lockedAt) ? new Date(time(j.capitalUsdAtDeploy.lockedAt)).toISOString() : null,
    capitalSolUsdAtLock: r2(j.capitalUsdAtDeploy?.solUsd), capitalFreeSolAtLock: num(j.capitalUsdAtDeploy?.freeSol), capitalReserveSol: num(j.capitalUsdAtDeploy?.reserveSol),
    flowsDeclaredNetUsd: r2(j.flowsDeclaredNetUsd),
    preDeployHistory: (Array.isArray(j.preDeployHistory) ? j.preDeployHistory : []).slice(0, 10).map((h) => ({ atWib: text(h.atWib, 30), type: text(h.type, 30), sol: num(h.sol), by: text(h.by, 20), note: /meridian2|bersama/i.test(String(h.note || '')) ? null : text(h.note, 160), historyOnly: true })), execErrors: num(j.execErrors), screening: screening(), equityStatus: text(j.equityStatus, 80),
    walletSolShared: num(j.walletSolShared?.sol) == null ? null : { sol: Number(Number(j.walletSolShared.sol).toFixed(4)), usd: num(j.solPriceUsd) == null ? null : r2(j.walletSolShared.sol * j.solPriceUsd), label: 'saldo SOL bebas wallet GMSOL' },
    sizing: { sizeUsd: r2(j.sizing?.sizeUsd), maxOpen: num(j.sizing?.maxOpen), maxOpenCap: num(j.sizing?.maxOpenCap) },
    brakes: { dailyPct: num(b.dailyPct), totalFloorUsd: r2(b.totalFloorUsd), dailyBlocked: b.dailyBlocked === true,
      dailyBlockedUntil: time(b.dailyBlockedUntil), dayChangePct: r3(b.dayChangePct), dayStartLedgerUsd: r2(b.dayStartLedgerUsd), dayFloorUsd: r2(b.dayFloorUsd), gateUnknownBlock: b.gateUnknownBlock === true, halted: b.halted === true },
  };
};

try {
  if (!existsSync(SRC)) wait('belum jalan — menunggu mesin v3.2 menulis data live');
  let j; try { j = JSON.parse(readFileSync(SRC, 'utf8')); } catch { wait('berkas sumber rusak'); }
  if (j?.fund !== 'gmsol' || j?.mode !== 'live') wait('belum jalan — sumber bukan mode live');
  // Berkas lama v2.x (rem lama, ekuitas wallet) tidak dipakai lagi.
  if (!('equityLedgerUsd' in j)) wait('belum jalan — menunggu mesin v3.2 (data v2 lama diabaikan)');
  CAPITAL = r2(j.capitalUsd); CAP_LOCK = time(j.capitalUsdAtDeploy?.lockedAt);
  if (CAPITAL == null || !CAP_LOCK) wait('menunggu modal r4.1 dikunci mesin');
  const asOf = time(j.updatedAt);
  const eq = r2(j.equityLedgerUsd);
  if (!asOf) wait('belum jalan — menunggu data live');
  if (now - asOf > STALE_MS) wait('Mesin berhenti, menunggu restart', asOf);
  if (eq == null) { out({ ...base, status: 'waiting', reason: 'ekuitas buku belum diketahui', asOf, ...v3Fields(j) }); console.log('[gmsol] waiting: ledger unknown'); release(); process.exit(0); }
  // valueUsd/feesUsd per posisi: dari state mesin (HANYA DIBACA), pembacaan on-chain terakhir p.last.
  // valueUsd = (likuiditas + fee belum diklaim + rent) x harga SOL; feesUsd = fee belum diklaim + fee sudah diklaim (USD saat klaim).
  // Tidak ada pembacaan / basi (>15 menit) / harga tidak ada -> null (tidak dikarang).
  const px = num(j.solPriceUsd), st = Object.values(readJSON(resolve(ENGINE, 'state', 'live.json'), {})?.positions || {});
  const live = (p) => { const s = st.find((q) => time(q.openedAt) === time(p.openedAt) && text(q.name, 24) === text(p.symbol, 24)); const l = s?.last;
    return s && l && px != null && num(l.valueL) != null && num(l.unclaimedL) != null && now - (time(l.t) ?? 0) <= STALE_MS ? { s, l } : null; };
  const seats = (Array.isArray(j.openSeats) ? j.openSeats : []).slice(0, 10).map((p) => { const m = live(p);
    return { symbol: text(p.symbol, 24), openedAt: time(p.openedAt), basisUsd: r2(p.basisUsd), pnlUsd: r2(p.pnlUsd), pnlPct: r3(p.pnlPct), inRange: typeof p.inRange === 'boolean' ? p.inRange : null,
      valueUsd: m ? r2((Number(m.l.valueL) + Number(m.l.unclaimedL) + (num(m.s.rentL) || 0)) / 1e9 * px) : null,
      feesUsd: m ? r2(Number(m.l.unclaimedL) / 1e9 * px + (num(m.s.claimedUsd) || 0)) : null }; });
  const closes = (Array.isArray(j.closeHistory) ? j.closeHistory : []).slice(0, 200).map((c) => ({
    symbol: text(c.symbol, 24), openedAt: time(c.openedAt), closedAt: time(c.closedAt), netUsd: r2(c.netUsd), netPct: r3(c.netPct), reason: text(c.reason, 80) }));
  const WALLET = await walletShared(readJSON(resolve(ENGINE, 'state', 'live.json'), {}));
  out({ ...base, status: 'ok', asOf, ...v3Fields(j),
    equityUsd: eq, pnlUsd: r2(eq - CAPITAL), pnlPct: r3((eq / CAPITAL - 1) * 100),
    realizedUsd: r2(j.realizedUsd), unrealizedUsd: r2(j.unrealizedUsd),
    openSeats: seats, closes, equityCurve: curve(asOf, eq),
    engine: { label: 'Buku internal mesin r4.1', note: 'Buku internal mesin GMSOL r4.1 (modal dikunci saat deploy, dasar rem mesin). BUKAN angka utama; angka utama = wallet.totalAssetsUsd.', capitalUsd: CAPITAL, equityUsd: eq, pnlUsd: r2(eq - CAPITAL), pnlPct: r3((eq / CAPITAL - 1) * 100),
      realizedUsd: r2(j.realizedUsd), unrealizedUsd: r2(j.unrealizedUsd), totalFloorUsd: r2(j.brakes?.totalFloorUsd), dayFloorUsd: r2(j.brakes?.dayFloorUsd), maxOpen: num(j.sizing?.maxOpen), openCount: seats.length, closedCount: closes.length,
      winRatePct: closes.length ? r2(closes.filter((c) => c.netUsd > 0).length / closes.length * 100) : null },
    ...(() => { const w = WALLET; return { wallet: w, walletShared: w /* alias lama untuk app.js */, headline: { label: 'Aset GMSOL', usd: w?.totalAssetsUsd ?? null, source: 'wallet.totalAssetsUsd', rule: 'saldo wallet sekarang = acuan utama (Orel, 22 Okt)', pnlNote: 'Headline hanya nilai aset. PnL/drawdown/rem TIDAK dihitung dari angka ini vs modal; tetap dari blok engine sampai modal dikunci ulang saat r4.2 deploy.' } }; })() });
  console.log(`[gmsol] ok ledger ${eq}`);
} finally { release(); }
