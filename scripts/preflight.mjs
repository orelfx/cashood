#!/usr/bin/env node
// Read-only checks before installing code into the cron checkout.
import { resolve,dirname } from 'node:path';import {fileURLToPath} from 'node:url';
import { readJSON } from './lib/io.mjs';import { readFileSync,existsSync } from 'node:fs';
import Core from '../assets/core.js';import {treasury,parseTransfers} from './lib/treasury.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=resolve(process.argv[2]||root);let failed=false;
for(const fund of ['reborn','meridian','ferari']){
 try{
  const cfg=readJSON(resolve(root,'data',fund,'config.json')),ledger=Core.buildLedger(cfg);
  const old=readJSON(resolve(source,'data',fund,'live.json'));
  const manual=resolve(source,'data',fund,'treasury.jsonl');
  if(existsSync(manual))treasury(cfg,[],parseTransfers(readFileSync(manual,'utf8')));
  console.log(`${fund}: ${ledger.owners.length} investor, ${ledger.totalUnits.toFixed(6)} unit; snapshot sumber ${old?new Date(old.updatedAt).toISOString():'belum ada'}`);
 }catch(err){console.error(`${fund}: ${err.message}`);failed=true;}
}
const sb=readJSON(resolve(source,'data/safebox/live.json'));
if(sb?.owners?.length)console.log(`Safe Box: ${sb.owners.length} saldo pemilik dapat dibekukan sebagai baseline migrasi; riwayat lama tidak dialokasikan ulang.`);
if(failed)process.exitCode=1;
