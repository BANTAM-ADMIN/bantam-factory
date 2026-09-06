import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as snapshot from '../snapshot.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-public-'));
  fs.writeFileSync(path.join(dir,'a.txt'),'abc'); fs.chmodSync(path.join(dir,'a.txt'),0o640);
  t.after(() => fs.rmSync(dir,{recursive:true,force:true})); return dir;
}
test('existing builder hashes exact bytes and permission bits', t => {
  const root = fixture(t);
  assert.deepEqual(snapshot.createManifest(root,['a.txt']),{version:1,files:[{
    path:'a.txt',sha256:crypto.createHash('sha256').update('abc').digest('hex'),size:3,mode:0o640,
  }]});
});
test('new verifier reports unchanged, content and missing', t => {
  const root = fixture(t), manifest = snapshot.createManifest(root,['a.txt']);
  assert.deepEqual(snapshot.verifyManifest(root,manifest),{ok:true,unchanged:['a.txt'],changed:[],missing:[],unsafe:[]});
  fs.writeFileSync(path.join(root,'a.txt'),'xyz');
  assert.deepEqual(snapshot.verifyManifest(root,manifest).changed,[{path:'a.txt',reasons:['content']}]);
  fs.unlinkSync(path.join(root,'a.txt'));
  assert.deepEqual(snapshot.verifyManifest(root,manifest).missing,['a.txt']);
});
test('unsafe selections and invalid manifests throw', t => {
  const root = fixture(t);
  assert.throws(() => snapshot.createManifest(root,['../outside']));
  assert.throws(() => snapshot.verifyManifest(root,{version:2,files:[]}));
});
