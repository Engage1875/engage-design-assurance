// Project-file text must always be shown as text. This test fills every free-text field
// of a project (main app and Project brief) with a marker element, draws every page and
// sub-tab, and fails if a marker element appears in the page as real markup.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, pages, goPage, closeBrowser } from './helpers.mjs';
after(closeBrowser);

test('project text is never drawn as markup', { timeout: 600000 }, async () => {
const a=await openApp(); const p=a.page;

await goPage(p,'crs'); await p.click('#pg-crs button:has-text("Load sample data")'); await p.waitForTimeout(300);
await goPage(p,'brief'); await p.waitForTimeout(800);
await p.evaluate(()=>{
  const A=S.assets[0]; const z=A.zones[0]; const r=REGS[RA][0]; const key=r.id+'|'+z.id+'|'+z.levels[0];
  A.status[r.id+'|'+(cols(A)[0]||{}).key]='SUB'; A.notes[r.id]='A note';
  A.ev[r.id]=[{eid:'e1',title:'Evidence title',docNo:'DOC 1',rev:'P01 a',suit:'S3',type:'Other',url:'http://x.y/z',date:'2026-11-01',lv:'*',by:'Some One',at:Date.now()}];
  S.signer={name:'Sign Er',role:'AP',org:'Org Name'};
  S.log.push({ts:Date.now(),aid:A.id,asset:A.name,id:r.id,lv:[],lvn:['Level name'],kind:'status',to:'SUB',from:{},by:'Sign Er',role:'AP',org:'Org Name',cmt:'A comment here',ev:['e1']});
  S.project='Project name';S.proj.number='No 1';S.proj.client='Client Co';S.proj.location='Some Place';
  try{const f=document.getElementById('briefFrame');S.brief=f.contentWindow.EngageBrief.getState()}catch(e){}
});
const n=await p.evaluate(()=>{
  const TEXT=new Set(['name','code','title','docNo','rev','note','cmt','comment','by','org','project','client','number','location','label','desc','text','reason','url','ans','src','q','resp','response','own','who','ref','file','subject','action','remarks','summary','body','detail','details','owner','party','req','inp','item','sec','obs','fn','meet','act','why','rat','rationale','proposal','prop','authoriser','auth','asset','lvn','t']);
  const map=[];let n=0;
  const walk=(v,path,key)=>{
    if(typeof v==='string'){ if(v.length&&(TEXT.has(key)||/\s/.test(v)||path.includes('.levels.')||path.includes('.notes.')||path.includes('.lvn.'))&&!/^\d{4}-\d{2}-\d{2}/.test(v)){map.push(path);return v+'<i data-xss="'+(n++)+'"></i>'} return v}
    if(Array.isArray(v))return v.map((x,i)=>walk(x,path+'.'+i,key));
    if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v))o[k]=walk(v[k],path+'.'+k,k);return o}
    return v};
  const t=walk(JSON.parse(JSON.stringify(S)),'S','');
  localStorage.setItem('aptInterfaceTool.v1',JSON.stringify(t)); localStorage.setItem('__map',JSON.stringify(map)); return map.length});
assert.ok(n>300,'enough fields tainted');
await p.reload(); await p.waitForFunction(()=>typeof renderAll==='function'); await p.waitForTimeout(500);
const map=await p.evaluate(()=>JSON.parse(localStorage.getItem('__map')));
const found=new Map();
async function scan(where){
  const ids=await p.evaluate(()=>{const out=[...document.querySelectorAll('[data-xss]')].map(e=>e.dataset.xss);const f=document.getElementById('briefFrame');try{out.push(...[...f.contentDocument.querySelectorAll('[data-xss]')].map(e=>'b'+e.dataset.xss))}catch(e){};return out});
  for(const i of ids){if(!found.has(i))found.set(i,where)}
}
const SUB='.psubb,[data-crs-view],.rqstep,[data-act=psplit],[data-act=cfview],[data-act=odgrp]';
for(const pg of await pages(p)){
  await goPage(p,pg); await scan(pg);
  const subs=await p.$$eval('#pg-'+pg+' :is('+SUB+')',els=>els.length);
  for(let k=0;k<subs;k++){try{await p.evaluate(([pg,k,SUB])=>{const els=document.querySelectorAll('#pg-'+pg+' :is('+SUB+')');els[k]&&els[k].click()},[pg,k,SUB]);await p.waitForTimeout(200);await scan(pg+'#'+k)}catch(e){}}
  if(pg==='brief'){
    const bt=await p.evaluate(()=>{const d=document.getElementById('briefFrame').contentDocument;return [...d.querySelectorAll('[data-tab],[data-a^="tab"],.tabs button,nav button,.ptab')].length});
    for(let k=0;k<bt;k++){await p.evaluate(k=>{const d=document.getElementById('briefFrame').contentDocument;const e=[...d.querySelectorAll('[data-tab],[data-a^="tab"],.tabs button,nav button,.ptab')][k];e&&e.click()},k);await p.waitForTimeout(250);await scan('brief-tab'+k)}
  }
}
// matrix: open detail of first row
await goPage(p,'matrix'); try{await p.click('#pg-matrix [data-act=det]',{timeout:2000});await p.waitForTimeout(300);await scan('matrix-detail')}catch(e){}
const rows=[...found].map(([i,w])=>w+'  '+(i.startsWith('b')?'Project brief ':'')+map[+i.replace('b','')]);
assert.deepEqual(rows, []);
assert.deepEqual(a.errors, []);
await a.close();
});
