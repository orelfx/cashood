/*
 * GMSOL wallet.tokens[]: token selain SOL di wallet (PROMPT_GMSOL_DATA.md field 5).
 * Murni (tanpa jaringan) supaya bisa dites. Alamat mint TIDAK pernah keluar: hanya
 * id stabil "token#N" (nomor urut tetap per mint, disimpan lokal) + simbol.
 * Bentuk per token: { id, symbol, amount, priceUsd, usd, quotedUsd, countedUsd }.
 * SEMUA token dihitung $0 untuk nilai dana, PnL, dan grafik (seperti excludedTokens/NITA): usd = countedUsd = 0;
 * quotedUsd = jumlah x harga Jupiter, hanya info. Tanpa harga → priceUsd/quotedUsd null.
 */
const ADDR = /[1-9A-HJ-NP-Za-km-z]{32,}/g;
const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const clean = (s, max = 16) => (s == null ? null : String(s).replace(ADDR, '').replace(/[\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);

/**
 * @param {Array<{mint:string, amount:number}>} accounts saldo token on-chain (sudah dibagi desimal)
 * @param {Record<string,{usdPrice?:number}>} prices harga Jupiter per mint
 * @param {Record<string,{symbol?:string}>} meta simbol per mint
 * @param {{ids?:Record<string,number>, next?:number}} idMap peta mint → nomor (diubah di tempat)
 * @param {string[]} skipMints mint yang tidak dihitung (SOL/wSOL)
 */
export function buildTokens(accounts, prices = {}, meta = {}, idMap = {}, skipMints = []) {
  idMap.ids ||= {}; idMap.next ||= 1;
  const byMint = new Map();
  for (const a of accounts || []) {
    if (!a || !a.mint || skipMints.includes(a.mint) || !fin(a.amount) || Number(a.amount) <= 0) continue;
    byMint.set(a.mint, (byMint.get(a.mint) || 0) + Number(a.amount));
  }
  const out = [];
  for (const [mint, amount] of byMint) {
    if (!idMap.ids[mint]) idMap.ids[mint] = idMap.next++;
    const p = fin(prices?.[mint]?.usdPrice) ? Number(prices[mint].usdPrice) : null;
    out.push({ id: `token#${idMap.ids[mint]}`, symbol: clean(meta?.[mint]?.symbol), amount: Number(amount.toPrecision(12)),
      priceUsd: p == null ? null : Number(p.toPrecision(6)), usd: 0, quotedUsd: p == null ? null : Number((amount * p).toFixed(2)), countedUsd: 0 });
  }
  out.sort((a, b) => (b.quotedUsd ?? -1) - (a.quotedUsd ?? -1) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const priced = out.filter((t) => t.quotedUsd != null);
  return { tokens: out, tokensUsd: 0, tokensQuotedUsd: Number(priced.reduce((s, t) => s + t.quotedUsd, 0).toFixed(2)), tokensUnpriced: out.length - priced.length };
}

/** Nilai wallet GMSOL: SOL bebas + nilai LP + fee belum diklaim. Token TIDAK pernah ikut (dihitung $0). */
export function walletTotal({ solUsd, lpUsd, unclaimedUsd }) {
  const ok = [solUsd, lpUsd, unclaimedUsd].every(fin);
  return ok ? Number((Number(solUsd) + Number(lpUsd) + Number(unclaimedUsd)).toFixed(2)) : null;
}

/**
 * Nomor token tunggal = label mesin di excludedTokens (token#N). Cocokkan per token wallet
 * dengan item spl_token mesin lewat simbol + jumlah unit (toleransi relatif 1e-6), lalu unit saja.
 * Token tanpa pasangan: id null, inExcluded false (tetap $0). Tidak ada alamat yang dipakai/keluar.
 */
export function mapExcluded(tokens, items) {
  const pool = (Array.isArray(items) ? items : []).filter((i) => i && ((i.kind === 'spl_token' && /^token#\d+$/.test(String(i.label))) || /nft/.test(String(i.kind))));
  const used = new Set();
  const near = (a, b) => fin(a) && fin(b) && Math.abs(Number(a) - Number(b)) <= Math.max(1e-12, Math.abs(Number(b)) * 1e-6);
  const pick = (f) => pool.find((i) => !used.has(i.label) && f(i));
  return (tokens || []).map((t) => {
    const m = (t.symbol && pick((i) => i.symbol === t.symbol && near(t.amount, i.units))) || pick((i) => near(t.amount, i.units) && (!i.symbol || !t.symbol || i.symbol === t.symbol));
    if (m) used.add(m.label);
    return { ...t, id: m ? m.label : null, inExcluded: !!m };
  });
}
