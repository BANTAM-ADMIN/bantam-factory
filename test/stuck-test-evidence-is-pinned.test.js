// 7R, turn 129: the prompt no longer contained the stuck test's source OR its
// failure line — compaction evicted the load-bearing bytes and the model
// spent seventy turns editing a test it could no longer see. While a test
// stays red, every failing verdict now re-carries its source + diff into
// RECENT history, where compaction keeps it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a repeatedly-red test's source and diff are pinned into the observation", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-evpin-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "target.js"), 'export const value = "wrong";\n');
  fs.writeFileSync(path.join(ws, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { value } from "./target.js";',
    'test("value carries the distinctive marker", () => assert.equal(value, "MARKER-9271"));',
  ].join("\n"));
  const outputs = [
    JSON.stringify({ a: "shell", c: "npm test" }),
    JSON.stringify({ a: "shell", c: "npm test # second look" }),
    JSON.stringify({ a: "write_file", p: "target.js", content: 'export const value = "MARKER-9271";\n' }),
    JSON.stringify({ a: "shell", c: "npm test # verify" }),
    JSON.stringify({ a: "done", summary: "Pinned evidence read; fixed the marker; suite green." }),
  ];
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
  const result = await runAgent({
    task: "Fix target.js so the suite passes.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  assert.doesNotMatch(String(result.turns[0].observation), /\[fix-tests\] evidence pinned/);
  const second = String(result.turns[1].observation);
  assert.match(second, /\[fix-tests\] evidence pinned for "value carries the distinctive marker"/);
  assert.match(second, /MARKER-9271/, "the test's own source travels with the pin");
  assert.ok(result.metrics.evidencePins >= 1);
});
