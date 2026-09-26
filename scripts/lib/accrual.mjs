import Core from '../../assets/core.js';
const DAY=86400000;
function owners(rows) {
 const ids=new Set();return rows.map(o=>{if(!o.id||ids.has(o.id))throw new Error('ID pemilik Safe Box harus unik');ids.add(o.id);return {...o,principalUsd:Core.number(o.principalUsd,'Pokok Safe Box',0)};});
}
/** Allocate observed fee growth over elapsed intervals; gaps are explicitly estimates. */
export function accrue(cfg, previous, observation, published = null, payouts = []) {
 const now=Core.number(observation.at,'Waktu pengamatan',1),fee=Core.number(observation.fee,'Fee kumulatif',0);
 const current=owners(cfg.owners||[]),signature=JSON.stringify(current.map(o=>[o.id,o.principalUsd]));
 const state=previous?structuredClone(previous):{
  version:2,at:now,feeHighWater:fee,signature,owners:current,days:[], balances:Object.fromEntries(current.map(o=>{
   const old=published?.owners?.find(p=>p.name===o.name);
   return [o.id,{id:o.id,name:o.name,color:o.color,accrued:Core.number(old?.interestUsd??0,'Bunga awal',0),paid:0}];
  })),migration:{at:now,note:'Hak awal dibekukan dari snapshot terakhir; riwayat kepemilikan lama tidak ditebak.'},payoutIds:[]
 };
 if(state.signature!==signature)throw new Error('Jangan ubah pokok awal: gunakan ownerEvents dengan waktu efektif');
 if(now<state.at)throw new Error('Waktu pengamatan mundur');
 const min=Core.number(cfg.rate?.minMonthlyPct??0,'Batas bawah bunga',0),max=Core.number(cfg.rate?.maxMonthlyPct??100,'Batas atas bunga',0);
 if(max<min)throw new Error('Batas bunga terbalik');
 const events=(cfg.ownerEvents||[]).map(e=>({at:typeof e.at==='number'?e.at:Date.parse(e.at),owners:owners(e.owners)})).sort((a,b)=>a.at-b.at);
 if(events.some((e,i)=>!Number.isFinite(e.at)||(i>0&&events[i-1].at===e.at)))throw new Error('Waktu perubahan pemilik tidak valid atau duplikat');
 const history=events.filter(e=>e.at<=state.at);
 if(JSON.stringify(history)!==JSON.stringify(state.processedEvents||[]))throw new Error('Riwayat ownerEvents tidak boleh diubah atau ditambahkan mundur');
 const changes=events.filter(e=>e.at>state.at&&e.at<=now);
 let active=state.owners, cursor=state.at;
 const elapsed=now-state.at,gain=Math.max(0,fee-state.feeHighWater);
 let eventIndex=0;
 while(cursor<now){
  const midnight=Core.eventTime({date:Core.day(cursor)})+DAY;
  const end=Math.min(now,midnight,changes[eventIndex]?.at??Infinity);
  const fraction=elapsed?(end-cursor)/elapsed:0, feePart=gain*fraction;
  const principal=active.reduce((t,o)=>t+o.principalUsd,0),duration=(end-cursor)/DAY;
  const earned=Math.min(principal*max/100/30*duration,Math.max(principal*min/100/30*duration,feePart));
  const allocation=Core.allocate(earned,active.map(o=>({id:o.id,share:o.principalUsd})),10000);
  const date=Core.day(cursor);let entry=state.days.find(d=>d.date===date);
  if(!entry){entry={date,usd:0,owners:{},estimated:false};state.days.push(entry);}
  for(const o of active){
   const amount=allocation[o.id]||0;
   state.balances[o.id] ||= {id:o.id,name:o.name,color:o.color,accrued:0,paid:0};
   state.balances[o.id].accrued=Number((state.balances[o.id].accrued+amount).toFixed(4));
   entry.owners[o.id]=Number(((entry.owners[o.id]||0)+amount).toFixed(4));
  }
  entry.usd=Number((entry.usd+Object.values(allocation).reduce((a,b)=>a+b,0)).toFixed(4));
  entry.estimated ||= elapsed>2*3600000;
  cursor=end;
  if(changes[eventIndex]?.at===end){active=changes[eventIndex].owners;eventIndex++;}
 }
 for(const p of payouts){
  if(p.type!=='interest'||!p.owner||!(p.id||p.tx))throw new Error('Pembayaran bunga perlu owner dan ID');
  const id=p.id||p.tx;if(state.payoutIds.includes(id))continue;
  const at=typeof p.at==='number'?p.at:Date.parse(p.at);if(!Number.isFinite(at)||at>now)throw new Error('Waktu pembayaran bunga tidak valid');
  const b=state.balances[p.owner],usd=Core.number(p.usd,'Pembayaran bunga',.01);
  if(!b||usd>b.accrued-b.paid+.00001)throw new Error('Pembayaran melebihi hak bunga');
  b.paid=Core.money(b.paid+usd);state.payoutIds.push(id);
 }
 state.processedEvents=events.filter(e=>e.at<=now);
 state.at=now;state.feeHighWater=Math.max(state.feeHighWater,fee);state.owners=active;
 return state;
}
