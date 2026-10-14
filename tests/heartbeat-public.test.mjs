import test from 'node:test';
import assert from 'node:assert/strict';
import {assertHeartbeatText,sanitizeHeartbeatText,publicHeartbeatRow} from '../scripts/lib/heartbeat-public.mjs';
test('ordinary long lower-case explanations are publishable',()=>{
 assert.doesNotThrow(()=>assertHeartbeatText('the position remains inside its configured range while accrued trading fees continue to increase over time'));
});
test('mnemonics, keys, tokens and configured secrets remain blocked without echoing material',()=>{
 const fixtures=['abandon '.repeat(11)+'about','ABANDON\n'.repeat(12),'abandon '.repeat(24), '0x'+'a'.repeat(64),'b'.repeat(64),'MNEMONIC = hidden','"API_KEY": "hidden"','wallet_key=hidden','123456789:'+'X'.repeat(35),'https://rpc.example/?api_key=hidden','sk-proj-'+'X'.repeat(30)];
 for(const value of fixtures){assert.throws(()=>assertHeartbeatText(value));}
 assert.throws(()=>assertHeartbeatText('value opaqueCredential987',{secrets:['opaqueCredential987']}),e=>!e.message.includes('opaqueCredential987'));
});
test('wallet block and identifier sanitization still work',()=>{
 const address='0x'+'1'.repeat(40);
 assert.throws(()=>sanitizeHeartbeatText('wallet '+address,{walletAddress:address}));
 assert.equal(sanitizeHeartbeatText('pool '+address),'pool [identitas disembunyikan]');
});
test('archive fields are allowlisted and every text checked',()=>{
 const row=publicHeartbeatRow({updatedAt:1,generatedAt:'2026-10-12 17:04:00 WIB',source:'mirror',text:'position report',extraSecret:'do not publish'});
 assert.equal('extraSecret' in row,false);
 assert.throws(()=>publicHeartbeatRow({...row,text:'abandon '.repeat(12)}));
 assert.throws(()=>publicHeartbeatRow({...row,generatedAt:'not a timestamp'}));
});

import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('exporter publishes ordinary prose and refuses secret current/archive without overwriting last good output',()=>{
 const root=mkdtempSync(join(tmpdir(),'cashood-heartbeat-test-'));
 try{
  const home=join(root,'bot');mkdirSync(join(home,'.state'),{recursive:true});
  const mirror=join(home,'.state','heartbeat.json'),out=join(root,'public','heartbeat.json');
  const put=text=>writeFileSync(mirror,JSON.stringify({generatedAt:'2026-10-12 21:04:00 WIB',text}));
  const run=()=>spawnSync(process.execPath,[resolve('scripts/heartbeat.mjs'),out],{encoding:'utf8',env:{PATH:process.env.PATH,RR_HOME:home}});
  put('the position remains inside its configured range while accrued trading fees continue to increase over time');
  const good=run();assert.equal(good.status,0,good.stderr);const saved=readFileSync(out,'utf8');
  put('abandon '.repeat(11)+'about');const bad=run();assert.notEqual(bad.status,0);assert.equal(readFileSync(out,'utf8'),saved);assert.ok(!bad.stderr.includes('abandon'));
  put('ordinary new report');const prior=JSON.parse(saved);prior.archive=[{generatedAt:'2026-10-11 20:00:00 WIB',text:'PRIVATE_KEY=neverpublish'}];writeFileSync(out,JSON.stringify(prior));const before=readFileSync(out,'utf8');
  const badArchive=run();assert.notEqual(badArchive.status,0);assert.equal(readFileSync(out,'utf8'),before);assert.ok(!badArchive.stderr.includes('neverpublish'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
