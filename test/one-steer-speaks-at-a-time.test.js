// Guard-pair precedence, enforced instead of hoped. A single inspect batch
// can qualify for BOTH the inspect-paging steer (3rd window of one big file)
// and the shuffle steer (2nd consecutive mostly-covered batch). Unchecked,
// both append their full coaching paragraph to one observation — conflicting
// remedies ("search for the identifier" vs "use map/deps or begin work") and
// double metrics. The rule: the more specific steer wins. Paging names one
// file and one remedy; shuffle stands down that turn and keeps its streak.

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

test("a batch qualifying for paging AND shuffle draws exactly one steer", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-onesteer-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const n of ["a", "b"]) {
    fs.writeFileSync(path.join(workspace, `${n}.js`), Array.from({ length: 500 }, (_, i) => `export const ${n}${i} = ${i};`).join("\n") + "\n");
  }
  for (const n of ["c1", "c2"]) fs.writeFileSync(path.join(workspace, `${n}.js`), "export const tiny = 1;\n");

  const batch = (ops) => JSON.stringify({ a: "inspect", ops });
  const win = (p) => ({ a: "read_file", p, limit: 60 });
  const model = scriptedModel([
    batch([win("a.js"), win("b.js")]),                       // fresh; pages a=1 b=1
    batch([win("a.js"), win("b.js"), win("c1.js")]),          // 2/3 covered → stale 1; pages a=2 b=2
    batch([win("a.js"), win("b.js"), win("c2.js")]),          // 2/3 covered → stale 2 AND a.js page 3
    JSON.stringify({ a: "respond", text: "a/b export constants; c1/c2 are tiny." }),
  ]);

  const events = [];
  const result = await runAgent({
    task: "Survey these modules.",
    workspace,
    model,
    maxTurns: 8,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (["paging_steer", "inspect_shuffle_steer"].includes(e.type)) events.push(e.type); },
  });

  assert.equal(result.responded, true);
  assert.deepEqual(events, ["paging_steer"], "the specific steer speaks; the general one stands down");
  const steerTags = result.turns
    .map((turn) => String(turn.observation ?? ""))
    .flatMap((obs) => obs.match(/\[(paging|shuffle)\]/g) ?? []);
  assert.deepEqual(steerTags, ["[paging]"], "one coaching paragraph, not two");
});
