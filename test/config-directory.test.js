import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bantamConfigDirectory} from '../src/config-directory.js';

test('setup config root is explicit and does not repurpose OS home',()=>{
 assert.equal(bantamConfigDirectory('/tmp/test-user','/tmp/ignored'),'/tmp/test-user/.bantam');
 assert.equal(bantamConfigDirectory(undefined,'/tmp/custom/../isolated'),'/tmp/isolated');
 for(const invalid of ['', '.', '/', '/tmp/unsafe\n', 'relative/path'])
  assert.throws(()=>bantamConfigDirectory(undefined,invalid),/BANTAM_CONFIG_DIR/);
});

test('separate processes remember only isolated connections/settings/registrations; stock configs pin their root',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-config-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config=path.join(root,'config'),exe=path.join(root,'opencode');
 fs.writeFileSync(exe,'#!/bin/sh\nexit 99\n',{mode:0o700});
 const repo=fileURLToPath(new URL('../',import.meta.url));
 const run=source=>execFileSync(process.execPath,['--input-type=module','-e',source],{
  cwd:repo,env:{...process.env,BANTAM_CONFIG_DIR:config,BANTAM_TEST_EXE:exe},encoding:'utf8'}).trim();
 run(`import {saveConnection} from './src/first-run.js';
 import {saveUserSetting} from './src/logic/user-settings.js';
 import {registerCompetitor} from './src/competitor-registry.js';
 import {registerStockProfiles} from './src/stock-model.js';
 saveConnection({kind:'api',apiUrl:'http://127.0.0.1:8085/v1',model:'test-model',dialect:'llamacpp'});
 saveUserSetting('stream',true);registerCompetitor('opencode',process.env.BANTAM_TEST_EXE);
 registerStockProfiles({server:process.env.BANTAM_TEST_EXE});`);
 const result=JSON.parse(run(`import os from 'node:os';
 import {loadConnection,connectionPath} from './src/first-run.js';
 import {loadUserSettings} from './src/logic/user-settings.js';
 import {readCompetitorRegistry} from './src/competitor-registry.js';
 import {llamaInstallRoot} from './src/llama-install.js';
 console.log(JSON.stringify({home:os.homedir(),connection:loadConnection(),file:connectionPath(),
 settings:loadUserSettings(),peers:readCompetitorRegistry(),llama:llamaInstallRoot()}));`));
 assert.equal(result.home,os.homedir());assert.equal(result.connection.model,'test-model');
 assert.equal(result.file,path.join(config,'connection.json'));assert.equal(result.settings.stream,true);
 assert.equal(result.peers.tools.opencode.executable,exe);assert.equal(result.llama,path.join(config,'llama'));
 assert.equal(fs.statSync(result.file).mode&511,0o600);
 const saved=JSON.parse(fs.readFileSync(path.join(config,'stock/davidau-27b/72k-cpu-vision.json'),'utf8'));
 assert.equal(saved.configDir,config);assert.equal(saved.home,undefined);
 const restored=JSON.parse(run(`import {stockPlan} from './src/stock-model.js';
 process.env.BANTAM_CONFIG_DIR='/tmp/different-config';
 console.log(JSON.stringify(stockPlan(${JSON.stringify(saved)})));`));
 assert.equal(restored.root,path.join(config,'stock/davidau-27b'));
 assert.equal(fs.existsSync(path.join(root,'.bantam')),false);
});
