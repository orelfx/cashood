/* Deterministic Chromium integration tests. All requests are intercepted locally. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashood-browser-'));
 const executable=process.env.CHROME||['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'].find(fs.existsSync);
 if(!executable)throw Error('Set CHROME to a Chromium executable');
 const chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
 let ws;
 try{
 const address=await new Promise((resolve,reject)=>{let text='';chrome.stderr.on('data',d=>{text+=d;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});chrome.on('exit',c=>reject(Error('Chrome exited '+c)));setTimeout(()=>reject(Error('Chrome startup timeout: '+text.slice(-2000))),30000).unref();});
 ws=new WebSocket(address);await new Promise(r=>ws.onopen=r);let n=0,sid;const pending=new Map(),errors=[],counts={};let delayReborn=false,fxDelay=0,fullForecast=false;const snapshotResponses=new Map();
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
      if(kind==='live'){
       body=JSON.stringify(fund==='safebox'?safe:snapshots[fund]);
       // Simulate a CDN retaining the response for the same request URL.
       if(fund==='meridian'){
         if(snapshotResponses.has(p.request.url))body=snapshotResponses.get(p.request.url);
         else snapshotResponses.set(p.request.url,body);
       }
      }
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
 await cmd('Page.navigate',{url:'https://cashood.test/#reborn/portfolio'});
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(await ev('Boolean(globalThis.cashood?.state.nav)'))break;}
 assert.equal(await ev('state.nav.totalUsd'),14000);{const cells=await ev('document.querySelectorAll("#ownerTable tbody td").length');
 // Baris tabel harus tetap berupa sel. Pembersih HTML tanpa konteks tabel
 // pernah membuang <tr>/<td> dan seluruh tabel situs jadi tumpukan teks.
 assert.ok(cells>=4,`tabel pemilik kehilangan selnya: ${cells}`);}
console.log('PASS initial render');
 const before=counts['/orelfx/cashood/data/reborn/nav.json'];await ev('load({force:true})');await new Promise(r=>setTimeout(r,100));assert.ok(counts['/orelfx/cashood/data/reborn/nav.json']>before);console.log('PASS refresh requests new NAV');
 await cmd('Page.setBypassCSP',{enabled:true});
 assert.equal(await ev(`(async()=>{globalThis.__audit=0;renderHoldings({holdings:[{symbol:'<img src=x onerror="globalThis.__audit=1">',amount:1,price:1,usd:1}]});await new Promise(r=>setTimeout(r,100));return globalThis.__audit})()`),0);
 assert.equal(await ev(`(async()=>{setHTML(document.querySelector('#holdHint'),'<svg><a href="javascript:globalThis.__audit=2"><text>x</text></a><foreignObject><img src=x onerror="globalThis.__audit=3"></foreignObject></svg>');await new Promise(r=>setTimeout(r,100));return globalThis.__audit})()`),0);console.log('PASS malicious HTML and SVG cannot execute');
 assert.equal(await ev(`(async()=>{showSafebox();await new Promise(r=>setTimeout(r,50));document.querySelector('[data-fund="reborn"]').click();return state.view})()`),'fund');console.log('PASS return from Safe Box to same fund');
 const portfolio=await ev(`(async()=>{await renderPortofolio();return document.querySelector('#portoList').textContent})()`);assert.match(portfolio,/Stefani/);assert.match(portfolio,/Si Nakal/);console.log('PASS actual Safe Box owners');
 {const home=await ev(`(async()=>{showHome();await renderHome();const aum=document.querySelector('#homeAum').textContent;const cards=document.querySelectorAll('#homeProducts .prod').length;const menu=document.querySelectorAll('#homeMenu .menu-tile').length;const visible=!document.querySelector('#tab-home').hidden&&document.querySelector('#tab-portfolio').hidden;return {aum,cards,menu,visible}})()`);
 assert.ok(home.visible,'beranda tidak tampil sendiri');assert.match(home.aum,/Total aset dikelola/);assert.match(home.aum,/\$\s?2[0-9],[0-9]{3}/);assert.ok(home.cards>=4,`kartu produk: ${home.cards}`);assert.equal(home.menu,8);
 {const k=await ev(`(async()=>{showKinerja();await renderKinerja();showPemegang();await renderPemegang();return {kin:document.querySelectorAll('#kinerjaBody .kin').length,inv:document.querySelector('#pemegangBody').textContent}})()`);assert.ok(k.kin>=3,'kartu analys: '+k.kin);assert.match(k.inv,/Stefani/);console.log('PASS global analys and investors');}
 assert.equal(await ev(`(async()=>{document.querySelector('[data-fund="reborn"]').click();await new Promise(r=>setTimeout(r,50));return !document.querySelector('#tab-home').hidden})()`),false);console.log('PASS homepage');}
 await ev('(async()=>{showHome();await renderHome()})()');
 snapshots.meridian.totalUsd=5500;snapshots.meridian.holdings[0].usd=5500;
 const refreshedHome=await ev(`(async()=>{await load({force:true});await renderHome();const row=[...document.querySelectorAll('#homeAum .alloc-legend li')].find(r=>r.textContent.includes('Meridian'));return {total:(await loadFundBrief('meridian')).totalUsd,text:row.textContent}})()`);
 assert.equal(refreshedHome.total,5500,'home refresh must update a fund other than the selected background fund');
 assert.match(refreshedHome.text,/5,500/);console.log('PASS home refresh replaces cached non-selected fund value');
 snapshots.meridian.totalUsd=5000;snapshots.meridian.holdings[0].usd=5000;
 await ev(`(async()=>{await load({force:true});await renderHome();document.querySelector('[data-fund="reborn"]').click()})()`);
 delayReborn=true;
 const raced=await ev(`(async()=>{const a=load({force:true});await new Promise(r=>setTimeout(r,40));const b=switchFund('meridian');await Promise.all([a,b]);return {fund:state.fund,nav:state.nav.totalUsd,native:state.nav.nativeSymbol,cache:JSON.parse(localStorage.getItem(cacheKey('meridian'))).totalUsd}})()`);
 assert.deepEqual(raced,{fund:'meridian',nav:5000,native:'SOL',cache:5000});console.log('PASS delayed Reborn cannot overwrite Meridian');
 delayReborn=false;fxDelay=2000;const elapsed=await ev('(async()=>{const t=performance.now();await load({force:true});return performance.now()-t})()');assert.ok(elapsed<1800,`load waited ${elapsed}ms`);console.log('PASS NAV does not wait for FX');
 await ev('showTab("analys")');await new Promise(r=>setTimeout(r,100));assert.match(await ev('document.querySelector("#anForecast").textContent'),/belum cukup|Belum cukup/);
 fullForecast=true;await ev('delete forecastCache.meridian;showTab("analys")');await new Promise(r=>setTimeout(r,100));{const t=await ev('document.querySelector("#anForecast").textContent');
 // Tata letak yang disetujui pemilik: peluang dulu, dividen terkumpul, dan
 // tidak ada peluang yang ditulis "0%" (aturan 2026-09-19: paling kecil 0,001%).
 assert.match(t,/Worst Case/);assert.match(t,/Peluang dana turun 10% bulan ini/);
 assert.match(t,/Dividen yang terkumpul/);assert.doesNotMatch(t,/(^|[^0-9,.<])0(\.0+)?%/);}
console.log('PASS complete forecast render');
 await ev('showTab("investor");renderAll()');assert.ok(await ev('document.querySelector("#divFlow").textContent.includes("Diterima")'));console.log('PASS dividend and insufficient-data views');
 const chartSummary=await ev(`(async()=>{showHome();await renderHome();homeView.hours=24;const now=Date.now();
  const b={id:'cash-flow-fixture',label:'Fixture',accent:'#14f195',totalUsd:620,flows:[{at:now-7200000,usd:500}],cfg:{fund:{cashFlowsRecorded:false}},history:[]};
  seriesCache.set(b.id,{at:now,points:[{t:now-25*3600000,usd:100},{t:now-3600000,usd:620}]});
  await renderGrowth({briefs:[b],box:null,total:620},[]);
  return {card:document.querySelector('#aumChg').textContent,chart:document.querySelector('#hgSum').textContent,rows:document.querySelector('#hgCompareRows').textContent};})()`);
 assert.match(chartSummary.card,/\+\$20/);assert.match(chartSummary.chart,/\+\$20/);assert.match(chartSummary.rows,/\+\$20/);
 console.log('PASS chart and 24-hour summary agree; recorded deposits are not gains');
 // Use known points to test attribution, arbitrary comparison points and units.
 await ev(`(async()=>{showHome();await renderHome();++growthEpoch;homeView.referenceAt=null;homeView.selectedAt=null;
   lastUsdIdr=16000;coinPrice.eth=2500;coinPrice.sol=100;
   const t=Date.now()-3600000;globalThis.__growthFixture=[
    {t,v:20500,parts:[{id:'r',name:'Reborn',usd:10000},{id:'m',name:'Meridian',usd:7400},{id:'o',name:'Other',usd:3100}]},
    {t:t+1800000,v:18500,parts:[{id:'r',name:'Reborn',usd:9600},{id:'m',name:'Meridian',usd:6000},{id:'o',name:'Other',usd:2900}]},
    {t:t+3600000,v:19000,parts:[{id:'r',name:'Reborn',usd:9800},{id:'m',name:'Meridian',usd:6300},{id:'o',name:'Other',usd:2900}]}];
   globalThis.__point=(fraction)=>{const box=document.querySelector('#hgWrap').getBoundingClientRect();document.querySelector('#hgHit').dispatchEvent(new PointerEvent('pointermove',{clientX:box.left+box.width*fraction,pointerType:'mouse'}))};
   currency='usd';drawGrowth(document.querySelector('#hgChart'),__growthFixture,false);__point(.46);
 })()`);
 let comparison=await ev('({text:document.querySelector("#hgCompareRows").textContent,total:document.querySelector("#hgCompareTotal").textContent,tip:document.querySelector("#hgTip").textContent})');
 assert.match(comparison.total,/-\$2,000/);assert.match(comparison.total,/-9\.76%/);assert.match(comparison.text,/-18\.92%/);assert.match(comparison.tip,/-\$1,400/);
 await ev('document.querySelector("#hgSetReference").click();__point(.9)');
 assert.match(await ev('document.querySelector("#hgCompareTotal").textContent'),/\+\$500/);
 for(const c of ['idr','eth','sol','usd']){
  await ev(`(async()=>{document.querySelector('[data-c="${c}"]').click();await renderHome();++growthEpoch;drawGrowth(document.querySelector('#hgChart'),__growthFixture,false);__point(.9)})()`);
  const actual=await ev('document.querySelector("#hgCompareTotal").textContent');
  assert.match(actual,/2\.70%/);assert.doesNotMatch(actual,/NaN|Infinity/);
  if(c==='idr'){assert.match(actual,/Rp/);assert.doesNotMatch(actual,/\$/);}
  if(c==='usd')assert.match(actual,/\+\$500/);
  if(c==='eth')assert.match(actual,/0\.200/);
  if(c==='sol')assert.match(actual,/5\.000/);
 }
 await ev('document.querySelector("#hgResetReference").click()');
 assert.match(await ev('document.querySelector("#hgCompareTotal").textContent'),/-\$1,500/);
 console.log('PASS per-fund chart deltas, reference selection and USD/IDR/ETH/SOL switching');
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});const width=await ev('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.equal(width.scroll,width.width);console.log('PASS mobile layout');
 await ev(`drawGrowth(document.querySelector('#hgChart'),__growthFixture,false);const bounds=document.querySelector('#hgWrap').getBoundingClientRect();document.querySelector('#hgHit').dispatchEvent(new PointerEvent('pointerdown',{clientX:bounds.left+bounds.width*.46,pointerType:'touch'}));document.querySelector('#homeGrowth').scrollIntoView()`);
 assert.equal(await ev('document.querySelector("#hgTip").classList.contains("dock")'),true);
 assert.equal(await ev('document.documentElement.scrollWidth===innerWidth'),true);
 if(process.env.CASHOOD_SCREENSHOT_DIR){fs.mkdirSync(process.env.CASHOOD_SCREENSHOT_DIR,{recursive:true});const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.CASHOOD_SCREENSHOT_DIR,'growth-mobile.png'),Buffer.from(shot.data,'base64'));}
 console.log('PASS touch chart comparison stays within the mobile viewport');
 await ev(`homeView.referenceAt=null;homeView.selectedAt=null;const missing=structuredClone(__growthFixture);missing[0].parts[0].known=false;drawGrowth(document.querySelector('#hgChart'),missing,false)`);
 assert.match(await ev('document.querySelector("#hgCompareTotal").textContent'),/data pembanding belum lengkap/i);
 console.log('PASS missing history cannot appear as a total gain');
 await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await ev(`location.hash='#home';window.scrollTo(0,0);`);
 await ev('renderHome()');
 await new Promise(r=>setTimeout(r,100));
 assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),false);
 const beforeSpider=await ev('document.querySelector("#homeAum").textContent');
 const beforeAside=await ev('document.querySelector("#cashoodSpider").getBoundingClientRect().x');
 await ev('document.querySelector("#cashoodSpider").click()');
 assert.notEqual(await ev('document.querySelector("#cashoodSpider").getBoundingClientRect().x'),beforeAside);
 assert.match(await ev('document.querySelector(".spider-caption").textContent'),/geser|pindah|ruang/);
 assert.equal(await ev('document.querySelector("#homeAum").textContent'),beforeSpider);
 assert.equal(await ev('document.querySelector("#cashoodSpider").getAnimations().length'),0);
 console.log('PASS spider yields on click without changing financial data; reduced motion respected');
 // Clear the reading pause via navigation before testing automatic source updates.
 await ev("location.hash='#analisa'");await new Promise(r=>setTimeout(r,100));
 await ev("location.hash='#home';window.scrollTo(0,0)");await new Promise(r=>setTimeout(r,100));
 await cmd('Emulation.setEmulatedMedia',{features:[]});
 await new Promise(r=>setTimeout(r,100));
 await ev(`document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:100,currency:'usd',complete:true}}));document.querySelector('#homeAum .aum-v').textContent='$120';document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:120,currency:'usd',complete:true}}));`);
 const legBefore=await ev('document.querySelector(".spider-leg path").getAttribute("d")');
 await new Promise(r=>setTimeout(r,380));
 assert.notEqual(await ev('document.querySelector(".spider-leg path").getAttribute("d")'),legBefore);
 await new Promise(r=>setTimeout(r,2200));
 const legRest=await ev('document.querySelector(".spider-leg circle:last-child").getAttribute("cx")');
 await new Promise(r=>setTimeout(r,150));
 assert.equal(await ev('document.querySelector(".spider-leg circle:last-child").getAttribute("cx")'),legRest);
 assert.equal(await ev('document.querySelector("#cashoodSpider").classList.contains("resting")'),true);
 assert.ok(await ev('document.querySelector(".spider-core").getAnimations().length>0'));
 console.log('PASS walking feet stay planted while idle breathing animates');
 // Force a nearby source-value target and measure planted toes in screen space.
 await ev(`(()=>{const v=document.querySelector('#homeAum .aum-v'),r=document.querySelector('#cashoodSpider').getBoundingClientRect();window.__oldValueStyle=v.style.cssText;v.style.cssText='position:fixed;width:30px;height:40px;left:'+(r.left-68)+'px;top:'+(r.top+50)+'px';v.textContent='$121';document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:121,currency:'usd',complete:true}}));})()`);
 await new Promise(r=>setTimeout(r,250));
 const feet=()=>ev(`(()=>{const spider=document.querySelector('#cashoodSpider');return {mode:spider.dataset.locomotion,x:spider.getBoundingClientRect().x,feet:[...document.querySelectorAll('.spider-leg')].map(g=>{const t=g.querySelector('circle:last-child'),p=new DOMPoint(+t.getAttribute('cx'),+t.getAttribute('cy')).matrixTransform(t.getScreenCTM());return {x:p.x,y:p.y,planted:t.dataset.planted==='true'}})}})()`);
 let plantedVerified=false, plantedBefore=await feet();
 for(let sample=0;sample<8 && !plantedVerified;sample++){
   await new Promise(r=>setTimeout(r,30));const plantedAfter=await feet();
   const pairs=plantedBefore.feet.map((f,i)=>[f,plantedAfter.feet[i]]).filter(([a,b])=>a.planted&&b.planted);
   if(plantedAfter.mode==='walk' && Math.abs(plantedBefore.x-plantedAfter.x)>.1 && pairs.length>=2){
     for(const [a,b] of pairs)assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<.3,'stance foot slid across the page');
     plantedVerified=true;
   }
   plantedBefore=plantedAfter;
 }
 assert.ok(plantedVerified,'walking never produced stationary stance feet');
 await new Promise(r=>setTimeout(r,1100));
 // A long jump must expose its silk line before pulling the body.
 await ev(`(()=>{const v=document.querySelector('#homeAum .aum-v');v.style.left='170px';v.style.top='580px';v.textContent='$122';document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:122,currency:'usd',complete:true}}));})()`);
 await new Promise(r=>setTimeout(r,400));
 assert.equal(await ev('document.querySelector("#cashoodSpider").dataset.locomotion'),'web');
 assert.equal(await ev('document.querySelector("#spiderSilk").hidden'),false);
 assert.notEqual(await ev('getComputedStyle(document.querySelector("#spiderSilk")).display'),'none');
 if(process.env.CASHOOD_SCREENSHOT_DIR){const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.CASHOOD_SCREENSHOT_DIR,'spider-silk.png'),Buffer.from(shot.data,'base64'));}
 await new Promise(r=>setTimeout(r,1900));
 assert.equal(await ev('document.querySelector("#spiderSilk").hidden'),true);
 await ev(`document.querySelector('#homeAum .aum-v').style.cssText=window.__oldValueStyle`);
 console.log('PASS stance feet stay planted and long travel uses visible silk');
 assert.equal(await ev('document.querySelector("#homeAum .aum-v").textContent'),'$122');
 await ev(`document.querySelector('#homeAum .aum-v').textContent='$90';document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:90,currency:'usd',complete:true}}));document.querySelector('#spiderToggle').click()`);
 assert.equal(await ev('document.querySelector("#homeAum .aum-v").textContent'),'$90');
 assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),true);
 assert.equal(await ev('localStorage.getItem("cashood-spider")'),'off');
 await ev('document.querySelector("#spiderToggle").click()');
 await ev(`document.querySelector('#homeAum .aum-v').textContent='Rp 1.440.000';document.dispatchEvent(new CustomEvent('cashood:home-data',{detail:{total:90,currency:'idr',complete:true}}));`);
 assert.equal(await ev('document.querySelector("#homeAum .aum-v").textContent'),'Rp 1.440.000');
 await ev(`location.hash='#meridian/portfolio'`);await new Promise(r=>setTimeout(r,100));
 assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),false);
 console.log('PASS spider reveals source updates, cancels safely, ignores currency conversions and follows navigation');
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 for (const route of ['#safebox','#meridian/investor']) {
   await ev(`location.hash='${route}'`);await new Promise(r=>setTimeout(r,700));
   assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),false);
   await ev(`document.querySelector('footer').scrollIntoView()`);
   await new Promise(r=>setTimeout(r,100));
   const before=await ev('location.hash');
   await ev(`document.querySelector('#cashoodSpider').click()`);
   assert.equal(await ev('location.hash'),before);
   await ev(`document.querySelector('footer [data-spider-toggle]').click()`);
   assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),true);
   await ev(`document.querySelector('footer [data-spider-toggle]').click()`);
 }
 console.log('PASS spider stays on Safe Box and invoices; global controls work without navigating for the reader');
 await cmd('Emulation.setEmulatedMedia',{features:[]});
 await new Promise(r=>setTimeout(r,100));
 await ev(`location.hash='#home'`);await ev('renderHome()');await ev('window.scrollTo(0,0)');
 await new Promise(r=>setTimeout(r,3000));
 if(process.env.CASHOOD_SCREENSHOT_DIR){const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.CASHOOD_SCREENSHOT_DIR,'spider-desktop.png'),Buffer.from(shot.data,'base64'));}
 await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await new Promise(r=>setTimeout(r,3000));
 assert.equal(await ev('document.documentElement.scrollWidth===innerWidth'),true);
 if(process.env.CASHOOD_SCREENSHOT_DIR){const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.CASHOOD_SCREENSHOT_DIR,'spider-mobile.png'),Buffer.from(shot.data,'base64'));}
 // Remain document-bound while scrolling, then visibly catch up after a pause.
 await ev('window.scrollTo(0,0)');await new Promise(r=>setTimeout(r,300));
 const readSpider=()=>ev(`(()=>{const r=document.querySelector('#cashoodSpider').getBoundingClientRect();return {y:r.y,docY:r.y+scrollY,bottom:r.bottom,height:document.body.offsetHeight}})()`);
 const anchored=await readSpider();
 await ev(`window.scrollTo(0,document.body.scrollHeight-innerHeight)`);await new Promise(r=>setTimeout(r,300));
 const offscreen=await readSpider();
 assert.ok(offscreen.bottom<0,'spider was pinned to the viewport during scroll');
 assert.ok(Math.abs(offscreen.docY-anchored.docY)<.5);
 await new Promise(r=>setTimeout(r,3600));
 const followed=await readSpider();assert.ok(followed.y>100 && followed.y<844,'spider did not catch up at the bottom');
 assert.ok(followed.docY>anchored.docY+500);assert.equal(followed.height,anchored.height);
 const gaze=()=>ev('document.querySelector(".spider-pupils").getAttribute("transform")');
 await ev(`document.dispatchEvent(new PointerEvent('pointermove',{clientX:0,clientY:0,pointerType:'mouse'}))`);await new Promise(r=>setTimeout(r,70));const leftEye=await gaze();
 await ev(`document.dispatchEvent(new PointerEvent('pointerdown',{clientX:innerWidth,clientY:innerHeight,pointerType:'touch'}))`);await new Promise(r=>setTimeout(r,70));
 assert.notEqual(await gaze(),leftEye,'eyes did not react to mouse and touch');
 await ev(`document.querySelector('footer [data-spider-toggle]').click()`);
 const pausedEye=await gaze();await ev(`document.dispatchEvent(new PointerEvent('pointermove',{clientX:0,clientY:0}))`);await new Promise(r=>setTimeout(r,150));assert.equal(await gaze(),pausedEye);
 assert.equal(await ev('document.querySelector("#spiderLayer").hidden'),true);
 await ev(`document.querySelector('footer [data-spider-toggle]').click()`);
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await new Promise(r=>setTimeout(r,150));
 assert.equal(await ev('document.querySelector(".spider-core").getAnimations().length'),0);
 await cmd('Emulation.setEmulatedMedia',{features:[]});
 // New routes receive context-specific scans and reviewed title variations.
 await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await ev("location.hash='#analisa';window.scrollTo(0,0)");
 await new Promise(r=>setTimeout(r,500));
 const portfolioNumbers=await ev('document.querySelector("#portoTotals").textContent');
 let scannedPortfolio=false;
 for(let i=0;i<80;i++){
   await new Promise(r=>setTimeout(r,100));
   if(await ev('!document.querySelector(".spider-scan").hidden && document.querySelector("#cashoodSpider").dataset.scanTarget?.toLowerCase().includes("portofolio")')){scannedPortfolio=true;break;}
 }
 if(!scannedPortfolio)console.log(await ev(`({hash:location.hash,caption:document.querySelector('.spider-caption').textContent,title:document.querySelector('#portoCard h2').textContent,scan:document.querySelector('#cashoodSpider').dataset.scanTarget,loc:document.querySelector('#cashoodSpider').style.transform,headingRect:document.querySelector('#portoCard h2').getBoundingClientRect().toJSON(),page:document.querySelector('main > div[id^="tab-"]:not([hidden])')?.id})`));
 assert.ok(scannedPortfolio,'new route did not scan its heading');
 assert.notEqual(await ev('document.querySelector("#portoCard h2").textContent'),'Ringkasan portofolio');
 assert.equal(await ev('document.querySelector("#portoTotals").textContent'),portfolioNumbers);
 const asideOrigin=await ev('(()=>{const r=document.querySelector("#cashoodSpider").getBoundingClientRect();return [r.x,r.y]})()');
 await ev('document.querySelector("#cashoodSpider").click()');
 assert.equal(await ev('document.querySelector(".spider-scan").hidden'),true);
 assert.match(await ev('document.querySelector(".spider-caption").textContent'),/geser|pindah|ruang/);
 await new Promise(r=>setTimeout(r,3300));
 const asideEnd=await ev('(()=>{const r=document.querySelector("#cashoodSpider").getBoundingClientRect();return [r.x,r.y]})()');
 assert.ok(Math.hypot(asideEnd[0]-asideOrigin[0],asideEnd[1]-asideOrigin[1])>100);
 await new Promise(r=>setTimeout(r,1000));
 assert.equal(await ev('document.querySelector("#cashoodSpider").getBoundingClientRect().x'),asideEnd[0]);
 assert.match(await ev('location.hash'),/^#analisa/);
 await ev("location.hash='#kinerja';window.scrollTo(0,0)");
 await new Promise(r=>setTimeout(r,4500));
 assert.match(await ev('document.querySelector("#tab-kinerja h2").textContent'),/Analisis|Tinjauan/);
 assert.doesNotMatch(await ev('document.querySelector(".spider-caption").textContent'),/geser|pindah dulu/);
 console.log('PASS contextual scans and approved copy on portfolio and analys; click yields and pauses without changing data or route');
 console.log('PASS delayed scroll following, bottom-page roaming, mouse/touch gaze, off switch and reduced motion');
 // Real UI navigation uses replaceState (no hashchange); hover cannot stall exploration.
 await ev(`document.querySelector('[data-fund="reborn"]').click();window.scrollTo(0,0)`);
 await new Promise(r=>setTimeout(r,250));
 await ev(`document.querySelector('#tabs [data-tab="portfolio"]').click()`);await new Promise(r=>setTimeout(r,100));
 assert.equal(await ev('document.querySelector("#tab-portfolio").hidden'),false);
 const fundNumbers=await ev('[...document.querySelectorAll("#tab-portfolio .kpi .big")].map(el=>el.textContent)');
 assert.ok(fundNumbers.every(value=>value.trim()!=='—'),'cached fund was shown without rendering its values');
 await ev('document.querySelector("#cashoodSpider").dispatchEvent(new PointerEvent("pointerenter"))');
 const fundScans=new Set();
 for(let i=0;i<140;i++){
   await new Promise(r=>setTimeout(r,100));
   const target=await ev('document.querySelector("#cashoodSpider").dataset.scanTarget');if(target)fundScans.add(target);
   if(fundScans.size>=2)break;
 }
 assert.ok(fundScans.size>=2,'fund detail did not continue scanning after real navigation and hover');
 assert.deepEqual(await ev('[...document.querySelectorAll("#tab-portfolio .kpi .big")].map(el=>el.textContent)'),fundNumbers);
 await ev(`document.querySelector('#tabs [data-tab="analys"]').click()`);
 let detailScan=false;
 for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,100));if(await ev('!!document.querySelector("#cashoodSpider").dataset.scanTarget')){detailScan=true;break;}}
 assert.ok(detailScan,'fund analys tab never resumed scanning');
 assert.match(await ev('location.hash'),/reborn\/analys/);
 await ev('document.querySelector(".spider-shell").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 assert.match(await ev('document.querySelector(".spider-caption").textContent'),/geser|pindah|ruang/);
 console.log('PASS real fund navigation, continued scanning under hover, fund subtab exploration and body click');
 // Caption must stay below the real sticky header after scroll and resize.
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await ev("location.hash='#home';window.scrollTo(0,0)");await new Promise(r=>setTimeout(r,200));
 for(const width of [1280,390]){
   await cmd('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
   await ev('window.scrollTo(0,50)');await new Promise(r=>setTimeout(r,200));
   const bubble=await ev(`(()=>{const c=document.querySelector('.spider-caption'),r=c.getBoundingClientRect(),h=document.querySelector('header.top').getBoundingClientRect(),s=getComputedStyle(c);return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,header:h.bottom,width:document.documentElement.clientWidth,color:s.color,opacity:s.opacity,font:parseFloat(s.fontSize),visibility:s.visibility}})()`);
   assert.ok(bubble.top>=bubble.header+7 && bubble.bottom<=844-7,'caption obscured by header or viewport');
   assert.ok(bubble.left>=7 && bubble.right<=bubble.width-7,'caption clips horizontally');
   assert.equal(bubble.color,'rgb(255, 255, 255)');assert.equal(bubble.opacity,'1');assert.ok(bubble.font>=12);assert.equal(bubble.visibility,'visible');
   if(process.env.CASHOOD_SCREENSHOT_DIR){const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.CASHOOD_SCREENSHOT_DIR,'caption-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 }
 console.log('PASS white readable captions stay clear of sticky header and viewport on desktop and mobile');
 // An isolated reading area exercises decorative effects without altering source values.
 await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await ev("location.hash='#kinerja';window.scrollTo(0,0)");await new Promise(r=>setTimeout(r,150));
 await ev(`(()=>{const page=document.querySelector('#tab-kinerja');page.replaceChildren();for(const title of ['Ringkasan kinerja','Data investor','Menu']){const h=document.createElement('h2');h.textContent=title;h.style.cssText='width:240px;margin:45px 20px;color:rgb(240,240,240)';page.append(h);}const stat=document.createElement('div');stat.className='stat';for(const [cls,txt] of [['k','Perubahan 24 jam'],['v','-Rp 120.000']]){const span=document.createElement('span');span.className=cls;span.textContent=txt;stat.append(span);}stat.style.marginTop='300px';page.append(stat);})()`);
 await cmd('Emulation.setEmulatedMedia',{features:[]});
 let inkSeen=false,tossSeen=false,codeSeen=false;
 for(let i=0;i<220;i++){
   await new Promise(r=>setTimeout(r,100));
   const effects=await ev(`({ink:[...document.querySelectorAll('#tab-kinerja h2')].some(el=>getComputedStyle(el).color!=='rgb(240, 240, 240)'),toss:!!document.querySelector('.spider-toss'),code:document.querySelector('.spider-code pre')?.textContent})`);
   inkSeen ||= effects.ink;tossSeen ||= effects.toss;
   if(effects.code){assert.match(effects.code,/-Rp 120.000/);codeSeen=true;}
   if(inkSeen && tossSeen && codeSeen)break;
 }
 assert.ok(inkSeen && tossSeen && codeSeen,'missing injected color, thrown word, or real-value code panel');
 await ev('document.querySelector("#cashoodSpider").click()');await new Promise(r=>setTimeout(r,100));
 assert.equal(await ev('document.querySelectorAll(".spider-toss,.spider-code").length'),0);
 assert.equal(await ev('[...document.querySelectorAll("#tab-kinerja h2")].every(el=>getComputedStyle(el).color==="rgb(240, 240, 240)")'),true);
 assert.equal(await ev('document.querySelector("#tab-kinerja .stat .v").textContent'),'-Rp 120.000');
 console.log('PASS temporary text colors, bounded thrown words, truthful currency readout and cleanup on click');
 assert.deepEqual(errors,[]);console.log('PASS no uncaught browser exceptions');
 }finally{
  if(ws)ws.close();try{process.kill(-chrome.pid,'SIGTERM');}catch{}await new Promise(r=>{if(chrome.exitCode!==null)r();else chrome.once('exit',r);});await new Promise(r=>setTimeout(r,500));for(let i=0;i<10;i++){try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});break;}catch(e){if(i===9)throw e;await new Promise(r=>setTimeout(r,200));}}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
