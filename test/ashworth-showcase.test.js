import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {SHOWCASE_STATIC_FILES,showcaseAssets} from '../scripts/factory-showcase-page.mjs';
const root=new URL('../site/examples/ashworth/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const record=JSON.parse(read('build.json'));

test('ASHWORTH publishes the reviewed factory snapshot with its source and original attribution',()=>{
  assert.equal(record.status,'playable-preview');
  assert.equal(record.model,'GPT-6 Astra');
  assert.equal(record.harness,'BANTAM FACTORY');
  assert.equal(record.runtimeEditsForPublication,0);
  assert.match(record.comparisonStatus,/has not started/);
  const names=new Set();
  for(const file of record.files){
    assert.ok(file.path.startsWith('game/'));
    assert.equal(path.posix.normalize(file.path),file.path);
    assert.ok(!names.has(file.path));names.add(file.path);
    const bytes=read(file.path);
    assert.equal(bytes.length,file.bytes,file.path);
    assert.equal(sha(bytes),file.sha256,file.path);
    assert.ok(SHOWCASE_STATIC_FILES.includes('examples/ashworth/'+file.path),file.path);
  }
  assert.ok(names.has('game/vendor/three/LICENSE'));
  assert.match(read('game/vendor/three/LICENSE').toString(),/MIT License/);
  assert.match(read('game/LICENSE').toString(),/Apache License/);
  for(const shot of record.screenshots)assert.equal(sha(read(shot.path)),shot.sha256);
  const archive=read(record.download.path);
  assert.equal(archive.length,record.download.bytes);assert.equal(sha(archive),record.download.sha256);
  assert.deepEqual(record.checks.map(check=>check.groups.length),[10,10,7]);
  assert.ok(record.checks.every(check=>check.pass&&check.groups.every(group=>group.pass)));
  assert.doesNotMatch(JSON.stringify(record),/\/home\/|threadId|rawUsage|actualCostUsd/);
});

test('published runtime includes the complete local module closure and stages the download',()=>{
  const files=new Set(record.files.map(file=>file.path));
  for(const file of files){
    if(!file.endsWith('.js'))continue;
    for(const [,specifier] of read(file).toString().matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)){
      let target;
      if(specifier==='three')target='game/vendor/three/three.module.js';
      else if(specifier.startsWith('three/addons/'))target='game/vendor/three/addons/'+specifier.slice('three/addons/'.length);
      else {assert.ok(specifier.startsWith('.'),file+': '+specifier);target=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));}
      assert.ok(files.has(target),file+' requires '+target);
    }
  }
  const staged=new Map(showcaseAssets());
  for(const file of ['index.html','station.jpg','train.jpg','ashworth-st.zip','build.json','game/index.html']){
    assert.equal(sha(staged.get('assets/showcase/examples/ashworth/'+file)),sha(read(file)));
  }
  assert.ok(![...staged.keys()].some(file=>/ashworth\/.*(?:node_modules|DESIGN\.md|PROGRESS\.md|provider-traces)/.test(file)));
});
