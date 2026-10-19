import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { linkedDietz, meridianFlows } from '../scripts/lib/dietz.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D0 = Date.parse('2026-10-20T00:00:00+07:00'), H = 3600e3;

test('linked Modified Dietz: hari kedua dengan setoran di tengah hari', () => {
  const points = [{ t: D0, usd: 100 }, { t: D0 + 24 * H, usd: 110 }, { t: D0 + 48 * H, usd: 165 }];
  const r = linkedDietz({ points, flows: [{ t: D0 + 36 * H, usd: 50 }], t0: D0 });
  // hari 1: +10%; hari 2: (165-110-50)/(110+0.5*50) = 5/135
  assert.ok(Math.abs(r.pctSinceStart - (1.1 * (1 + 5 / 135) - 1) * 100) < 1e-9);
  assert.ok(Math.abs(r.rawPctSinceStart - 65) < 1e-9);
  assert.equal(r.netFlowsUsd, 50);
  assert.equal(r.days.length, 2);
});

test('arus sebelum T0 tidak dihitung; tanpa titik sesudah T0 → null', () => {
  const points = [{ t: D0 - 24 * H, usd: 50 }, { t: D0, usd: 100 }, { t: D0 + 12 * H, usd: 101 }];
  const r = linkedDietz({ points, flows: [{ t: D0 - 2 * H, usd: 50 }], t0: D0 });
  assert.equal(r.netFlowsUsd, 0);
  assert.ok(Math.abs(r.pctSinceStart - 1) < 1e-9);
  assert.equal(linkedDietz({ points: [{ t: D0, usd: 100 }], t0: D0 + H }), null);
});

test('meridianFlows: reinvest dilewati, pasangan jual-beli saham saling hapus, outflow dari titik NAV', () => {
  const cfg = { events: [
    { type: 'deposit', usd: 100, at: D0 }, { type: 'reinvest', usd: 40, at: D0 },
    { type: 'withdraw', usd: 500, at: D0 + H, dividend: true }, { type: 'deposit', usd: 500, at: D0 + H },
  ] };
  const f = meridianFlows(cfg, [{ t: D0, outflowTotalUsd: 0 }, { t: D0 + 2 * H, outflowTotalUsd: 30 }]);
  assert.equal(f.reduce((s, x) => s + x.usd, 0), 100 - 30);
  assert.equal(f.filter((x) => x.kind === 'outflow').length, 1);
});

function setup(meridian) {
  const dir = mkdtempSync(join(tmpdir(), 'gm-')), data = join(dir, 'data');
  mkdirSync(join(data, 'meridian'), { recursive: true });
  for (const [n, v] of Object.entries(meridian)) writeFileSync(join(data, 'meridian', n), JSON.stringify(v));
  return dir;
}
function runSync(engine, meridian, dir = setup(meridian), extraEnv = {}) {
  const data = join(dir, 'data');
  const src = join(dir, 'grok-meridian.json'); writeFileSync(src, JSON.stringify(engine));
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-gm.mjs')], {
    env: { ...process.env, GM_STATE: src, CASHOOD_DATA_DIR: data, GM_PIN_BACKUP: join(dir, 'no-backup.json'), ...extraEnv }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(join(data, 'gm', 'live.json'), 'utf8'));
}
const meridian = {
  'nav.json': { points: [{ t: D0, usd: 100, quality: 'complete' }, { t: D0 + 24 * H, usd: 110, quality: 'complete' }, { t: D0 + 48 * H, usd: 165, quality: 'complete' }] },
  'live.json': { updatedAt: D0 + 48 * H, totalUsd: 165, quality: { complete: true } },
  'config.json': { events: [{ type: 'deposit', usd: 50, at: D0 + 36 * H }] },
};
const engine = { paperOnly: true, updatedAt: D0 + 48 * H, startCapitalUsd: 100, challenger: { label: 'x', pctSinceStart: 3 },
  live: { pctSinceStart: 999, netFlowsUsd: -1, equityUsd: 1 } };

test('sync-gm: kolom live dihitung dari data Meridian, blok live mesin diabaikan', () => {
  const out = runSync({ ...engine, startedAt: D0 }, meridian);
  assert.equal(out.status, 'ok');
  assert.equal(out.live.status, 'ok');
  assert.equal(out.live.pctSinceStart, Number(((1.1 * (1 + 5 / 135) - 1) * 100).toFixed(2)));
  assert.equal(out.live.netFlowsUsd, 50);
  assert.equal(out.live.rawPctSinceStart, 65);
  assert.equal(out.live.equityUsd, 165);
  assert.match(out.live.note, /bukan dari mesin Grok/);
});

