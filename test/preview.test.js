import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyPreviewReport,
  codexPreviewVisionEnabled,
  findDeclaredExternalReferences,
  formatPreviewReport,
  parseTaskAwarePreviewReview,
  previewPointerHitTestEnabled,
  previewProof,
  previewVisionPrompt,
  runPreviewSync,
  previewTool,
  taskAwarePreviewVisionEnabled,
} from "../src/logic/preview.js";
import { chromiumSkipReason, codexSkipReason, networkSkipReason, compositeSkipReason } from "./helpers/env-guards.js";

const _chromiumSkip = chromiumSkipReason();
const _codexSkip = codexSkipReason();
const _networkSkip = await networkSkipReason();

test("preview detects remote dependencies declared inside a local stylesheet", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-deps-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(workspace, "index.html"),
    '<link rel="stylesheet" href="styles.css"><main>Offline page</main>',
  );
  fs.writeFileSync(
    path.join(workspace, "styles.css"),
    '@import url("https://fonts.example.invalid/family.css");',
  );

  const externalReferences = findDeclaredExternalReferences(workspace, "index.html");
  assert.deepEqual(externalReferences, ["https://fonts.example.invalid/family.css"]);
  assert.equal(classifyPreviewReport({
    networkEnabled: false,
    externalReferences,
    resourceErrors: [],
    pageErrors: [],
    rejections: [],
    consoleMessages: [],
    serverMisses: [],
    visibleTextLength: 12,
  }), "offline-external-dependency");
});

test("Codex preview vision remains default-off until promoted by A/B", () => {
  assert.equal(codexPreviewVisionEnabled({}), false);
  assert.equal(codexPreviewVisionEnabled({ BANTAM_CODEX_PREVIEW_VISION: "1" }), true);
  assert.equal(taskAwarePreviewVisionEnabled({}), false);
  assert.equal(taskAwarePreviewVisionEnabled({ BANTAM_CODEX_PREVIEW_VISION: "1" }), true);
  assert.equal(taskAwarePreviewVisionEnabled({
    BANTAM_CODEX_PREVIEW_VISION: "1",
    BANTAM_CODEX_PREVIEW_TASK_REVIEW: "0",
  }), false);
  assert.equal(taskAwarePreviewVisionEnabled({ BANTAM_CODEX_PREVIEW_TASK_REVIEW: "1" }), true);
});

test("deterministic pointer hit-testing defaults on with an explicit rollback", () => {
  assert.equal(previewPointerHitTestEnabled({}), true);
  assert.equal(previewPointerHitTestEnabled({ BANTAM_PREVIEW_POINTER_HIT_TEST: "1" }), true);
  assert.equal(previewPointerHitTestEnabled({ BANTAM_PREVIEW_POINTER_HIT_TEST: "0" }), false);
});

test("auxiliary screenshot timeout does not become a page interaction failure", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-shot-timeout-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "index.html"), "<main>Working page</main>");
  const fakeChromium = path.join(workspace, "fake-chromium");
  fs.writeFileSync(fakeChromium, `#!/bin/sh
case " $* " in
  *" --dump-dom "*) printf '%s' '<html><body><main>Working page</main><script id="__bantam_report" type="application/json">{"pageErrors":[],"console":[],"rejections":[],"resourceErrors":[],"visibleTextLength":12,"visibleText":"Working page","interaction":{"requested":true,"completed":true,"actions":["click-primary"],"issues":[],"notes":[]}}</script></body></html>' ;;
  *) sleep 1 ;;
esac
`);
  fs.chmodSync(fakeChromium, 0o755);

  const report = runPreviewSync(workspace, "index.html", {
    chromium: fakeChromium,
    interact: true,
    captureInteractiveScreenshot: true,
    timeoutMs: 80,
  });

  assert.equal(report.browserTimedOut, true);
  assert.equal(report.interactionTimedOut, false);
  assert.equal(report.screenshotCaptureTimedOut, true);
  assert.equal(report.interaction.completed, true);
  assert.equal(report.previewStatus, "pass");
  assert.equal(previewProof(report).screenshotCaptureTimedOut, true);
  const formatted = formatPreviewReport(report);
  assert.match(formatted, /interaction pass completed/i);
  assert.doesNotMatch(formatted, /non-terminating handler|could not return a final DOM/i);
  assert.match(formatted, /Visible text starts: "Working page"/);
});

