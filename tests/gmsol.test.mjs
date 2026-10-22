import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const src = (over = {}) => ({ fund: 'gmsol', mode: 'live', updatedAt: new Date(NOW - 60e3).toISOString(), t0At: new Date(NOW - 3600e3).toISOString(),
  equityLedgerUsd: 1195.5, walletSolShared: { sol: 8.7, label: 'dipakai bersama Meridian' }, sizing: { sizeUsd: 50, maxOpen: 5 }, brakes: { dailyPct: 25, totalFloorUsd: 600, halted: false }, openSeats: [{ symbol: 'ABC-SOL', basisUsd: 50 }], closeHistory: [{ symbol: 'XYZ-SOL', netUsd: 1 }], ...over });
function run(source, { passed = false, now = NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmsol-')), data = join(dir, 'data'), file = join(dir, 'src.json');
  mkdirSync(join(data, 'gmsol'), { recursive: true });
  if (passed) writeFileSync(join(data, 'gmsol', 'test-passed.local'), '');
  if (source !== undefined) writeFileSync(file, JSON.stringify(source));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-gmsol.mjs')], { env: { ...process.env, CASHOOD_DATA_DIR: data, GMSOL_SRC: file, GMSOL_NOW: String(now) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(data, 'gmsol', 'live.json'), 'utf8'));
}

test('gmsol v3: kinerja dari equityLedgerUsd, wallet hanya info bersama', () => {
  const d = run(src({ equityUsd: 900, specStatus: 'DRAFT', solPriceUsd: 100 }));
  assert.ok(!JSON.stringify(d).includes('DRAFT')); assert.equal(d.walletSolShared.usd, 870);
  assert.equal(d.status, 'ok'); assert.equal(d.risk, 'high');
  assert.equal(d.equityUsd, 1195.5); assert.equal(d.pnlUsd, -4.5);
  assert.equal(d.walletSolShared.label, 'dipakai bersama Meridian');
  assert.equal(d.brakes.totalFloorUsd, 600); assert.equal(d.sizing.maxOpen, 5);
  assert.equal(d.openSeats.length, 1); assert.equal(d.closes.length, 1);
});
test('gmsol: v2 lama, basi, bukan live, tanpa berkas, ledger null → tanpa angka', () => {
  const { equityLedgerUsd, ...v2 } = src();
  for (const d of [run({ ...v2, equityUsd: 942 }), run(src({ updatedAt: new Date(NOW - 20 * 60e3).toISOString() })), run(src({ mode: 'dry_run' })), run(undefined), run(src({ equityLedgerUsd: null }))]) {
    assert.equal(d.status, 'waiting'); assert.equal(d.equityUsd, undefined); assert.equal(d.pnlUsd, undefined);
  }
});
