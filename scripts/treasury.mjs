#!/usr/bin/env node
// Record an already completed transfer. This command NEVER sends money.
import { readFileSync, appendFileSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../assets/core.js';
import { lock } from './lib/io.mjs';
import { parseTransfers } from './lib/treasury.mjs';
const args=process.argv.slice(2),get=(k)=>{const i=args.indexOf('--'+k);return i<0?null:args[i+1];};
const fund=get('fund')||'reborn';if(!['reborn','meridian','ferari','safebox'].includes(fund))throw new Error('Dana tidak dikenal');
const type=args[0];if(!['sweep','deposit','expense','dividend','withdraw','interest'].includes(type))throw new Error('Jenis transfer tidak valid');
const id=get('id'),tx=get('tx');if(!/^[a-zA-Z0-9_.:-]{3,160}$/.test(id||tx||''))throw new Error('--id atau --tx wajib');
const amount=Core.number(get('usd'),'Nominal',.01);const usd=Core.money(amount);if(Math.abs(amount-usd)>1e-9)throw new Error('Nominal maksimal dua desimal');const at=Date.parse(get('at')||'');if(!Number.isFinite(at)||at>Date.now()+60000)throw new Error('--at ISO waktu transfer wajib');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const dir=resolve(process.env.CASHOOD_DATA_DIR||resolve(root,'data'),fund);
const release=lock(resolve(dir,'treasury.lock.local'));
try{
 const path=resolve(dir,fund==='safebox'?'payouts.jsonl':'treasury.jsonl');const text=existsSync(path)?readFileSync(path,'utf8'):'';const rows=parseTransfers(text);
 if(rows.some(r=>(id&&r.id===id)||(tx&&r.tx?.toLowerCase()===tx.toLowerCase())))throw new Error('Transfer sudah tercatat');
 const entry={id:id||tx,tx:tx||undefined,type,at,usd,asset:get('asset')||'USDG',owner:get('owner')||undefined,period:get('period')||Core.day(at).slice(0,7)};
 if(fund==='safebox'&&(!entry.owner||type!=='interest'))throw new Error('Safe Box hanya menerima pembayaran interest dengan --owner ID');
 if(text&&!text.endsWith('\n'))throw new Error('Baris terakhir belum lengkap; periksa sebelum append');
 if(!args.includes('--dry')){const fd=openSync(path,'a',0o600);try{appendFileSync(fd,JSON.stringify(entry)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
 console.log(JSON.stringify({...entry,tx:tx?'[tersimpan lokal]':undefined},null,2));
}finally{release();}
