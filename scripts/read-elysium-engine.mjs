#!/usr/bin/env node
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
import {atomicJSON,readJSON,lock,assertPublic} from './lib/io.mjs';
import {engineSnapshot} from './lib/elysium-engine.mjs';
const root=resolve(process.env.ELYSIUM_HOME||'/root/ELYSIUM'),data=resolve(process.env.CASHOOD_DATA_DIR||'data'),release=lock(resolve(data,'elysium','engine.lock.local'));
const wallet=readJSON(resolve(data,'elysium','wallet.local.json'))?.address?.toLowerCase();
const line=readFileSync(resolve(root,'.env'),'utf8').split('\n').find(x=>/^\s*ELYSIUM_WALLET_ADDRESS\s*=/.test(x));
const configured=line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g,'').toLowerCase();
if(!wallet||configured!==wallet)throw Error('Wallet mesin tidak cocok dengan dana Elysium LP');
const db=new DatabaseSync(resolve(process.env.ELYSIUM_HUNTER_DB||resolve(root,'.hunter/market.sqlite')),{readOnly:true});
try{
 db.exec('BEGIN');
 const runtime=key=>{const row=db.prepare('SELECT value FROM hunter_meta WHERE key=?').get('runtime:'+key);return row?JSON.parse(row.value):null;};
 const live=runtime('live-status'),archivePath=resolve(data,'elysium','engine-exits.local.json'),archive=readJSON(archivePath,[]);
 const lasts=db.prepare("SELECT value FROM hunter_meta WHERE key LIKE 'runtime:live-last-exit%'").all().map(r=>JSON.parse(r.value));
 for(const last of lasts)if(last?.owner?.toLowerCase()===wallet&&last.id){const i=archive.findIndex(x=>x.id===last.id);if(i<0)archive.push(last);else archive[i]=last;}
 const input={cycle:runtime('cycle'),live,performance:runtime('live-performance'),audit:runtime('decision-audit'),completed:runtime('live-transactions')?.completed||{},exits:archive.filter(x=>x.owner?.toLowerCase()===wallet),paperPositions:db.prepare('SELECT data FROM hunter_paper_positions').all().map(r=>JSON.parse(r.data)),paperCycles:db.prepare('SELECT data FROM hunter_strategy_cycles ORDER BY at DESC LIMIT 24').all().map(r=>JSON.parse(r.data))};
 db.exec('COMMIT');const output=engineSnapshot(input);assertPublic(output);atomicJSON(archivePath,archive);atomicJSON(resolve(data,'elysium','engine.local.json'),output);console.log('[elysium engine]',output.status,output.mode,output.state,'closed',output.closedCount);
}finally{db.close();release();}
