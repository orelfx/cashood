import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binanceHealth } from '../scripts/lib/binance-health.mjs';
const now = 1790850000000;
const beat = { state: 'ALIVE', updated_ms: now - 10000 };
test('live process in cooldown has stale account and is not labelled dead', () => {
  const h = binanceHealth({ updated_ms: now - 3600000 }, { state:'COOLDOWN', until_ms:now+600000,updated_ms:now }, beat, now);
  assert.equal(h.alive,true); assert.match(h.status,/cooldown/); assert.equal(h.usable,false);assert.equal(h.healthy,false);
});
test('stopped or stale heartbeat stays dead even with a fresh account', () => {
  for(const b of [{state:'STOPPED',updated_ms:now},{state:'ALIVE',updated_ms:now-300000}]) {
    const h=binanceHealth({updated_ms:now},{state:'CONNECTED'},b,now);assert.equal(h.status,'tidak aktif');assert.equal(h.usable,false);
  }
});
test('expired cooldown does not silently turn into healthy connected', () => {
  const h=binanceHealth({updated_ms:now},{state:'COOLDOWN',until_ms:now-1},beat,now);
  assert.match(h.status,/memulihkan/);assert.equal(h.usable,false);
});
test('healthy account recovers independently of manual pause', () => {
  assert.equal(binanceHealth({updated_ms:now},{state:'CONNECTED'},beat,now).healthy,true);
  const h=binanceHealth({updated_ms:now,paused:true},{state:'CONNECTED'},beat,now);
  assert.equal(h.status,'dijeda');assert.equal(h.healthy,false);assert.equal(h.usable,true);
});
test('proactive request budget wait is distinct from exchange ban', () => {
  const h=binanceHealth({updated_ms:now},{state:'RATE_LIMIT_WAIT',until_ms:now+60000},beat,now);
  assert.equal(h.status,'menunggu anggaran request');assert.equal(h.usable,false);
});
