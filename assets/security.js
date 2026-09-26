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
  globalThis.setHTML = function (el, markup, append = false) {
    if (!el) return;
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    const clean = DOMPurify.sanitize(String(markup ?? ''), {
      USE_PROFILES: svg ? { svg: true } : { html: true, svg: true },
      NAMESPACE: svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'img', 'image', 'foreignObject', 'use'],
      FORBID_ATTR: ['srcset'],
      RETURN_DOM_FRAGMENT: true,
    });
    if (append) el.append(clean); else el.replaceChildren(clean);
  };
})();
