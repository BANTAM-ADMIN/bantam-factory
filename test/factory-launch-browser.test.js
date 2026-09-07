import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {captureLaunchImage} from '../scripts/factory-launch-browser.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.homedir(), 'bantam-capture-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'image.svg');
  fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#d02030"/></svg>');
  return {root, file, browser: '/snap/bin/chromium', output: path.join(root, 'result.png')};
}

test('capture refuses remote, nonregular, oversized viewport and nonfresh targets before launch', async t => {
  const base = fixture(t);
  for (const change of [{file:'https://example.invalid/card.svg'}, {file:base.root}, {width:0}, {height:4097},
    {width:1.5}, {scrollY:NaN}, {scrollY:-1}, {scrollY:100001}, {browser:'chromium'}, {output:path.join(base.root,'a.jpg')}])
    await assert.rejects(captureLaunchImage({...base,...change}));
  const link = path.join(base.root, 'link.svg'); fs.symlinkSync(base.file, link);
  await assert.rejects(captureLaunchImage({...base,file:link}), /regular/);
  fs.writeFileSync(base.output, 'keep');
  await assert.rejects(captureLaunchImage(base), /fresh/);
  assert.equal(fs.readFileSync(base.output,'utf8'), 'keep');
});

test('capture cleans its entire owned browser group and profile after protocol failure', async t => {
  const base = fixture(t), browser = path.join(base.root,'fake-browser.mjs'), marker = path.join(base.root,'owned.json');
  fs.writeFileSync(browser, `#!/usr/bin/env node
import fs from 'node:fs';import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,profile:process.argv.find(a=>a.startsWith('--user-data-dir=')).split('=').slice(1).join('=')}));
fs.writeSync(4,'invalid json\\0');setInterval(()=>{},1000);
`, {mode:0o755});
  await assert.rejects(captureLaunchImage({...base,browser}), /invalid browser protocol response/);
  const owned=JSON.parse(fs.readFileSync(marker,'utf8'));
  assert.equal(fs.existsSync(owned.profile),false,'profile is removed after browser settles');
  let alive=false;
  try { process.kill(owned.pid,0); alive=!/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${owned.pid}/stat`,'utf8')); }
  catch(error){if(!['ESRCH','ENOENT'].includes(error.code))throw error;}
  assert.equal(alive,false,'a descendant must not survive browser failure');
  assert.equal(fs.existsSync(base.output),false);
});

// Decode screenshot scanlines so the actual last pixel, not just IHDR, proves
// the old 87px white-footer/window-versus-viewport regression is absent.
function lastPixel(png) {
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20),channels=png[25]===6?4:3;
  assert.equal(png[24],8);assert.ok([2,6].includes(png[25]));
  const parts=[];for(let p=8;p<png.length;){const n=png.readUInt32BE(p),type=png.toString('ascii',p+4,p+8);
    if(type==='IDAT')parts.push(png.subarray(p+8,p+8+n));p+=12+n;}
  const bytes=zlib.inflateSync(Buffer.concat(parts)),stride=width*channels;let previous=Buffer.alloc(stride),offset=0;
  for(let y=0;y<height;y++){
    const filter=bytes[offset++],row=Buffer.from(bytes.subarray(offset,offset+stride));offset+=stride;
    for(let x=0;x<stride;x++){
      const a=x>=channels?row[x-channels]:0,b=previous[x],c=x>=channels?previous[x-channels]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      row[x]=(row[x]+[0,a,b,Math.floor((a+b)/2),pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter])&255;
    }previous=row;
  }
  return [...previous.subarray(stride-channels,stride-channels+3)];
}

test('real Chromium captures exact SVG extent and mobile/desktop scrolled HTML viewports', {
  skip:process.env.BANTAM_LAUNCH_BROWSER_TEST!=='1',timeout:60000,
}, async t => {
  const base=fixture(t);
  const result=await captureLaunchImage(base);
  assert.equal(result.width,1200);assert.equal(result.height,630);
  assert.deepEqual(lastPixel(fs.readFileSync(base.output)),[208,32,48]);
  const file=path.join(base.root,'page.html');
  fs.writeFileSync(file,'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}div{height:1000px;background:#d02030}section{height:2000px;background:#2040d0}</style><div></div><section></section>');
  for(const [width,height] of [[1440,1000],[390,900]]){
    const output=path.join(base.root,`page-${width}.png`);
    await captureLaunchImage({...base,file,output,width,height,scrollY:1100});
    const png=fs.readFileSync(output);
    assert.equal(png.readUInt32BE(16),width);assert.equal(png.readUInt32BE(20),height);
    assert.deepEqual(lastPixel(png),[32,64,208]);
  }
});
