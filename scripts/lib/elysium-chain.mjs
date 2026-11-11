import {NATIVE,V4_MANAGER,BIN_MANAGERS} from './elysium-assets.mjs';
export async function elysiumReader({client,viem,root,blockNumber,nativePriceUsd}){
 const {parseAbi,parseAbiItem,decodeEventLog,keccak256,toBytes}=viem;
 const {getPositionPnl,getActiveBin,poolId}=await import(root+'/venue/univ4.js');
 const {principalForBin}=await import(root+'/hunter/bins.js');
 const {POOL_MANAGER_ABI}=await import(root+'/chain/abi.js');
 const {V4}=await import(root+'/chain/addresses.js');
 const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function symbol() view returns(string)']);
 const nft=parseAbi(['function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)','error ERC721NonexistentToken(uint256 tokenId)']);
 const claims=parseAbi(['function balanceOf(address,uint256) view returns(uint256)']);
 const bin=parseAbi(['struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }','struct Position { address owner; uint64 unlockAt; PoolKey key; int24 firstBin; uint128[] liquidity; }','function getPosition(uint256) view returns(Position)','function collectFees(uint256,address) returns(uint256,uint256)','event Deposited(uint256 indexed positionId,bytes32 indexed id,address indexed owner,int24 firstBin,uint128[] liquidity,uint256 amount0,uint256 amount1,uint64 unlockAt)']);
 let queue=Promise.resolve(),last=0;
 const paced=job=>{const task=queue.then(async()=>{const wait=600-(Date.now()-last);if(wait>0)await new Promise(r=>setTimeout(r,wait));last=Date.now();return job();});queue=task.catch(()=>{});return task;};
 const read=(address,abi,functionName,args=[])=>paced(()=>client.readContract({address,abi,functionName,args,blockNumber}));
 async function logs(filter,from=0n,to=blockNumber){
  try{const rows=await paced(()=>client.request({method:'eth_getLogs',params:[{...filter,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]}));if(!Array.isArray(rows)||rows.length>=10000)throw Error('Log response limit');return rows;}
  catch(e){if(from>=to||!/range|limit|size|timeout|413/i.test(e.shortMessage||e.message)||/429/.test(e.shortMessage||e.message))throw e;const mid=(from+to)/2n;return [...await logs(filter,from,mid),...await logs(filter,mid+1n,to)];}
 }
 const eventLogs=async(address,event,args)=>{
  const topics=viem.encodeEventTopics({abi:[event],eventName:event.name,args});
  return (await logs({address,topics})).map(log=>decodeEventLog({abi:[event],data:log.data,topics:log.topics}));
 };
 async function discover(owner){
  const to='0x'+owner.slice(2).toLowerCase().padStart(64,'0'),tokens=new Set(),nfts=new Map(),other=new Map();
  const transfers=await logs({topics:[keccak256(toBytes('Transfer(address,address,uint256)')),null,to]});
  for(const log of transfers){const contract=log.address.toLowerCase();if(log.topics.length===4){const id=BigInt(log.topics[3]);nfts.set(contract+':'+id,{contract,id});}else if(log.topics.length===3)tokens.add(contract);else throw Error('Malformed transfer');}
  for(const [sig,index] of [['TransferSingle(address,address,address,uint256,uint256)',3],['TransferBatch(address,address,address,uint256[],uint256[])',3],['Transfer(address,address,address,uint256,uint256)',2]]){
   const topics=Array(index+1).fill(null);topics[0]=keccak256(toBytes(sig));topics[index]=to;
   for(const log of await logs({topics})){
    let ids;if(index===2)ids=[BigInt(log.topics[3])];
    else {const abi=parseAbiItem(sig.startsWith('TransferSingle')?'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)':'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)');const a=decodeEventLog({abi:[abi],data:log.data,topics:log.topics}).args;ids=a.ids||[a.id];}
    for(const id of ids)other.set(log.address+':'+id,{contract:log.address,id});
   }
  }
  const helios=[];
  for(const contract of BIN_MANAGERS){for(const e of await eventLogs(contract,bin.find(x=>x.name==='Deposited'),{owner}))helios.push({contract,id:e.args.positionId});}
  return {tokens:[...tokens],nfts:[...nfts.values()],helios,other:[...other.values()]};
 }
 const prices=new Map();
 async function token(address){
  if(prices.has(address))return prices.get(address);
  const decimals=Number(await read(address,erc20,'decimals'));
  const symbol=await read(address,erc20,'symbol').catch(()=>'Token');
  const init=POOL_MANAGER_ABI.find(x=>x.name==='Initialize');
  const events=await eventLogs(V4.poolManager,init,{currency0:NATIVE,currency1:address});
  let best=null;
  for(const e of events){const a=e.args,key={currency0:a.currency0,currency1:a.currency1,fee:a.fee,tickSpacing:a.tickSpacing,hooks:a.hooks};
   const p=await paced(()=>getActiveBin({pool_key:key,pool_address:a.id,blockNumber}));
   if(p.liquidity<=0n)continue;
   const sqrt=Number(p.sqrtPriceX96)/2**96,ratio=sqrt*sqrt*10**(18-decimals);
   const depth=Number(p.liquidity)/sqrt/1e18*nativePriceUsd;
   const priceUsd=nativePriceUsd/ratio;
   if(depth>=10&&Number.isFinite(priceUsd)&&priceUsd>0&&(!best||depth>best.depth))best={priceUsd,depth};
  }
  if(!best)throw Error('No liquid HYPE price source');
  const out={decimals,symbol:String(symbol).slice(0,80),priceUsd:best.priceUsd};prices.set(address,out);return out;
 }
 return {discover,read:{token,metadata:async a=>({decimals:Number(await read(a,erc20,'decimals')),symbol:await read(a,erc20,'symbol')}),balance:(a,o)=>read(a,erc20,'balanceOf',[o]),nftCount:(a,o)=>read(a,nft,'balanceOf',[o]),
  nftOwner:async(a,id)=>{try{return await read(a,nft,'ownerOf',[id]);}catch(e){if(e.cause?.data?.errorName==='ERC721NonexistentToken'||/NOT_MINTED|owner query for nonexistent|invalid token ID/i.test(e.cause?.reason||''))return null;throw e;}},
  v4:id=>paced(()=>getPositionPnl({tokenId:id,blockNumber})),
  heliosPosition:(a,id)=>read(a,bin,'getPosition',[id]),
  heliosFees:async(a,id,owner)=>(await paced(()=>client.simulateContract({address:a,abi:bin,functionName:'collectFees',args:[id,owner],account:owner,blockNumber}))).result,
  heliosAmounts:async p=>{const pool=await paced(()=>getActiveBin({pool_key:p.key,pool_address:poolId(p.key),blockNumber}));return p.liquidity.reduce((sum,L,i)=>{const a=principalForBin({id:p.firstBin+i,spacing:p.key.tickSpacing,sqrtPriceX96:pool.sqrtPriceX96,liquidity:L});return {amount0:sum.amount0+a.amount0,amount1:sum.amount1+a.amount1};},{amount0:0n,amount1:0n});},
  claimBalance:(r,o)=>read(r.contract,claims,'balanceOf',[o,r.id])}};
}
