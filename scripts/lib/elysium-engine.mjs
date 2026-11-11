const finite=Number.isFinite;
export const safeLabel=value=>String(value||'').replace(/0x[0-9a-f]{8,}/gi,'').replace(/[^a-zA-Z0-9 ._+/$%-]/g,'').slice(0,80);
export function engineSnapshot({cycle,live,performance,audit,completed={},exits=[],paperPositions=[],paperCycles=[]},now=Date.now()){
 const updatedAt=Number(cycle?.finishedAt)*1000,liveAt=Number(live?.at)*1000;
 const fresh=t=>finite(t)&&t>0&&t<=now+60000&&now-t<=15*60000;
 if(!fresh(updatedAt)||cycle?.status!=='OK'||!fresh(liveAt))return {status:'unavailable',updatedAt:finite(updatedAt)?updatedAt:null,quality:{complete:false},source:'VPS Elysium LP'};
 const closed=exits.filter(x=>x.accounting==='VERIFIED'&&x.positionId!=null&&finite(x.at)&&x.at*1000<=now+60000).map((x,i)=>({label:'Posisi '+(i+1),pair:safeLabel(x.pair)||'LP',closedAt:x.at*1000,netUsd:finite(x.netUsdAtEntryMark)?x.netUsdAtEntryMark:null,netHype:/^-?\d+$/.test(x.netHypeWei||'')?Number(x.netHypeWei)/1e18:null,gasHype:/^\d+$/.test(x.gasWei||'')?Number(x.gasWei)/1e18:null,reason:safeLabel(x.reason)}));
 const executions=Object.values(completed).filter(x=>['CONFIRMED','REVERTED'].includes(x.state));
 const count=Number.isInteger(performance?.closed)&&performance.closed>=0?performance.closed:!executions.length&&!live.lastExit?0:null;
 const historyComplete=count!==null&&count===closed.length;
 const netUsd=finite(performance?.netUsdAtEntryMarks)?performance.netUsdAtEntryMarks:count===0&&!executions.length?0:null;
 const graded=closed.filter(x=>finite(x.netUsd)&&x.netUsd!==0),wins=graded.filter(x=>x.netUsd>0).length;
 return {status:'available',source:'VPS Elysium LP',updatedAt:Math.min(updatedAt,liveAt),quality:{complete:true},
  mode:live.mode==='LIVE'?'LIVE':'PAPER',state:safeLabel(live.state),reason:safeLabel(live.reason),activatedAt:finite(live.activatedAt)?live.activatedAt*1000:null,
  openCount:Array.isArray(live.positions)?live.positions.length:null,closedCount:count,realizedUsd:netUsd,
  winRate:historyComplete&&graded.length?wins/graded.length*100:null,closed,historyComplete,
  transactionCount:executions.length,revertedCount:executions.filter(x=>x.state==='REVERTED').length,
  gasHype:executions.every(x=>/^\d+$/.test(x.gasWei||''))?executions.reduce((n,x)=>n+Number(x.gasWei)/1e18,0):null,
  decisions:paperCycles.slice(0,24).map(x=>({at:Number(x.asOf)*1000,mode:'PAPER',actions:(x.decisions||[]).map(y=>({action:safeLabel(y.action),reasons:(y.reasons||[y.reason]).filter(Boolean).map(safeLabel)}))})).filter(x=>finite(x.at)),
  pools:(audit?.pools||[]).slice(0,12).map(x=>({pair:safeLabel(x.pair),tvlUsd:finite(x.tvlUsd)?x.tvlUsd:null,volume1hUsd:finite(x.volume1hUsd)?x.volume1hUsd:null,fees24hUsd:finite(x.fees24hUsd)?x.fees24hUsd:null,decision:safeLabel(x.referenceRank),reasons:(x.referenceReasons||[]).map(safeLabel)})),
  paperHistory:{open:paperPositions.filter(x=>x.open).length,closed:paperPositions.filter(x=>!x.open).length},
  note:'Jurnal mesin Elysium LP saja. Nilai hasil USD memakai harga acuan mesin saat entry. Transaksi manual wallet dicatat terpisah dari jurnal mesin.'};
}
