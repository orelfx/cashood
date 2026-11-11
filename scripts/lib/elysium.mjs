// Paper performance and funded custody are separate books. Never use simulated
// equity as the value of the real $100 transferred by the owner.
const finite = v => typeof v === 'number' && Number.isFinite(v);
export function elysiumPaper(source, now = Date.now()) {
 const cycle=source?.health?.runtime, book=source?.book;
 const at=Number(cycle?.finishedAt)*1000;
 const base={fund:'elysium',family:'reborn',label:'Elysium LP',chain:'Elysium',risk:'medium',mode:'paper',realMoney:false,checkedAt:now};
 const ready=source?.mode==='PAPER' && book?.mode==='PAPER' && book.initialized===true && source.health?.status==='OK' && cycle?.status==='OK' && finite(at) && at>0 && at<=now+60_000 && now-at<=15*60_000;
 if(!ready)return {...base,status:'unavailable',updatedAt:null,quality:{complete:false,estimated:true},note:'Data simulasi belum tersedia atau sudah kedaluwarsa. Saldo nyata terpisah.'};
 const fields={capitalUsd:book.policy?.capitalUsd,equityUsd:book.equityUsd,cashUsd:book.cashUsd,principalUsd:book.principalUsd,netPnlUsd:book.netPnlUsd,realizedPnlUsd:book.realizedPnlUsd,unrealizedPnlUsd:book.unrealizedPnlUsd,feesUsd:book.feesUsd,costsUsd:book.costsUsd};
 if(Object.values(fields).some(v=>!finite(v)) || fields.capitalUsd<=0 || fields.equityUsd<0 || !Array.isArray(book.openPositions))throw Error('Buku simulasi Elysium tidak lengkap');
 return {...base,status:'paper',updatedAt:at,quality:{complete:true,estimated:true},paper:{...fields,openPositions:book.openPositions.length,feeEstimated:book.feeStatus!=='VERIFIED'},note:'Hasil simulasi; tidak termasuk dalam total aset nyata atau saham investor.'};
}
export function elysiumCustody({fund,chainId,updatedAt,nativeAmount,nativePriceUsd,tokenUsd,lpUsd,complete,holdings=[],positions=[],knownTokenUsd,knownLpUsd,unpriced=[],problems=[]},now=Date.now()){
 if(!['elysium','riskelysium'].includes(fund)||chainId!==99901)throw Error('Identitas sumber Elysium salah');
 const base={fund,chain:'Elysium',chainId,checkedAt:now,realMoney:true};
 const cleanSymbol=s=>String(s||'Token').replace(/0x[0-9a-f]{16,}/gi,'').replace(/[^a-zA-Z0-9 ._+-]/g,'').slice(0,24)||'Token';
 const detailValid=Array.isArray(holdings)&&Array.isArray(positions)&&holdings.every(h=>h&&[h.amount,h.priceUsd,h.usd].every(finite)&&h.amount>=0&&h.priceUsd>0&&h.usd>=0&&Math.abs(h.amount*h.priceUsd-h.usd)<.00001)&&positions.every(p=>p&&['Uniswap v4','Helios DLMM'].includes(p.kind)&&[p.principalUsd,p.feesUsd,p.valueUsd].every(finite)&&p.principalUsd>=0&&p.feesUsd>=0&&Math.abs(p.valueUsd-p.principalUsd-p.feesUsd)<.00001)
  &&Math.abs(holdings.reduce((n,h)=>n+h.usd,0)-tokenUsd)<.00001&&Math.abs(positions.reduce((n,p)=>n+p.valueUsd,0)-lpUsd)<.00001;

 const fresh=[updatedAt,nativeAmount,nativePriceUsd].every(finite)&&nativeAmount>=0&&nativePriceUsd>0&&updatedAt>0&&updatedAt<=now+60_000&&now-updatedAt<=15*60_000;
 if(!fresh||!detailValid||complete!==true||![tokenUsd,lpUsd].every(finite)||tokenUsd<0||lpUsd<0||!finite(nativeAmount*nativePriceUsd+tokenUsd+lpUsd)){
  const partial={...base,status:'unavailable',updatedAt:null,totalUsd:null,quality:{complete:false},note:'Saldo Elysium belum terverifikasi lengkap; tidak dianggap nol.'};
  // Reuse full validation for the priced subset; never promote it to totalUsd.
  if(fresh&&complete===false&&finite(knownTokenUsd)&&finite(knownLpUsd)){
   const known=elysiumCustody({fund,chainId,updatedAt,nativeAmount,nativePriceUsd,tokenUsd:knownTokenUsd,lpUsd:knownLpUsd,complete:true,holdings,positions},now);
   if(known.quality.complete)return {...known,status:'partial',totalUsd:null,knownTotalUsd:known.totalUsd,quality:{complete:false},
    unpriced:Array.isArray(unpriced)?unpriced.map(h=>({symbol:cleanSymbol(h.symbol),amount:finite(h.amount)&&h.amount>=0?h.amount:null})):[],
    unresolvedCount:Array.isArray(problems)?problems.length:1,note:'Subtotal aset yang berhasil dinilai. Aset tanpa harga belum termasuk; bukan saldo lengkap.'};
  }
  return partial;
 }

 return {...base,status:'verified',updatedAt,nativeAmount,nativePriceUsd,tokenUsd,lpUsd,totalUsd:nativeAmount*nativePriceUsd+tokenUsd+lpUsd,holdings:holdings.map(h=>({symbol:cleanSymbol(h.symbol),amount:h.amount,priceUsd:h.priceUsd,usd:h.usd})),positions:positions.map((p,i)=>({label:'Posisi '+(i+1),kind:p.kind,principalUsd:p.principalUsd,feesUsd:p.feesUsd,valueUsd:p.valueUsd,...(typeof p.inRange==='boolean'?{inRange:p.inRange}:{}),...(Number.isInteger(p.bins)&&p.bins>0?{bins:p.bins}:{})})),quality:{complete:true}};
}
