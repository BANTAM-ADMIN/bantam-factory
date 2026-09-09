import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePreviewRequest, previewTool, previewVisionPrompt } from '../src/logic/preview.js';
import { unresolvedPreviewObjection } from '../src/logic/preview-evidence.js';
import { refreshPreviewFailureSequence } from '../src/preview-failure-sequence.js';
import { chromiumSkipReason, networkSkipReason, compositeSkipReason } from './helpers/env-guards.js';

const browserSkip = compositeSkipReason(chromiumSkipReason(), await networkSkipReason());
const sizes = [{width:1280,height:900},{width:390,height:844},{width:320,height:740}];
const query = 'preview index.html interact --viewports=1280x900,390x844,320x740';
function workspace(t, html = '<main>Responsive page</main>') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-preview-viewports-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}
function report(viewport, failed = false) {
  return {entry:'index.html',browserExit:0,previewStatus:failed?'interaction-problems':'pass',
    networkEnabled:false, pageErrors:[],rejections:[],consoleMessages:[],resourceErrors:[],serverMisses:[],
    visibleTextLength:20,visibleTextSample:'Responsive page',screenshotBytes:0,
    interaction:{requested:true,completed:true,actions:['click-primary'],issues:failed?['phone control is blocked']:[]},
    layout:{viewport:{w:viewport.width,h:viewport.height},page:{w:viewport.width,h:viewport.height},blocks:[]}};
}

test('viewport batches have bounded, unambiguous dimensions', () => {
  assert.deepEqual(parsePreviewRequest(query), {entry:'index.html',interact:true,viewports:sizes});
  assert.deepEqual(parsePreviewRequest('preview --viewports 320x740 index.html').viewports,[sizes[2]]);
  for (const suffix of ['--viewports=', '--viewports=320x20', '--viewports=320x9000', '--viewports=abc',
    '--viewports=320x740,', '--viewports=320x740,320x740', '--viewports=0320x740,320X740',
    '--viewports=320x740,390x844,1280x900,800x800', '--viewports=320x740 --width=390',
    '--viewports=320x740 --height=844', '--viewports=320x740 --viewports=390x844']) {
    assert.throws(() => parsePreviewRequest(`preview index.html ${suffix}`), /viewports|preview option/, suffix);
  }
});

test('a failing phone view survives later desktop success and is shown before green detail', async t => {
  const seen=[];
  const tool=previewTool(workspace(t),{previewRunner:(_dir,_entry,options)=>{
    seen.push(options);return report(options.viewport, options.viewport.width===390);
  }});
  const text=await tool.answer(query);
  assert.deepEqual(seen.map(x=>x.viewport),sizes);
  assert.ok(seen.every(x=>x.interact && x.network===false));
  assert.equal(tool.lastResult.status,'interaction-problems');
  assert.deepEqual(tool.lastResult.views.map(x=>x.status),['pass','interaction-problems','pass']);
  assert.deepEqual(tool.lastResult.viewport,sizes[1]);
  assert.ok(text.indexOf('VIEWPORT 390x844')<text.indexOf('VIEWPORT 1280x900'));
  for(const status of ['interaction-problems','interaction-timeout','interaction-inconclusive','pass']) {
    const proof={...tool.lastResult,status,generation:2};
    const objection=unresolvedPreviewObjection(proof,status==='pass'?3:2);
    assert.ok(objection.includes('--viewports=1280x900,390x844,320x740'),status);
  }
  const sequence=refreshPreviewFailureSequence({...tool.lastResult,interactionIssues:['index.html:3: broken start','index.html:7: broken hold']},'');
  assert.equal(sequence.query,query);
});

test('runner failure cannot be hidden by another viewport and resets proof on invalid input', async t => {
  const seen=[];
  const tool=previewTool(workspace(t),{previewRunner:(_dir,_entry,{viewport})=>{
    seen.push(viewport.width);if(viewport.width===390)throw Error('synthetic browser launch failure');return report(viewport);
  }});
  assert.match(await tool.answer(query),/390x844: runner-error.*synthetic browser launch failure/);
  assert.deepEqual(seen,[1280,390,320]);
  assert.equal(tool.lastResult.status,'runner-error');
  assert.equal(tool.lastResult.views.length,3);
  assert.match(await tool.answer(query+' --height=844'),/cannot be combined/);
  assert.equal(tool.lastResult,null);
});

test('single phone proof and screenshot review retain their actual viewport', async t => {
  const tool=previewTool(workspace(t),{previewRunner:(_dir,_entry,{viewport})=>report(viewport)});
  await tool.answer('preview index.html interact --width=390 --height=844');
  assert.deepEqual(tool.lastResult.viewport,sizes[1]);
  assert.match(unresolvedPreviewObjection({...tool.lastResult,generation:1},2),/390x844/);
  assert.match(previewVisionPrompt('Build a phone page.',{taskAware:true,viewport:sizes[1]}),/actual 390x844/);
});

test('real browser batch catches a phone-only error and checks every requested size', {skip:browserSkip}, async t => {
  const dir=workspace(t,'<meta name="viewport" content="width=device-width,initial-scale=1"><main>Responsive page under test</main><script>if(innerWidth<400)throw new Error("phone-only defect");</script>');
  const tool=previewTool(dir);
  const text=await tool.answer('preview index.html --viewports=1280x900,390x844');
  assert.equal(tool.lastResult?.views.length,2,text);
  assert.equal(tool.lastResult.views[0].status,'pass');
  assert.equal(tool.lastResult.views[1].status,'problems');
  assert.equal(tool.lastResult.status,'problems');
  assert.match(text,/phone-only defect/);
  assert.deepEqual(tool.lastResult.views.map(x=>x.viewport),sizes.slice(0,2));
});
