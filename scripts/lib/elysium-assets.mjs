// All observations are pinned to a single block. Adapter methods perform reads
// and eth_call only: collecting fee estimates never sends a transaction.
export const NATIVE='0x0000000000000000000000000000000000000000';
export const V4_MANAGER='0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518';
export const BIN_MANAGERS=['0xd3bde60ff5a3851f04b0083cf27c0be828c611f2','0xb7f0fa5cb99cd327017f789966f3be0a0308fd1c'];
const lower=x=>String(x).toLowerCase();
const numeric=x=>{const n=Number(x);if(!Number.isFinite(n)||n<0)throw Error('Invalid asset value');return n;};
export function rawValue(raw,decimals,price){
 if(!Number.isInteger(decimals)||decimals<0||decimals>255||!(price>0)||!Number.isFinite(price)||BigInt(raw)<0n)throw Error('Invalid asset valuation');
 return numeric(Number(raw)/10**decimals*price);
}
export async function valueElysiumInventory({inventory,owner,read,nativePriceUsd}){
 const holdings=[],positions=[],problems=[];const meta=new Map();
 const token=async address=>{address=lower(address);if(!meta.has(address))meta.set(address,Promise.resolve(address===NATIVE?{decimals:18,symbol:'HYPE',priceUsd:nativePriceUsd}:read.token(address)));return meta.get(address);};
 const value=async(address,raw)=>{if(BigInt(raw)===0n)return 0;const m=await token(address);return rawValue(raw,m.decimals,m.priceUsd);};
 const attempt=async(kind,job)=>{try{await job();}catch{problems.push(kind);}};
 for(const address of [...new Set(inventory.tokens.map(lower))])await attempt('token belum dapat dinilai',async()=>{
  const amount=await read.balance(address,owner);if(amount===0n)return;
  const m=await token(address),usd=rawValue(amount,m.decimals,m.priceUsd);
  holdings.push({symbol:m.symbol,amount:numeric(Number(amount)/10**m.decimals),priceUsd:m.priceUsd,usd});
 });
 let verifiedV4=0;
 for(const nft of [...new Map(inventory.nfts.map(p=>[lower(p.contract)+':'+p.id,p])).values()])await attempt('NFT atau posisi v4 belum dapat dinilai',async()=>{
  const actual=await read.nftOwner(nft.contract,nft.id);
  if(actual===null||lower(actual)!==lower(owner))return;
  if(lower(nft.contract)!==V4_MANAGER)throw Error('Unsupported NFT');
  verifiedV4++;
  const p=await read.v4(nft.id);if(p.feesError)throw Error('Unverified fees');
  const principalUsd=await value(p.poolKey.currency0,p.amount0)+await value(p.poolKey.currency1,p.amount1);
  const feesUsd=await value(p.poolKey.currency0,p.fees0)+await value(p.poolKey.currency1,p.fees1);
  if(principalUsd===0&&feesUsd===0)return;
  positions.push({kind:'Uniswap v4',principalUsd,feesUsd,valueUsd:principalUsd+feesUsd,inRange:p.inRange});
 });
 await attempt('jumlah posisi v4 tidak cocok dengan penemuan aset',async()=>{if(BigInt(verifiedV4)!==await read.nftCount(V4_MANAGER,owner))throw Error('Incomplete NFT discovery');});
 for(const deposit of [...new Map(inventory.helios.map(p=>[lower(p.contract)+':'+p.id,p])).values()])await attempt('posisi Helios belum dapat dinilai',async()=>{
  if(!BIN_MANAGERS.includes(lower(deposit.contract)))throw Error('Unknown manager');
  const p=await read.heliosPosition(deposit.contract,deposit.id);
  if(lower(p.owner)!==lower(owner)||!p.liquidity.some(x=>BigInt(x)>0n))return;
  const amounts=await read.heliosAmounts(p),fees=await read.heliosFees(deposit.contract,deposit.id,owner);
  const principalUsd=await value(p.key.currency0,amounts.amount0)+await value(p.key.currency1,amounts.amount1);
  const feesUsd=await value(p.key.currency0,fees[0])+await value(p.key.currency1,fees[1]);
  positions.push({kind:'Helios DLMM',principalUsd,feesUsd,valueUsd:principalUsd+feesUsd,bins:p.liquidity.filter(x=>BigInt(x)>0n).length});
 });
 for(const receipt of inventory.other)await attempt('klaim token nonstandar belum dapat dinilai',async()=>{if(await read.claimBalance(receipt,owner)!==0n)throw Error('Unsupported active claim');});
 const tokenUsd=holdings.reduce((n,h)=>n+h.usd,0),lpUsd=positions.reduce((n,p)=>n+p.valueUsd,0);
 return {complete:!problems.length,tokenUsd:problems.length?null:tokenUsd,lpUsd:problems.length?null:lpUsd,knownTokenUsd:tokenUsd,knownLpUsd:lpUsd,holdings,positions,problems:[...new Set(problems)]};
}
