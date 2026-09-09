// Local eyes first (operator order, 2026-08-18): codex mode silently routed
// screenshots to the Codex account even with a local projector serving.
// Local mmproj wins by default; codex only by explicit preference, or as the
// fallback when no projector is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolRegistry, pickImageProvider } from "../src/logic/tools.js";

test("local wins by default when both are available", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: undefined }), "local");
});
test("explicit codex preference routes to codex", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: true, preference: "codex" }), "codex");
});
test("codex is the fallback only when no local projector exists", () => {
  assert.equal(pickImageProvider({ localVision: false, codexVision: true, preference: undefined }), "codex");
});
test("explicit local preference never falls back to codex", () => {
  assert.equal(pickImageProvider({ localVision: false, codexVision: true, preference: "local" }), null);
});
test("codex preference degrades to local when codex is absent", () => {
  assert.equal(pickImageProvider({ localVision: true, codexVision: false, preference: "codex" }), "local");
});

test('preview honors Codex eyes when a local projector is also available', t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-preview-eyes-'));
  const keys=['PATH','BANTAM_CHROMIUM','BANTAM_NO_VISION','BANTAM_NO_PREVIEW'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}fs.rmSync(workspace,{recursive:true,force:true});});
  fs.writeFileSync(path.join(workspace,'curl'),'#!/bin/sh\nprintf \'%s\' \'{"modalities":{"vision":true}}\'\n',{mode:0o755});
  process.env.PATH=workspace+path.delimiter+process.env.PATH;
  process.env.BANTAM_CHROMIUM=path.join(workspace,'unused-chromium');
  delete process.env.BANTAM_NO_VISION;delete process.env.BANTAM_NO_PREVIEW;
  const opts={codex:true,codexModel:'gpt-6-astra',endpoint:'http://fixture.invalid',repoMapDir:null,env:{}};
  const local=buildToolRegistry({workspace},{...opts,imageProvider:'local'});
  assert.match(local.get('preview').description,/vision description/);
  const codex=buildToolRegistry({workspace},{...opts,imageProvider:'codex'});
  assert.match(codex.get('view_image').description,/Codex vision/);
  assert.doesNotMatch(codex.get('preview').description,/vision description/,
    'default-off Codex preview interpretation must not silently fall through to local inference');
  const enabled=buildToolRegistry({workspace},{...opts,imageProvider:'codex',env:{BANTAM_CODEX_PREVIEW_VISION:'1'}});
  assert.match(enabled.get('preview').description,/vision description/);
  local.dispose();codex.dispose();enabled.dispose();
});
