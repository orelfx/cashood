const test=require('node:test'),assert=require('node:assert/strict'),Core=require('../assets/core.js');
const cfg=require('../data/meridian/config.json');
test('Meridian November 10 transfers affect only Orel units and preserve other investors at each cash flow',()=>{
 const rows=cfg.events.filter(e=>e.id.startsWith('meridian-orel-')&&e.date==='2026-11-10');
 assert.equal(rows.length,2);assert.deepEqual(rows.map(e=>[e.type,e.usd]),[['withdraw',1721.6],['deposit',1281.88]]);
 for(const e of rows){
  const before=Core.buildLedger(cfg,{before:e.at}),after=Core.buildLedger(cfg,{before:e.at+1});
  const newNav=e.navBefore+(e.type==='deposit'?e.usd:-e.usd);
  for(const owner of before.owners){
   const post=after.owners.find(o=>o.id===owner.id);
   const expected=owner.units/before.totalUnits*e.navBefore+(owner.id==='orel'?(e.type==='deposit'?e.usd:-e.usd):0);
   assert.ok(Math.abs(post.units/after.totalUnits*newNav-expected)<0.00001);
   if(owner.id!=='orel')assert.equal(post.units,owner.units);
  }
 }
});
test('Reborn transfer to Elysium withdraws exactly $100 from Orel without charging other owners',()=>{
 const c=require('../data/reborn/config.json');const e=c.events.find(e=>e.id==='reborn-orel-transfer-elysium-100-20261110');assert.equal(e.usd,100);assert.equal(e.owner,'orel');
 const before=Core.buildLedger(c,{before:e.at}),after=Core.buildLedger(c,{before:e.at+1});
 for(const o of before.owners){const p=after.owners.find(x=>x.id===o.id);const prior=o.units/before.totalUnits*e.navBefore,next=p.units/after.totalUnits*(e.navBefore-e.usd);assert.ok(Math.abs(next-prior+(o.id==='orel'?100:0))<0.00001);if(o.id!=='orel')assert.equal(p.units,o.units);}
});