test("legacy and explicit interaction timeouts remain blocking", () => {
  const interaction = { requested: true, completed: false, issues: [] };
  assert.equal(classifyPreviewReport({
    browserTimedOut: true,
    interaction,
    visibleTextLength: 12,
  }), "interaction-timeout");
  assert.equal(classifyPreviewReport({
    browserTimedOut: true,
    interactionTimedOut: true,
    screenshotCaptureTimedOut: false,
    interaction,
    visibleTextLength: 12,
  }), "interaction-timeout");
});

test("runner still marks a real DOM interaction timeout as blocking", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-interaction-timeout-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "index.html"), "<main>Slow page</main>");
  const fakeChromium = path.join(workspace, "fake-chromium");
  fs.writeFileSync(fakeChromium, "#!/bin/sh\nsleep 1\n");
  fs.chmodSync(fakeChromium, 0o755);

  const report = runPreviewSync(workspace, "index.html", {
    chromium: fakeChromium,
    interact: true,
    captureInteractiveScreenshot: true,
    timeoutMs: 80,
  });

  assert.equal(report.browserTimedOut, true);
  assert.equal(report.interactionTimedOut, true);
  assert.equal(report.screenshotCaptureTimedOut, false);
  assert.equal(report.previewStatus, "interaction-timeout");
});

test("task-aware preview review is bounded, visible-only, and contract grounded", () => {
  const prompt = previewVisionPrompt(
    `Build a page with headline "Signal Garden" and keep it readable.${" Extra context.".repeat(1000)}`,
    { taskAware: true },
  );
  assert.match(prompt, /RESULT: REPAIR/);
  assert.match(prompt, /requirements that can genuinely be seen/i);
  assert.match(prompt, /Signal Garden/);
  assert.ok(prompt.length < 5000);
  assert.equal(previewVisionPrompt("ignored", { taskAware: false }).includes("TASK CONTRACT"), false);
});

test("task-aware preview verdicts fail closed only on the exact review protocol", () => {
  assert.deepEqual(
    parseTaskAwarePreviewReview("RESULT: REPAIR — Wrong heading is visible.\n- Replace it with Signal Garden."),
    {
      verdict: "fail",
      summary: "Wrong heading is visible.",
      issues: ["Replace it with Signal Garden."],
      protocol: "task-aware",
    },
  );
  assert.equal(parseTaskAwarePreviewReview("RESULT: CLEAR\nThe visible contract is satisfied.").verdict, "pass");
  assert.equal(parseTaskAwarePreviewReview("I think this needs repair.").verdict, "uncertain");
  assert.equal(parseTaskAwarePreviewReview("CLEAR").verdict, "uncertain");
});

test("preview accepts an asynchronous Codex-style screenshot describer", { skip: _chromiumSkip }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-vision-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(workspace, "index.html"),
    "<main><h1>Visible constellation</h1></main>",
  );
  let screenshotPath = null;
  const tool = previewTool(workspace, {
    describeScreenshot: async (file, prompt) => {
      screenshotPath = file;
      assert.match(prompt, /screenshot of a web page/i);
      return "A visible constellation heading.";
    },
  });

  const answer = await tool.answer("preview index.html --interact");
  assert.ok(screenshotPath && fs.existsSync(screenshotPath));
  assert.match(answer, /WHAT THE PAGE LOOKS LIKE.*visible constellation heading/is);
  assert.equal(tool.lastResult.status, "pass");
  assert.equal(tool.lastResult.mode, "interact");
});

