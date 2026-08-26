import test from "node:test";
import assert from "node:assert/strict";
import { classifyPreviewReport, parseVisualReview, previewProof } from "../src/logic/preview.js";
import { taskRequiresVisualPreview } from "../src/logic/preview-evidence.js";
import { unresolvedPreviewObjection } from "../src/logic/preview-evidence.js";
import { deliveryFor, BLOCK, OFF } from "../src/gate-policy.js";

test("visual review parses a bounded JSON verdict", () => {
  assert.deepEqual(parseVisualReview('{"verdict":"fail","summary":"large black bar covers the scene","issues":["dominant stray geometry"]}'), {
    verdict: "fail",
    summary: "large black bar covers the scene",
    issues: ["dominant stray geometry"],
  });
});

test("only an explicit visual failure changes the preview result", () => {
  const report = { visibleTextLength: 20, pageErrors: [], rejections: [], consoleMessages: [], resourceErrors: [], serverMisses: [], visualReview: { verdict: "fail", summary: "blank canvas", issues: [] } };
  assert.equal(classifyPreviewReport(report), "visual-fail");
  assert.equal(previewProof(report).visualReview.verdict, "fail");
  report.visualReview.verdict = "uncertain";
  assert.equal(classifyPreviewReport(report), "pass");
});

test("deterministic pointer obstruction is trusted preview evidence", () => {
  const obstruction = {
    control: { tag: "button", text: "Night" },
    blocker: { tag: "main", text: "Signal Garden" },
    x: 1080,
    y: 66,
  };
  const report = {
    visibleTextLength: 20,
    pageErrors: [],
    rejections: [],
    consoleMessages: [],
    resourceErrors: [],
    serverMisses: [],
    pointerOcclusions: [obstruction],
  };
  assert.equal(classifyPreviewReport(report), "pointer-obstruction");
  assert.deepEqual(previewProof(report).pointerOcclusions, [obstruction]);
  assert.equal(previewProof(report).problemCount, 1);
});

test("a rendered canvas is not called empty solely because it has no text", () => {
  const report = {
    visibleTextLength: 0, screenshotBytes: 1000,
    pageErrors: [], rejections: [], consoleMessages: [], resourceErrors: [], serverMisses: [],
    layout: { blocks: [{ tag: "canvas", w: 960, h: 640 }] },
  };
  assert.equal(classifyPreviewReport(report), "pass");
});

test("visual task detection stays limited to browser-rendered deliverables", () => {
  assert.equal(taskRequiresVisualPreview("Create a 960x640 Canvas voxel pagoda scene"), true);
  assert.equal(taskRequiresVisualPreview("Generate a pagoda illustration in prose"), false);
  assert.equal(taskRequiresVisualPreview("Implement a Canvas click toggle"), true);
});

test("visual preview failures are load-bearing only for autonomous visual work", () => {
  assert.equal(deliveryFor("preview", { visualTask: true }), BLOCK);
  assert.equal(deliveryFor("preview", { visualTask: false }), OFF);
});

test("visual failure objection carries the reviewer finding", () => {
  const message = unresolvedPreviewObjection(
    { status: "visual-fail", generation: 2, visualReview: { summary: "black rail obscures the pagoda", issues: ["dominant artifact"] } },
    2,
  );
  assert.match(message, /black rail obscures the pagoda/);
});

test("pointer obstruction objection identifies the control and blocker", () => {
  const message = unresolvedPreviewObjection(
    {
      status: "pointer-obstruction",
      generation: 2,
      pointerOcclusions: [{
        control: { text: "Night" },
        blocker: { text: "Signal Garden" },
      }],
    },
    2,
  );
  assert.match(message, /Night is covered by Signal Garden/);
  assert.match(message, /pointer hit-test/i);
});

test("a first interaction timeout asks for confirmation before source edits", () => {
  const message = unresolvedPreviewObjection(
    {
      status: "interaction-timeout",
      generation: 2,
      interactionIssues: ["Timed out while dispatching ArrowUp."],
    },
    2,
  );
  assert.match(message, /single timeout is inconclusive/i);
  assert.match(message, /rerun.*once before editing/i);
  assert.doesNotMatch(message, /Treat .* likely non-terminating/i);
});
