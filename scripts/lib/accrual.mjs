import Core from '../../assets/core.js';
const DAY=86400000;

/*
 * Bunga Safe Box per hari (aturan pemilik 2026-10-05).
 *
 * Laju harian mengikuti gerak Cashood Index pada hari itu (jam Jakarta):
 *   - index turun atau datar  → bunga hari itu 0;
 *   - index naik              → bunga = kenaikannya, tapi paling tinggi
 *     maxMonthlyPct / 30 per hari (3% per bulan → 0,1% per hari).
 * Satu hari yang luar biasa tidak boleh menaikkan bunga di atas batas harian,
 * jadi sebulan penuh paling banyak 3%. Bunga dihitung dari pokok, tidak
 * berbunga lagi, dan dibayar lewat payouts.jsonl.
 *
 * Hari yang sudah lewat dibekukan di state: titik index lama yang kemudian
 * dirapatkan (downsample) tidak boleh mengubah bunga yang sudah tercatat.
 * Hari yang sedang berjalan dihitung ulang tiap siklus dan baru dibekukan
 * setelah tengah malam WIB.
 */
function owners(rows) {
 const ids=new Set();return rows.map(o=>{if(!o.id||ids.has(o.id))throw new Error('ID pemilik Safe Box harus unik');ids.add(o.id);return {...o,principalUsd:Core.number(o.principalUsd,'Pokok Safe Box',0)};});
}
/** Pemilik yang aktif pada waktu `t`: daftar awal, lalu ownerEvents yang sudah berlaku. */
export function ownersAt(cfg,t){
 let active=owners(cfg.owners||[]);
 for(const e of [...(cfg.ownerEvents||[])].map(e=>({...e,at:typeof e.at==='number'?e.at:Date.parse(e.at)})).sort((a,b)=>a.at-b.at)){
  if(!Number.isFinite(e.at))throw new Error('Waktu perubahan pemilik tidak valid');
  if(e.at<=t)active=owners(e.owners);
 }
 return active;
}
/** Laju satu hari dari deret index: penutupan hari itu dibanding penutupan hari sebelumnya. */
export function dayRate(points,dayStart,closeAt,{minDaily,maxDaily}){
 let open=null,close=null;
 for(const p of points){if(p.t<dayStart)open=p;else if(p.t<=closeAt)close=p;else break;}
 if(!open||!close||!(open.usd>0)||!(close.usd>0))return {rate:0,open:open?.usd??null,close:close?.usd??null,missing:true};
 const move=close.usd/open.usd-1;
 return {rate:Math.min(maxDaily,Math.max(minDaily,move)),move,open:open.usd,close:close.usd,missing:false};
}
export function accrue(cfg,previous,observation,payouts=[]){
 const now=Core.number(observation.at,'Waktu pengamatan',1);
 const points=(observation.points||[]).filter(p=>Number.isFinite(p.t)&&p.usd>0).sort((a,b)=>a.t-b.t);
 const maxM=Core.number(cfg.rate?.maxMonthlyPct??3,'Batas atas bunga',0),minM=Core.number(cfg.rate?.minMonthlyPct??0,'Batas bawah bunga',0);
 if(maxM<minM)throw new Error('Batas bunga terbalik');
 const limits={maxDaily:maxM/100/30,minDaily:minM/100/30};
 const state=previous?structuredClone(previous):{version:3,from:Core.eventTime({date:cfg.rate?.dailyFrom||Core.day(now)}),days:[],balances:{},payoutIds:[]};
 if(state.version!==3)throw new Error('State bunga Safe Box bukan versi harian');
 if(state.at&&now<state.at)throw new Error('Waktu pengamatan mundur');
 const lastFrozen=state.days.length?Core.eventTime({date:state.days.at(-1).date})+DAY:state.from;
 let today=null;
 for(let start=Math.max(lastFrozen,state.from);start<=now;start+=DAY){
  const end=start+DAY,closeAt=Math.min(end-1,now),done=end<=now;
  const r=dayRate(points,start,closeAt,limits);
  const active=ownersAt(cfg,closeAt);
  const entry={date:Core.day(start),ratePct:Number((r.rate*100).toFixed(4)),movePct:r.missing?null:Number((r.move*100).toFixed(4)),usd:0,owners:{},estimated:r.missing};
  for(const o of active){
   const amount=Number((o.principalUsd*r.rate).toFixed(4));
   entry.owners[o.id]=amount;entry.usd=Number((entry.usd+amount).toFixed(4));
   state.balances[o.id] ||= {id:o.id,name:o.name,color:o.color,accrued:0,paid:0};
   if(done)state.balances[o.id].accrued=Number((state.balances[o.id].accrued+amount).toFixed(4));
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
