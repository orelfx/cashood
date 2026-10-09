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
  let gaitFrame = 0, gaitLast = 0, gaitStart = 0, heading = 0;
  // Eight articulated legs, 30 updates/second only during travel. No layout reads.
  function pose(phase = 0) {
    const shape = [[69,-91],[100,-42],[102,36],[62,99]];
    legs.forEach(({path,joints}, index) => {
      const side = index < 4 ? -1 : 1, i = index % 4;
      const [reach, spread] = shape[i];
      const wave = Math.sin(phase + i * Math.PI / 2 + (side > 0 ? Math.PI : 0));
      const lift = Math.max(0, wave) * 9;
      const hip = [120 + side*5, 120+(i-1.5)*5];
      const knee = [120+side*(reach*.46+lift),120+spread*.43-wave*8];
      const ankle = [120+side*(reach*.77-lift*.4),120+spread*.73+wave*9];
      const toe = [120+side*(reach-lift*.3),120+spread+wave*15];
      path.setAttribute('d', 'M'+[hip,knee,ankle,toe].map(p=>p.map(n=>n.toFixed(1)).join(' ')).join(' L'));
      [knee,ankle,toe].forEach((p,j)=>{joints[j].setAttribute('cx',p[0].toFixed(1));joints[j].setAttribute('cy',p[1].toFixed(1));});
    });
  }
  function stopGait() { cancelAnimationFrame(gaitFrame); gaitFrame = 0; }
  function startGait(dx,dy) {
    stopGait();
    heading = Math.atan2(dy,dx)*180/Math.PI+90;
    rig.setAttribute('transform', `rotate(${heading.toFixed(1)} 120 120)`);
    gaitStart = performance.now(); gaitLast = 0;
    const tick = now => {
      if (!motion || !active() || reduced.matches) { stopGait(); return; }
      if (now-gaitLast >= 1000/30) { pose((now-gaitStart)/115); gaitLast=now; }
      gaitFrame = requestAnimationFrame(tick);
    };
    gaitFrame = requestAnimationFrame(tick);
  }
  function bounds() {
    const radius = parseFloat(getComputedStyle(spider).getPropertyValue('--spider-span'))/2;
    return { minX: radius-14, maxX: innerWidth-radius-30, minY: radius+94, maxY: innerHeight-radius-30 };
  }

  const visible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > 115 && r.bottom < innerHeight - 8;
  };
  const active = () => enabled && !document.hidden;
  function cancel() {
    generation++; stopGait();
    clearTimeout(timer); clearTimeout(scrollIdle);
    reveal?.(); reveal = null;
    if (motion) {
      const m = new DOMMatrixReadOnly(getComputedStyle(spider).transform);
      location = { x: m.m41, y: m.m42 };
      motion.cancel(); motion = null;
      spider.style.transform = `translate(${location.x}px,${location.y}px)`;
    }
    spider.classList.remove('walking');
  }
  function schedule() {
    clearTimeout(timer);
    if (active() && !reduced.matches) timer = setTimeout(tour, 7500);
  }
  function visit(target, message, action) {
    if (!active() || !visible(target)) { schedule(); return; }
    cancel();
    const token = generation;
    const r = target.getBoundingClientRect(), b = bounds();
    const next = {
      x: Math.max(b.minX, Math.min(b.maxX, r.right - 22)),
      y: Math.max(b.minY, Math.min(b.maxY, r.top - 50)),
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
    const duration = Math.min(1800, Math.max(650, Math.hypot(next.x-location.x, next.y-location.y)*2));
    motion = spider.animate([
      { transform: `translate(${location.x}px,${location.y}px)` },
      { transform: `translate(${next.x}px,${next.y}px)` },
    ], { duration, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    startGait(next.x-location.x, next.y-location.y);
    motion.onfinish = () => { const done = motion; arrive(); done?.cancel(); };
  }
  function tour() {
    if (!active()) return;
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
      if (!reduced.matches) timer = setTimeout(tour, 1200);
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
    if (changed && active() && visible(value) && nextText !== oldText) {
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
  window.addEventListener('hashchange', sync);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('scroll', () => {
    // Stop at the viewport edge while the reader scrolls; never follow a stale target.
    if (!active() || reduced.matches) return;
    if (motion || reveal) cancel();
    clearTimeout(timer); clearTimeout(scrollIdle);
    scrollIdle = setTimeout(() => { scrollIdle = null; tour(); }, 500);
  }, { passive: true });
  reduced.addEventListener('change', sync);
  sync();
})();
