import { test } from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import Core from '../assets/core.js';
const write=(root,name,text)=>{const file=join(root,name);mkdirSync(file.slice(0,file.lastIndexOf('/')),{recursive:true});writeFileSync(file,text);};
function fixture(){const root=mkdtempSync(join(tmpdir(),'cashood-exporter-')),bot=join(root,'bot'),data=join(root,'data');
 write(bot,'package.json','{"type":"module"}');write(bot,'node_modules/dotenv/package.json','{"type":"module"}');write(bot,'node_modules/dotenv/config.js','export {};');
 const address='0x'+'1'.repeat(40),usdg='0x'+'2'.repeat(40),weth='0x'+'3'.repeat(40);
 write(bot,'chain/addresses.js',`export const NATIVE='native',USDG='${usdg}',WETH='${weth}';export const decimalsOf=()=>6;`);
 write(bot,'chain/signer.js',`export const getWallet=()=>({address:'${address}'});`);
 write(bot,'chain/abi.js','export const ERC20_ABI=[];');
 write(bot,'chain/rpc.js',`export const getClient=()=>({getBalance:async()=>1000000000000000000n,readContract:async({functionName})=>functionName==='decimals'?6:1000000n});`);
 write(bot,'venue/quote.js',`export const balanceOf=async()=>{if(process.env.FAIL==='balance')throw Error('RPC');return 1000000n};`);
 write(bot,'venue/price.js','export const ethUsd=async()=>2500;');
 write(bot,'manager.js',`export const readBook=async()=>[{integrity:{complete:true},positions:[{tokenId:'123',quoteToken:'${usdg}',basisQuote:100000000,principalUsd:100,feesUsd:2,valueUsd:102,symbol:'TEST',tickLower:0,tickUpper:10,currentTick:5,inRange:true}]}];`);
 write(bot,'store.js','export const getClosed=()=>[],getClosedSince=()=>[],profitSweeps=()=>[],getOpen=()=>[{tokenId:"123",claimedQuote:1000000}];');
 write(bot,'venue/univ4.js',`export const getPositionPnl=async()=>({amount0:1000000000000000000n,amount1:1000000n,fees0:0n,fees1:process.env.FAIL==='fee'?10000000000000000000000n:100000n,inRange:true});`);
 write(bot,'venue/lpagent.js',`export const openPositions=async()=>{if(process.env.FAIL==='lp')throw Error('RPC');return [{tokenId:'123',pairName:'TEST',currentValue:100,unCollectedFee:2,inputValue:100,collectedFee:1,poolInfo:{feeTier:3000},ageHour:1}];};`);
 write(bot,'cli.js',`setInterval(()=>{},300000);const balance={sol_price:100,sol:1,sol_usd:100,usdc:100,tokens:[{mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC',balance:100,usd:100},{mint:'dust',symbol:'DUST',balance:1,usd:.1}]};const positions={positions:[{position:'S'.repeat(40),pair:'TOKEN/SOL',total_value_true_usd:100,unclaimed_fees_true_usd:2,collected_fees_true_usd:1,pnl_true_usd:3,lower_bin:0,upper_bin:10,active_bin:5}]};if(process.env.FAIL==='positions')delete positions.positions;if(String(process.env.FAIL).startsWith('unpriced'))balance.tokens.push({mint:'unknown',balance:10,usd:null});console.log(JSON.stringify(process.argv[2]==='balance'?balance:positions));`);
 const cfg={owners:[{id:'a',name:'A'}],events:[{id:'initial',date:'2026-09-01',owner:'a',type:'deposit',usd:1000,founding:true}],fund:{capacityUsd:10000},costs:{items:[]},dividend:{basis:'nav',distributePct:100,reinvestPct:0},treasury:{openingUsd:0}};
 for(const fund of ['reborn','meridian','ferari'])write(data,`${fund}/config.json`,JSON.stringify(cfg));
 write(data,'ferari/wallet.local.json',JSON.stringify({address}));
 write(data,'safebox/config.json',JSON.stringify({owners:[{id:'a',name:'A',principalUsd:3000}],rate:{minMonthlyPct:.1,maxMonthlyPct:3}}));
 write(data,'safebox/position.local.json',JSON.stringify({position:{tokenId:'123'},principalUsd:2500}));
 // All HTTP dependencies are deterministic. The bot mocks never hold a key or send a transaction.
 write(root,'network.cjs',`globalThis.fetch=async(url)=>{if(process.env.FAIL==='unpriced-offline'&&/jup\\.ag|dexscreener/.test(String(url)))throw new Error('offline');return {ok:true,json:async()=>({ethereum:{usd:2500,idr:40000000},solana:{usd:100,idr:1600000},pairs:[]})};};`);
 const run=(script,extra=[],fail='')=>spawnSync(process.execPath,['--require',join(root,'network.cjs'),resolve('scripts',script),...extra],{cwd:resolve('.'),env:{...process.env,RR_HOME:bot,MERIDIAN_HOME:bot,CASHOOD_DATA_DIR:data,FAIL:fail},encoding:'utf8',timeout:15000});
 return {root,data,run};}
test('all exporters produce coherent public snapshots; failed reads retain prior snapshots',()=>{const f=fixture();try{
 for(const [fund,script,args,fail] of [['reborn','sync.mjs',[join(f.data,'reborn/live.json')],'balance'],['meridian','sync-meridian.mjs',[],'positions'],['ferari','sync-ferari.mjs',[],'lp']]){
  const r=f.run(script,args);assert.equal(r.status,0,`${fund}: ${r.stderr}`);const p=join(f.data,fund,'live.json'),text=readFileSync(p,'utf8'),live=JSON.parse(text);Core.validateSnapshot(live,{complete:true});assert.match(live.positions[0].tokenId,/^pos-/);assert.equal(text.includes('"tokenId": "123"'),false);if(fund==='meridian')assert.equal(live.walletUsd,200.1);
  const failed=f.run(script,args,fail);assert.notEqual(failed.status,0,`${fund} accepted a partial read`);assert.equal(readFileSync(p,'utf8'),text);if(fund==='meridian'){
   // Harga tidak bisa dicari: tetap menolak, snapshot lama dipertahankan.
   assert.notEqual(f.run(script,args,'unpriced-offline').status,0);assert.equal(readFileSync(p,'utf8'),text);
   // Dua pasar menjawab dan tidak ada pasar sama sekali: $0, tapi dicatat terang.
   const dead=f.run(script,args,'unpriced');assert.equal(dead.status,0,dead.stderr);
   const after=JSON.parse(readFileSync(p,'utf8'));assert.equal(after.noMarketTokens.length,1);assert.equal(after.walletUsd,200.1);}
 }
 const good=f.run('sync-safebox.mjs',['--now']);assert.equal(good.status,0,good.stderr);const p=join(f.data,'safebox/live.json'),before=readFileSync(p,'utf8');const bad=f.run('sync-safebox.mjs',['--now'],'fee');assert.notEqual(bad.status,0);assert.equal(readFileSync(p,'utf8'),before);
}finally{rmSync(f.root,{recursive:true,force:true});}});
