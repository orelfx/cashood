// Resolve every requested asset. An unavailable price is not a zero balance.
export async function solanaPrices(mints, { fetchImpl = globalThis.fetch } = {}) {
  const ids = [...new Set(mints)], prices = {}, noMarket = [];
  const read = async url => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Sumber harga tidak tersedia (HTTP ${r.status})`);
    return r.json();
  };
  for (let i = 0; i < ids.length; i += 50) {
    const data = await read('https://lite-api.jup.ag/price/v3?ids=' + ids.slice(i, i + 50).join(','));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Jawaban harga Jupiter tidak valid');
    for (const mint of ids.slice(i, i + 50)) {
      const price = data[mint]?.usdPrice;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices[mint] = { usdPrice: price, source: 'jupiter' };
    }
  }
  for (const mint of ids.filter(id => !prices[id])) {
    const data = await read('https://api.dexscreener.com/latest/dex/tokens/' + mint);
    if (!data || !('pairs' in data) || (data.pairs !== null && !Array.isArray(data.pairs))) throw new Error('Jawaban pasar cadangan tidak valid');
    const pairs = (data.pairs || []).filter(p => p.chainId === 'solana' && p.baseToken?.address === mint);
    if (!pairs.length) { noMarket.push(mint); continue; }
    const priced = pairs.filter(p => Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0)
      .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    if (!priced.length) throw new Error('Token memiliki pasar tetapi harganya belum terbaca');
    prices[mint] = { usdPrice: Number(priced[0].priceUsd), source: 'dexscreener' };
  }
  return { prices, noMarket };
}
