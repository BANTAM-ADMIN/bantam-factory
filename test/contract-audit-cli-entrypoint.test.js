import test from "node:test";
import assert from "node:assert/strict";
import {contractAuditRecoveryNote} from "../src/contract-audit-recovery.js";
import {clipKeepingControllerAnnotation} from "../src/prompt.js";

test("CLI recovery names the subject entrypoint and bounded child execution, without substituting the diagnostic", () => {
  const note = contractAuditRecoveryNote({turn:1,needsFocused:true,needsProject:true,
    missing:["focused-execution","project-verification"],configuredCommand:"npm test",report:"review ".repeat(1000)});
  assert.match(note, /entry is the subject CLI, NOT this check/);
  assert.match(note, /NOT the diagnostic's import\.meta\.url or process\.argv\[1\]/);
  assert.match(note, /timeout: 5000, killSignal: 'SIGKILL'/);
  assert.match(note, /A timeout is not a pass/);
  assert.match(note, /actual runtime/);
  assert.ok(note.length < 3500);
  const executive = note.split("\n")[0];
  const delivered = clipKeepingControllerAnnotation("[repetition] Repeated command.\n" + note + "\nworking note".repeat(1400));
  assert.ok(delivered.includes(executive));
});
