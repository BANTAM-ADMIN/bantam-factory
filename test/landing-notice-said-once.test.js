import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// The landing window is ~10% of the budget, so the untouched-requirement clause
// repeated on every one of the last turns. tb24 (2026-08-17) spent its endgame
// being told seven times that "the task names src/agent.js and this run has not
// edited it yet" — a path its ticket mentions once, parenthetically, describing
// what ALREADY exists. The model had built its fix as a new module plus wiring,
// a legitimate reading, and could do nothing with the message but re-read it.
//
// The countdown still comes every turn; the requirement is named when it first
// matters and again at the very end.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-landing-once-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/named.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "other.js"), "module.exports = 2;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const act = (o) => JSON.stringify(o);

describe("the landing note does not repeat its requirement every turn", () => {
  it("names the untouched path once, and again on the last turn", async (t) => {
    const dir = workspace(t);
    // Edit something OTHER than the named path, then burn the landing window.
    const script = [
      act({ a: "write_file", p: "other.js", content: "module.exports = 3;\n" }),
      ...Array.from({ length: 9 }, () => act({ a: "read_file", p: "other.js" })),
    ];
    const result = await runAgent({
      task: "Adjust the pipeline. Background: the current behaviour lives in (src/named.js handler) and is wrong.",
      workspace: dir,
      model: {
        assistantPrefill: "",
        actTemperature: null,
        async complete() {
          return { content: script.shift() ?? act({ a: "read_file", p: "other.js" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
        },
      },
      maxTurns: 10,
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    const notices = result.turns.filter((turn) => /The task names .* has not edited/.test(String(turn.observation ?? ""))).length;
    const countdowns = result.turns.filter((turn) => /\[budget\] \d+ turns? left/.test(String(turn.observation ?? ""))).length;
    assert.ok(countdowns >= 3, `the countdown must still come every landing turn, saw ${countdowns}`);
    assert.ok(notices >= 1, "the untouched requirement must be named at least once");
    assert.ok(notices <= 2, `and at most twice — first and last — saw ${notices} across ${countdowns} landing turns`);
  });
});
