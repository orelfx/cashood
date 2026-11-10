#!/usr/bin/env node
// Read-only observer. No signer, private key, approvals, or transaction submission.
// Initially supports native-only wallets. Any token/NFT receipt defers total
// valuation until that asset/position has a verified valuation adapter.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {atomicJSON,lock} from './lib/io.mjs';
const data=resolve(process.env.CASHOOD_DATA_DIR||'data');
const release=lock(resolve(data,'elysium','custody.lock.local'));
const root=process.env.ELYSIUM_HOME||'/root/ELYSIUM';
const {createPublicClient,http,keccak256,toBytes,parseAbiItem}=await import(resolve(root,'node_modules/viem/_esm/index.js'));
const client=createPublicClient({transport:http(process.env.ELYSIUM_RPC_URL||'https://rpc.elysium.kinetiq.xyz',{retryCount:1,timeout:20000})});
const chainId=await client.getChainId();if(chainId!==99901)throw Error('RPC bukan jaringan Elysium');
const block=await client.getBlock();const now=Date.now();
if(now-Number(block.timestamp)*1000>120000)throw Error('Blok Elysium kedaluwarsa');
const response=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd&include_last_updated_at=true',{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error('Harga HYPE tidak tersedia');
const price=(await response.json()).hyperliquid;
if(!(price?.usd>0)||!Number.isFinite(price.last_updated_at)||now-price.last_updated_at*1000>15*60000||price.last_updated_at*1000>now+60000)throw Error('Harga HYPE tidak layak');
const signatures=[['Transfer(address,address,uint256)',2],['TransferSingle(address,address,address,uint256,uint256)',3],['TransferBatch(address,address,address,uint256[],uint256[])',3],['Transfer(address,address,address,uint256,uint256)',2]];
for(const fund of ['elysium','riskelysium']){
 const {address}=JSON.parse(readFileSync(resolve(data,fund,'wallet.local.json'),'utf8'));
 if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('Alamat wallet Elysium tidak valid');
 const recipient='0x'+address.slice(2).toLowerCase().padStart(64,'0');
 let receiptCount=0;
 for(const [sig,index] of signatures){
  const topics=Array(index+1).fill(null);topics[0]=keccak256(toBytes(sig));topics[index]=recipient;
  const logs=await client.request({method:'eth_getLogs',params:[{fromBlock:'0x0',toBlock:'0x'+block.number.toString(16),topics}]});
  if(!Array.isArray(logs))throw Error('Daftar aset Elysium tidak valid');receiptCount+=logs.length;
 }
 const native=await client.getBalance({address,blockNumber:block.number});
 const positions=await client.readContract({address:'0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518',abi:[parseAbiItem('function balanceOf(address) view returns (uint256)')],functionName:'balanceOf',args:[address],blockNumber:block.number});
 const complete=receiptCount===0&&positions===0n;
 atomicJSON(resolve(data,fund,'custody.local.json'),{fund,chainId,updatedAt:Math.min(Number(block.timestamp)*1000,price.last_updated_at*1000),observedAt:now,blockNumber:String(block.number),nativeAmount:Number(native)/1e18,nativePriceUsd:price.usd,tokenUsd:complete?0:null,lpUsd:complete?0:null,complete,receiptCount,knownPositions:Number(positions),valuationScope:'native-only; no ERC20/ERC721/ERC1155/ERC6909 receipts since genesis',priceSource:'coingecko:hyperliquid'});
 console.log(`[${fund}] custody ${complete?'verified native-only':'asset valuation pending'}`);
}
release();
