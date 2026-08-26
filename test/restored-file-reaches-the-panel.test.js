// "[reverted] … I restored your best-passing version of X (now shown in
// <open_files>)" is a promise about the NEXT prompt, and writing the file does
// not by itself keep it: the panel renders a bounded recency list, so a
// snapshot file the model has not touched lately can simply not be there.
// Measured once across 49 restore notices in the stored corpus
// (2026-08-16T16-16-10-688Z): the named file — src/fixture-runner.js, edited
// early and long since crowded out — was absent from the panel the model read
// the notice against. Told its work had been rolled back, and unable to see to
// what.
//
// The refused-read path already refreshes residency where its claim is made
// (fa3de36b, "refresh residency where the refusal actually happens"). Both
// restore sites now do the same.
//
// The panel is capped at two entries here so the recency list actually binds:
// the regression is caused by editing `late.js`, which keeps ITSELF at the
// front, while `early.js` is the snapshot member that falls out.

process.env.BANTAM_OPEN_FILES = "2";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const { runAgent } = await import("../src/agent.js");

const VERIFY = "node --test";

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-restore-panel-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "early.js"), "module.exports='early-good'");
  fs.writeFileSync(path.join(dir, "late.js"), "module.exports='late-good'");
  fs.writeFileSync(
    path.join(dir, "both.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("both are good", () => {',
      '  delete require.cache[require.resolve("./early.js")];',
      '  delete require.cache[require.resolve("./late.js")];',
      '  assert.equal(require("./early.js"), "early-good");',
      '  assert.equal(require("./late.js"), "late-good");',
      "});",
    ].join("\n"),
  );
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `filler${i}.js`), `module.exports=${i};\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingModel(outputs, prompts) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete(prompt) {
      prompts.push(String(prompt ?? ""));
      return {
        content: outputs.shift() ?? JSON.stringify({ a: "done", summary: "out of script" }),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

const act = (o) => JSON.stringify(o);

describe("a restored file is where the restore notice says it is", () => {
  it("puts every reverted file in the panel the model reads the notice against", async (t) => {
    const dir = workspace(t);
    const prompts = [];

    const script = [
      act({ a: "write_file", p: "early.js", content: "module.exports = 'early-good'" }),
      act({ a: "write_file", p: "late.js", content: "module.exports = 'late-good'" }),
      act({ a: "shell", c: VERIFY }),                     // green: snapshot holds early.js AND late.js
      act({ a: "read_file", p: "filler0.js" }),           // crowd early.js out of a two-entry panel
      act({ a: "read_file", p: "filler1.js" }),
      act({ a: "read_file", p: "filler2.js" }),
      act({ a: "write_file", p: "late.js", content: "module.exports='late-bad'" }),
      act({ a: "shell", c: VERIFY }),                     // guard restores both
      act({ a: "respond", text: "what now" }),            // the turn that READS the notice
      act({ a: "done", summary: "finished" }),
    ];

    const result = await runAgent({
      task: "Adjust early.js and late.js.",
      workspace: dir,
      model: recordingModel(script, prompts),
      maxTurns: script.length + 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
      verificationScript: VERIFY,
    });

    const revertIndex = result.turns.findIndex((turn) => /\[reverted\] Those edits regressed you/.test(String(turn.observation ?? "")));
    assert.ok(revertIndex >= 0, "the guard must have restored for this test to mean anything");

    const seen = prompts[revertIndex + 1];
    assert.ok(seen, "there must be a turn after the revert that reads the notice");
    assert.match(seen, /\[reverted\] Those edits regressed you/, "the notice reaches that prompt");

    // late.js would be present anyway — editing it is what caused the dip.
    // early.js is the one the promise was quietly breaking.
    assert.match(seen, /# early\.js \(current,/, "the notice names early.js; the panel must hold it");
    assert.match(seen, /early-good/, "and show the RESTORED bytes");
  });
});
