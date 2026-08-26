// The evidence gate judged commands by name shape: `python3 gguf-scope` (an
// extensionless tool the model itself wrote) was never classified as running
// the deliverable, so seven red self-tests were followed by an accepted done
// (2026-08-18 bake-off, arm-B). A file the run's own history says the model
// edited IS the deliverable, whatever its name looks like.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedEvidenceObjection } from "../src/logic/evidence-guard.js";
import { isDeliverableRun } from "../src/logic/deliverable-signals.js";

const FAIL_OBS = '$ python3 gguf-scope fixtures/model.gguf > /tmp/a1.txt 2>&1; echo "exit=$?"; cat /tmp/a1.txt\nexit=1\nTraceback (most recent call last):\n  File "gguf-scope", line 210, in extract_facts\nTypeError: sequence item 0: expected str instance, tuple found';

test("running an edited extensionless file is a deliverable run", () => {
  assert.equal(isDeliverableRun("python3 gguf-scope fixtures/model.gguf", { editedNames: new Set(["gguf-scope"]) }), true);
  assert.equal(isDeliverableRun("python3 gguf-scope fixtures/model.gguf"), false);
});

test("arm-B regression: red extensionless self-test blocks done", () => {
  const turns = [
    { action: { a: "write_file", p: "gguf-scope" }, observation: "wrote 500 bytes" },
    { action: { a: "shell", c: 'python3 gguf-scope fixtures/model.gguf > /tmp/a1.txt 2>&1; echo "exit=$?"; cat /tmp/a1.txt' }, observation: FAIL_OBS },
  ];
  const msg = unresolvedEvidenceObjection(turns, 0);
  assert.ok(msg, "gate must object");
  assert.match(msg, /your own last check/);
});

test("precision holds: interpreter run of an unedited script stays invisible", () => {
  const turns = [
    { action: { a: "write_file", p: "gguf-scope" }, observation: "wrote" },
    { action: { a: "shell", c: 'python3 other-tool data.bin' }, observation: "exit=1\nTraceback ..." },
  ];
  assert.equal(unresolvedEvidenceObjection(turns, 0), null);
});
