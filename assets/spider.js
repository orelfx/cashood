/* A presentation-only companion. It never fetches, invents or changes balances. */
(() => {
  const layer = document.getElementById('spiderLayer');
  const spider = document.getElementById('cashoodSpider');
  const toggle = document.getElementById('spiderToggle');
  const toggles = document.querySelectorAll('[data-spider-toggle]');
  if (!layer || !spider || !toggle) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true;
  try { enabled = localStorage.getItem('cashood-spider') !== 'off'; } catch {}
  let timer, scrollIdle, motion, reveal, previous, phrase = 0, generation = 0;
  let location = { x: 20, y: 160 };
  let explored = new WeakSet(), quietUntil=0, asideCount=0, scanAnimation=null;
  const copySteps=new WeakMap();
  const headlines = ['Bot yang kerja.', 'Otomasi yang kerja.', 'Sistem yang kerja.'];
  const caption = spider.querySelector('.spider-caption');
  const rig = spider.querySelector('.spider-rig');
  const legs = [...spider.querySelectorAll('.spider-leg')].map(el => ({
    path: el.querySelector('path'), joints: [...el.querySelectorAll('circle')],
  }));
  let gaitFrame = 0, heading = 0, idleTimer=0, gazeFrame=0, attention=null;
  const pupils=spider.querySelector('.spider-pupils');
  const waypoint=document.createElement('span');waypoint.className='spider-waypoint';waypoint.setAttribute('aria-hidden','true');layer.append(waypoint);
  const scan=document.createElement('div');scan.className='spider-scan';scan.hidden=true;scan.setAttribute('aria-hidden','true');
  const sweep=document.createElement('i');scan.append(sweep);layer.append(scan);
  // Reviewed equivalents only. Never rewrite numeric values, names, controls or warnings.
  const copyGroups=[
    ['Ringkasan portofolio','Portofolio dalam ringkasan','Gambaran portofolio'],
    ['Analys seluruh bot','Analisis seluruh bot','Tinjauan kinerja seluruh bot'],
    ['Data investor','Rincian investor','Informasi investor'],
    ['Perkembangan total dana','Perubahan total dana','Pergerakan total dana'],
    ['Dana mana yang naik atau turun?','Lihat kenaikan dan penurunan tiap dana'],
    ['Ringkasan kinerja','Kinerja dalam ringkasan','Gambaran kinerja'],
    ['Riwayat profit','Catatan profit','Perjalanan profit'],
    ['Riwayat posisi ditutup','Catatan posisi yang ditutup'],
    ['Cara kerjanya','Alur kerja sistem'],
    ['Invoice','Laporan invoice'],
    ['Estimasi dividen','Perkiraan dividen'],
    ['Pemilik simpanan','Daftar pemilik simpanan'],
    ['Apa itu Safe Box','Mengenal Safe Box'],
    ['Apa itu Cashood Index','Mengenal Cashood Index'],
    ['Menu','Jelajahi Cashood','Pilihan halaman'],
  ];
  function currentPage(){return document.querySelector('main > div[id^="tab-"]:not([hidden])');}
  function copyAction(el){
    if(!el.matches('h2,h3') || el.children.length || el.closest('a,button'))return;
    const group=copyGroups.find(g=>g.includes(el.textContent.trim()));
    if(!group)return;
    return ()=>{const step=(copySteps.get(el)??group.indexOf(el.textContent.trim()))+1;copySteps.set(el,step);el.textContent=group[step%group.length];};
  }
  function describe(el){
    const text=el.textContent.trim().replace(/\s+/g,' ').slice(0,90);
    if(el.closest('a[href$=".pdf"]'))return 'Laporan PDF tersedia. Kamu bisa membukanya sendiri.';
    const stat=el.closest('.stat');
    if(stat){const label=stat.querySelector('.k')?.textContent.trim(),value=stat.querySelector('.v')?.textContent.trim();if(label&&value)return `${label}: ${value}. Ini nilai yang tampil.`;}
    if(/invoice|dividen/i.test(text))return 'Bagian ini memuat laporan atau pembagian dividen.';
    if(/pembaruan|diperbarui|sumber/i.test(text))return `Info sumber: ${text}`;
    return `Aku sedang membaca “${text}”.`;
  }
  function clearScan(){scanAnimation?.cancel();scanAnimation=null;scan.hidden=true;delete spider.dataset.scanTarget;}
  function scanTarget(target){
    clearScan();if(reduced.matches || !visible(target))return;
    const r=target.getBoundingClientRect();
    Object.assign(scan.style,{left:`${r.left+scrollX-3}px`,top:`${r.top+scrollY-3}px`,width:`${r.width+6}px`,height:`${r.height+6}px`});
    scan.hidden=false;spider.dataset.scanTarget=target.textContent.trim().slice(0,90);
    scanAnimation=sweep.animate([{transform:'translateX(0)'},{transform:`translateX(${r.width+4}px)`}],{duration:1100,easing:'ease-in-out'});
    scanAnimation.onfinish=()=>{scan.hidden=true;scanAnimation=null;};
  }
  const toePositions = [];
  const silk = document.querySelector('#spiderSilk');
  const silkLine = silk.querySelector('line');
  const silkAnchor = silk.querySelector('circle');
  // Joint positions traced from the supplied reference, in body-local coordinates.
  // Legs attach along an elongated body, not to a radial central point.
  const legGeometry = [[[114.1,110.0],[82.7,87.2],[50.3,89.7],[22.5,90.4]],[[112.3,119.1],[85.2,115.9],[68.9,125.9],[47.1,141.3]],[[112.1,125.2],[90.6,146.7],[84.9,175.4],[80.2,200.1]],[[113.7,133.1],[103.0,161.9],[111.6,188.6],[117.5,211.6]],[[126.3,134.0],[158.2,158.7],[194.0,156.9],[225.0,156.2]],[[126.1,122.5],[149.4,123.2],[168.2,113.0],[184.0,104.4]],[[126.3,113.7],[145.1,109.8],[155.8,97.4],[166.2,86.5]],[[125.7,102.6],[132.0,77.2],[125.0,63.0],[116.6,46.5]]];
  const smooth = t => t*t*(3-2*t);
  function drawLeg(index, toe, lift = 0) {
    toePositions[index]=[...toe];
    const geometry = legGeometry[index], original = geometry[3];
    const delta = [toe[0]-original[0],toe[1]-original[1]];
    const points = geometry.map(([x,y],j) => j===3 ? toe : j===0 ? [x,y] :
      [x+delta[0]*(j/3)+(x<120?-1:1)*lift*7,y+delta[1]*(j/3)-lift*5]);
    const {path,joints} = legs[index];
    path.setAttribute('d','M'+points.map(p=>p.map(n=>n.toFixed(1)).join(' ')).join(' L'));
    points.slice(1).forEach((p,j)=>{joints[j].setAttribute('cx',p[0].toFixed(1));joints[j].setAttribute('cy',p[1].toFixed(1));});
  }
  function updateGaze() {
    gazeFrame=0;
    if(!attention || !active() || !onScreen())return;
    const dx=attention.x-location.x-22,dy=attention.y-location.y-22;
    const a=heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a),length=Math.hypot(dx,dy)||1;
    pupils.setAttribute('transform',`translate(${((dx*c+dy*s)/length*1.25).toFixed(2)} ${((-dx*s+dy*c)/length*1.25).toFixed(2)})`);
  }
  function startIdle() {
    if(idleTimer || motion || gaitFrame || !active() || !onScreen() || reduced.matches)return;
    spider.classList.add('resting');updateGaze();
    const tick=()=>{
      idleTimer=0;
      if(motion || gaitFrame || !active() || !onScreen() || reduced.matches){spider.classList.remove('resting');return;}
      const phase=performance.now()/1300;
      // Small joint flexes at 10 Hz; planted toes and document position stay fixed.
      [0,6].forEach((i,j)=>drawLeg(i,legGeometry[i][3],.11+.1*Math.sin(phase+j*Math.PI)));
      idleTimer=setTimeout(tick,100);
    };
    idleTimer=setTimeout(tick,100);
  }
  function stopIdle() {
    clearTimeout(idleTimer);idleTimer=0;cancelAnimationFrame(gazeFrame);gazeFrame=0;
    spider.classList.remove('resting');
  }
  function stopGait() { cancelAnimationFrame(gaitFrame); gaitFrame=0; silk.hidden=true; }
  function travel(next, arrive) {
    const from={...location}, dx=next.x-from.x, dy=next.y-from.y, distance=Math.hypot(dx,dy);
    const ux=distance?dx/distance:0, uy=distance?dy/distance:0;
    const scale=parseFloat(getComputedStyle(spider).getPropertyValue('--spider-span'))/240;
    const web=distance>360, walkDistance=web?Math.min(62,distance):distance;
    const walkStart={x:next.x-ux*walkDistance,y:next.y-uy*walkDistance};
    const shootMs=web?180:0, zipMs=web?650:0, walkAt=shootMs+zipMs;
    const walkMs=Math.max(450,walkDistance/170*1000), settleMs=320, endAt=walkAt+walkMs;
    const steps=Math.max(1,Math.ceil(walkDistance/29));
    const curve=web?0:Math.min(16,walkDistance*.06)*(dx>=0?1:-1);
    const phaseOffsets=[0,.51,.13,.64,.5,.01,.63,.14];
    const started=performance.now();let last=0,feet=null,settleFrom=null;
    const frameMs=innerWidth<=600?1000/30:1000/60;
    const place=(point)=>{location=point;spider.style.transform=`translate(${point.x}px,${point.y}px)`;};
    const world=(point,center,angle=heading)=>{
      const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
      return {x:center.x+22+((point[0]-120)*c-(point[1]-120)*s)*scale,
        y:center.y+22+((point[0]-120)*s+(point[1]-120)*c)*scale};
    };
    const local=point=>{
      const a=heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
      const x=(point.x-location.x-22)/scale,y=(point.y-location.y-22)/scale;
      return [120+x*c+y*s,120-x*s+y*c];
    };
    const face=(direction,dt)=>{
      const change=((direction-heading+540)%360)-180;
      heading+=change*(1-Math.exp(-dt/85));
      rig.setAttribute('transform',`rotate(${heading.toFixed(2)} 120 120)`);
    };
    // Smooth body speed through each step; grounded feet, not stop/start easing,
    // provide the impression of walking. Acceleration is only at path endpoints.
    const pathAt=p=>{
      const advance=p-Math.sin(2*Math.PI*p)*.10;
      const bend=Math.sin(Math.PI*p)*curve;
      return {x:walkStart.x+ux*walkDistance*advance-uy*bend,
        y:walkStart.y+uy*walkDistance*advance+ux*bend};
    };
    motion={cancel:stopGait};
    const tick=now=>{
      if(!motion || !active() || reduced.matches){stopGait();return;}
      if(last && now-last<frameMs-.5){gaitFrame=requestAnimationFrame(tick);return;}
      const dt=last?Math.min(60,now-last):frameMs;last=now;
      const elapsed=now-started;
      if(attention)updateGaze();
      if(web && elapsed<walkAt){
        spider.dataset.locomotion='web';silk.hidden=false;
        const shot=smooth(Math.min(1,elapsed/shootMs));
        const anchor={x:from.x+22+dx*shot,y:from.y+22+dy*shot};
        const p=Math.max(0,Math.min(1,(elapsed-shootMs)/zipMs));
        face(Math.atan2(dy,dx)*180/Math.PI+90,dt);
        place({x:from.x+(walkStart.x-from.x)*smooth(p),y:from.y+(walkStart.y-from.y)*smooth(p)});
        silkLine.setAttribute('x1',location.x+22);silkLine.setAttribute('y1',location.y+22);
        silkLine.setAttribute('x2',anchor.x);silkLine.setAttribute('y2',anchor.y);
        silkAnchor.setAttribute('cx',anchor.x);silkAnchor.setAttribute('cy',anchor.y);
        // Pull legs inward progressively, then open them before touching down.
        const fold=Math.sin(Math.PI*p)*.28;
        legGeometry.forEach((g,i)=>drawLeg(i,[120+(g[3][0]-120)*(1-fold),120+(g[3][1]-120)*(1-fold)],fold));
      }else if(elapsed<endAt){
        silk.hidden=true;spider.dataset.locomotion='walk';
        if(!feet)feet=legGeometry.map((g,i)=>({anchor:world(toePositions[i]||g[3],location),swing:false}));
        const progress=Math.min(1,(elapsed-walkAt)/walkMs), cycle=progress*steps;
        const point=pathAt(progress), ahead=pathAt(Math.min(1,progress+.015));
        face(Math.atan2(ahead.y-point.y,ahead.x-point.x)*180/Math.PI+90,dt);
        // A small lateral sway follows the support legs without scaling the body.
        const sway=Math.sin(cycle*2*Math.PI)*1.2*Math.sin(Math.PI*progress);
        place({x:point.x-uy*sway,y:point.y+ux*sway});
        let lifting=feet.filter(f=>f.swing).length;
        [0,5,2,7,4,1,6,3].forEach(i=>{
          const foot=feet[i];
          const phase=(cycle+phaseOffsets[i])%1, desired=world(legGeometry[i][3],location);
          // Turn steps are selected by reach, not a rigid spin of all eight legs.
          const overextended=Math.hypot(desired.x-foot.anchor.x,desired.y-foot.anchor.y)>34*scale;
          if(!foot.swing && lifting<4 && (phase>=.56 || overextended)){
            lifting++;
            foot.swing=true;foot.liftedAt=elapsed;foot.from={...foot.anchor};
            foot.duration=Math.max(95,Math.min(180,walkMs/steps*.44));
            const future=pathAt(Math.min(1,progress+foot.duration/walkMs+.14/steps));
            foot.to=world(legGeometry[i][3],future,Math.atan2(dy,dx)*180/Math.PI+90);
          }
          let lift=0;
          if(foot.swing){
            const t=Math.min(1,(elapsed-foot.liftedAt)/foot.duration), p=smooth(t);
            lift=Math.sin(t*Math.PI);
            foot.anchor={x:foot.from.x+(foot.to.x-foot.from.x)*p,y:foot.from.y+(foot.to.y-foot.from.y)*p};
            if(t>=1){foot.swing=false;lifting--;}
          }
          drawLeg(i,local(foot.anchor),lift);
          legs[i].joints[2].dataset.planted=String(!foot.swing);
        });
      }else if(elapsed<endAt+settleMs){
        spider.dataset.locomotion='settle';place(next);
        if(!settleFrom)settleFrom=legGeometry.map((g,i)=>toePositions[i]||g[3]);
        const t=(elapsed-endAt)/settleMs;
        legGeometry.forEach((g,i)=>{
          const p=smooth(Math.max(0,Math.min(1,(t-(i%2)*.22)/.78)));
          drawLeg(i,[settleFrom[i][0]+(g[3][0]-settleFrom[i][0])*p,settleFrom[i][1]+(g[3][1]-settleFrom[i][1])*p],Math.sin(p*Math.PI)*.35);
        });
      }else{
        legGeometry.forEach((g,i)=>drawLeg(i,g[3]));spider.dataset.locomotion='idle';arrive();return;
      }
      gaitFrame=requestAnimationFrame(tick);
    };
    gaitFrame=requestAnimationFrame(tick);
  }
  function inspectTarget(target) {
    // A single reaching leg touches the panel; the body never shrinks or spins.
    const r=target.getBoundingClientRect(),scale=parseFloat(getComputedStyle(spider).getPropertyValue('--spider-span'))/240;
    const a=heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
    const dx=(Math.min(r.right,Math.max(r.left,location.x+22))+scrollX-location.x-22)/scale;
    const dy=(r.top+scrollY-location.y-22)/scale;
    const aim=[120+dx*c+dy*s,120-dx*s+dy*c];
    let index=0;legGeometry.forEach((g,i)=>{if(Math.hypot(g[3][0]-aim[0],g[3][1]-aim[1])<Math.hypot(legGeometry[index][3][0]-aim[0],legGeometry[index][3][1]-aim[1]))index=i;});
    const base=legGeometry[index][3], length=Math.hypot(aim[0]-base[0],aim[1]-base[1])||1;
    const reach=Math.min(18,length),started=performance.now();let last=0;
    spider.dataset.locomotion='inspect';
    const tick=now=>{
      if(!active() || reduced.matches){stopGait();return;}
      if(now-last<1000/30){gaitFrame=requestAnimationFrame(tick);return;}last=now;
      const t=Math.min(1,(now-started)/420),p=Math.sin(t*Math.PI);
      drawLeg(index,[base[0]+(aim[0]-base[0])/length*reach*p,base[1]+(aim[1]-base[1])/length*reach*p],p*.4);
      if(t<1)gaitFrame=requestAnimationFrame(tick);else {gaitFrame=0;spider.dataset.locomotion='idle';startIdle();}
    };
    gaitFrame=requestAnimationFrame(tick);
  }
  function bounds() {
    const radius = parseFloat(getComputedStyle(spider).getPropertyValue('--spider-span'))/2;
    return { minX: radius-14, maxX: innerWidth-radius-30, minY: radius+94, maxY: document.body.offsetHeight-radius-30 };
  }

  const visible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > 115 && r.bottom < innerHeight - 8;
  };
  const active = () => enabled && !document.hidden;
  const onScreen=()=>location.y+44-scrollY>115 && location.y-scrollY<innerHeight && location.x+44>scrollX && location.x<scrollX+innerWidth;
  function cancel() {
    generation++; clearScan(); stopIdle(); stopGait();
    clearTimeout(timer); clearTimeout(scrollIdle);
    reveal?.(); reveal = null;
    if (motion) { motion.cancel(); motion=null; }
    spider.dataset.locomotion='idle';
    spider.classList.remove('walking','yielding');
  }
  function schedule() {
    startIdle();clearTimeout(timer);
    if (active() && onScreen() && !reduced.matches) timer = setTimeout(tour, Math.max(2300,quietUntil-performance.now()));
  }
  function visit(target, message, action, following=false) {
    if (!active() || (!onScreen() && !following) || !visible(target)) { schedule(); return; }
    cancel();
    const token = generation;
    const r = target.getBoundingClientRect(), b = bounds();
    const next = {
      x: Math.max(b.minX, Math.min(b.maxX, r.right + scrollX - 22)),
      y: Math.max(b.minY, Math.min(b.maxY, r.top + scrollY - 50)),
    };
    caption.textContent = message;
    spider.classList.toggle('caption-left', next.x > innerWidth / 2);
    const arrive = () => {
      if (token !== generation || !active()) return;
      stopGait(); motion = null; location = next;
      spider.style.transform = `translate(${next.x}px,${next.y}px)`;
      spider.classList.remove('walking');
      if (target.isConnected && visible(target)) {
        action?.();
        scanTarget(target);
        if (!reduced.matches) {
          target.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.65)', textShadow: '0 0 16px #2dd4bf' }, { filter: 'brightness(1)' }], { duration: 850 });
          inspectTarget(target);
          spider.querySelector('.spider-heart').animate([{opacity:1},{opacity:.35},{opacity:1}],{duration:450});
        }
      }
      schedule();
    };
    if (reduced.matches) { arrive(); return; }
    spider.classList.add('walking');
    travel(next,arrive);
  }
  function tour(following=false) {
    if (!active() || (!onScreen() && following!==true)) return;
    if(performance.now()<quietUntil){schedule();return;}
    const targets = [
      [document.getElementById('spiderHeadline'), 'Ganti sudut pandang.', () => {
        const title = document.getElementById('spiderHeadline');
        title.textContent = headlines[++phrase % headlines.length];
        caption.textContent = 'Kalimat baru. Makna tetap.';
      }],
      [document.querySelector('#homeAum .aum-v'), 'Total aset dari data yang tampil.'],
      [document.querySelector('#homeAum .aum-foot'), 'Waktu pembaruan ada di sini.'],
      [document.querySelector('#homeStats .hs-v'), 'Rincian portofolio.'],
      [document.querySelector('#homeGrowth h2'), 'Telusuri perubahan tiap dana.'],
      [document.querySelector('#hgCompareTotal'), 'Bandingkan dua titik waktu.'],
    ].filter(([el]) => visible(el));
    // Read only the current page, at most once per visit. No polling/fetching or
    // broad DOM observer: invoice tables can contain thousands of rows.
    const page = currentPage();
    if (page) {
      const candidates = page.querySelectorAll('h2,h3,.aum-v,.hs-v,.prod-name,.menu-tile b,a[href$=".pdf"],.sub-h,.stat .k,.stat .v,.stat .n,.card-head .hint,.hb-head p,.prod-desc');
      const seen = new Set(targets.map(([el]) => el));
      for (const el of Array.from(candidates).slice(0, 200)) {
        if (!seen.has(el) && visible(el)) {
          targets.push([el, describe(el), ()=>{copyAction(el)?.();caption.textContent=describe(el);}]);
          seen.add(el);
        }
      }
    }
    const footer = document.querySelector('footer [data-spider-toggle]');
    if (visible(footer)) targets.push([footer, 'Animasi bisa dimatikan di sini.']);
    if (!targets.length) {
      if(following===true){
        waypoint.style.left=`${Math.max(100,innerWidth-130)}px`;
        waypoint.style.top=`${scrollY+Math.max(200,innerHeight*.6)}px`;
        visit(waypoint,'Menjelajah halaman.',undefined,true);
      }else schedule();
      return;
    }
    for(const item of targets){if(!item[2])item[2]=copyAction(item[0]);}
    let fresh=targets.filter(([el])=>!explored.has(el));
    if(!fresh.length){explored=new WeakSet();fresh=targets;}
    const distanceTo=([el])=>{const r=el.getBoundingClientRect();return Math.hypot(r.right+scrollX-22-location.x,r.top+scrollY-50-location.y);};
    fresh.sort((a,b)=>distanceTo(a)-distanceTo(b));
    const chosen=fresh[0];explored.add(chosen[0]);visit(chosen[0],chosen[1],chosen[2],following===true);
  }
  function moveAside(){
    if(!active())return;
    cancel();quietUntil=performance.now()+9000;
    const b=bounds(),origin={...location};
    const top=Math.max(b.minY,scrollY+175),bottom=Math.max(top,Math.min(b.maxY,scrollY+innerHeight-125));
    const obstacles=[];
    for(const el of Array.from(currentPage()?.querySelectorAll('h2,h3,p,a,button,.stat,.prod-name,td,th,.hint')||[]).slice(0,300)){
      const r=el.getBoundingClientRect();if(r.width&&r.height&&r.bottom>115&&r.top<innerHeight)obstacles.push(r);
    }
    const points=[];
    for(let row=0;row<5;row++)for(let col=0;col<5;col++){
      const x=b.minX+(b.maxX-b.minX)*col/4,y=top+(bottom-top)*row/4;
      const distance=Math.hypot(x-origin.x,y-origin.y);if(distance<130)continue;
      let overlap=0;
      for(const r of obstacles)overlap+=Math.max(0,Math.min(x+66,r.right)-Math.max(x-22,r.left))*Math.max(0,Math.min(y-scrollY+66,r.bottom)-Math.max(y-scrollY-22,r.top));
      points.push({x,y,score:overlap-distance*.08});
    }
    points.sort((a,b)=>a.score-b.score);
    const next=points[0]||{x:origin.x<b.maxX/2?b.maxX:b.minX,y:bottom};
    caption.textContent=['Oke, aku geser. Silakan dibaca.','Permisi, aku pindah dulu ya.','Siap, aku beri ruang buat kamu.'][asideCount++%3];
    spider.classList.toggle('caption-left',next.x>innerWidth/2);spider.classList.add('yielding');
    const token=generation;
    const arrive=()=>{if(token!==generation)return;stopGait();motion=null;location={x:next.x,y:next.y};spider.style.transform=`translate(${next.x}px,${next.y}px)`;spider.classList.remove('walking');schedule();};
    if(reduced.matches)arrive();else{spider.classList.add('walking');travel(next,arrive);}
  }
  function followReader() {
    if(!active() || reduced.matches)return;
    if(onScreen()){schedule();return;}
    const b=bounds();
    // Skip only the invisible part of a long journey, then enter with visible silk.
    // Coordinates remain in the document: nothing is pinned to the screen.
    if(location.y<scrollY-160)location.y=Math.max(b.minY,scrollY-140);
    else if(location.y>scrollY+innerHeight+160)location.y=Math.min(b.maxY,scrollY+innerHeight+140);
    location.x=Math.max(b.minX,Math.min(location.x,b.maxX));
    spider.style.transform=`translate(${location.x}px,${location.y}px)`;
    tour(true);
  }
  function sync() {
    cancel();
    layer.hidden = !active();
    for (const button of toggles) {
      button.textContent = enabled ? 'Spider aktif' : 'Spider nonaktif';
      button.setAttribute('aria-pressed', String(enabled));
    }
    if (active()) {
      const b = bounds();
      location.x = Math.max(b.minX, Math.min(location.x, b.maxX));
      location.y = Math.max(b.minY, Math.min(location.y, b.maxY));
      spider.style.transform = `translate(${location.x}px,${location.y}px)`;
      startIdle();
      if (!reduced.matches) timer = setTimeout(()=>onScreen()?tour():followReader(),1200);
    }
  }
  for (const button of toggles) button.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('cashood-spider', enabled ? 'on' : 'off'); } catch {}
    sync();
  });
  spider.addEventListener('click',moveAside);
  spider.addEventListener('pointerenter', () => { if(motion && spider.classList.contains('yielding'))return;cancel();startIdle(); });
  spider.addEventListener('pointerleave', schedule);
  document.addEventListener('cashood:home-data', ({ detail }) => {
    // Compare raw USD totals only; switching display currency is not a gain.
    const changed = previous && previous.complete && detail.complete
      && previous.currency === detail.currency && Math.abs(detail.total - previous.total) >= .005;
    const value = document.querySelector('#homeAum .aum-v');
    const nextText = value?.textContent;
    const oldText = previous?.text;
    previous = { ...detail, text: nextText };
    if(performance.now()<quietUntil){schedule();return;}
    cancel();
    if (changed && active() && onScreen() && visible(value) && nextText !== oldText) {
      visit(value, 'Pembaruan data masuk.', () => {
        reveal?.(); reveal = null;
        caption.textContent = 'Nilai terbaru dari sumber data.';
      });
      if (!reduced.matches) {
        // Brief presentation handoff only. Cancellation always reveals the latest value.
        // The portfolio state and all calculations already use the new source value.
        value.textContent = oldText;
        const fallback = setTimeout(() => { reveal?.(); reveal = null; }, 2000);
        reveal = () => { clearTimeout(fallback); value.textContent = nextText; };
      }
    } else schedule();
  });
  window.addEventListener('hashchange', () => {
    // A different page gets a fresh entry point; scrolling never relocates it.
    quietUntil=0;caption.textContent='Aku lihat bagian halaman ini dulu, ya.';explored=new WeakSet();location={x:100,y:180}; sync();
  });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('scroll', () => {
    // Keep document coordinates. Scrolling moves the character with the content.
    // Follow only after scrolling settles; let it visibly leave the viewport first.
    if (!active()) return;
    quietUntil=0;cancel();
    if (!reduced.matches) scrollIdle=setTimeout(() => {scrollIdle=null;followReader();},850);
  }, { passive: true });
  const trackAttention=event=>{
    if(!active())return;
    attention={x:event.clientX+scrollX,y:event.clientY+scrollY};
    if(!gazeFrame)gazeFrame=requestAnimationFrame(updateGaze);
  };
  document.addEventListener('pointermove',trackAttention,{passive:true});
  document.addEventListener('pointerdown',trackAttention,{passive:true});
  reduced.addEventListener('change', sync);
  sync();
})();
