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
export function elysiumCustody({fund,chainId,updatedAt,nativeAmount,nativePriceUsd,tokenUsd,lpUsd,complete},now=Date.now()){
 if(!['elysium','riskelysium'].includes(fund)||chainId!==99901)throw Error('Identitas sumber Elysium salah');
 const base={fund,chain:'Elysium',chainId,checkedAt:now,realMoney:true};
 if(complete!==true||![updatedAt,nativeAmount,nativePriceUsd,tokenUsd,lpUsd].every(finite)||nativeAmount<0||nativePriceUsd<=0||tokenUsd<0||lpUsd<0||updatedAt<=0||updatedAt>now+60_000||now-updatedAt>15*60_000)return {...base,status:'unavailable',updatedAt:null,totalUsd:null,quality:{complete:false},note:'Saldo Elysium belum terverifikasi lengkap; tidak dianggap nol.'};
 return {...base,status:'verified',updatedAt,nativeAmount,nativePriceUsd,tokenUsd,lpUsd,totalUsd:nativeAmount*nativePriceUsd+tokenUsd+lpUsd,quality:{complete:true}};
}
