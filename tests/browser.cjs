/* Deterministic Chromium integration tests. All requests are intercepted locally. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashood-browser-'));
 const executable=process.env.CHROME||['/usr/bin/chromium','/usr/bin/google-chrome','/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(fs.existsSync);
 if(!executable)throw Error('Set CHROME to a Chromium executable');
 const chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
 let ws;
 try{
 const address=await new Promise((resolve,reject)=>{let text='';chrome.stderr.on('data',d=>{text+=d;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});chrome.on('exit',c=>reject(Error('Chrome exited '+c)));setTimeout(()=>reject(Error('Chrome startup timeout')),15000).unref();});
 ws=new WebSocket(address);await new Promise(r=>ws.onopen=r);let n=0,sid;const pending=new Map(),errors=[],counts={};let delayReborn=false,fxDelay=0,fullForecast=false;
 const cmd=(method,params={},sessionId=sid)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const snapshots=Object.fromEntries(['reborn','meridian','ferari'].map((fund,i)=>[fund,{fund,schemaVersion:2,generation:'fixture',updatedAt:Date.now(),totalUsd:[14000,5000,3000][i],treasuryUsd:fund==='reborn'?1100:0,
 holdings:[{symbol:i===1?'SOL':'ETH',amount:1,price:[12900,5000,3000][i],usd:[12900,5000,3000][i]}],positions:[],history:[],quality:{complete:true},nativeSymbol:i===1?'SOL':'ETH',nativePrice:i===1?100:2500}]));
 const {forecastFund}=await import('../scripts/lib/forecast.mjs');
 const forecastNow=Date.now(),modelCfg={owners:[{id:'a',name:'A'}],events:[{date:'2026-09-01',owner:'a',type:'deposit',usd:5000,founding:true}],fund:{capacityUsd:5000},costs:{items:[]},dividend:{basis:'nav',distributePct:100,reinvestPct:0}};
 const model=forecastFund('meridian',modelCfg,snapshots.meridian,Array.from({length:10},(_,i)=>({t:forecastNow-(10-i)*86400000,usd:5000,quality:'complete',outflowTotalUsd:0})),{now:forecastNow,paths:20});
 const safe={schemaVersion:2,updatedAt:Date.now(),valueUsd:3006,balanceUsd:3006,principalUsd:3000,interestUsd:6,interestTodayUsd:.2,days:[],owners:[{id:'stefani',name:'Stefani',principalUsd:2000,sharePct:200/3,balanceUsd:2004,interestUsd:4},{id:'sinakal',name:'Si Nakal',principalUsd:1000,sharePct:100/3,balanceUsd:1002,interestUsd:2}],measure:{monthlyPct:1,perDayUsd:1,minMonthlyPct:.1,maxMonthlyPct:3,spanDays:1}};
 ws.onmessage=({data})=>{
  const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
  if(m.method==='Fetch.requestPaused'){
   const p=m.params,u=new URL(p.request.url);counts[u.pathname]=(counts[u.pathname]||0)+1;
   let body='',type='application/json',status=200,delay=0;
   try{
    let file;
    if(u.hostname==='cashood.test')file=u.pathname==='/'?'index.html':u.pathname.slice(1);
    else if(u.hostname==='raw.githubusercontent.com')file='data/'+u.pathname.split('/').slice(4).join('/');
    else if(u.hostname==='api.coingecko.com'){body=JSON.stringify({ethereum:{usd:2500,idr:40000000},solana:{usd:100,idr:1600000}});delay=fxDelay;}
    else body='{}';
    const match=file?.match(/^data\/(reborn|meridian|ferari|safebox)\/(live|nav|forecast|heartbeat)\.json$/);
    if(match){const [,fund,kind]=match;
      if(kind==='live')body=JSON.stringify(fund==='safebox'?safe:snapshots[fund]);
      if(kind==='nav')body=JSON.stringify({generation:'fixture',points:[{t:Date.now()-600000,usd:10000},{t:Date.now(),usd:snapshots[fund].totalUsd}]});
      if(kind==='forecast')body=JSON.stringify(fullForecast?{...model,fund}:{fund,enough:false,samples:0,reason:'Sumber belum terverifikasi'});
      if(kind==='heartbeat')body=JSON.stringify({text:'SYSTEM\nAll good',updatedAt:Date.now()});
    }else if(file){body=fs.readFileSync(path.resolve(file),'utf8');type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/json';}
   }catch{body='{}';status=404;}
   if(delayReborn&&u.pathname.endsWith('/reborn/live.json'))delay=500;
   const reply=()=>cmd('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:'*'}],body:Buffer.from(body).toString('base64')},m.sessionId).catch(()=>{});
   if(delay)setTimeout(reply,delay);else reply();
  }
 };
 const target=await cmd('Target.createTarget',{url:'about:blank'},null);sid=(await cmd('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
 await cmd('Runtime.enable');await cmd('Page.enable');await cmd('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 const ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 await cmd('Page.navigate',{url:'https://cashood.test/'});
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(await ev('Boolean(globalThis.cashood?.state.nav)'))break;}
 assert.equal(await ev('state.nav.totalUsd'),14000);console.log('PASS initial render');
 const before=counts['/orelfx/cashood/data/reborn/nav.json'];await ev('load({force:true})');await new Promise(r=>setTimeout(r,100));assert.ok(counts['/orelfx/cashood/data/reborn/nav.json']>before);console.log('PASS refresh requests new NAV');
 await cmd('Page.setBypassCSP',{enabled:true});
 assert.equal(await ev(`(async()=>{globalThis.__audit=0;renderHoldings({holdings:[{symbol:'<img src=x onerror="globalThis.__audit=1">',amount:1,price:1,usd:1}]});await new Promise(r=>setTimeout(r,100));return globalThis.__audit})()`),0);
 assert.equal(await ev(`(async()=>{setHTML(document.querySelector('#holdHint'),'<svg><a href="javascript:globalThis.__audit=2"><text>x</text></a><foreignObject><img src=x onerror="globalThis.__audit=3"></foreignObject></svg>');await new Promise(r=>setTimeout(r,100));return globalThis.__audit})()`),0);console.log('PASS malicious HTML and SVG cannot execute');
 assert.equal(await ev(`(async()=>{showSafebox();await new Promise(r=>setTimeout(r,50));document.querySelector('[data-fund="reborn"]').click();return state.view})()`),'fund');console.log('PASS return from Safe Box to same fund');
 const portfolio=await ev(`(async()=>{await renderPortofolio();return document.querySelector('#portoList').textContent})()`);assert.match(portfolio,/Stefani/);assert.match(portfolio,/Si Nakal/);console.log('PASS actual Safe Box owners');
 delayReborn=true;
 const raced=await ev(`(async()=>{const a=load({force:true});await new Promise(r=>setTimeout(r,40));const b=switchFund('meridian');await Promise.all([a,b]);return {fund:state.fund,nav:state.nav.totalUsd,native:state.nav.nativeSymbol,cache:JSON.parse(localStorage.getItem(cacheKey('meridian'))).totalUsd}})()`);
 assert.deepEqual(raced,{fund:'meridian',nav:5000,native:'SOL',cache:5000});console.log('PASS delayed Reborn cannot overwrite Meridian');
 delayReborn=false;fxDelay=2000;const elapsed=await ev('(async()=>{const t=performance.now();await load({force:true});return performance.now()-t})()');assert.ok(elapsed<1800,`load waited ${elapsed}ms`);console.log('PASS NAV does not wait for FX');
 await ev('showAnalisa("meridian")');await new Promise(r=>setTimeout(r,100));assert.match(await ev('document.querySelector("#analisaBody").textContent'),/belum cukup|Belum cukup/);
 fullForecast=true;await ev('delete forecastCache.meridian;showAnalisa("meridian")');await new Promise(r=>setTimeout(r,100));assert.match(await ev('document.querySelector("#analisaBody").textContent'),/Frekuensi penurunan/);console.log('PASS complete forecast render');
 await ev('showTab("investor");renderAll()');assert.ok(await ev('document.querySelector("#divFlow").textContent.includes("Diterima")'));console.log('PASS dividend and insufficient-data views');
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});const width=await ev('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.equal(width.scroll,width.width);console.log('PASS mobile layout');
 assert.deepEqual(errors,[]);console.log('PASS no uncaught browser exceptions');
 }finally{
  if(ws)ws.close();try{process.kill(-chrome.pid,'SIGTERM');}catch{}await new Promise(r=>{if(chrome.exitCode!==null)r();else chrome.once('exit',r);});await new Promise(r=>setTimeout(r,500));for(let i=0;i<10;i++){try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});break;}catch(e){if(i===9)throw e;await new Promise(r=>setTimeout(r,200));}}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