test('sync-gm: tanpa startedAt → live menunggu T0', () => {
  const out = runSync(engine, meridian);
  assert.equal(out.live.status, 'waiting_t0');
  assert.equal(out.live.pctSinceStart, undefined);
});

const P1 = { version: 'v1', sha256Prereg: 'a'.repeat(64), sha256Params: 'b'.repeat(64) };

test('warmup: T0 tidak dipatok, live menunggu T0', () => {
  const dir = setup(meridian);
  const out = runSync({ ...engine, startedAt: D0, phase: 'warmup' }, meridian, dir);
  assert.equal(out.startedAt, null);
  assert.equal(out.live.status, 'waiting_t0');
  assert.equal(existsSync(join(dir, 'data', 'gm', 't0.local.json')), false);
});

test('T0 dipatok sekali; startedAt/hash yang berubah memunculkan peringatan', () => {
  const dir = setup(meridian);
  const a = runSync({ ...engine, startedAt: D0, preregistration: P1 }, meridian, dir);
  assert.equal(a.startedAt, D0);
  assert.equal(a.t0Pin.prereg12, 'aaaaaaaaaaaa');
  assert.ok(!a.warnings.some((w) => /T0 berubah|Hash/.test(w)));
  const b = runSync({ ...engine, startedAt: D0 + 2 * H, preregistration: { ...P1, sha256Prereg: 'c'.repeat(64) } }, meridian, dir);
  assert.equal(b.startedAt, D0);
  assert.equal(b.engineStartedAt, D0 + 2 * H);
  assert.ok(b.warnings.some((w) => w.startsWith('T0 berubah')));
  assert.ok(b.warnings.some((w) => /Hash pra-registrasi berubah/.test(w)));
  assert.ok(!b.warnings.some((w) => /Hash parameter/.test(w)));
  assert.equal(b.live.pctSinceStart, a.live.pctSinceStart);
});

test('T0 dipulihkan dari salinan terbit kalau berkas lokal hilang', () => {
  const dir = setup(meridian), backup = join(dir, 't0.json');
  writeFileSync(backup, JSON.stringify({ fund: 'gm', startedAt: D0, pinnedAt: D0, prereg12: null, params12: null }));
  const out = runSync({ ...engine, startedAt: D0 + H }, meridian, dir, { GM_PIN_BACKUP: backup });
  assert.equal(out.startedAt, D0);
  assert.ok(out.warnings.some((w) => w.startsWith('T0 berubah')));
});

test('cek arus dana: cocok tanpa peringatan, selisih > $1 diperingatkan', () => {
  const ok = runSync({ ...engine, startedAt: D0, challenger: { ...engine.challenger, netFlowsUsd: 50 } }, meridian);
  assert.ok(!ok.warnings.some((w) => /Arus dana|arus dana/.test(w)));
  assert.equal(ok.challenger.cashoodNetFlowsUsd, 50);
  const bad = runSync({ ...engine, startedAt: D0, challenger: { ...engine.challenger, netFlowsUsd: 48 } }, meridian);
  assert.ok(bad.warnings.some((w) => w.startsWith('Arus dana tidak cocok')));
  const none = runSync({ ...engine, startedAt: D0 }, meridian);
  assert.ok(none.warnings.some((w) => /belum melaporkan arus dana/.test(w)));
});

test('DD Grok dihitung harian dari dailyEquity dengan arus dana Cashood', () => {
  const ch = { ...engine.challenger, netFlowsUsd: 50, pctSinceStart: Number(((0.9 * (1 + 5 / 115) - 1) * 100).toFixed(2)),
    dailyEquity: [{ t: D0, equityUsd: 100 }, { t: D0 + 24 * H, equityUsd: 90 }, { t: D0 + 48 * H, equityUsd: 145 }] };
  const out = runSync({ ...engine, startedAt: D0, challenger: ch }, meridian);
  // hari 1: -10%; hari 2: (145-90-50)/(90+25) = 5/115
  assert.equal(out.challenger.maxDrawdownPct, -10);
  assert.equal(out.challenger.ddBasis, 'harian');
  assert.ok(!out.warnings.some((w) => /Persen Grok/.test(w)));
  const noDaily = runSync({ ...engine, startedAt: D0, challenger: { ...engine.challenger, netFlowsUsd: 50, maxDrawdownPct: -1 } }, meridian);
  assert.equal(noDaily.challenger.maxDrawdownPct, null);
  assert.match(noDaily.challenger.ddNote, /dailyEquity/);
});
