// The typewriter PWA replay hit its 60-turn cap still grepping: six advisory
// countdown notes, zero compliance, then "⏸ Paused" with no summary and no
// Next: line for the person to accept (chat r1 @ 2026-08-17T23:24). Advisory
// text steers sometimes; the wrap-up mask lands always. The final two turns
// of an interactive budget now engage it — recon disabled, write/done/respond
// live — so a capped run ends with a landing, not a shrug.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

test("an interactive run's final turns engage the wrap-up mask", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-land-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(workspace, `${n}.js`), `export const ${n} = 1;\n`);

  const model = scriptedModel([
    JSON.stringify({ a: "read_file", p: "a.js" }),
    JSON.stringify({ a: "read_file", p: "b.js" }),
    JSON.stringify({ a: "respond", text: "a and b each export one constant. Next: nothing pressing — this is a good stopping point." }),
  ]);

  const masks = [];
  const result = await runAgent({
    task: "Survey these modules.",
    workspace,
    model,
    maxTurns: 4,
    interactive: true,
    useGrammar: true,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "wrap_up_mask") masks.push(e); },
  });

  assert.equal(result.responded, true);
  assert.ok(masks.length >= 1, "the landing turns are masked, not merely advised");
});

test("headless runs keep their own landing machinery — no interactive mask", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-land-headless-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "a.js"), "export const a = 1;\n");

  const model = scriptedModel([
    JSON.stringify({ a: "read_file", p: "a.js" }),
    JSON.stringify({ a: "respond", text: "one constant." }),
  ]);

  const masks = [];
  await runAgent({
    task: "Survey this module.",
    workspace,
    model,
    maxTurns: 3,
    interactive: false,
    useGrammar: true,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "wrap_up_mask") masks.push(e); },
  });

  assert.equal(masks.length, 0, "the last-turns mask is an interactive-session behavior");
});
