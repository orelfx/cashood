import test from 'node:test';
import assert from 'node:assert/strict';
import {elysiumPaper,elysiumCustody} from '../scripts/lib/elysium.mjs';
const now=Date.now();
const source={mode:'PAPER',health:{status:'OK',runtime:{status:'OK',finishedAt:Math.floor(now/1000)}},book:{mode:'PAPER',initialized:true,policy:{capitalUsd:1000},equityUsd:1001,cashUsd:801,principalUsd:200,netPnlUsd:1,realizedPnlUsd:0,unrealizedPnlUsd:1,feesUsd:1,costsUsd:0,feeStatus:'ESTIMATED',openPositions:[{address:'secret'}]}};
test('Elysium simulation never masquerades as investor assets or exposes source identities',()=>{
 const d=elysiumPaper(source,now);assert.equal(d.realMoney,false);assert.equal(d.totalUsd,undefined);assert.equal(d.paper.equityUsd,1001);assert.equal(d.paper.openPositions,1);assert.equal(JSON.stringify(d).includes('secret'),false);
});
test('stale or unhealthy Elysium simulation publishes no fabricated value',()=>{for(const s of [null,{...source,mode:'LIVE'}, {...source,health:{...source.health,status:'DEGRADED'}}])assert.equal(elysiumPaper(s,now).status,'unavailable');assert.equal(elysiumPaper(source,now+16*60000).paper,undefined);});
test('real Elysium custody requires full valuation on the correct chain',()=>{
 const d={fund:'riskelysium',chainId:99901,updatedAt:now,nativeAmount:2,nativePriceUsd:30,tokenUsd:40,lpUsd:100,complete:true,holdings:[{symbol:'T',amount:4,priceUsd:10,usd:40}],positions:[{kind:'Uniswap v4',principalUsd:90,feesUsd:10,valueUsd:100}]};
 assert.equal(elysiumCustody(d,now).totalUsd,200);assert.equal(elysiumCustody({...d,complete:false},now).totalUsd,null);assert.throws(()=>elysiumCustody({...d,chainId:4663},now));assert.equal(elysiumCustody({...d,lpUsd:undefined},now).totalUsd,null);
});
test('internal funding is eliminated from global contributed capital only when the source withdrawal matches',async()=>{
 const {readFileSync}=await import('node:fs'),{runInNewContext}=await import('node:vm');
 const app=readFileSync(new URL('../assets/app.js',import.meta.url),'utf8');
 const fn=runInNewContext(app.slice(app.indexOf('function matchedInternalCapital('))+';matchedInternalCapital');
 const source={id:'reborn',cfg:{events:[{id:'transfer',owner:'orel',type:'withdraw',usd:100}]}};
 const dest={internalTransfer:{sourceFund:'reborn',sourceEvent:'transfer',owner:'orel',usd:100}};
 assert.equal(fn([source,dest]),100);assert.equal(fn([dest]),0);
 assert.equal(fn([source,{internalTransfer:{...dest.internalTransfer,owner:'stefani'}}]),0);
 assert.equal(fn([source,{internalTransfer:{...dest.internalTransfer,usd:101}}]),0);
});
test('published asset detail reconciles totals and strips contract identities',()=>{
 const address='0x'+'a'.repeat(40), d={fund:'elysium',chainId:99901,updatedAt:now,nativeAmount:1,nativePriceUsd:10,tokenUsd:4,lpUsd:6,complete:true,holdings:[{symbol:address,amount:2,priceUsd:2,usd:4,address}],positions:[{kind:'Helios DLMM',principalUsd:5,feesUsd:1,valueUsd:6,bins:3,address}]};
 const out=elysiumCustody(d,now);assert.equal(out.totalUsd,20);assert.equal(JSON.stringify(out).includes(address),false);assert.equal(out.positions[0].bins,3);
 assert.equal(elysiumCustody({...d,tokenUsd:5},now).quality.complete,false);
 assert.equal(elysiumCustody({...d,positions:[]},now).totalUsd,null);
});
