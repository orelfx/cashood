#!/usr/bin/env node
/*
 * cashood — snapshot exporter (opsional).
 *
 * Situsnya sendiri hanya bisa membaca saldo token dari RPC publik. Nilai posisi
 * LP tidak kelihatan dari browser, jadi script ini yang menghitungnya: dia
 * memakai kode bot yang sudah ada (bookValueUsd + readBook) lalu menulis
 * data/live.json. Yang keluar cuma angka — tidak ada key, tidak ada seed.
 *
 *   RR_HOME=/root/robinhood node scripts/sync.mjs
 *
 * Jalankan tiap jam lewat cron, lalu commit + push data/live.json:
 *   0 * * * * cd /root/cashood && node scripts/sync.mjs >> /tmp/cashood-sync.log 2>&1
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '..', 'data', 'live.json');
const RR_HOME = process.env.RR_HOME || '/root/robinhood';

const load = (rel) => import(pathToFileURL(resolve(RR_HOME, rel)).href);

process.chdir(RR_HOME);                       // .env dan .state dibaca relatif ke sini
await load('node_modules/dotenv/config.js').catch(() => {});

const { bookValueUsd, readBook } = await load('manager.js');
const { balanceOf } = await load('venue/quote.js');
const { ethUsd } = await load('venue/price.js');
const { getWallet } = await load('chain/signer.js');
const { NATIVE, USDG, WETH } = await load('chain/addresses.js');

const wallet = getWallet('multi');
if (!wallet) throw new Error('wallet "multi" tidak ketemu — cek RR_* di .env');

const price = await ethUsd();
const [eth, usdg, weth] = await Promise.all([
  balanceOf(NATIVE, wallet.address).catch(() => 0n),
  balanceOf(USDG, wallet.address).catch(() => 0n),
  balanceOf(WETH, wallet.address).catch(() => 0n),
]);

const holdings = [
  { symbol: 'ETH', amount: Number(eth) / 1e18, price },
  { symbol: 'USDG', amount: Number(usdg) / 1e6, price: 1 },
  { symbol: 'WETH', amount: Number(weth) / 1e18, price },
]
  .filter((h) => h.amount > 0)
  .map((h) => ({ ...h, usd: h.price == null ? null : h.amount * h.price }));

const positions = [];
for (const book of await readBook()) {
  for (const p of book.positions || []) {
    if (p.error) continue;
    positions.push({
      tokenId: String(p.tokenId ?? ''),
      symbol: p.symbol ?? null,
      principalUsd: Number(p.principalUsd) || 0,
      feesUsd: Number(p.feesUsd) || 0,
    });
  }
}

const totalUsd = await bookValueUsd('multi');
if (!Number.isFinite(totalUsd) || totalUsd <= 0) throw new Error(`bookValueUsd tidak masuk akal: ${totalUsd}`);

const snapshot = {
  updatedAt: Date.now(),
  address: wallet.address,
  totalUsd: Number(totalUsd.toFixed(2)),
  ethPrice: price,
  holdings,
  positions,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`[cashood] ${new Date().toISOString()} total=$${snapshot.totalUsd} positions=${positions.length} -> ${OUT}`);
process.exit(0);
