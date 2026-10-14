import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sourceProblems} from '../scripts/lib/source-quality.mjs';
const now=Date.now(),DAY=86400000;
const quality={complete:true,estimated:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'cashood-quality-'));
 const put=(name,value)=>{mkdirSync(resolve(dir,name,'..'),{recursive:true});writeFileSync(join(dir,name),JSON.stringify(value));};
 const get=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
 for(const id of ['reborn','meridian','ferari','robsol']){
  put(id+'/config.json',JSON.parse(readFileSync(resolve('data',id,'config.json'),'utf8')));
  put(id+'/live.json',{totalUsd:1000,updatedAt:now-1000,quality});
 }
 put('safebox/config.json',{owners:[{id:'a',name:'A',principalUsd:1000}],rate:{minMonthlyPct:0,maxMonthlyPct:3}});
 writeFileSync(join(dir,'source.mjs'),'export async function observe(){return {total:0,valueUsd:1000}}');
 const run=script=>{const p=spawnSync(process.execPath,[resolve('scripts',script)],{env:{...process.env,CASHOOD_DATA_DIR:dir,CASHOOD_SAFEBOX_SOURCE:join(dir,'source.mjs')},encoding:'utf8'});assert.equal(p.status,0,p.stderr);};
 return {dir,put,get,run,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('source freshness rejects absent, incomplete, estimated, stale and future values',()=>{
 for(const source of [null,{}, {updatedAt:now,quality:{complete:false}}, {updatedAt:now,quality:{...quality,estimated:true}},{updatedAt:now-1800001,quality},{updatedAt:now+61000,quality}])assert.ok(sourceProblems('x',source,now).length);
 assert.deepEqual(sourceProblems('x',{updatedAt:now-1000,quality},now),[]);
});
test('Index holds level, ledger, history and timestamp on component failure and recovers',()=>{
 const f=fixture();try{
  f.run('sync-index.mjs');const live=f.get('index/live.json'),state=f.get('index/state.local.json'),nav=f.get('index/nav.local.json');
  assert.equal(live.updatedAt,now-1000);assert.equal(live.components.length,4);
  for(const bad of [{totalUsd:9999,updatedAt:now-3600000,quality},{totalUsd:9999,updatedAt:now,quality:{complete:false}},{totalUsd:0,updatedAt:now,quality},{totalUsd:9999,updatedAt:now+3600000,quality},null]){
   f.put('meridian/live.json',bad);f.run('sync-index.mjs');const held=f.get('index/live.json');
   assert.equal(held.level,live.level);assert.equal(held.updatedAt,live.updatedAt);assert.equal(held.quality.calculationDeferred,true);
   assert.ok(held.quality.problems.some(p=>p.id==='meridian'));
   assert.deepEqual(f.get('index/state.local.json'),state);assert.deepEqual(f.get('index/nav.local.json'),nav);
  }
  f.put('meridian/live.json',{totalUsd:1100,updatedAt:now,quality});f.run('sync-index.mjs');assert.equal(f.get('index/live.json').quality.complete,true);
 }finally{f.close();}
});
test('Safe Box rejects stale, mixed-generation and unverified historical Index without changing accrual',()=>{
 const f=fixture();try{
  const points=Array.from({length:193},(_,i)=>({t:now-(192-i)*3600000,sourceAt:now-(192-i)*3600000,usd:100+i/100,quality}));
  const live={level:points.at(-1).usd,generation:'verified',updatedAt:now,quality};
  const nav={generation:'verified',updatedAt:now,quality,points};
  f.put('index/live.json',live);f.put('index/nav.local.json',nav);f.run('sync-safebox.mjs');
  const state=f.get('safebox/accrual-v3.local.json'),good=f.get('safebox/live.json');assert.equal(good.quality.complete,true);
  for(const bad of [{...live,updatedAt:now-3600000},{...live,generation:'other'},{...live,quality:{complete:false}}]){
   f.put('index/live.json',bad);f.run('sync-safebox.mjs');assert.deepEqual(f.get('safebox/accrual-v3.local.json'),state);assert.equal(f.get('safebox/live.json').quality.calculationDeferred,true);
  }
  f.put('index/live.json',live);
  for (const badPoints of [{},[null],[...points].reverse()]) {
   f.put('index/nav.local.json',{...nav,points:badPoints});f.run('sync-safebox.mjs');assert.deepEqual(f.get('safebox/accrual-v3.local.json'),state);assert.equal(f.get('safebox/live.json').quality.calculationDeferred,true);
  }
  // Riwayat tanpa tanda kualitas: bagian bot ditahan (laju bot 0) tapi akrual
  // tetap berjalan supaya lantai minimum dibayar — tidak lagi membekukan Safe Box.
  f.put('index/nav.local.json',{...nav,points:points.map(({quality,...p})=>p)});f.run('sync-safebox.mjs');
  {const held=f.get('safebox/accrual-v3.local.json');const all=[...held.days,...(held.today?[held.today]:[])];assert.ok(all.length>0&&all.every(d=>d.botRateHeld===true&&d.botRatePct===0));}
  f.put('index/nav.local.json',nav);f.run('sync-safebox.mjs');assert.equal(f.get('safebox/live.json').quality.complete,true);
 }finally{f.close();}
});
test('Safe Box without a trusted snapshot publishes unavailable instead of inventing zero balances',()=>{
 const f=fixture();try{f.run('sync-safebox.mjs');const d=f.get('safebox/live.json');assert.equal(d.updatedAt,null);assert.equal(d.balanceUsd,undefined);assert.equal(d.quality.complete,false);assert.equal(existsSync(join(f.dir,'safebox/accrual-v3.local.json')),false);}finally{f.close();}
});
