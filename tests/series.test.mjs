import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSpikes } from '../scripts/lib/io.mjs';

const series = (values) => values.map((usd, i) => ({ t: i * 600000, usd }));

test('a one-point misread that recovers is dropped', () => {
  const out = dropSpikes(series([13600, 13610, 12900, 13620, 13615]));
  assert.deepEqual(out.map((p) => p.usd), [13600, 13610, 13620, 13615]);
});

test('a two-point misread that recovers is dropped', () => {
  const out = dropSpikes(series([10400, 10396, 9727, 9721, 10383, 10380]));
  assert.deepEqual(out.map((p) => p.usd), [10400, 10396, 10383, 10380]);
});

test('an upward spike that returns is dropped too', () => {
  const out = dropSpikes(series([13567, 13560, 14243, 13538, 13540]));
  assert.equal(out.some((p) => p.usd === 14243), false);
});

test('a deposit is a step, not a spike, and is kept', () => {
  const vals = [10358, 10360, 13302, 14009, 14010, 14005];
  assert.deepEqual(dropSpikes(series(vals)).map((p) => p.usd), vals);
});

test('a sustained fall is real movement and is kept', () => {
  const vals = [10000, 9950, 9600, 9580, 9590, 9570];
  assert.deepEqual(dropSpikes(series(vals)).map((p) => p.usd), vals);
});

test('an impossible reading is dropped even when its neighbours differ', () => {
  const out = dropSpikes(series([4700, 4720, 28.47, 4655, 4700]));
  assert.equal(out.some((p) => p.usd === 28.47), false);
});
