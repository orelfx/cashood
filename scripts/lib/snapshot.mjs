import Core from '../../assets/core.js';
import { atomicJSON, downsample, generation, publicSnapshot, readJSON } from './io.mjs';
import { resolve, dirname } from 'node:path';
import { buildPerformance } from './performance.mjs';
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
      snapshot.performance = buildPerformance({
        closes: inp.closes || [], points: flowsKnown ? points : [], flows, flatBand: inp.flatBand ?? 0.5,
        capitalUsd: ledger.capitalBasis ?? ledger.deposited, navUsd: snapshot.totalUsd,
      });
      if (!flowsKnown) {
        snapshot.performance.equityWithheld = 'Dompet dana ini dibaca, bukan dijalankan: uang yang masuk atau keluar dompet tidak tercatat di sini, jadi penurunan nilai tidak bisa dibedakan dari penarikan. Penurunan terdalam, rasio risiko, dan pemulihan ditahan sampai arus kasnya dicatat.';
        snapshot.performance.recoveryFactor = null;
      }
    } catch (err) { snapshot.performance = null; }
  }
  const publicData=publicSnapshot(snapshot,dir);
  // Only after all validation/sanitization has passed may any new generation be written.
  atomicJSON(local,snapshot);atomicJSON(navPath,{updatedAt:snapshot.updatedAt,generation:snapshot.generation,points});atomicJSON(out,publicData);
  return snapshot;
}
