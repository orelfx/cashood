import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionMarginUsd } from '../scripts/lib/binance-margin.mjs';

test('v2.7 seat after the top-up shows the full isolated margin', () => {
  assert.equal(positionMarginUsd({ planned_initial_margin: 300, isolated_margin_usd: 500, seat_margin_status: 'ADDED' }), 500);
});
test('before the top-up (first cycle) the initial margin is shown', () => {
  assert.equal(positionMarginUsd({ planned_initial_margin: 300.456, seat_margin_pending: true }), 300.46);
});
test('failed or unnecessary top-up records the initial margin as isolated margin', () => {
  assert.equal(positionMarginUsd({ planned_initial_margin: 300, isolated_margin_usd: 300, seat_margin_status: 'FAILED' }), 300);
});
test('positions from v2.4–v2.6 keep the planned initial margin', () => {
  assert.equal(positionMarginUsd({ planned_initial_margin: 1.14 }), 1.14);
  assert.equal(positionMarginUsd({ planned_initial_margin: 338.11, isolated_margin_usd: null }), 338.11);
});
test('unusable isolated values fall back instead of showing zero or NaN', () => {
  for (const bad of [0, -5, 'abc', NaN, Infinity]) {
    assert.equal(positionMarginUsd({ planned_initial_margin: 120, isolated_margin_usd: bad }), 120);
  }
});
test('no margin recorded stays unknown', () => {
  assert.equal(positionMarginUsd({}), null);
  assert.equal(positionMarginUsd(null), null);
});
