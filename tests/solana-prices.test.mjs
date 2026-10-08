import test from 'node:test';
import assert from 'node:assert/strict';
import { solanaPrices } from '../scripts/lib/solana-prices.mjs';
const response = body => ({ ok: true, json: async () => body });
test('missing Jupiter price uses a quoted market; only a confirmed absent market stays unpriced', async () => {
  const result = await solanaPrices(['SOL', 'extra', 'dead'], { fetchImpl: async url => {
    if (url.includes('jup.ag')) return response({ SOL: { usdPrice: 100 } });
    if (url.endsWith('/dead')) return response({ pairs: null });
    return response({ pairs: [{ chainId: 'solana', baseToken: { address: 'extra' }, priceUsd: '2.5', liquidity: { usd: 1000 } }] });
  } });
  assert.equal(result.prices.extra.usdPrice, 2.5);
  assert.equal(result.prices.SOL.usdPrice, 100);
  assert.deepEqual(result.noMarket, ['dead']);
});
test('prices all assets beyond the first 50 and deduplicates requests', async () => {
  const mints = Array.from({ length: 63 }, (_, i) => 'mint' + i), sizes = [];
  const result = await solanaPrices([...mints, mints[0]], { fetchImpl: async url => {
    const ids = new URL(url).searchParams.get('ids').split(','); sizes.push(ids.length);
    return response(Object.fromEntries(ids.map(id => [id, { usdPrice: 1 }])));
  } });
  assert.deepEqual(sizes, [50, 13]); assert.equal(Object.keys(result.prices).length, 63);
});
test('source outage and malformed or unavailable market prices never become zero', async () => {
  for (const fallback of [() => { throw Error('offline'); }, () => response({}),
    () => ({ ok: false, status: 503 }),
    () => response({ pairs: [{ chainId: 'solana', baseToken: { address: 'extra' }, priceUsd: null }] })]) {
    await assert.rejects(solanaPrices(['extra'], { fetchImpl: async url => url.includes('jup.ag') ? response({}) : fallback() }));
  }
});
