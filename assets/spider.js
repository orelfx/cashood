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
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > 115 && r.bottom < innerHeight - 8;
  };
  const active = () => enabled && !document.hidden;
  function cancel() {
    generation++;
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
    const r = target.getBoundingClientRect(), size = spider.offsetWidth || 76;
    const next = {
      x: Math.max(8, Math.min(innerWidth - size - 12, r.right - size * .25)),
      y: Math.max(116, Math.min(innerHeight - size - 38, r.top - size * .68)),
    };
    caption.textContent = message;
    spider.classList.toggle('caption-left', next.x > innerWidth / 2);
    const arrive = () => {
      if (token !== generation || !active()) return;
      motion = null; location = next;
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
      location.x = Math.min(location.x, innerWidth - 88);
      location.y = Math.min(location.y, innerHeight - 114);
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
