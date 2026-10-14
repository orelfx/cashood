import { wordlist } from '@scure/bip39/wordlists/english';
const words=new Set(wordlist);
// Reject secret material before redacting public identifiers. Never echo a hit.
export function assertHeartbeatText(text,{walletAddress=null,secrets=[]}={}) {
 if(typeof text!=='string'||!text.trim())throw new Error('heartbeat text missing');
 if(walletAddress&&text.toLowerCase().includes(walletAddress.toLowerCase()))throw new Error('heartbeat contains private wallet identity');
 if(secrets.some(v=>typeof v==='string'&&v.length>=8&&text.includes(v)))throw new Error('heartbeat contains a configured secret');
 const forbidden=[
  /\b(?:0x)?[0-9a-f]{64}\b/i,
  /\b(?:PRIVATE[_ -]?KEY|MNEMONIC|SEED[_ -]?PHRASE|BOT[_ -]?TOKEN|API[_ -]?KEY|WALLET[_ -]?KEY|PASSWORD|SECRET)\b["']?\s*[:=]/i,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
  /https?:\/\/[^\s"<>]+[?&](?:key|token|api_key)=/i,
  /\b(?:sk-proj-|sk-ant-|sk-)[A-Za-z0-9_-]{20,}/,
 ];
 if(forbidden.some(re=>re.test(text)))throw new Error('heartbeat contains secret-like material');
 // BIP39 English vocabulary, including multiline/case variants. Conservatively
 // reject 12+ consecutive vocabulary words even with an invalid checksum.
 for(const run of text.normalize('NFKD').toLowerCase().matchAll(/[a-z]+(?:\s+[a-z]+)*/g)){
  let n=0;
  for(const word of run[0].split(/\s+/)){n=words.has(word)?n+1:0;if(n>=12)throw new Error('heartbeat contains mnemonic-like material');}
 }
}
export function sanitizeHeartbeatText(text,options={}) {
 assertHeartbeatText(text,options);
 return text.replace(/0x[0-9a-fA-F]{40,64}\b/g,'[identitas disembunyikan]')
  .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,'[identitas disembunyikan]');
}
// Strict allowlist: archive metadata must not smuggle arbitrary source fields.
export function publicHeartbeatRow(row,options={}) {
 if(!row||typeof row!=='object')throw new Error('invalid heartbeat row');
 const generatedAt=row.generatedAt==null?null:row.generatedAt;
 if(generatedAt!==null&&!(typeof generatedAt==='number'&&Number.isFinite(generatedAt))&&!(typeof generatedAt==='string'&&/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?: WIB|(?:\.\d{3})?Z)?$/.test(generatedAt)))throw new Error('invalid heartbeat timestamp');
 return {updatedAt:Number.isFinite(row.updatedAt)?row.updatedAt:null,generatedAt,source:row.source==='rendered'?'rendered':'mirror',text:sanitizeHeartbeatText(row.text,options)};
}
