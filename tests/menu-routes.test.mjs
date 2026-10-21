import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(import.meta.dirname, '..', 'assets', 'app.js'), 'utf8');

// Halaman khusus di menu dropdown (data-view) harus ditangani klik menu, rute
// alamat (#…), dan render ulang. 2026-10-21: GMSOL lupa di klik menu, jadi
// menekan GMSOL membuka Reborn Rich.
test('setiap halaman khusus di menu punya handler klik, rute, dan render ulang', () => {
  const list = app.match(/for \(const k of \[([^\]]+)\]\) if \(state\[k\]/);
  assert.ok(list, 'daftar halaman khusus di navItems tidak ditemukan');
  const keys = list[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.ok(keys.includes('gmsol') && keys.includes('solbot'));
  for (const k of keys) {
    assert.match(app, new RegExp(`if \\(view === '${k}'\\) \\{ show`), `klik menu ${k}`);
    assert.match(app, new RegExp(`if \\(parts\\[0\\] === '${k}'\\) return`), `rute #${k}`);
    assert.match(app, new RegExp(`if \\(route\\.${k}\\) \\{ show`), `hashchange ${k}`);
  }
});
