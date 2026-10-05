import Core from '../../assets/core.js';
const DAY=86400000;

/*
 * Bunga Safe Box per hari (aturan pemilik 2026-10-05).
 *
 * Laju harian = kenaikan Cashood Index selama `windowDays` hari terakhir
 * (bawaan 7) dibagi jumlah harinya — rata-rata seminggu, bukan gerak satu hari
 * saja (aturan pemilik 2026-10-05, revisi kedua):
 *   - index seminggu turun atau datar → bunga hari itu 0;
 *   - index seminggu naik             → bunga = rata-rata kenaikan hariannya.
 * Tidak ada batas harian. Jatahnya mingguan dan bulanan (revisi ketiga, sama
 * harinya), supaya minggu yang bagus tidak menghabiskan jatah sebulan:
 *   - jatah per minggu (Senin–Minggu WIB) = weeklyQuotaPct dari pokok
 *     (bawaan maxMonthlyPct / 4 = 0,75%). Kelebihan di atas jatah itu tidak
 *     hilang: masuk CADANGAN pemilik itu (paling banyak reserveMaxPct);
 *   - hari yang rata-rata seminggunya rugi atau datar (laju 0) diisi dari
 *     cadangan, paling banyak jatah harian normal (weeklyQuotaPct / 7), selama
 *     jatah minggu dan bulan itu masih ada;
 *   - sebulan kalender tetap paling banyak maxMonthlyPct. Itu batas atas,
 *     bukan janji: bulan yang buruk bisa jauh di bawahnya.
 * Cadangan bukan hak pemilik — ia hanya penyangga. Pemilik yang keluar
 * meninggalkan cadangannya.
 * Bunga dihitung dari pokok, tidak berbunga lagi, dan dibayar lewat
 * payouts.jsonl.
 *
 * Hari yang sudah lewat dibekukan di state: titik index lama yang kemudian
 * dirapatkan (downsample) tidak boleh mengubah bunga yang sudah tercatat.
 * Hari yang sedang berjalan dihitung ulang tiap siklus dan baru dibekukan
 * setelah tengah malam WIB.
 */