test("preview can ask Codex for a task-aware actionable review", { skip: _chromiumSkip }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-task-review-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "index.html"), "<main><h1>Wrong heading</h1></main>");
  let deliveredPrompt = "";
  const tool = previewTool(workspace, {
    taskContext: 'The visible headline must be "Signal Garden".',
    taskAwareReview: true,
    describeScreenshot: async (_file, prompt) => {
      deliveredPrompt = prompt;
      return "RESULT: REPAIR — Replace the visible Wrong heading text with Signal Garden.";
    },
  });

  const answer = await tool.answer("preview index.html");
  assert.match(deliveredPrompt, /TASK CONTRACT:[\s\S]*Signal Garden/);
  assert.match(answer, /RESULT: REPAIR/);
  assert.match(answer, /PREVIEW STATUS: visual-fail/);
  assert.equal(tool.lastResult.status, "visual-fail");
  assert.equal(tool.lastResult.visualReview.verdict, "fail");
});

test("interaction smoke does not mistake ordinary pause prose for a keyboard control", { skip: compositeSkipReason(_chromiumSkip, _networkSkip) }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-pause-prose-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(workspace, "index.html"),
    '<main><h1>A pause above the city.</h1><a href="#details">The experience</a><section id="details">Details</section></main>',
  );

  const tool = previewTool(workspace);
  const answer = await tool.answer("preview index.html interact");
  assert.doesNotMatch(answer, /Pause is advertised/);
  assert.equal(tool.lastResult.interactionIssues.length, 0);
});

test("interaction smoke retains a real advertised P-to-pause failure", { skip: compositeSkipReason(_chromiumSkip, _networkSkip) }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-pause-control-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(workspace, "index.html"),
    "<main><h1>Orbit Game</h1><p>Press P to pause.</p><button>Start</button></main>",
  );

  const tool = previewTool(workspace);
  const answer = await tool.answer("preview index.html interact");
  assert.match(answer, /Pause is advertised/);
  assert.equal(tool.lastResult.interactionIssues.length, 1);
});

test('interactive pause checks recognize a shared overlay by its changing text', { skip: compositeSkipReason(_chromiumSkip, _networkSkip) }, (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-preview-shared-overlay-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const stuck of [false, true]) {
    fs.writeFileSync(path.join(workspace, 'index.html'), `<main>
      <p>Press P to pause.</p><button id="start">Start</button>
      <div class="overlay" id="overlay" hidden><h2>Flight paused.</h2><p>Resume flight</p></div>
      </main><script>
      let playing = false, paused = false;
      document.querySelector('#start').onclick = function(){ playing = true; this.blur(); };
      document.addEventListener('keydown', e => { if (e.key === 'p' && playing) {
        paused = ${stuck ? 'true' : '!paused'}; document.querySelector('#overlay').hidden = !paused;
      }});
      </script>`);
    const report = runPreviewSync(workspace, 'index.html', { interact: true, realtimeProbe: false });
    assert.equal(report.interaction.completed, true);
    if (stuck) assert.match(report.interaction.issues.join('\n'), /second P did not close/);
    else assert.deepEqual(report.interaction.issues, []);
  }
});

test('preview accepts bounded viewport options and reports unsupported options accurately', async () => {
  const { parsePreviewRequest } = await import('../src/logic/preview.js');
  assert.deepEqual(parsePreviewRequest('preview arcade.html interact --width=390 --height=844'), {
    entry: 'arcade.html', interact: true, viewport: { width: 390, height: 844 },
  });
  assert.deepEqual(parsePreviewRequest('preview --width 320 --height 800 arcade.html'), {
    entry: 'arcade.html', interact: false, viewport: { width: 320, height: 800 },
  });
  for (const query of ['preview arcade.html --width=-1', 'preview --width=999999', 'preview --width=320 --width=400', 'preview --unknown']) {
    assert.throws(() => parsePreviewRequest(query), /preview option|must be|duplicate/);
  }
});

