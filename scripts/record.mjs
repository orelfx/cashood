#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Core from '../assets/core.js';
import { atomicJSON, lock } from './lib/io.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), flags={}, positional=[];
const booleans=new Set(['dry','push','force']);
for(let i=0;i<args.length;i++){
  if(!args[i].startsWith('--')){positional.push(args[i]);continue;}
  const name=args[i].slice(2);if(!['dry','push','force','fund','id','nav','at','date','note','prorata','batch'].includes(name))throw new Error(`Opsi tidak dikenal: ${name}`);
  if(flags[name]!==undefined)throw new Error(`Opsi duplikat: ${name}`);
  flags[name]=booleans.has(name)?true:args[++i];if(flags[name]==null||String(flags[name]).startsWith('--'))throw new Error(`Nilai --${name} wajib`);
}
const fund=flags.fund||'reborn';if(!['reborn','meridian','ferari'].includes(fund))throw new Error('Dana tidak dikenal');
const type=positional[0];if(!['deposit','withdraw','reinvest'].includes(type))throw new Error('Pakai: record.mjs deposit|withdraw|reinvest owner usd --id ID --at ISO [--nav USD] [--dry]');
const prorata=flags.prorata!==undefined;if(prorata&&type!=='withdraw')throw new Error('Pro-rata hanya untuk withdrawal');
const owner=prorata?null:positional[1];const amount=Core.number(prorata?flags.prorata:positional[2],'Nominal',0.01);
if(Math.abs(amount-Core.money(amount))>1e-8)throw new Error('Nominal maksimal dua desimal');
if(!/^[a-zA-Z0-9_.:-]{3,160}$/.test(flags.id||''))throw new Error('--id unik wajib; gunakan ID transaksi yang sama saat mengulang');
const at=flags.at ? Date.parse(flags.at) : flags.date ? Core.eventTime({date:flags.date}) : Date.now();
if(!Number.isFinite(at)||at>Date.now()+60000)throw new Error('Waktu transaksi tidak valid');
const date=flags.date||Core.day(at);Core.eventTime({at,date});
const dir=resolve(process.env.CASHOOD_DATA_DIR||resolve(ROOT,'data'),fund),configPath=resolve(dir,'config.json');
const release=lock(resolve(dir,'record.lock.local'));
try{
 const cfg=JSON.parse(readFileSync(configPath,'utf8'));
 const duplicate=(cfg.events||[]).filter(e=>e.id===flags.id||e.id?.startsWith(flags.id+':'));
 if(duplicate.length)throw new Error(`ID ${flags.id} sudah tercatat; tidak menulis ulang`);
 const ledger=Core.buildLedger(cfg);
 if(ledger.events.some(e=>e.at>at)&&!flags.nav&&type!=='reinvest')throw new Error('Transaksi historis memerlukan --nav pada waktu transaksi');
 let nav;
 if(type==='reinvest') nav=1;
 else if(flags.nav!==undefined)nav=Core.number(flags.nav,'NAV sebelum transaksi',0.01);
 else{
  const live=JSON.parse(readFileSync(resolve(dir,'live.json'),'utf8'));
  Core.validateSnapshot(live,{maxAge:30*60000,complete:true});nav=live.totalUsd;
  if(Math.abs(at-live.updatedAt)>30*60000)throw new Error('Waktu transaksi jauh dari snapshot; gunakan NAV historis');
  if(type==='deposit'&&!flags.force){
   const series=JSON.parse(readFileSync(resolve(dir,'nav.json'),'utf8')).points||[];
   const [a,b]=series.slice(-2);if(a&&b&&Date.now()-b.t<30*60000){
    const jump=(b.usd-(b.lp||0))-(a.usd-(a.lp||0));
    if(Math.abs(jump-amount)<Math.max(5,amount*.05))throw new Error(`Dana tampaknya sudah masuk; verifikasi --nav sebelum transfer (perkiraan ${Core.money(nav-amount)})`);
   }
  }
 }
 const before=Core.buildLedger(cfg,{before:at+1});
 const shares=before.owners.filter(o=>o.units>0).map(o=>({id:o.id,share:o.units}));
 const cuts=prorata?Core.allocate(amount,shares):{[owner]:amount};
 const batch=flags.batch||(prorata?flags.id:undefined);
 const events=Object.entries(cuts).filter(([,usd])=>usd>0).map(([id,usd])=>({id:prorata?`${flags.id}:${id}`:flags.id,date,at,type,owner:id,usd,
  ...(type==='reinvest'?{}:{navBefore:nav}),...(batch?{batchId:batch}:{}),note:flags.note||''}));
 const after={...cfg,events:[...cfg.events,...events]};Core.buildLedger(after);
 console.log(JSON.stringify({fund,events,afterUnits:Core.buildLedger(after).totalUnits},null,2));
 if(!flags.dry){atomicJSON(configPath,after);console.log('Transaksi tersimpan atomik.');}
 if(flags.push&&!flags.dry){if(process.env.CASHOOD_DATA_DIR)throw new Error('--push tidak tersedia pada direktori data alternatif');
  for(const command of [['add',`data/${fund}/config.json`],['commit','-m',`data: ${fund} ${type} ${flags.id}`],['push']])execFileSync('git',command,{cwd:ROOT,stdio:'inherit'});}
}finally{release();}
