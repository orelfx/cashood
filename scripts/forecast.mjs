#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, readJSON, lock, assertPublic } from './lib/io.mjs';
import { forecastFund } from './lib/forecast.mjs';
const DATA=process.env.CASHOOD_DATA_DIR||resolve(dirname(fileURLToPath(import.meta.url)),'..','data');
const funds=process.argv[2]?[process.argv[2]]:['reborn','meridian','ferari'];
for(const fund of funds){
 if(!['reborn','meridian','ferari'].includes(fund))throw new Error('Dana tidak dikenal');
 const dir=resolve(DATA,fund),release=lock(resolve(dir,'forecast.lock.local'));
 try{
  const cfg=readJSON(resolve(dir,'config.json')),live=readJSON(resolve(dir,'live.json')),nav=readJSON(resolve(dir,'nav.json'));
  if(!cfg||!live||!nav)throw new Error('Sumber proyeksi tidak lengkap');
  const out=forecastFund(fund,cfg,live,nav.points);assertPublic(out);atomicJSON(resolve(dir,'forecast.json'),out);
  console.log(`[forecast] ${fund}: ${out.enough?'tersedia':out.reason}`);
 }finally{release();}
}
