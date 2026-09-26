import Core from '../../assets/core.js';
const { number, money, eventTime } = Core;
/** Merge identities, never guess that equal daily amounts identify a transfer. */
export function treasury(cfg, botRows = [], manualRows = []) {
  const opening = number(cfg.treasury?.openingUsd ?? 0, 'Kas awal', 0);
  const from = cfg.treasury?.countFromAt ?? (cfg.treasury?.countFrom ? eventTime({ date: cfg.treasury.countFrom }) : 0);
  const map = new Map();
  const all = [...botRows.map(r => ({ at: r.at ?? Date.parse(r.day), usd: r.amountUsd, tx: r.tx, asset: 'USDG', type: 'sweep' })), ...manualRows];
  for (const r of all) {
    const at = typeof r.at === 'number' ? r.at : Date.parse(r.at);
    if (!Number.isFinite(at) || at <= 0 || at > Date.now()+60000) throw new Error('Waktu transfer kas tidak valid');
    if (at < from) continue; // Opening balance already includes older transfers.
    const usd = money(number(r.usd, 'Transfer kas', 0.01));
    const type = r.type || 'sweep';
    if (!['sweep','deposit','expense','dividend','withdraw','interest'].includes(type)) throw new Error('Jenis transfer kas tidak valid');
    const identity = String(r.tx || r.id || '').trim();
    const key = /^0x[0-9a-f]+$/i.test(identity) ? identity.toLowerCase() : identity;
    if (!key) throw new Error('Transfer kas memerlukan tx atau id unik; rekonsiliasi catatan lama dahulu');
    const entry = { ...r, at, usd, type, asset: r.asset || 'USDG' };
    if (map.has(key)) {
      const prev = map.get(key);
      if (prev.usd !== usd || prev.type !== type) throw new Error('Transfer dengan ID sama mempunyai nominal/jenis berbeda');
      continue;
    }
    map.set(key, entry);
  }
  const rows = [...map.values()].filter(r => r.at >= from).sort((a,b)=>a.at-b.at);
  const cutoff = cfg.dividend?.legacy?.cutoff;
  const layers = opening ? [{ usd: opening, before: cutoff ? eventTime({date:cutoff}) : (from || Date.now()), label: cfg.treasury?.openingLabel || 'saldo awal' }] : [];
  let balance = opening, newUsd = 0;
  for (const r of rows) {
    const incoming = ['sweep','deposit'].includes(r.type);
    balance = money(balance + (incoming ? r.usd : -r.usd));
    if (balance < 0) throw new Error('Pengeluaran melebihi kas cadangan tercatat');
    if (incoming) { newUsd = money(newUsd+r.usd); layers.push({usd:r.usd,before:r.at+1,label:'laba tersapu'}); }
    else { let remaining = r.usd;
      for (const l of layers) { const cut=Math.min(l.usd,remaining); l.usd=money(l.usd-cut); remaining=money(remaining-cut); if(!remaining)break; }
    }
  }
  return { costsPaidUsd: money(rows.filter(r=>r.type==='expense' && (r.period || Core.day(r.at).slice(0,7))===Core.day(Date.now()).slice(0,7)).reduce((t,r)=>t+r.usd,0)), outflowTotalUsd: money(rows.filter(r=>!['sweep','deposit'].includes(r.type)).reduce((t,r)=>t+r.usd,0)), treasuryUsd: balance, treasuryDistributableUsd: balance, treasuryOpeningUsd: opening,
    treasuryOpeningLabel: cfg.treasury?.openingLabel || null, treasuryNewUsd: newUsd,
    treasuryCountFrom: cfg.treasury?.countFrom || (from ? Core.day(from) : null),
    treasuryMoves: rows.slice(-40).map(({at,usd,asset,type})=>({at,usd,asset,type})), dividendLayers:layers.filter(l=>l.usd>0) };
}
export function parseTransfers(text) {
  const rows=[];const lines=text.split('\n');
  for (let i=0;i<lines.length;i++) {
    const line=lines[i].trim();if(!line||line.startsWith('#'))continue;
    try { rows.push(JSON.parse(line)); } catch { throw new Error(`Transfer kas baris ${i+1} belum lengkap/rusak`); }
  }
  return rows;
}
