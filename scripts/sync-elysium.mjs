#!/usr/bin/env node
import {resolve} from 'node:path';
import {atomicJSON,assertPublic,readJSON,lock,downsample} from './lib/io.mjs';
import {elysiumPaper,elysiumCustody} from './lib/elysium.mjs';
const data=resolve(process.env.CASHOOD_DATA_DIR||'data');
const release=lock(resolve(data,'elysium','sync.lock.local'));
const now=Date.now();let source=null;
try{const r=await fetch(process.env.ELYSIUM_STATUS_URL||'http://127.0.0.1:3387/api/status',{signal:AbortSignal.timeout(15000)});if(r.ok)source=await r.json();}catch{}
for(const fund of ['elysium','riskelysium']){
 const cfg=readJSON(resolve(data,fund,'config.json'));
 if(!cfg)throw Error('Konfigurasi Elysium belum tersedia');
 // Only independently verified custody exports are eligible for real balances.
 const observed=readJSON(resolve(data,fund,'custody.local.json'),{});
 const custody=elysiumCustody({...observed,fund,chainId:observed.chainId??99901},now);
 const navFile=resolve(data,fund,'nav.local.json');
 const previous=readJSON(navFile,{points:[]});
 // Saldo sebagian (token tanpa harga dihitung $0) juga dicatat, sama seperti di Total aset;
 // dulu kurva berhenti total begitu ada satu token tanpa harga.
 const value=custody.quality.complete?custody.totalUsd:custody.status==='partial'&&Number.isFinite(custody.knownTotalUsd)?custody.knownTotalUsd:null;
 if(value!=null && (!previous.points.length || custody.updatedAt>previous.points.at(-1).t))previous.points=downsample([...previous.points,{t:custody.updatedAt,usd:value,...(custody.quality.complete?{}:{partial:true})}],now);
 atomicJSON(navFile,previous);
 const snapshot={fund,schemaVersion:2,checkedAt:now,label:cfg.label,family:cfg.family,risk:cfg.risk,custody,
  funding:cfg.funding,curve:previous.points,activity:readJSON(resolve(data,fund,'activity.local.json')),...(fund==='elysium'?{simulation:elysiumPaper(source,now),engine:readJSON(resolve(data,fund,'engine.local.json'))}:{})};
 assertPublic(snapshot);atomicJSON(resolve(data,fund,'live.json'),snapshot);
}
release();
