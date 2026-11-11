#!/usr/bin/env node
// Historical reads only. No signer, approvals or transaction broadcast.
import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {atomicJSON,readJSON,lock,assertPublic} from './lib/io.mjs';
import {safeLabel} from './lib/elysium-engine.mjs';
import {elysiumReader} from './lib/elysium-chain.mjs';
import {V4_MANAGER} from './lib/elysium-assets.mjs';
const root=resolve(process.env.ELYSIUM_HOME||'/root/ELYSIUM'),data=resolve(process.env.CASHOOD_DATA_DIR||'data');
const release=lock(resolve(data,'riskelysium','history.lock.local'));
const v=await import(resolve(root,'node_modules/viem/_esm/index.js'));
const client=v.createPublicClient({transport:v.http(process.env.ELYSIUM_RPC_URL||'https://rpc.elysium.kinetiq.xyz',{retryCount:2,timeout:20000})});
if(await client.getChainId()!==99901)throw Error('Jaringan riwayat Elysium salah');
const block=await client.getBlock(),at=Number(block.timestamp)*1000;if(Date.now()-at>120000)throw Error('Blok riwayat sudah lama');
const signature=v.keccak256(v.toBytes('Transfer(address,address,uint256)')),erc20=v.parseAbi(['function decimals() view returns(uint8)','function symbol() view returns(string)']);
let last=0;async function read(fn){const wait=200-(Date.now()-last);if(wait>0)await new Promise(r=>setTimeout(r,wait));last=Date.now();return fn();}
for(const fund of ['elysium','riskelysium']){
 const {address}=readJSON(resolve(data,fund,'wallet.local.json'));const owner=address.toLowerCase();
 const cacheFile=resolve(data,fund,'chain-history.local.json'),cache=readJSON(cacheFile,{owner,rows:[],nextNonce:0});if(cache.owner!==owner)throw Error('Wallet cache riwayat berbeda');
 const head=await read(()=>client.getTransactionCount({address,blockNumber:block.number}));
 const found=new Map(),counts=new Map();
 const nonceAt=async n=>{const key=String(n);if(!counts.has(key))counts.set(key,await read(()=>client.getTransactionCount({address,blockNumber:n})));return counts.get(key);};
 // Bound first backfill; later cycles extend it forward. Coverage is explicit.
 const start=Math.max(cache.nextNonce||0,head-80);let floor=0n;
 for(let nonce=start;nonce<head;nonce++){
  let lo=floor,hi=block.number;while(lo<hi){const mid=(lo+hi)/2n;if(await nonceAt(mid)>nonce)hi=mid;else lo=mid+1n;}floor=lo;
  const b=await read(()=>client.getBlock({blockNumber:lo,includeTransactions:true}));
  for(const tx of b.transactions)if(tx.from.toLowerCase()===owner&&tx.nonce===nonce)found.set(tx.hash,{tx,block:b});
 }
 const topic='0x'+owner.slice(2).padStart(64,'0'),fromBlock=cache.lastBlock?BigInt(cache.lastBlock)+1n:0n;
 if(fromBlock<=block.number)for(const topics of [[signature,null,topic],[signature,topic]]){
  const logs=await read(()=>client.request({method:'eth_getLogs',params:[{fromBlock:v.toHex(fromBlock),toBlock:v.toHex(block.number),topics}]}));
  if(!Array.isArray(logs)||logs.length>=10000)throw Error('Riwayat token melebihi cakupan satu pembacaan');
  for(const l of logs)if(!cache.rows.some(x=>x.hash===l.transactionHash)&&!found.has(l.transactionHash))found.set(l.transactionHash,{});
 }
 const metadata=new Map();const rows=[];
 for(const [hash,hint] of found){
  const tx=hint.tx||await read(()=>client.getTransaction({hash})),receipt=await read(()=>client.getTransactionReceipt({hash})),b=hint.block||await read(()=>client.getBlock({blockNumber:receipt.blockNumber,includeTransactions:true}));
  const movements=[];
  for(const l of receipt.logs){if(l.topics[0]!==signature||l.topics.length!==3)continue;
   const from='0x'+l.topics[1].slice(-40),to='0x'+l.topics[2].slice(-40);if(from!==owner&&to!==owner)continue;
   const a=l.address.toLowerCase();if(!metadata.has(a)){try{metadata.set(a,{symbol:safeLabel(await read(()=>client.readContract({address:a,abi:erc20,functionName:'symbol',blockNumber:block.number}))),decimals:Number(await read(()=>client.readContract({address:a,abi:erc20,functionName:'decimals',blockNumber:block.number})))});}catch{metadata.set(a,null);}}
   const m=metadata.get(a);movements.push({symbol:m?.symbol||'Token',amount:m?Number(BigInt(l.data))/10**m.decimals:null,direction:from===to?'self':to===owner?'in':'out'});
  }
  const outgoing=tx.from.toLowerCase()===owner,ownCount=b.transactions.filter(t=>t.from.toLowerCase()===owner).length;
  let change=null;if(outgoing&&ownCount===1){const [before,after]=await Promise.all([read(()=>client.getBalance({address,blockNumber:b.number-1n})),read(()=>client.getBalance({address,blockNumber:b.number}))]);change=Number(after-before)/1e18;}
  rows.push({hash,at:Number(b.timestamp)*1000,block:String(b.number),outgoing,status:receipt.status==='success'?'confirmed':'reverted',kind:receipt.status!=='success'?'Transaksi gagal':movements.length?'Interaksi token':tx.input==='0x'?'Transfer HYPE':'Interaksi kontrak',nativeSent:outgoing?Number(tx.value)/1e18:tx.to?.toLowerCase()===owner?Number(tx.value)/1e18:null,nativeBlockChange:change,gasHype:outgoing?Number(receipt.gasUsed*receipt.effectiveGasPrice)/1e18:0,movements});
 }
 const all=[...new Map([...cache.rows,...rows].map(r=>[r.hash,r])).values()].sort((a,b)=>a.at-b.at);
 const custody=readJSON(resolve(data,fund,'custody.local.json'),{});
 const adapter=await elysiumReader({client,viem:v,root,blockNumber:block.number,nativePriceUsd:custody.nativePriceUsd||1});const inventory=await adapter.discover(address);
 const identities=[...new Map([...inventory.nfts.filter(n=>n.contract.toLowerCase()===V4_MANAGER).map(n=>({...n,kind:'Uniswap v4'})),...inventory.helios.map(n=>({...n,kind:'Helios DLMM'}))].map(n=>[n.contract+':'+n.id,n])).values()];
 const positions=[];
 const withdrawn=v.parseAbiItem('event Withdrawn(uint256 indexed positionId, address indexed to, uint256 amount0, uint256 amount1)'),deposited=v.parseAbiItem('event Deposited(uint256 indexed positionId,bytes32 indexed id,address indexed owner,int24 firstBin,uint128[] liquidity,uint256 amount0,uint256 amount1,uint64 unlockAt)');
 for(const n of identities){
  let state='Belum terverifikasi';
  try{if(n.kind==='Helios DLMM'){const p=await adapter.read.heliosPosition(n.contract,n.id);state=p.owner.toLowerCase()!==owner?'Tidak lagi dimiliki':p.liquidity.some(x=>x>0n)?'Aktif':'Likuiditas sudah kosong';}
   else {const current=await adapter.read.nftOwner(n.contract,n.id);if(!current)state='NFT dibakar';else if(current.toLowerCase()!==owner)state='Tidak lagi dimiliki';else {const p=await adapter.read.v4(n.id);state=p.amount0>0n||p.amount1>0n?'Aktif':'Likuiditas sudah kosong';}}
  }catch{}
  let openedAt=null,withdrawnAt=null;
  if(n.kind==='Helios DLMM')try{
   for(const [event,key] of [[deposited,'open'],[withdrawn,'exit']]){
    const logs=await read(()=>client.getLogs({address:n.contract,event,args:{positionId:n.id},fromBlock:0n,toBlock:block.number}));
    const l=key==='open'?logs[0]:logs.at(-1);if(l){const b=await read(()=>client.getBlock({blockNumber:l.blockNumber}));if(key==='open')openedAt=Number(b.timestamp)*1000;else withdrawnAt=Number(b.timestamp)*1000;}
   }
  }catch{state+=' · riwayat event belum lengkap';}
  positions.push({label:'LP '+(positions.length+1),kind:n.kind,state,openedAt,withdrawnAt});
 }
 const discoveredLp=positions.length;
 const publicRows=all.slice(-200).reverse().map(({hash,...r})=>({...r,id:createHash('sha256').update(hash).digest('hex').slice(0,12)}));
 const output={source:'Blockchain Elysium',chainId:99901,updatedAt:at,status:'available',quality:{complete:true},walletTransactionCount:head,indexedFromNonce:cache.indexedFromNonce??start,indexedOutgoing:all.filter(r=>r.outgoing).length,tokenEventsIncluded:true,coverage:'Transaksi yang dikirim wallet serta transfer token masuk/keluar. Transfer HYPE internal tanpa log tidak tercakup seluruhnya.',transactions:publicRows,transactionCount:all.length,gasHype:all.reduce((s,r)=>s+r.gasHype,0),discoveredLp,positions,closedLpCount:discoveredLp===0?0:null,closed:[],historyComplete:discoveredLp===0,realizedUsd:null,winRate:null};
 assertPublic(output);atomicJSON(cacheFile,{owner,rows:all,nextNonce:head,lastBlock:String(block.number),indexedFromNonce:cache.indexedFromNonce??start});atomicJSON(resolve(data,fund,'activity.local.json'),output);
 console.log('['+fund+'] blockchain history',all.length,'transactions,',discoveredLp,'LP identities');
}
release();
