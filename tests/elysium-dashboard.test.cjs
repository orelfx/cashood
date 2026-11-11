const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(require('node:path').join(__dirname,'../assets/app.js'),'utf8');
const perf=vm.runInNewContext(app.slice(app.indexOf('function elysiumPerformance('),app.indexOf('function elysiumSummary('))+';elysiumPerformance',{elysiumFundingEvents:f=>f?.events||[]});
const now=Date.now(),t=now-1200000;
test('Elysium graph removes deposits and withdrawals instead of reporting transfers as gains',()=>{
 const d={curve:[{t,usd:100},{t:t+600000,usd:605},{t:now,usd:550}],funding:{events:[{at:t+100000,type:'deposit',usd:500},{at:t+900000,type:'withdraw',usd:60}]}};
 const p=perf(d,'all',now);assert.equal(p.delta,10);assert.ok(Math.abs(p.percent-10)<1e-10);assert.deepEqual(Array.from(p.points,x=>x.adjusted),[100,105,110]);
});
test('graph excludes invalid future observations and refuses performance across missing data',()=>{
 const d={curve:[{t:t-3600000,usd:90},{t,usd:100},{t:now,usd:101},{t:now+1000,usd:999},{t:now-1,usd:null}]};
 const p=perf(d,'all',now);assert.equal(p.points.length,3);assert.equal(p.continuous,false);assert.equal(p.delta,null);
});
test('range retains preceding baseline, sorts and deduplicates without importing older transfers',()=>{
 const d={curve:[{t:now,usd:105},{t,usd:100},{t,usd:100}],funding:{events:[{at:t-1,type:'deposit',usd:100}]}};
 const p=perf(d,'24h',now);assert.equal(p.points.length,2);assert.equal(p.delta,5);
});
test('compressed hourly history remains readable while longer outages remain gaps',()=>{
 const old=now-2*86400000;
 assert.equal(perf({curve:[{t:old,usd:100},{t:old+3600000,usd:102}]},'all',now).delta,2);
 assert.equal(perf({curve:[{t:old,usd:100},{t:old+3*3600000,usd:102}]},'all',now).delta,null);
});
