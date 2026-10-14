// Exporters run every five minutes. Allow six cycles, never refresh source time.
export const MAX_SOURCE_AGE = 30 * 60_000;
export function sourceProblems(id, source, now) {
 const reasons=[];
 if (!source) return [{id,reason:'sumber tidak tersedia'}];
 if (!Number.isFinite(source.updatedAt) || source.updatedAt<=0) reasons.push('waktu sumber tidak valid');
 else if (source.updatedAt>now+60_000) reasons.push('waktu sumber di masa depan');
 else if (now-source.updatedAt>MAX_SOURCE_AGE) reasons.push('sumber lebih lama dari 30 menit');
 if (source.quality?.complete!==true) reasons.push('kelengkapan sumber belum terverifikasi');
 if (source.quality?.estimated || source.quality?.degraded || source.quality?.allocationEstimated) reasons.push('sumber parsial atau estimasi');
 return reasons.map(reason=>({id,reason}));
}
export function heldSnapshot(previous, fund, now, problems) {
 return {...(previous||{fund,schemaVersion:2,updatedAt:null}),checkedAt:now,
  quality:{complete:false,estimated:true,degraded:true,calculationDeferred:true,problems},
  dataNotice:'Perhitungan ditunda. Angka yang tersedia adalah hasil terakhir, bukan pembaruan saldo. '+problems.map(p=>`${p.id}: ${p.reason}`).join('; ')};
}
