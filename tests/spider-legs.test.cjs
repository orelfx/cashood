const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('assets/spider.js','utf8');
const geometry=JSON.parse(source.match(/const legGeometry = (\[.*\]);/)[1]);
const solver=source.slice(source.indexOf('  function solveLeg('),source.indexOf('  function drawLeg('));
const solve=vm.runInNewContext(solver+';solveLeg');
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
test('spider joints keep segment lengths through turns, lifts and unreachable steps',()=>{
 for(const g of geometry)for(let angle=-Math.PI;angle<Math.PI;angle+=Math.PI/12)for(const reach of [0,10,50,120,300])for(const lift of [0,.2,1]){
  const toe=[g[0][0]+Math.cos(angle)*reach,g[0][1]+Math.sin(angle)*reach];
  const points=solve(g,toe,lift);
  for(const p of points)assert.ok(p.every(Number.isFinite));
  for(let i=1;i<4;i++)assert.ok(Math.abs(distance(points[i-1],points[i])-distance(g[i-1],g[i]))<1e-6,'leg segment stretched');
  const axis=Math.atan2(g[3][1]-g[0][1],g[3][0]-g[0][0]);
  const actual=Math.atan2(points[3][1]-g[0][1],points[3][0]-g[0][0]);
  assert.ok(Math.abs(Math.atan2(Math.sin(actual-axis),Math.cos(actual-axis)))<=Math.PI/3+1e-8,'foot crossed body');
 }
});
test('rest pose preserves the reference design and idle keeps toes planted',()=>{
 for(const g of geometry){
  const rest=solve(g,g[3]);
  for(let i=0;i<4;i++)assert.ok(distance(rest[i],g[i])<.01,'reference joint moved');
  for(const lift of [.01,.1,.21])assert.ok(distance(solve(g,g[3],lift)[3],g[3])<.01,'idle toe slid');
 }
});