test('phone previews measure the requested CSS viewport below the Chromium window minimum', { skip: compositeSkipReason(_chromiumSkip, _networkSkip) }, (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-preview-exact-phone-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'index.html'), '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}main{width:100vw;height:100vh}</style><main>Phone layout</main>');
  const report = runPreviewSync(workspace, 'index.html', { viewport: { width: 320, height: 844 }, realtimeProbe: false });
  assert.equal(report.previewStatus, 'pass');
  assert.deepEqual(report.layout.viewport, { w: 320, h: 844 });
  assert.deepEqual(report.layout.page, { w: 320, h: 844 });
  assert.ok(report.screenshotBytes > 0);
});

test('interaction checks admit render-loop UI updates while retaining broken hard-drop failures', { skip: compositeSkipReason(_chromiumSkip, _networkSkip) }, t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-preview-frame-ui-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  for(const broken of [false,true]){
    fs.writeFileSync(path.join(workspace,'index.html'), `<main>
      <p>Space: Hard Drop. Press P to pause.</p><button id="start">Start</button>
      <p>Score <span id="score">0</span></p><style>#overlay.hidden{opacity:0;pointer-events:none}</style><div id="overlay" class="hidden">Paused. Resume play.<button>Resume</button></div>
      </main><script>
      let playing=false, paused=false, score=0;
      document.querySelector('#start').onclick=function(){playing=true;this.blur();};
      document.addEventListener('keydown',e=>{if(!playing)return;if(e.key==='p')paused=!paused;
        if(e.key===' '&&!paused)score+=${broken ? 0 : 30};});
      function render(){document.querySelector('#score').textContent=score;
        document.querySelector('#overlay').className=paused?'':'hidden';requestAnimationFrame(render);}
      requestAnimationFrame(render);
      </script>`);
    const report=runPreviewSync(workspace,'index.html',{interact:true,realtimeProbe:false});
    assert.equal(report.interaction.completed,true);
    if(broken)assert.match(report.interaction.issues.join('\n'),/value did not change/);
    else assert.deepEqual(report.interaction.issues,[]);
    assert.deepEqual(report.pointerOcclusions,[]);
  }
});


test('canvas pause controls are observed without requiring a DOM overlay', {skip:compositeSkipReason(_chromiumSkip,_networkSkip)}, t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(),'bantam-preview-canvas-pause-'));
  t.after(() => fs.rmSync(workspace,{recursive:true,force:true}));
  for (const mode of ['toggle','stuck','canvas-only','button-only']) {
    fs.writeFileSync(path.join(workspace,'index.html'), `<main><h1>Orbit Game</h1>
      <p>${mode === 'button-only' ? 'Take a break whenever you like.' : 'P pause'}</p>
      <canvas width="200" height="300"></canvas><button id="pause">Pause</button></main>
      <script>let paused=false;
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
      function draw(){ctx.clearRect(0,0,200,300);ctx.fillText(paused?'PAUSED':'PLAYING',20,20);}
      document.addEventListener('keydown',e=>{if(e.key==='p' && '${mode}'!=='button-only'){
        paused=${mode === 'stuck' ? 'true' : '!paused'};
        if('${mode}'!=='canvas-only')document.querySelector('#pause').textContent=paused?'Resume':'Pause';draw();
      }});draw();</script>`);
    const report=runPreviewSync(workspace,'index.html',{interact:true,realtimeProbe:false});
    assert.equal(report.interaction.completed,true,mode);
    if(mode==='stuck') assert.match(report.interaction.issues.join(' '),/second P did not close/);
    else assert.deepEqual(report.interaction.issues,[],mode);
    if(mode==='canvas-only') assert.match(report.interaction.notes.join(' '),/outside this DOM check/);
    if(mode==='toggle') assert.ok(report.interaction.snapshots.afterPause1.pauseControls.some(c=>c.text==='Resume'));
    if(mode==='button-only') assert.doesNotMatch(report.interaction.notes.join(' '),/Pause is advertised/);
  }
});
