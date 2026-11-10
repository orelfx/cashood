#!/usr/bin/env node
// Read-only observer. No signer, private key, approvals, or transaction submission.
// Token, Uniswap v4 and Helios BinManager balances are valued at one block.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {valueElysiumInventory} from './lib/elysium-assets.mjs';
import {elysiumReader} from './lib/elysium-chain.mjs';
import {atomicJSON,lock} from './lib/io.mjs';
const data=resolve(process.env.CASHOOD_DATA_DIR||'data');
const release=lock(resolve(data,'elysium','custody.lock.local'));
const root=resolve(process.env.ELYSIUM_HOME||'/root/ELYSIUM');
if(process.env.ELYSIUM_FORK==='1')throw Error('Pembaca produksi tidak memakai fork');
const viem=await import(resolve(root,'node_modules/viem/_esm/index.js'));
const {createPublicClient,http}=viem;
const client=createPublicClient({transport:http(process.env.ELYSIUM_RPC_URL||'https://rpc.elysium.kinetiq.xyz',{retryCount:1,timeout:20000})});
const chainId=await client.getChainId();if(chainId!==99901)throw Error('RPC bukan jaringan Elysium');
const block=await client.getBlock();const now=Date.now();
if(now-Number(block.timestamp)*1000>120000)throw Error('Blok Elysium kedaluwarsa');
const response=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd&include_last_updated_at=true',{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error('Harga HYPE tidak tersedia');
const price=(await response.json()).hyperliquid;
if(!(price?.usd>0)||!Number.isFinite(price.last_updated_at)||now-price.last_updated_at*1000>15*60000||price.last_updated_at*1000>now+60000)throw Error('Harga HYPE tidak layak');
const adapter=await elysiumReader({client,viem,root,blockNumber:block.number,nativePriceUsd:price.usd});
for(const fund of ['elysium','riskelysium']){
 const {address}=JSON.parse(readFileSync(resolve(data,fund,'wallet.local.json'),'utf8'));
 if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('Alamat wallet Elysium tidak valid');
 const inventory=await adapter.discover(address);
 const valued=await valueElysiumInventory({inventory,owner:address,read:adapter.read,nativePriceUsd:price.usd});
 const native=await client.getBalance({address,blockNumber:block.number});
 const complete=valued.complete;
 atomicJSON(resolve(data,fund,'custody.local.json'),{fund,chainId,updatedAt:Math.min(Number(block.timestamp)*1000,price.last_updated_at*1000),observedAt:now,blockNumber:String(block.number),nativeAmount:Number(native)/1e18,nativePriceUsd:price.usd,...valued,valuationScope:'wallet tokens, Uniswap v4 and Helios V1/V2, block-pinned mark-to-market',priceSource:'coingecko:hyperliquid'});
 console.log(`[${fund}] custody ${complete?'verified wallet and LP':'asset valuation pending'}`);
}
release();
