import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const src = (over = {}) => ({ fund: 'gmsol', mode: 'live', updatedAt: new Date(NOW - 60e3).toISOString(), t0At: new Date(NOW - 3600e3).toISOString(),
  equityUsd: 1195.5, walletUsd: 1195.5, lpUsd: 0, tokensUsd: 0, openSeats: [{ symbol: 'ABC-SOL', basisUsd: 50 }], closeHistory: [{ symbol: 'XYZ-SOL', netUsd: 1 }], ...over });
function run(source, { passed = false, now = NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmsol-')), data = join(dir, 'data'), file = join(dir, 'src.json');
  mkdirSync(join(data, 'gmsol'), { recursive: true });
  if (passed) writeFileSync(join(data, 'gmsol', 'test-passed.local'), '');
  if (source !== undefined) writeFileSync(file, JSON.stringify(source));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-gmsol.mjs')], { env: { ...process.env, CASHOOD_DATA_DIR: data, GMSOL_SRC: file, GMSOL_NOW: String(now) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(data, 'gmsol', 'live.json'), 'utf8'));
}

test('gmsol: sebelum uji $50 lulus hanya saldo yang terbit (pretest), tanpa statistik trading', () => {
  const d = run(src());
  assert.equal(d.status, 'pretest');
  assert.equal(d.equityUsd, 1195.5);
  assert.equal(d.pnlUsd, -4.5);
  assert.equal(d.openSeats, undefined);
  assert.equal(d.closes, undefined);
  assert.equal(d.equityCurve.length, 1);
});

test('gmsol: data basi, bukan mode live, atau tanpa berkas → menunggu tanpa angka', () => {
  for (const d of [run(src({ updatedAt: new Date(NOW - 20 * 60e3).toISOString() })), run(src({ mode: 'paper' })), run(undefined)]) {
    assert.equal(d.status, 'waiting');
    assert.equal(d.equityUsd, undefined);
  }
});

test('gmsol: setelah uji lulus semua bagian terbit (ok)', () => {
  const d = run(src(), { passed: true });
  assert.equal(d.status, 'ok');
  assert.equal(d.openSeats.length, 1);
  assert.equal(d.closes.length, 1);
});