function owners(rows) {
 const ids=new Set();return rows.map(o=>{if(!o.id||ids.has(o.id))throw new Error('ID pemilik Safe Box harus unik');ids.add(o.id);return {...o,principalUsd:Core.number(o.principalUsd,'Pokok Safe Box',0)};});
}
/** Senin (WIB) dari minggu tanggal `date` (YYYY-MM-DD). */
export function weekOf(date){const t=Date.parse(date+'T00:00:00Z');return new Date(t-((new Date(t).getUTCDay()+6)%7)*DAY).toISOString().slice(0,10);}
/** Pemilik yang aktif pada waktu `t`: daftar awal, lalu ownerEvents yang sudah berlaku. */
export function ownersAt(cfg,t){
 let active=owners(cfg.owners||[]);
 for(const e of [...(cfg.ownerEvents||[])].map(e=>({...e,at:typeof e.at==='number'?e.at:Date.parse(e.at)})).sort((a,b)=>a.at-b.at)){
  if(!Number.isFinite(e.at))throw new Error('Waktu perubahan pemilik tidak valid');
  if(e.at<=t)active=owners(e.owners);
 }
 return active;
}
/** Laju harian rata-rata dari deret index: titik terakhir sampai `closeAt` dibanding `windowDays` hari sebelumnya. */
export function windowRate(points,closeAt,{windowDays,minDaily,maxDaily}){
 let start=null,end=null;const from=closeAt-windowDays*DAY;
 for(const p of points){if(p.t>closeAt)break;end=p;if(p.t<=from||!start)start=p;}
 const span=start&&end?(end.t-start.t)/DAY:0;
 // Kurang dari sehari data belum bisa disebut rata-rata.
 if(!start||!end||span<1||!(start.usd>0)||!(end.usd>0))return {rate:0,move:null,spanDays:span,missing:true};
 const move=end.usd/start.usd-1;
 return {rate:Math.min(maxDaily,Math.max(minDaily,move/span)),move,spanDays:span,missing:false};
}
export function accrue(cfg,previous,observation,payouts=[]){
 const now=Core.number(observation.at,'Waktu pengamatan',1);
 const points=(observation.points||[]).filter(p=>Number.isFinite(p.t)&&p.usd>0).sort((a,b)=>a.t-b.t);
 const maxM=Core.number(cfg.rate?.maxMonthlyPct??3,'Batas atas bunga',0),minM=Core.number(cfg.rate?.minMonthlyPct??0,'Batas bawah bunga',0);
 if(maxM<minM)throw new Error('Batas bunga terbalik');
 const maxD=cfg.rate?.maxDailyPct==null?Infinity:Core.number(cfg.rate.maxDailyPct,'Batas harian',0)/100;
 const weekQ=Core.number(cfg.rate?.weeklyQuotaPct??maxM/4,'Jatah mingguan',0)/100;
 const reserveMax=Core.number(cfg.rate?.reserveMaxPct??maxM,'Batas cadangan',0)/100;
 const limits={windowDays:Core.number(cfg.rate?.windowDays??7,'Jendela rata-rata',1),maxDaily:maxD,minDaily:minM/100/30};
 const state=previous?structuredClone(previous):{version:3,from:Core.eventTime({date:cfg.rate?.dailyFrom||Core.day(now)}),days:[],balances:{},payoutIds:[]};
 if(state.version!==3)throw new Error('State bunga Safe Box bukan versi harian');
 if(state.at&&now<state.at)throw new Error('Waktu pengamatan mundur');
 const lastFrozen=state.days.length?Core.eventTime({date:state.days.at(-1).date})+DAY:state.from;
 let today=null;
 for(let start=Math.max(lastFrozen,state.from);start<=now;start+=DAY){
  const end=start+DAY,closeAt=Math.min(end-1,now),done=end<=now;
  const r=windowRate(points,closeAt,limits);
  const active=ownersAt(cfg,closeAt);
  const date=Core.day(start),month=date.slice(0,7),week=weekOf(date);
  const entry={date,ratePct:Number((r.rate*100).toFixed(4)),windowMovePct:r.missing?null:Number((r.move*100).toFixed(4)),windowDays:Number(r.spanDays.toFixed(2)),usd:0,owners:{},estimated:r.missing};
  for(const o of active){
   const b=(state.balances[o.id] ||= {id:o.id,name:o.name,color:o.color,accrued:0,paid:0});
   const P=o.principalUsd,sum=(keep)=>state.days.filter(d=>keep(d.date)).reduce((t,d)=>t+(d.owners?.[o.id]||0),0);
   // Sisa jatah minggu ini dan bulan ini, dari yang sudah dicatat.
   const room=Math.max(0,Math.min(P*weekQ-sum((d)=>weekOf(d)===week),P*maxM/100-sum((d)=>d.startsWith(month))));
   const raw=P*r.rate,reserve=Number(b.reserve)||0;
   let amount=Math.min(room,raw),fromReserve=0;
   // Minggu rugi: isi sebagian dari cadangan kelebihan minggu-minggu sebelumnya.
   if(r.rate<=0)fromReserve=Math.min(reserve,room,P*weekQ/7),amount=fromReserve;
   const excess=Math.max(0,raw-amount);
   amount=Number(amount.toFixed(4));
   if(excess>1e-9)entry.capped=true;
   if(fromReserve>0)(entry.fromReserve ||= {})[o.id]=Number(fromReserve.toFixed(4));
   entry.owners[o.id]=amount;entry.usd=Number((entry.usd+amount).toFixed(4));
   if(done){
    b.accrued=Number((b.accrued+amount).toFixed(4));
    b.reserve=Number(Math.min(P*reserveMax,reserve-fromReserve+excess).toFixed(4));
   }
  }
  if(done)state.days.push(entry);else today=entry;
 }
 for(const p of payouts){
  if(p.type!=='interest'||!p.owner||!(p.id||p.tx))throw new Error('Pembayaran bunga perlu owner dan ID');
  const id=p.id||p.tx;if(state.payoutIds.includes(id))continue;
  const at=typeof p.at==='number'?p.at:Date.parse(p.at);if(!Number.isFinite(at)||at>now)throw new Error('Waktu pembayaran bunga tidak valid');
  const b=state.balances[p.owner],usd=Core.number(p.usd,'Pembayaran bunga',.01);
  if(!b||usd>b.accrued-b.paid+.00001)throw new Error('Pembayaran melebihi hak bunga');
  b.paid=Core.money(b.paid+usd);state.payoutIds.push(id);
 }
 state.today=today;state.owners=ownersAt(cfg,now);state.at=now;
 return state;
}
