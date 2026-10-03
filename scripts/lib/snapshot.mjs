import Core from '../../assets/core.js';
import { atomicJSON, downsample, generation, publicSnapshot, readJSON } from './io.mjs';
import { resolve, dirname } from 'node:path';
import { buildPerformance } from './performance.mjs';
import { groupTradeDays, writeTradeDays } from './trades.mjs';
export function reconcile(snapshot, cfg, previous = null) {
  snapshot.schemaVersion = 2;
  snapshot.generation ||= generation();
  snapshot.holdings = snapshot.holdings.map(h => ({ ...h, price: h.price ?? h.priceUsd ?? null, usd: Core.money(Core.number(h.usd, 'Saldo token', 0)) }));
  snapshot.positions = snapshot.positions.map(p => {
    const principalUsd = Core.money(Core.number(p.principalUsd, 'Principal LP', 0)), feesUsd = Core.money(Core.number(p.feesUsd, 'Fee LP', 0));
    const valueUsd = Core.money(principalUsd+feesUsd);
    return { ...p, principalUsd, feesUsd, valueUsd,
      pnlUsd: p.investedUsd == null ? null : Core.money(valueUsd+Number(p.collectedFeesUsd||0)-p.investedUsd),
      totalFeesUsd: Core.money(feesUsd+Number(p.collectedFeesUsd||0)) };
  });
  const wallet = Core.money(snapshot.holdings.reduce((s,h)=>s+h.usd,0));
  const lp = Core.money(snapshot.positions.reduce((s,p)=>s+p.valueUsd,0));
  snapshot.walletUsd=wallet;snapshot.lpUsd=lp;snapshot.botWalletUsd=Core.money(wallet+lp);
  snapshot.treasuryUsd=Core.money(snapshot.treasuryUsd||0);
  snapshot.totalUsd=Core.money(snapshot.botWalletUsd+snapshot.treasuryUsd);
  const stale=snapshot.positions.some(p=>p.stale||p.unreadable);
  snapshot.quality={ ...(snapshot.quality||{}), complete:!stale&&snapshot.quality?.complete!==false, reasons:[...(snapshot.quality?.reasons||[]),...(stale?['sebagian posisi memakai nilai terakhir']:[])] };
  snapshot.costsShareUsd=Core.monthlyCosts(cfg);
  // A large move is quarantined, not silently clamped or admitted as a NAV point.
  if (previous?.totalUsd > 0) {
    const flow=(cfg.events||[]).filter(e=>Core.eventTime(e)>previous.updatedAt&&Core.eventTime(e)<=snapshot.updatedAt)
      .reduce((s,e)=>s+(e.type==='deposit'?e.usd:e.type==='withdraw'?-e.usd:0),0);
    const outflow=Math.max(0,Number(snapshot.outflowTotalUsd||0)-Number(previous.outflowTotalUsd||0));
    const expected=previous.totalUsd+flow-outflow;
    if (expected>0 && Math.abs(snapshot.totalUsd-expected)/expected>0.30) throw new Error('Perubahan NAV >30% tanpa arus kas setara: perlu rekonsiliasi sumber');
  }
  Core.validateSnapshot(snapshot);
  return snapshot;
}
export function saveSnapshot(out, snapshot, cfg) {
  const dir=dirname(out), local=resolve(dir,'snapshot.local.json');
  const previous=readJSON(local);
  reconcile(snapshot,cfg,previous);
  const navPath=resolve(dir,'nav.json'), nav=readJSON(navPath,{points:[]});
  const points=snapshot.quality.complete ? downsample([...nav.points,{t:snapshot.updatedAt,usd:snapshot.totalUsd,lp:snapshot.lpUsd,quality:'complete',outflowTotalUsd:snapshot.outflowTotalUsd||0,generation:snapshot.generation}],snapshot.updatedAt) : nav.points;
  // Kinerja nyata dihitung SETELAH rekonsiliasi, dari nilai akhir dan deret
  // yang sama yang akan terbit — bukan dari angka sementara exporter.
  if (snapshot.performanceInput) {
    const inp = snapshot.performanceInput;
    delete snapshot.performanceInput;
    const flows = (cfg.events || []).filter((e) => e.type === 'deposit' || e.type === 'withdraw')
      .map((e) => ({ at: Core.eventTime(e), usd: e.type === 'deposit' ? Number(e.usd) : -Number(e.usd) }));
    const ledger = Core.buildLedger(cfg);
    try {
      // Dana yang dompetnya hanya DIBACA: uang masuk-keluar dompet tidak lewat
      // pembukuan ini, jadi penurunan nilai bisa berarti uang ditarik pemilik,
      // bukan rugi. Semua angka yang dihitung dari nilai dana ditahan; statistik
      // posisi tertutup tetap terbit karena datanya lengkap.
      const flowsKnown = cfg.fund?.cashFlowsRecorded !== false;
      // Dompet yang hanya dibaca: kurva nilainya disusun SENDIRI dari hasil tiap
      // posisi yang ditutup (modal + hasil kumulatif). Hasil posisi tidak
      // terpengaruh uang yang dipindah pemilik, jadi penurunan terdalam, rasio
      // risiko, dan skor bisa dihitung tanpa menebak arus kas.
      const capital0 = ledger.capitalBasis ?? ledger.deposited;
      const usdCloses = (inp.closes || []).filter((c) => Number.isFinite(c.closedAt) && Number.isFinite(c.netUsd)).sort((a, b) => a.closedAt - b.closedAt);
      let run = capital0;
      const ownCurve = usdCloses.length ? [{ t: Math.min(usdCloses[0].closedAt - 1, ...((cfg.events || []).map(Core.eventTime))), usd: capital0 },
        ...usdCloses.map((c) => ({ t: c.closedAt, usd: (run += c.netUsd) }))] : [];
      const openPnl = (snapshot.positions || []).reduce((t, p) => t + (Number(p.pnlUsd) || 0), 0);
      snapshot.performance = buildPerformance({
        closes: inp.closes || [], points: flowsKnown ? points : ownCurve, flows: flowsKnown ? flows : [], flatBand: inp.flatBand ?? 0.5,
        // Basis untung/rugi: modal dikurangi profit yang DITERIMA investor
        // (bersih, sesuai invoice). Tanggungan biaya sistem tidak dihitung
        // sebagai uang yang diterima, jadi ditambahkan kembali ke basis.
        capitalUsd: (ledger.capitalBasis ?? ledger.deposited) + (cfg.events || []).filter((e) => e.dividend).reduce((t, e) => t + Number(e.usd || 0) - Number(e.receivedUsd ?? e.usd ?? 0), 0),
        navUsd: flowsKnown ? snapshot.totalUsd : run + openPnl,
        // Dividen yang dibayar mengurangi basis untuk menghitung untung/rugi
        // (uangnya sudah diterima investor), tapi persennya tetap dibandingkan
        // dengan modal yang disetor — bukan modal yang mengecil karena dividen.
        pctBaseUsd: (ledger.capitalBasis ?? ledger.deposited) + (cfg.events || []).filter((e) => e.dividend).reduce((t, e) => t + Number(e.usd || 0), 0),
      });
      if (!flowsKnown) {
        // Untung/rugi dari sisi posisi (untuk skor) dan dari saldo dompet (yang
        // tampil di kartu dana) dicatat terpisah — keduanya bisa berbeda kalau
        // pemilik memindahkan uang dari atau ke dompet.
        const p = snapshot.performance;
        p.positionProfitUsd = p.profitUsd;
        p.profitUsd = Number((snapshot.totalUsd - capital0).toFixed(2));
        p.profitPct = capital0 > 0 ? Number(((p.profitUsd / capital0) * 100).toFixed(2)) : null;
        p.equityBasis = 'closed-positions';
        p.equityNote = 'Dompet dana ini hanya dibaca, jadi uang yang dipindah pemiliknya tidak tercatat. Penurunan terdalam, rasio risiko, dan skor di sini dihitung dari hasil tiap posisi yang ditutup (modal + hasil kumulatif), bukan dari saldo dompet.';
      }
    } catch (err) { snapshot.performance = null; }
  }
  // Riwayat lengkap: indeks per hari ikut snapshot, barisnya ke berkas harian.
  let tradeFiles=null;
  if (Array.isArray(snapshot.tradesAll)) {
    const g=groupTradeDays(snapshot.tradesAll, snapshot.tradesFlatBand ?? 0.5);
    snapshot.tradeDays=g.index; tradeFiles=g.files;
    delete snapshot.tradesAll; delete snapshot.tradesFlatBand; delete snapshot.tradesFile;
  }
  const publicData=publicSnapshot(snapshot,dir);
  // Only after all validation/sanitization has passed may any new generation be written.
  atomicJSON(local,snapshot);atomicJSON(navPath,{updatedAt:snapshot.updatedAt,generation:snapshot.generation,points});atomicJSON(out,publicData);
  if (tradeFiles) writeTradeDays(dir, snapshot.fund, tradeFiles);
  return snapshot;
}
