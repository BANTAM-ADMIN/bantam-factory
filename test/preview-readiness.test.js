import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runPreviewSync} from '../src/logic/preview.js';
import {chromiumSkipReason} from './helpers/env-guards.js';

test('interactive preview waits for load handlers and asynchronous local initialization', {skip:chromiumSkipReason()}, t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-preview-ready-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.writeFileSync(path.join(workspace,'index.html'), `<!doctype html><html><body>
    <p>Fire: Space</p><button id="start">START GAME</button><main id="status">LOADING</main>
    <script>
      window.addEventListener('load',()=>{
        let ready=false;
        setTimeout(()=>{ready=true;document.querySelector('#status').textContent='READY';},60);
        document.querySelector('#start').onclick=function(){
          if(!ready)return;
          document.querySelector('#status').textContent='RUNNING';this.blur();
        };
      });
    </script></body></html>`);
  const report=runPreviewSync(workspace,'index.html',{interact:true,realtimeProbe:false});
  assert.equal(report.interaction.completed,true);
  assert.match(JSON.stringify(report.interaction.snapshots.afterPrimary),/RUNNING/);
  assert.deepEqual(report.interaction.issues,[]);
});
