#!/usr/bin/env node
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import Core from '../assets/core.js';
import { readJSON,atomicJSON,assertPublic } from './lib/io.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),destination=resolve(process.argv[2]||'');
if(!process.argv[2]||destination===ROOT)throw new Error('Direktori staging eksplisit wajib');
let failed=false;
for(const fund of ['reborn','meridian','ferari','safebox']){
 try{
  const dir=resolve(ROOT,'data',fund),live=readJSON(resolve(dir,'live.json'));if(!live)throw new Error('Snapshot belum ada');
  assertPublic(live);
  if(live.schemaVersion!==2)throw new Error('Snapshot versi lama belum disanitasi; jangan publikasi ulang');
  if(fund!=='safebox')Core.validateSnapshot(live);
  const nav=fund==='safebox'?null:readJSON(resolve(dir,'nav.json'));
  if(nav&&nav.generation!==live.generation)throw new Error('Generasi snapshot dan deret belum cocok');
  // File writes here are private until a single Git commit publishes all of them.
  atomicJSON(resolve(destination,fund,'live.json'),live);
  atomicJSON(resolve(destination,fund,'config.json'),readJSON(resolve(dir,'config.json')));
  if(nav)atomicJSON(resolve(destination,fund,'nav.json'),nav);
  for(const name of ['heartbeat.json','forecast.json']){
   if(fund==='safebox')continue;
   const value=readJSON(resolve(dir,name));if(value){assertPublic(value);atomicJSON(resolve(destination,fund,name),value);}
  }
 }catch(err){console.error(`[stage] ${fund}: ${err.message}`);failed=true;}
}
rmSync(resolve(destination,'safebox','nav.json'),{force:true});
// Valid other funds may still publish, but the operator gets a nonzero status.
if(failed)process.exitCode=2;
