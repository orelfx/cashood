const test=require('node:test'),assert=require('node:assert/strict'),Core=require('../assets/core.js');
const part=(id,usd,extra={})=>({id,name:id,color:'#fff',usd,...extra});
test('attributes the entire fall from 20500 to 18500 to its funds',()=>{
 const result=Core.compareGrowth({v:20500,parts:[part('reborn',10000),part('meridian',7400),part('other',3100)]},{v:18500,parts:[part('reborn',9600),part('meridian',6000),part('other',2900)]});
 assert.equal(result.delta,-2000);assert.equal(result.rows.reduce((s,r)=>s+r.delta,0),-2000);
 assert.equal(result.rows[0].pct,-4);assert.ok(Math.abs(result.pct+9.75609756)<1e-6);
});
test('cash-flow-adjusted values do not count a 500 deposit as gain',()=>{
 const r=Core.compareGrowth({v:600,parts:[part('a',600)]},{v:620,parts:[part('a',620)]});
 assert.equal(r.delta,20);assert.equal(r.rows[0].delta,20);
});
test('zero balances remain losses; missing history and fixed placeholders are not false zero changes',()=>{
 const r=Core.compareGrowth({v:300,parts:[part('gone',100),part('new',0,{known:false}),part('box',200,{fixed:true})]},{v:250,parts:[part('gone',0),part('new',50),part('box',200,{fixed:true})]});
 assert.equal(r.rows[0].delta,-100);assert.equal(r.rows[0].pct,-100);
 assert.equal(r.rows[1].delta,null);assert.equal(r.rows[2].delta,null);assert.equal(r.incomplete,true);assert.equal(r.delta,null);assert.equal(r.pct,null);
 const fresh=Core.compareGrowth({v:0,parts:[part('a',0)]},{v:5,parts:[part('a',5)]});assert.equal(fresh.rows[0].pct,null);
});
