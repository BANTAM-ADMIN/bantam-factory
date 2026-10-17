import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareVisionInput, downscalePng} from '../src/logic/vision-input.js';
import {decodePng} from '../src/logic/terminal-image.js';

function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-vision-input-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
// A header-only PNG: enough for the size check, not decodable.
function header(t,w,h){const file=path.join(dir(t),"image with ' quotes.png"),buf=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(buf);buf.writeUInt32BE(w,16);buf.writeUInt32BE(h,20);fs.writeFileSync(file,buf);return {file,buf};}
// A real RGBA PNG: left half red, right half blue.
function realPng(t,w,h){const pixels=Buffer.alloc(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;pixels[i]=x<w/2?255:0;pixels[i+2]=x<w/2?0:255;pixels[i+3]=255;}
 const {bytes}=downscalePng({width:w,height:h,pixels},Math.max(w,h));const file=path.join(dir(t),'real.png');fs.writeFileSync(file,bytes);return file;}

test('small PNG attachments remain byte identical without decoding',t=>{const {file,buf}=header(t,390,640);const r=prepareVisionInput(file,{decode(){throw Error('must not decode');}});assert.deepEqual(r.bytes,buf);assert.equal(r.resized,false);});
test('large PNG becomes a decodable overview with explicit dimensions; source untouched',t=>{
 const file=realPng(t,2048,1024),before=fs.readFileSync(file);
 const r=prepareVisionInput(file);
 assert.equal(r.resized,true);assert.deepEqual(r.delivered,[768,384]);
 assert.match(r.notice,/source 2048×1024px; delivered 768×384px/);assert.match(r.notice,/Original file unchanged/);
 assert.deepEqual(fs.readFileSync(file),before);
 const out=path.join(path.dirname(file),'overview.png');fs.writeFileSync(out,r.bytes);
 const decoded=decodePng(out);assert.equal(decoded.width,768);assert.equal(decoded.height,384);
 assert.deepEqual([...decoded.pixels.subarray(0,3)],[255,0,0],'left stays red');
 const last=(384*768-1)*4;assert.deepEqual([...decoded.pixels.subarray(last,last+3)],[0,0,255],'right stays blue');
});
test('PNG encodings the decoder does not cover are sent unresized with a notice',t=>{const {file,buf}=header(t,2048,2048);const r=prepareVisionInput(file);assert.deepEqual(r.bytes,buf);assert.equal(r.resized,false);assert.match(r.notice,/2048×2048px sent unresized/);});
