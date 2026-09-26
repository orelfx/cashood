const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../assets/core.js');
const cfg=()=>({owners:[{id:'a',name:'Same'},{id:'b',name:'Same'}],events:[{id:'initial',date:'2026-09-01',type:'deposit',owner:'a',usd:1000,founding:true}],costs:{items:[{usd:25}]},dividend:{basis:'nav',distributePct:100,reinvestPct:0,investorFeePct:0}});
test('explicit simultaneous deposits preserve a single share price',()=>{const c=cfg();c.events.push(...['x','y'].map(id=>({id,date:'2026-09-02',batchId:'same',owner:'b',type:'deposit',usd:100,navBefore:1100})));assert.equal(C.buildLedger(c).owners[1].units,200/1.1);});
test('separate same-date same-NAV transactions are not merged',()=>{const c=cfg();c.events.push(...['x','y'].map(id=>({id,date:'2026-09-02',owner:'b',type:'deposit',usd:100,navBefore:1000})));assert.equal(C.buildLedger(c).owners[1].units,210);});
test('reject malformed events, duplicate IDs, missing NAV, excessive withdrawal',()=>{
 for(const patch of [{type:'typo'},{type:'withdraw',usd:2000,navBefore:1000},{type:'deposit',usd:1},{type:'deposit',usd:'Infinity',navBefore:1000},{id:'initial',type:'deposit',usd:1,navBefore:1000}]){const c=cfg();c.events.push({id:'second',date:'2026-09-02',owner:'a',usd:100,...patch});assert.throws(()=>C.buildLedger(c));}
});
test('reinvestment changes basis without fabricating incoming cash or shares',()=>{const c=cfg();c.events.push({id:'reinvest',date:'2026-09-02',owner:'a',type:'reinvest',usd:100});const l=C.buildLedger(c);assert.equal(l.deposited,1000);assert.equal(l.capitalBasis,1100);assert.equal(l.totalUnits,1000);});
test('known Reborn holdings remain unchanged by explicit batch migration',()=>{const c=JSON.parse(fs.readFileSync('data/reborn/config.json'));assert.ok(Math.abs(C.buildLedger(c).totalUnits-12672.170636060566)<1e-8);});
test('historical cutoffs exclude subsequent transactions',()=>{const c=cfg();c.events.push({id:'later',date:'2026-10-02',owner:'b',type:'deposit',usd:100,navBefore:1000});assert.equal(C.buildLedger(c,{before:C.eventTime({date:'2026-10-01'})}).owners[1].units,0);});
test('allocations preserve every cent including equal display names',()=>{assert.deepEqual(C.allocate(100,[{id:'a',share:1},{id:'b',share:1},{id:'c',share:1}]),{a:33.34,b:33.33,c:33.33});assert.throws(()=>C.allocate(1,[{id:'a',share:1},{id:'a',share:1}]));});
test('dividend allocation retains exited holders and distinct same-name investors',()=>{
 const c=cfg(),old=C.buildLedger(c);const newer={owners:[{id:'b',name:'Same',units:1000}],totalUnits:1000};
 const result=C.allocateDividend(c,[{key:'old',grossUsd:100,ledger:old},{key:'new',grossUsd:100,ledger:newer}],0);
 assert.equal(result.rows.length,2);assert.equal(result.rows.reduce((s,r)=>s+r.netUsd,0),200);
});
test('missing cost is not zero; explicit shared zero is honored',()=>{const c=cfg();assert.equal(C.monthlyCosts(c,{costsShareUsd:null}),25);assert.equal(C.monthlyCosts(c,{costsShareUsd:0}),0);});
test('Reborn dashboard and invoices distribute actual cash, preserving legacy rights',()=>{const c=JSON.parse(fs.readFileSync('data/reborn/config.json'));const r=C.distribution(c,{totalUsd:13567.73,treasuryUsd:1100,updatedAt:Date.parse('2026-09-26T00:00:00Z')});assert.equal(r.plan.received,850);assert.equal(r.rows.some(o=>o.id==='sinakal'),false);assert.equal(r.rows.reduce((s,r)=>s+r.netUsd,0),850);});
test('snapshot must distinguish null, false timestamps, mismatch, stale and incomplete',()=>{const s={schemaVersion:2,totalUsd:10,updatedAt:Date.now(),holdings:[{usd:10}],positions:[],quality:{complete:true}};assert.equal(C.validateSnapshot(s),s);for(const bad of [{totalUsd:null},{updatedAt:null},{totalUsd:20},{quality:{complete:false}},{updatedAt:1}])assert.throws(()=>C.validateSnapshot({...s,...bad},{complete:true,maxAge:1800000}));});
