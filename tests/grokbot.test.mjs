// Dashboard paper Devil Greed (/grokbot/...): halaman terpisah dari Cashood.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pages = { 'grokbot/solana/index.html': 'dgsol', 'grokbot/robinhood/index.html': 'dgrh' };

test('setiap halaman rantai membaca satu buku saja dan berlabel PAPER', () => {
  for (const [page, fund] of Object.entries(pages)) {
    const html = read(page);
    assert.match(html, new RegExp(`data-fund="${fund}"`));
    assert.match(html, /PAPER TRADING MODE/);
    assert.match(html, /\/assets\/grokbot\.js\?v=__BUILD__/);
    // api.github.com hanya untuk SHA commit terbaru branch data (data tidak basi di CDN).
    assert.match(html, /connect-src 'self' https:\/\/raw\.githubusercontent\.com https:\/\/api\.github\.com;/);
  }
});

test('skrip dashboard valid, hanya membaca branch data, tanpa alamat', () => {
  const js = read('assets/grokbot.js');
  parse(js, { ecmaVersion: 'latest', sourceType: 'module' });
  parse(read('assets/grokbot-timeline.mjs'), { ecmaVersion: 'latest', sourceType: 'module' });
  parse(read('assets/grokbot-rules.mjs'), { ecmaVersion: 'latest', sourceType: 'module' });
  assert.match(js, /raw\.githubusercontent\.com\/orelfx\/cashood\/data\//);
  for (const f of ['assets/grokbot.js', 'assets/grokbot.css', 'assets/grokbot-timeline.mjs', 'assets/grokbot-rules.mjs', ...Object.keys(pages), 'grokbot/index.html']) {
    const s = read(f);
    assert.doesNotMatch(s, /0x[0-9a-fA-F]{40}/, `${f} memuat alamat EVM`);
    assert.doesNotMatch(s, /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/, `${f} memuat sesuatu berbentuk alamat Solana`);
  }
});
