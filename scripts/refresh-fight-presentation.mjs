#!/usr/bin/env node
// Rebuild reviewed presentation into a fresh directory. Never runs models,
// rewrites outcomes, adds unpublished cards, or updates the input packages.
// Optional reviewed performance receipts extend only the fresh output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {stageFightGallery,buildFightGallery,writeFightGallery} from './factory-fight-gallery.mjs';
import {buildLaunchData} from './factory-launch.mjs';
import {publicPerformance} from './fight-performance.mjs';
import {renderShowcase} from './factory-showcase.mjs';
import {renderLaunchPage,renderShareCard} from './factory-launch-page.mjs';
import {captureLaunchImage} from './factory-launch-browser.mjs';

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function refreshManifest(directory){
  const file=path.join(directory,'package.json'),manifest=JSON.parse(fs.readFileSync(file));
  const allowed=manifest.schema==='bantam.launch-package.v1'
    ?['index.html','fight-card.json','share-card.svg','share-card.png']:['index.html','showcase.json'];
  if(manifest.files.length!==allowed.length||new Set(manifest.files.map(f=>f.path)).size!==allowed.length
    ||manifest.files.some(f=>!allowed.includes(f.path)))throw Error('Unexpected presentation manifest members');
  manifest.files=manifest.files.map(receipt=>{
    const bytes=fs.readFileSync(path.join(directory,receipt.path));
    return {...receipt,bytes:bytes.length,sha256:digest(bytes)};
  });
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
}

export async function refreshFightPresentation({root,output,browser,performanceSupplement=null}){
  if(!path.isAbsolute(browser??'')||!fs.statSync(browser).isFile())throw Error('Expected absolute browser executable');
  // Verify the existing evidence and every staged asset before rebuilding.
  const staged=stageFightGallery({root,output});
  const gallery=JSON.parse(fs.readFileSync(path.join(output,'gallery.json')));
  const prefixes=[...gallery.cards.map(c=>c.id),...(gallery.references?.cards??[]).map(c=>'references/'+c.id)];
  const supplements=new Map();
  if(performanceSupplement!==null){
    if(performanceSupplement.schema!=='bantam.fight-performance-supplement.v1'||!Array.isArray(performanceSupplement.cards))throw Error('Invalid performance supplement');
    for(const card of performanceSupplement.cards){
      if(!prefixes.includes(card.card)||supplements.has(card.card)||!Array.isArray(card.rows))throw Error('Unbound or duplicate performance card');
      supplements.set(card.card,card);
    }
  }
  for(const prefix of prefixes){
    const directory=path.join(output,prefix),share=path.join(directory,'share');
    const sourceBytes=fs.readFileSync(path.join(directory,'showcase.json')),source=JSON.parse(sourceBytes);
    let data=JSON.parse(fs.readFileSync(path.join(share,'fight-card.json')));
    const supplement=supplements.get(prefix);
    if(supplement){
      if(supplement.sourceSha256!==digest(sourceBytes))throw Error('Performance supplement source mismatch');
      const rows=source.series.flatMap(s=>s.cards.flatMap(c=>c.rows)),seen=new Set();
      for(const entry of supplement.rows){
        const row=rows.find(r=>r.arm===entry.arm&&r.wallMs===entry.wallMs&&r.family==='local');
        const performance=publicPerformance(entry.performance);
        if(!row||seen.has(entry.arm)||!performance||JSON.stringify(performance)!==JSON.stringify(entry.performance))throw Error('Invalid or unbound public performance receipt');
        seen.add(entry.arm);row.performance=performance;
      }
      const bytes=Buffer.from(JSON.stringify(source,null,2)+'\n');
      fs.writeFileSync(path.join(directory,'showcase.json'),bytes);
      data=buildLaunchData(bytes);
      fs.writeFileSync(path.join(share,'fight-card.json'),JSON.stringify(data,null,2)+'\n');
      const manifestFile=path.join(share,'package.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
      manifest.source=data.source;fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    }
    const presentation=JSON.parse(fs.readFileSync(path.join(share,'package.json'))).presentation??'comparison';
    fs.writeFileSync(path.join(directory,'index.html'),renderShowcase({data:source,payloads:[]}));
    fs.writeFileSync(path.join(share,'index.html'),renderLaunchPage(data,{previewImage:'share-card.png',presentation,publishedPath:prefix+'/share/index.html'}));
    fs.writeFileSync(path.join(share,'share-card.svg'),renderShareCard(data,{presentation}));
    // Only this newly staged copy is replaced. Capture owns a separate browser.
    fs.unlinkSync(path.join(share,'share-card.png'));
    await captureLaunchImage({browser,file:path.join(share,'share-card.svg'),output:path.join(share,'share-card.png')});
    refreshManifest(directory);refreshManifest(share);
  }
  // Public data and source seals must still agree with the new hash receipts.
  buildFightGallery(output);
  writeFightGallery({root:output,replace:true});
  return {...staged,refreshed:prefixes.length,output};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,output,browser,supplementFile,...extra]=process.argv.slice(2);
  try{
    if(extra.length||!root||!output||!browser)throw Error('usage: refresh-fight-presentation.mjs ABS_REVIEWED_ROOT ABS_FRESH_OUTPUT ABS_BROWSER [ABS_PERFORMANCE_SUPPLEMENT_JSON]');
    let performanceSupplement=null;
    if(supplementFile){
      const stat=fs.lstatSync(supplementFile);
      if(!path.isAbsolute(supplementFile)||!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Expected a bounded performance supplement file');
      performanceSupplement=JSON.parse(fs.readFileSync(supplementFile));
    }
    console.log(JSON.stringify(await refreshFightPresentation({root,output,browser,performanceSupplement}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
