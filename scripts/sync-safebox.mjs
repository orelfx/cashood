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
const cfg=readJSON(resolve(DIR,'config.json')),secret=readJSON(resolve(DIR,'position.local.json'));
const prev=readJSON(resolve(DIR,'live.json'));
if(!process.argv.includes('--now')&&prev?.schemaVersion===2&&Date.now()-prev.updatedAt<55*60000){release();process.exit(0);}
const home=process.env.RR_HOME||'/root/robinhood';process.chdir(home);
const load=rel=>import(pathToFileURL(resolve(home,rel)).href);
await load('node_modules/dotenv/config.js');
const {getPositionPnl}=await load('venue/univ4.js'),{ethUsd}=await load('venue/price.js');
const price=Core.number(await ethUsd(),'Harga ETH',.01);
const pos=await getPositionPnl({tokenId:BigInt(secret.position.tokenId)});
if(pos.feesError)throw new Error('Fee Safe Box gagal dibaca');
const eth=v=>Core.number(v,'ETH mentah',0)/1e18*price,usd=v=>Core.number(v,'USDG mentah',0)/1e6;
const valueUsd=eth(pos.amount0)+usd(pos.amount1),unclaimed=eth(pos.fees0)+usd(pos.fees1);
if(!Number.isFinite(valueUsd)||valueUsd<=0||!Number.isFinite(unclaimed)||unclaimed<0||unclaimed>Math.max(10,valueUsd*2))throw new Error('Nilai Safe Box tidak wajar; snapshot lama dipertahankan');
const book=readJSON(resolve(DIR,'fees.json'),{collectedUsd:0,lastUnclaimedUsd:unclaimed,since:Date.now()});
Core.number(book.collectedUsd,'Buku fee kumulatif',0);
const last=Core.number(book.lastUnclaimedUsd,'Fee terakhir',0);
// Claims remain an estimate until confirmed claim events are available for this external position.
if(last-unclaimed>.02&&unclaimed<last*.3)book.collectedUsd+=last-unclaimed;
book.lastUnclaimedUsd=unclaimed;
const fee=book.collectedUsd+unclaimed,now=Date.now();
const stateFile=resolve(DIR,'accrual-v2.local.json');
const payoutFile=resolve(DIR,'payouts.jsonl');
const state=accrue(cfg,readJSON(stateFile),{at:now,fee},prev,existsSync(payoutFile)?parseTransfers(readFileSync(payoutFile,'utf8')):[]);
const principal=state.owners.reduce((t,o)=>t+o.principalUsd,0);
const today=state.days.find(d=>d.date===Core.day(now));
const rows=Object.values(state.balances).map(b=>{
 const owner=state.owners.find(o=>o.id===b.id),capital=owner?.principalUsd||0;
 const interest=Core.money(b.accrued-b.paid);
 return {id:b.id,name:b.name,color:b.color,principalUsd:capital,sharePct:principal?capital/principal*100:0,
  interestUsd:interest,interestTodayUsd:Core.money(today?.owners[b.id]||0),balanceUsd:Core.money(capital+interest)};
});
const interest=Core.money(rows.reduce((t,o)=>t+o.interestUsd,0));
const elapsedToday=Math.max(1,(now-Core.eventTime({date:Core.day(now)}))/86400000);
const todayRate=principal?(today?.usd||0)/elapsedToday*30/principal*100:0;
const snapshot={schemaVersion:2,generation:generation(),updatedAt:now,generatedAt:new Date(now+Core.WIB).toISOString().slice(0,16)+' WIB',
 principalUsd:principal,interestUsd:interest,interestTodayUsd:Core.money(today?.usd||0),valueUsd:Core.money(principal+interest),balanceUsd:Core.money(principal+interest),owners:rows,
 interestDay:Core.day(now),days:state.days.slice(-30).map(d=>({date:d.date,usd:d.usd,estimated:d.estimated})),inRange:pos.inRange===true,
 quality:{complete:true,feesEstimated:true,allocationEstimated:state.days.some(d=>d.estimated),migrationAt:state.migration?.at},
 measure:{monthlyPct:Number(todayRate.toFixed(3)),apyPct:Number((todayRate*365/30).toFixed(3)),perDayUsd:(today?.usd||0)/elapsedToday,
 minMonthlyPct:cfg.rate.minMonthlyPct,maxMonthlyPct:cfg.rate.maxMonthlyPct,spanDays:elapsedToday,basis:'fee teramati; periode tanpa pengamatan dialokasikan menurut durasi',since:Core.day(state.migration?.at||now)},
 ethPrice:price,nativePrice:price,nativeSymbol:'ETH'};
assertPublic(snapshot);
const navFile=resolve(DIR,'nav.json'),old=readJSON(navFile,{points:[]});
atomicJSON(stateFile,state);atomicJSON(resolve(DIR,'fees.json'),book);
atomicJSON(navFile,{updatedAt:now,points:downsample([...old.points,{t:now,usd:valueUsd,fee}],now)});
atomicJSON(resolve(DIR,'internal.json'),{updatedAt:now,lpValueUsd:valueUsd,feesUsd:fee,feesEstimated:true});
atomicJSON(resolve(DIR,'live.json'),snapshot);
console.log(`[safebox] saldo=$${snapshot.balanceUsd} bunga=$${interest} pemilik=${rows.length}`);
release();process.exit(0);
