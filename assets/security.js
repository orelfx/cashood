/* All rich HTML passes one sanitizer; plain external labels are also escaped. */
(function () {
  'use strict';
  if (!globalThis.DOMPurify) throw new Error('Pembersih HTML tidak tersedia');
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && /url\s*\(|@import|expression|[<>\\]/i.test(data.attrValue)) data.keepAttr = false;
    if (['href', 'src', 'xlink:href'].includes(data.attrName)) {
      const v = data.attrValue.trim();
      if (data.attrName !== 'href' || !(v.startsWith('#') || /^reports\/[a-z0-9-]+\.(pdf|html)$/i.test(v))) data.keepAttr = false;
    }
  });
  // BARIS TABEL BUTUH KONTEKS TABEL. DOMPurify mem-parse markup di dalam
  // <body>; di sana <tr> dan <td> tanpa <table> bukan HTML yang sah, jadi
  // parser membuangnya dan isinya jatuh jadi teks lepas. Itu yang membuat
  // seluruh tabel situs tampil sebagai tumpukan teks setelah pengaman ini
  // dipasang. Markup untuk isi tabel dibungkus dulu dalam tabel, dibersihkan,
  // lalu isi bagian yang dimaksud dipindahkan ke elemen tujuan.
  const CONTEXT = {
    TABLE: ['<table>', '</table>', 'table'],
    THEAD: ['<table><thead>', '</thead></table>', 'thead'],
    TBODY: ['<table><tbody>', '</tbody></table>', 'tbody'],
    TFOOT: ['<table><tfoot>', '</tfoot></table>', 'tfoot'],
    TR: ['<table><tbody><tr>', '</tr></tbody></table>', 'tr'],
  };
  globalThis.setHTML = function (el, markup, append = false) {
    if (!el) return;
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    const ctx = svg ? null : CONTEXT[el.tagName];
    const source = ctx ? ctx[0] + String(markup ?? '') + ctx[1] : String(markup ?? '');
    const clean = DOMPurify.sanitize(source, {
      USE_PROFILES: svg ? { svg: true } : { html: true, svg: true },
      NAMESPACE: svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'img', 'image', 'foreignObject', 'use'],
      FORBID_ATTR: ['srcset'],
      RETURN_DOM_FRAGMENT: true,
    });
    let out = clean;
    if (ctx) {
      const inner = clean.querySelector(ctx[2]);
      out = document.createDocumentFragment();
      if (inner) out.append(...inner.childNodes);
    }
    if (append) el.append(out); else el.replaceChildren(out);
  };
})();
