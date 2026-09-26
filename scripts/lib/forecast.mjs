import Core from '../../assets/core.js';
const DAY=86400000;
export function rng(seed){let s=2166136261;for(const c of seed){s^=c.charCodeAt(0);s=Math.imul(s,16777619);}return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
export const quantile=(values,q)=>{const a=[...values].sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*q,j=Math.floor(i);return a[j]+(a[Math.ceil(i)]-a[j])*(i-j);};
export function nextPayday(now,payDay=1){
 const d=new Date(now+Core.WIB),y=d.getUTCFullYear(),m=d.getUTCMonth();
 const validDay=Math.min(Core.number(payDay,'Tanggal pembayaran',1),28);
 let at=Date.UTC(y,m,validDay)-Core.WIB;if(at<=now)at=Date.UTC(y,m+1,validDay)-Core.WIB;
 return {at,days:Math.max(1,Math.ceil((at-now)/DAY))};
}
/** Closed WIB days only. Never use unverified legacy NAVs or unrecorded cash flows. */
export function dailyReturns(cfg,live,series,now){
 if(cfg.forecast?.cashFlowsComplete===false)return [];
 const end=Core.day(now),start=Math.min(...cfg.events.map(Core.eventTime));
 const daily=new Map();
 for(const p of [...series].sort((a,b)=>a.t-b.t))if(p.quality==='complete'&&p.t>=start&&Core.day(p.t)<end&&Number.isFinite(p.usd)&&p.usd>0)daily.set(Core.day(p.t),p);
 const points=[...daily.values()],result=[];
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];
  if(Core.eventTime({date:Core.day(b.t)})-Core.eventTime({date:Core.day(a.t)})!==DAY)continue;
  const events=cfg.events.filter(e=>Core.eventTime(e)>a.t&&Core.eventTime(e)<=b.t);
  const flows=events.reduce((t,e)=>t+(e.type==='deposit'?e.usd:e.type==='withdraw'?-e.usd:0),0);
  // Cumulative treasury outflows include costs/payments. Add them back to measure pre-distribution return.
  if(a.outflowTotalUsd==null||b.outflowTotalUsd==null)continue;
  const paid=b.outflowTotalUsd-a.outflowTotalUsd;
  if(paid<0)continue;
  const denominator=a.usd+Math.max(0,flows);
  const pct=(b.usd-a.usd-flows+paid)/denominator;
  if(!Number.isFinite(pct)||Math.abs(pct)>.3)continue;
  result.push({date:Core.day(b.t),pct});
 }
 return result;
}
export function simulate({cfg,live,daily,now,days,paths=10000,seed='cashood'}){
 const marks=new Set(days),last=Math.max(...days),random=rng(seed),costs=Core.monthlyCosts(cfg,live),ledger=Core.buildLedger(cfg);
 const base=ledger.capitalBasis+Number(cfg.dividend?.retainedUsd||0),cashInitial=Number(live.treasuryUsd||0);
 const fixed=Number(cfg.fund?.fixedCapitalUsd||0),capacity=Number(cfg.fund?.capacityUsd||0),step=Number(cfg.treasury?.stepUsd||100);
 const runs=[];
 for(let i=0;i<paths;i++){
  let working=Math.max(0,live.totalUsd-cashInitial),cash=cashInitial,paid=0,low=live.totalUsd,reference=base,next=nextPayday(now,cfg.dividend?.payDayOfMonth).at;
  const snapshots={};
  for(let d=1;d<=last;d++){
   const at=now+d*DAY,active=capacity>0?Math.min(working,capacity):working;
   const move=daily[Math.floor(random()*daily.length)].pct;
   working=Math.max(0,working+active*move);
   if(fixed>0&&working>fixed){const sweep=Math.floor((working-fixed)/step)*step;working-=sweep;cash+=sweep;}
   if(at>=next){
    const gross=cfg.dividend?.basis==='treasury'?cash:Math.max(0,working+cash-reference);
    const remainingCosts=Math.max(0,costs-(next===nextPayday(now,cfg.dividend?.payDayOfMonth).at?Number(live.costsPaidUsd||0):0));
    const plan=Core.dividendPlan(cfg,{gross,costs:remainingCosts,nav:working+cash});
    const due=Math.min(working+cash,plan.costs+plan.distributed);
    const cashPaid=Math.min(cash,due);cash-=cashPaid;working=Math.max(0,working-(due-cashPaid));
    paid+=Math.min(plan.received,Math.max(0,due-plan.costs-plan.fee));
    // Reinvested earnings remain assets but cease being new distributable profit.
    reference+=plan.reinvest;
    if(cfg.dividend?.basis==='treasury'&&cash>0){working+=cash;cash=0;}
    next=nextPayday(next+1,cfg.dividend?.payDayOfMonth).at;
   }
   const total=working+cash+paid;low=Math.min(low,total);
   if(marks.has(d))snapshots[d]={value:working+cash,working,cash,paid,low,total};
  }
  runs.push(snapshots);
 }
 return runs;
}
export function forecastFund(fund,cfg,live,series,{now=Date.now(),paths=10000}={}){
 const payday=nextPayday(now,cfg.dividend?.payDayOfMonth);
 const daily=dailyReturns(cfg,live,series,now);
 const meta={fund,updatedAt:now,generatedAt:new Date(now+Core.WIB).toISOString().slice(0,16)+' WIB',days:payday.days,paydayAt:payday.at,paydayDate:Core.day(payday.at),navNow:live.totalUsd,
  samples:daily.length,basis:'perubahan NAV terverifikasi setelah koreksi arus kas',rules:{...cfg.fund,distributePct:cfg.dividend?.distributePct??100},enough:false};
 if(live.quality?.complete!==true||now-live.updatedAt>45*60000||daily.length<7)return {...meta,reason:'Proyeksi memerlukan snapshot lengkap dan minimal tujuh hari selesai dengan arus kas serta NAV terverifikasi.'};
 const ledger=Core.buildLedger(cfg),units=ledger.totalUnits,base=ledger.capitalBasis+Number(cfg.dividend?.retainedUsd||0),costs=Core.monthlyCosts(cfg,live);
 const horizons=[['d1','1 hari',1],['w1','1 minggu',7],['m1','1 bulan',30],['m3','3 bulan',90],['m6','6 bulan',180],['y1','1 tahun',365]];
 const marks=[...new Set([payday.days,...horizons.map(h=>h[2])])];
 const runs=simulate({cfg,live,daily,now,days:marks,paths,seed:`${fund}:${Core.day(now)}:${JSON.stringify(daily)}:${live.totalUsd}`});
 const at=(days,q)=>{
  // Select an actual path ordered by TOTAL wealth, preserving the joint components.
  const sorted=runs.map(r=>r[days]).sort((a,b)=>a.total-b.total),r=sorted[Math.round((sorted.length-1)*q)];
  return {navUsd:Core.money(r.value),changePct:Number(((r.value/live.totalUsd-1)*100).toFixed(2)),dividendsUsd:Core.money(r.paid),sweptUsd:Core.money(r.cash),totalUsd:Core.money(r.total),sharePrice:units?Number((r.value/units).toFixed(4)):null};
 };
 const scenario=(q,label)=>{const r=at(payday.days,q);return {...r,label,changeUsd:Core.money(r.navUsd-live.totalUsd),dividend:{distributed:r.dividendsUsd,net:r.dividendsUsd,reinvested:0}};};
 const risk=days=>{const lows=runs.map(r=>r[days].low),pct=drop=>Number((lows.filter(v=>v<=live.totalUsd*(1-drop/100)).length/paths*100).toFixed(3));return {p10:pct(10),p50:pct(50),p80:pct(80),p90:pct(90),p99:pct(99),floored:false};};
 const mean=daily.reduce((s,r)=>s+r.pct,0)/daily.length,stdev=Math.sqrt(daily.reduce((s,r)=>s+(r.pct-mean)**2,0)/(daily.length-1));
 const positions=live.positions||[],history=(live.history||[]).filter(h=>h.date<Core.day(now));
 const closes=n=>{const cutoff=Core.day(now-n*DAY);return history.filter(h=>h.date>=cutoff).reduce((s,h)=>s+h.closes,0)/n;};
 const lp=positions.reduce((t,p)=>t+p.principalUsd+p.feesUsd,0);
 return {...meta,enough:true,sharePriceNow:units?live.totalUsd/units:null,baseCapital:base,costs,
  sample:{days:daily.length,from:daily[0].date,to:daily.at(-1).date,meanDailyPct:mean*100,stdevDailyPct:stdev*100,winDays:daily.filter(d=>d.pct>0).length,lossDays:daily.filter(d=>d.pct<0).length},
  monthSample:{days:daily.length,scope:'seluruh hari tervalidasi'},
  activity:{closesPerDay7d:closes(7),closesPerDay3d:closes(3),openPositions:positions.length,inRangePct:positions.length?positions.filter(p=>p.inRange).length/positions.length*100:0,openFeesUsd:live.stats?.openFeesUsd||0,winRatePct:live.stats?.winRate??0},
  scenarios:{worst:scenario(.1,'Persentil 10'),normal:scenario(.5,'Median'),best:scenario(.9,'Persentil 90')},
  horizons:horizons.map(([key,label,days])=>({key,label,days,speculative:days>daily.length*3,worst:at(days,.1),normal:at(days,.5),best:at(days,.9),risk:risk(days),belowBase:{endPct:runs.filter(r=>r[days].total<base).length/paths*100,anyPct:runs.filter(r=>r[days].low<base).length/paths*100}})),
  lossScenarios:[10,50,90].map(dropPct=>{const nav=live.totalUsd*(1-dropPct/100);return {dropPct,navUsd:Core.money(nav),changeUsd:Core.money(nav-live.totalUsd),sharePrice:units?nav/units:0,belowBase:nav<base,dividend:Core.dividendPlan(cfg,{gross:cfg.dividend?.basis==='treasury'?Number(live.treasuryUsd||0):Math.max(0,nav-base),costs,nav})};}),
  stress:{lpUsd:Core.money(lp),lpSharePct:lp/live.totalUsd*100,cashUsd:Core.money(live.totalUsd-lp),positions:positions.length,worstDayUsd:history.length?Math.min(...history.map(h=>h.usd)):null,worstDayPct:null,worstClosePct:live.stats?.worstClosePct??null},
  lossProfile:null,market:null,method:`Bootstrap ${daily.length} hari tervalidasi, ${paths} lintasan. Angka 0% berarti tidak muncul pada simulasi, bukan mustahil.`,
  caveats:['Ini frekuensi simulasi bersyarat pada sampel, bukan probabilitas kerugian dunia nyata.','Kas cadangan dan dividen yang sudah diterima termasuk total kekayaan investor; sapuan tidak dianggap kerugian.','Periode pendek dan perubahan strategi dapat membuat model tidak representatif. Tidak ada probabilitas minimum buatan atau kejutan sintetis tersembunyi.']};
}
