import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
test('installed factory symlink resolves its own checkout from an unrelated folder', {skip:process.platform!=='linux'}, t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-command-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const command=path.join(dir,'bantamfactory');fs.symlinkSync(path.join(root,'bin/bantamfactory'),command);
 const r=spawnSync(command,['--help'],{cwd:dir,encoding:'utf8',timeout:15000,env:{...process.env,BANTAM_CONFIG_DIR:path.join(dir,'config')}});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/bantam/i);
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
 const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
 assert.equal(pkg.bin.bantamfactory,'bin/bantamfactory');
 assert.deepEqual(lock.packages[''].bin,pkg.bin);assert.equal(lock.name,pkg.name);assert.equal(lock.version,pkg.version);
});
