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
  let timer, scrollIdle, motion, reveal, previous, step = 0, phrase = 0, generation = 0;
  let location = { x: 20, y: 160 };
  const headlines = ['Bot yang kerja.', 'Otomasi yang kerja.', 'Sistem yang kerja.'];
  const caption = spider.querySelector('.spider-caption');
  const rig = spider.querySelector('.spider-rig');
  const legs = [...spider.querySelectorAll('.spider-leg')].map(el => ({
    path: el.querySelector('path'), joints: [...el.querySelectorAll('circle')],
  }));
  let gaitFrame = 0, heading = 0;
  const silk = document.querySelector('#spiderSilk');
  const silkLine = silk.querySelector('line');
  const silkAnchor = silk.querySelector('circle');
  // Joint positions traced from the supplied reference, in body-local coordinates.
  // Legs attach along an elongated body, not to a radial central point.
  const legGeometry = [[[114.1,110.0],[82.7,87.2],[50.3,89.7],[22.5,90.4]],[[112.3,119.1],[85.2,115.9],[68.9,125.9],[47.1,141.3]],[[112.1,125.2],[90.6,146.7],[84.9,175.4],[80.2,200.1]],[[113.7,133.1],[103.0,161.9],[111.6,188.6],[117.5,211.6]],[[126.3,134.0],[158.2,158.7],[194.0,156.9],[225.0,156.2]],[[126.1,122.5],[149.4,123.2],[168.2,113.0],[184.0,104.4]],[[126.3,113.7],[145.1,109.8],[155.8,97.4],[166.2,86.5]],[[125.7,102.6],[132.0,77.2],[125.0,63.0],[116.6,46.5]]];
  const smooth = t => t*t*(3-2*t);
  function drawLeg(index, toe, lift = 0) {
    const geometry = legGeometry[index], original = geometry[3];
    const delta = [toe[0]-original[0],toe[1]-original[1]];
    const points = geometry.map(([x,y],j) => j===3 ? toe : j===0 ? [x,y] :
      [x+delta[0]*(j/3)+(x<120?-1:1)*lift*7,y+delta[1]*(j/3)-lift*5]);
    const {path,joints} = legs[index];
    path.setAttribute('d','M'+points.map(p=>p.map(n=>n.toFixed(1)).join(' ')).join(' L'));
    points.slice(1).forEach((p,j)=>{joints[j].setAttribute('cx',p[0].toFixed(1));joints[j].setAttribute('cy',p[1].toFixed(1));});
  }
  function stopGait() { cancelAnimationFrame(gaitFrame); gaitFrame=0; silk.hidden=true; }
  function travel(next, arrive) {
    const from={...location}, dx=next.x-from.x, dy=next.y-from.y, distance=Math.hypot(dx,dy);
    const ux=distance?dx/distance:0, uy=distance?dy/distance:0;
    const scale=parseFloat(getComputedStyle(spider).getPropertyValue('--spider-span'))/240;
    const targetHeading=Math.atan2(dy,dx)*180/Math.PI+90;
    const turn=((targetHeading-heading+540)%360)-180, oldHeading=heading;
    const web=distance>145, walkDistance=web?Math.min(44,distance):distance;
    const walkStart={x:next.x-ux*walkDistance,y:next.y-uy*walkDistance};
    const turnMs=180, shootMs=web?160:0, zipMs=web?620:0;
    const walkMs=Math.max(420,walkDistance/85*1000), settleMs=160;
    const walkAt=turnMs+shootMs+zipMs, endAt=walkAt+walkMs;
    const steps=Math.max(1,Math.ceil(walkDistance/24)), stride=walkDistance/steps;
    const started=performance.now();let last=0,feet=null;
    const angle=targetHeading*Math.PI/180, c=Math.cos(angle), s=Math.sin(angle);
    const world=(point,center)=>({x:center.x+22+((point[0]-120)*c-(point[1]-120)*s)*scale,
      y:center.y+22+((point[0]-120)*s+(point[1]-120)*c)*scale});
    const local=point=>{const x=(point.x-location.x-22)/scale,y=(point.y-location.y-22)/scale;return [120+x*c+y*s,120-x*s+y*c];};
    const place=(x,y)=>{location={x,y};spider.style.transform=`translate(${x}px,${y}px)`;};
    const rest=()=>legGeometry.forEach((g,i)=>drawLeg(i,g[3]));
    motion={cancel:stopGait};
    const tick=now=>{
      if(!motion || !active() || reduced.matches){stopGait();return;}
      if(now-last<1000/30){gaitFrame=requestAnimationFrame(tick);return;}last=now;
      const elapsed=now-started;
      if(elapsed<turnMs){
        heading=oldHeading+turn*smooth(elapsed/turnMs);
        rig.setAttribute('transform',`rotate(${heading} 120 120)`);
      }else{
        heading=targetHeading;rig.setAttribute('transform',`rotate(${heading} 120 120)`);
        if(web && elapsed<walkAt){
          spider.dataset.locomotion='web';silk.hidden=false;
          const shot=Math.min(1,(elapsed-turnMs)/shootMs);
          const anchor={x:from.x+22+dx*shot,y:from.y+22+dy*shot};
          const p=Math.max(0,Math.min(1,(elapsed-turnMs-shootMs)/zipMs));
          place(from.x+(walkStart.x-from.x)*smooth(p),from.y+(walkStart.y-from.y)*smooth(p));
          silkLine.setAttribute('x1',location.x+22);silkLine.setAttribute('y1',location.y+22);
          silkLine.setAttribute('x2',anchor.x);silkLine.setAttribute('y2',anchor.y);
          silkAnchor.setAttribute('cx',anchor.x);silkAnchor.setAttribute('cy',anchor.y);
          // Tuck legs during a silk pull instead of pretending to walk in midair.
          legGeometry.forEach((g,i)=>drawLeg(i,[120+(g[3][0]-120)*.73,120+(g[3][1]-120)*.73],.45));
        }else if(elapsed<endAt){
          silk.hidden=true;spider.dataset.locomotion='walk';
          const progress=Math.min(1,(elapsed-walkAt)/walkMs), cycle=progress*steps;
          const advance=(Math.floor(cycle)+smooth(cycle%1))/steps;
          place(walkStart.x+ux*walkDistance*advance,walkStart.y+uy*walkDistance*advance);
          if(!feet)feet=legGeometry.map(g=>({anchor:world(g[3],walkStart),swing:false}));
          feet.forEach((foot,i)=>{
            const phase=(cycle+(i%2)*.5)%1, swing=phase>=.58;
            if(swing && !foot.swing){
              foot.from={...foot.anchor};
              const ahead=Math.min(walkDistance,walkDistance*advance+stride*.75);
              foot.to=world(legGeometry[i][3],{x:walkStart.x+ux*ahead,y:walkStart.y+uy*ahead});
            }
            if(swing){const p=smooth((phase-.58)/.42);foot.anchor={x:foot.from.x+(foot.to.x-foot.from.x)*p,y:foot.from.y+(foot.to.y-foot.from.y)*p};}
            else if(foot.swing)foot.anchor={...foot.to};
            foot.swing=swing;
            // Stance feet stay in screen coordinates while the body passes over them.
            drawLeg(i,local(foot.anchor),swing?Math.sin((phase-.58)/.42*Math.PI):0);
            legs[i].joints[2].dataset.planted=String(!swing);
          });
        }else if(elapsed<endAt+settleMs){
          place(next.x,next.y);const p=smooth((elapsed-endAt)/settleMs);
          legGeometry.forEach((g,i)=>{const start=feet?local(feet[i].anchor):g[3];drawLeg(i,[start[0]+(g[3][0]-start[0])*p,start[1]+(g[3][1]-start[1])*p]);});
        }else{rest();spider.dataset.locomotion='idle';arrive();return;}
      }
      gaitFrame=requestAnimationFrame(tick);
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
  const onScreen = () => {
    const r=spider.getBoundingClientRect();
    return r.bottom>115 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
  };
  function cancel() {
    generation++; stopGait();
    clearTimeout(timer); clearTimeout(scrollIdle);
    reveal?.(); reveal = null;
    if (motion) { motion.cancel(); motion=null; }
    spider.dataset.locomotion='idle';
    spider.classList.remove('walking');
  }
  function schedule() {
    clearTimeout(timer);
    if (active() && onScreen() && !reduced.matches) timer = setTimeout(tour, 7500);
  }
  function visit(target, message, action) {
    if (!active() || !onScreen() || !visible(target)) { schedule(); return; }
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
        if (!reduced.matches) {
          target.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.65)', textShadow: '0 0 16px #2dd4bf' }, { filter: 'brightness(1)' }], { duration: 850 });
          spider.querySelector('svg').animate([{ transform: 'scale(1)' }, { transform: 'scale(.86) rotate(-8deg)' }, { transform: 'scale(1)' }], { duration: 360 });
        }
      }
      schedule();
    };
    if (reduced.matches) { arrive(); return; }
    spider.classList.add('walking');
    travel(next,arrive);
  }
  function tour() {
    if (!active() || !onScreen()) return;
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
    const page = document.querySelector('main > div[id^="tab-"]:not([hidden])');
    if (page) {
      const candidates = page.querySelectorAll('h2,h3,.aum-v,.hs-v,.prod-name,.menu-tile b,a[href$=".pdf"],.sub-h');
      const seen = new Set(targets.map(([el]) => el));
      for (const el of Array.from(candidates).slice(0, 200)) {
        if (!seen.has(el) && visible(el)) {
          targets.push([el, el.closest('a[href$=".pdf"]') ? 'Laporan tersedia. Klik untuk membukanya.' : 'Jelajahi rincian di halaman ini.']);
          seen.add(el);
        }
      }
    }
    const footer = document.querySelector('footer [data-spider-toggle]');
    if (visible(footer)) targets.push([footer, 'Animasi bisa dimatikan di sini.']);
    if (!targets.length) { schedule(); return; }
    visit(...targets[step++ % targets.length]);
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
      if (!reduced.matches && onScreen()) timer = setTimeout(tour, 1200);
    }
  }
  for (const button of toggles) button.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('cashood-spider', enabled ? 'on' : 'off'); } catch {}
    sync();
  });
  spider.addEventListener('click', tour);
  spider.addEventListener('pointerenter', () => { cancel(); });
  spider.addEventListener('pointerleave', schedule);
  document.addEventListener('cashood:home-data', ({ detail }) => {
    // Compare raw USD totals only; switching display currency is not a gain.
    const changed = previous && previous.complete && detail.complete
      && previous.currency === detail.currency && Math.abs(detail.total - previous.total) >= .005;
    const value = document.querySelector('#homeAum .aum-v');
    const nextText = value?.textContent;
    const oldText = previous?.text;
    previous = { ...detail, text: nextText };
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
    location={x:100,y:180}; sync();
  });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('scroll', () => {
    // Keep document coordinates. Scrolling moves the character with the content.
    // Pause off screen rather than seeking a new target in the viewport.
    if (!active()) return;
    cancel();
    if (!reduced.matches) scrollIdle=setTimeout(() => {scrollIdle=null;schedule();},200);
  }, { passive: true });
  reduced.addEventListener('change', sync);
  sync();
})();
