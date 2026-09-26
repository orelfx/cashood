#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Core from '../assets/core.js';
import { assertPublic } from './lib/io.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'dist');
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
for(const file of ['CNAME','.nojekyll'])cpSync(resolve(root,file),resolve(out,file));
let html=readFileSync(resolve(root,'index.html'),'utf8');
// Content-addressed filenames retain a consistent HTML/JS pair across deployments.
for(const file of ['assets/style.css','assets/vendor/purify.min.js','assets/security.js','assets/core.js','assets/app.js']){
 const content=readFileSync(resolve(root,file));const hash=createHash('sha256').update(content).digest('hex').slice(0,16);
 const name=file.replace(/\.(js|css)$/,'-'+hash+'.$1');mkdirSync(dirname(resolve(out,name)),{recursive:true});writeFileSync(resolve(out,name),content);html=html.replace(`${file}?v=__BUILD__`,name);
}
writeFileSync(resolve(out,'index.html'),html);
for(const file of ['data/funds.json','data/updates.json',...['reborn','meridian','ferari','safebox'].map(f=>`data/${f}/config.json`)]){
 const value=JSON.parse(readFileSync(resolve(root,file),'utf8'));assertPublic(value);if(file.endsWith('config.json')&&!file.includes('safebox'))Core.buildLedger(value);
 mkdirSync(dirname(resolve(out,file)),{recursive:true});writeFileSync(resolve(out,file),JSON.stringify(value));
}
const reports=JSON.parse(readFileSync(resolve(root,'reports/index.json'),'utf8'));assertPublic(reports);mkdirSync(resolve(out,'reports'),{recursive:true});
const manifest=reports.map(r=>({...r,status:r.status||(r.generatedAt<`${r.payDate}T00:00:00+07:00`?'draft':'legacy'),example:r.example||!r.status}));
for(const r of manifest){
 if(!/^reports\/[a-z0-9-]+\.pdf$/i.test(r.pdf))throw new Error('Path laporan tidak valid');
 cpSync(resolve(root,r.pdf),resolve(out,r.pdf));
 // HTML reports contain inline CSS only; untrusted content was escaped by the generator.
 if(r.html&&/^reports\/[a-z0-9-]+\.html$/i.test(r.html))cpSync(resolve(root,r.html),resolve(out,r.html));
}
writeFileSync(resolve(out,'reports/index.json'),JSON.stringify(manifest));
console.log('Built allowlisted site in dist/');
