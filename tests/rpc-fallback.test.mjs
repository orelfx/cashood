import test from 'node:test';
import assert from 'node:assert/strict';
import { solanaRpc, solanaRpcList, PUBLIC_SOLANA_RPCS } from '../scripts/lib/rpc-env.mjs';

const json = (body, status = 200) => ({ status, json: async () => body });

test('RPC Solana: utama dijeda → cadangan dipakai', async () => {
  const seen = [];
  const out = await solanaRpc('getBalance', ['x'], { urls: ['https://utama', 'https://cadangan'], fetchImpl: async (url) => {
    seen.push(url);
    return url === 'https://utama' ? json({ error: { code: -32005, message: 'The services are paused due to unpaid invoices' } }) : json({ result: { value: 42 } });
  } });
  assert.deepEqual(seen, ['https://utama', 'https://cadangan']);
  assert.equal(out.value, 42);
});

test('RPC Solana: semua gagal → error terakhir dilempar', async () => {
  await assert.rejects(solanaRpc('getSlot', [], { urls: ['https://a', 'https://b'], fetchImpl: async (url) => { if (url === 'https://a') throw new Error('timeout'); return json({}, 429); } }), /getSlot: HTTP 429/);
});

test('RPC Solana: daftar selalu berakhir dengan RPC publik', () => {
  const list = solanaRpcList();
  for (const u of PUBLIC_SOLANA_RPCS) assert.ok(list.includes(u));
});
