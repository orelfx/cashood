#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Core from '../assets/core.js';
import { atomicJSON, readJSON, lock, downsample, generation, assertPublic } from './lib/io.mjs';
import { accrue } from './lib/accrual.mjs';
import { parseTransfers } from './lib/treasury.mjs';
const DIR=resolve(process.env.CASHOOD_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)),'..','data'),'safebox');
const release=lock(resolve(DIR,'sync.lock.local'));
const cfg=readJSON(resolve(DIR,'config.json'));
const prev=readJSON(resolve(DIR,'live.json'));
// Penempatan dana Safe Box bersifat rahasia. Modul sumbernya berada di luar
// repo publik dan hanya mengembalikan hasil kumulatif; yang terbit dari sini
// hanya pokok, imbal hasil, dan saldo tiap pemilik.
const SOURCE=process.env.CASHOOD_SAFEBOX_SOURCE||'/root/cashood-private/safebox-source.mjs';
// Sejak bunga mengikuti index, sumber ini hanya mengisi catatan internal nilai
// penempatan. Kalau gagal dibaca, bunga tetap dihitung; catatan internal saja
// yang dilewati siklus ini.
let obs=null;
try{obs=await (await import(pathToFileURL(SOURCE).href)).observe({dir:DIR});Core.number(obs.total,'Hasil kumulatif',0);}
catch{obs=null;console.warn('[safebox] nilai penempatan tidak terbaca siklus ini; bunga tetap dihitung');}
const now=Date.now();
// Bunga mengikuti gerak harian Cashood Index (lib/accrual.mjs). Deret lengkap
// index ada di nav.local.json; nav.json publik dipakai kalau berkas lokal belum ada.
const IDX=resolve(DIR,'..','index');
const points=(readJSON(resolve(IDX,'nav.local.json'))||readJSON(resolve(IDX,'nav.json'),{points:[]})).points||[];
const stateFile=resolve(DIR,'accrual-v3.local.json');
const payoutFile=resolve(DIR,'payouts.jsonl');
const payouts=existsSync(payoutFile)?parseTransfers(readFileSync(payoutFile,'utf8')):[];
const state=accrue(cfg,readJSON(stateFile),{at:now,points},payouts);
const principal=state.owners.reduce((t,o)=>t+o.principalUsd,0);
const today=state.today;
// Pemilik yang sudah keluar tetap tampil selama masih ada bunga yang belum dibayar.
const rows=Object.values(state.balances).map(b=>{
 const owner=state.owners.find(o=>o.id===b.id),capital=owner?.principalUsd||0;
 const interest=Core.money(b.accrued+(today?.owners[b.id]||0)-b.paid);
 return {id:b.id,name:b.name,color:b.color,principalUsd:capital,sharePct:principal?capital/principal*100:0,left:!owner,
  interestUsd:interest,paidUsd:Core.money(b.paid),interestTodayUsd:Core.money(today?.owners[b.id]||0),balanceUsd:Core.money(capital+interest)};
}).filter(r=>r.principalUsd>0||r.interestUsd>=0.01);
const interest=Core.money(rows.reduce((t,o)=>t+o.interestUsd,0));
const dailyPct=today?today.ratePct:0, maxM=Number(cfg.rate?.maxMonthlyPct??3);
const done=state.days.filter(d=>d.date>=Core.day(state.from));
const avgDaily=done.length?done.reduce((t,d)=>t+d.ratePct,0)/done.length:dailyPct;
const snapshot={schemaVersion:2,generation:generation(),updatedAt:now,generatedAt:new Date(now+Core.WIB).toISOString().slice(0,16)+' WIB',
 principalUsd:principal,interestUsd:interest,paidUsd:Core.money(rows.reduce((t,o)=>t+o.paidUsd,0)),
 lastPayout:(()=>{const p=payouts.filter(x=>x.type==='interest');if(!p.length)return null;const at=Math.max(...p.map(x=>Date.parse(x.at)));const same=p.filter(x=>Date.parse(x.at)===at);return {at,period:same[0].period||null,usd:Core.money(same.reduce((t,x)=>t+Number(x.usd),0))};})(),
 interestTodayUsd:Core.money(today?.usd||0),valueUsd:Core.money(principal+interest),balanceUsd:Core.money(principal+interest),owners:rows,
 interestDay:Core.day(now),days:[...state.days,...(today?[today]:[])].slice(-30).map(d=>({date:d.date,usd:d.usd,ratePct:d.ratePct??null,estimated:d.estimated})),earning:dailyPct>0,
 quality:{complete:true,estimated:false,allocationEstimated:false},
 measure:{monthlyPct:Number((dailyPct*30).toFixed(3)),dailyPct:Number(dailyPct.toFixed(4)),windowDays:Number(cfg.rate?.windowDays??7),
  windowMovePct:today?.windowMovePct??null,capped:Boolean(today?.capped),
  monthUsedPct:principal?Number((([...state.days,...(today?[today]:[])].filter(d=>d.date.startsWith(Core.day(now).slice(0,7))).reduce((t,d)=>t+state.owners.reduce((u,o)=>u+(d.owners?.[o.id]||0),0),0))/principal*100).toFixed(3)):0,
  avgMonthlyPct:Number((avgDaily*30).toFixed(3)),apyPct:Number((avgDaily*365).toFixed(3)),perDayUsd:today?.usd||0,
  minMonthlyPct:Number(cfg.rate?.minMonthlyPct??0),maxMonthlyPct:maxM,spanDays:done.length,
  basis:'rata-rata kenaikan Cashood Index '+(cfg.rate?.windowDays??7)+' hari terakhir; seminggu rugi = 0; paling banyak '+String(maxM).replace('.',',')+'% per bulan',since:Core.day(state.from)},
 };
assertPublic(snapshot);
const navFile=resolve(DIR,'nav.json'),old=readJSON(navFile,{points:[]});
atomicJSON(stateFile,state);
if(obs){obs.commit?.();
 atomicJSON(navFile,{updatedAt:now,points:downsample([...old.points,{t:now,usd:obs.valueUsd,total:obs.total}],now)});
 atomicJSON(resolve(DIR,'internal.json'),{updatedAt:now,valueUsd:obs.valueUsd,totalUsd:obs.total,estimated:true});}
atomicJSON(resolve(DIR,'live.json'),snapshot);
console.log(`[safebox] saldo=$${snapshot.balanceUsd} bunga=$${interest} pemilik=${rows.length}`);
release();process.exit(0);
