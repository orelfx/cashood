import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const src = (over = {}) => ({ fund: 'gmsol', mode: 'live', updatedAt: new Date(NOW - 60e3).toISOString(), t0At: new Date(NOW - 3600e3).toISOString(),
  // r4.1: modal dikunci mesin saat deploy (tanpa ini sync menunggu).
  capitalUsd: 1200, capitalUsdAtDeploy: { usd: 1200, lockedAt: new Date(NOW - 3600e3).toISOString(), solUsd: 100, freeSol: 12, reserveSol: 0 },
  equityLedgerUsd: 1195.5, walletSolShared: { sol: 8.7, label: 'dipakai bersama Meridian' }, sizing: { sizeUsd: 50, maxOpen: 5 }, brakes: { dailyPct: 25, totalFloorUsd: 600, halted: false }, openSeats: [{ symbol: 'ABC-SOL', basisUsd: 50 }], closeHistory: [{ symbol: 'XYZ-SOL', netUsd: 1 }], ...over });
function run(source, { passed = false, now = NOW, engine = '/nonexistent-gmsol' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmsol-')), data = join(dir, 'data'), file = join(dir, 'src.json');
  mkdirSync(join(data, 'gmsol'), { recursive: true });
  if (passed) writeFileSync(join(data, 'gmsol', 'test-passed.local'), '');
  if (source !== undefined) writeFileSync(file, JSON.stringify(source));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-gmsol.mjs')], { env: { ...process.env, CASHOOD_DATA_DIR: data, GMSOL_SRC: file, GMSOL_NOW: String(now), GMSOL_ENGINE_DIR: engine }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(data, 'gmsol', 'live.json'), 'utf8'));
}

test('gmsol v3: kinerja dari equityLedgerUsd, wallet hanya info bersama', () => {
  const d = run(src({ equityUsd: 900, specStatus: 'DRAFT', solPriceUsd: 100 }));
  assert.ok(!JSON.stringify(d).includes('DRAFT')); assert.equal(d.walletSolShared.usd, 870);
  assert.equal(d.status, 'ok'); assert.equal(d.risk, 'high');
  assert.equal(d.equityUsd, 1195.5); assert.equal(d.pnlUsd, -4.5);
  assert.equal(d.walletSolShared.label, 'dipakai bersama Meridian2');
  assert.equal(d.brakes.totalFloorUsd, 600); assert.equal(d.sizing.maxOpen, 5);
  assert.equal(d.openSeats.length, 1); assert.equal(d.closes.length, 1);
});
test('gmsol: v2 lama, basi, bukan live, tanpa berkas, ledger null → tanpa angka', () => {
  const { equityLedgerUsd, ...v2 } = src();
  for (const d of [run({ ...v2, equityUsd: 942 }), run(src({ updatedAt: new Date(NOW - 20 * 60e3).toISOString() })), run(src({ mode: 'dry_run' })), run(undefined), run(src({ equityLedgerUsd: null }))]) {
    assert.equal(d.status, 'waiting'); assert.equal(d.equityUsd, undefined); assert.equal(d.pnlUsd, undefined);
  }
});
test('gmsol: data live basi → mesin berhenti, tanpa angka, waktu terakhir tetap ada', () => {
  const at = NOW - 30 * 60e3, d = run(src({ updatedAt: new Date(at).toISOString() }));
  assert.equal(d.status, 'waiting'); assert.equal(d.reason, 'Mesin berhenti, menunggu restart');
  assert.equal(d.asOf, at); assert.equal(d.equityUsd, undefined); assert.equal(d.openSeats, undefined);
});
test('gmsol: ringkasan screening dari scan terakhir, t0 dari state engine, tanpa alamat', () => {
  const eng = mkdtempSync(join(tmpdir(), 'gmeng-')); mkdirSync(join(eng, 'logs')); mkdirSync(join(eng, 'state'));
  writeFileSync(join(eng, 'state', 'live.json'), JSON.stringify({ created: '2026-10-22T03:34:29.332Z' }));
  const old = '2026-10-22T07:37:00.000Z', last = '2026-10-22T07:42:53.742Z', addr = '7b6dX3nE25xrfNViEKZHL9wVJFcBxQYuWPpmzHUxx28H';
  const rows = [{ ts: old, pool_symbol: 'OLD-SOL', reasons: ['pool.tvl=1 !>=10000'] },
    { ts: last, pool_symbol: '*', reasons: ['discovery_summary sol_dlmm=330 inactive_1h=122 tvl_zero=0'] },
    { ts: last, pool_symbol: 'AAA-SOL', bs: 100, reasons: ['pool.fee_active_tvl_ratio=0.5 !>=2'] },
    { ts: last, pool_symbol: 'BBB-SOL', bs: 80, reasons: ['pool.tvl=10 !>=10000', `pool.fee_active_tvl_ratio=0.1 !>=2 ${addr}`] }];
  writeFileSync(join(eng, 'logs', 'screen-2026-10-22.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const d = run(src({ t0At: null }), { engine: eng }), sc = d.screening;
  // r4.1: mulai live = waktu modal dikunci mesin (sebelum t0At / state engine).
  assert.equal(d.t0At, NOW - 3600e3);
  assert.equal(sc.scannedAt, Date.parse(last)); assert.equal(sc.solPools, 330); assert.equal(sc.checked, 2); assert.equal(sc.passed, 0);
  assert.deepEqual(sc.topReasons[0], { reason: 'pool.fee_active_tvl_ratio', pools: 2 });
  assert.equal(sc.closest[0].symbol, 'AAA-SOL'); assert.ok(!JSON.stringify(d).includes(addr)); assert.ok(!JSON.stringify(d).includes('OLD-SOL'));
});
