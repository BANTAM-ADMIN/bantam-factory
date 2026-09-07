import assert from "node:assert/strict";
import test from "node:test";
import { protectedAuditWitnessCleanupRefusal } from "../src/contract-audit-witness-retention.js";
import { clipKeepingControllerAnnotation } from "../src/prompt.js";

const options = { workspace: "/workspace", witness: { command: "node final-check.mjs", turn: 51, generation: 12 },
  initialSourcePaths: ["context-packet.js", "test/public.test.js"],
  sourcePaths: ["context-packet.js", "test/public.test.js", "final-check.mjs"] };
const observed = "rm -f final-check.mjs && ls && echo '---FINAL---' && npm test 2>&1";

test("the observed first-removal cleanup sequence is refused intact while the actual current proof remains valid", () => {
  const before = JSON.stringify(options);
  const result = protectedAuditWitnessCleanupRefusal(observed, options);
  assert.equal(result.kind, "protected-audit-witness-cleanup");
  assert.equal(result.path, "final-check.mjs");
  assert.deepEqual(result.witness, options.witness);
  assert.match(result.correction, /Requested cleanup was not executed/);
  assert.match(result.correction, /request DONE now/);
  assert.match(result.correction, /production fixes remain allowed/);
  assert.equal(JSON.stringify(options), before, "pure inspection cannot mutate proof or inventory");
  assert.equal(result.nextAction, undefined, "the controller must not execute a rewritten suffix");
  assert.ok(clipKeepingControllerAnnotation("[working] " + "x".repeat(16000) + "\n" + result.correction).includes(result.correction));
  const long = "checks/" + "a".repeat(210) + ".mjs";
  const bounded = protectedAuditWitnessCleanupRefusal(`rm -f ${long}`, { ...options,
    witness: { ...options.witness, command: `node ${long}`, turn: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER }, sourcePaths: [long] });
  assert.equal(bounded.path, long, "the exact file identity is not shortened");
  assert.ok(bounded.correction.length < 700);
  assert.ok(clipKeepingControllerAnnotation(bounded.correction + "\n[working] " + "x".repeat(16000)).includes(bounded.correction));
});

test("exact deletion aliases, standalone cleanup and cwd-preserving prefixes retain only the witnessed file", () => {
  for (const c of ["rm final-check.mjs", "unlink final-check.mjs", "unlink -- ./final-check.mjs",
    "rm --force -- /workspace/final-check.mjs", "ls; rm -f ./final-check.mjs",
    "npm test && rm -f final-check.mjs", "rm -f final-check.mjs && node -e \"console.log('cleanup')\""]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(c, options)?.path, "final-check.mjs", c);
  }
  const nested = { ...options, witness: { ...options.witness, command: "node 'checks/edge case.mjs'" },
    sourcePaths: ["context-packet.js", "checks/edge case.mjs"] };
  assert.equal(protectedAuditWitnessCleanupRefusal("rm -rf checks && ls", nested)?.path, "checks/edge case.mjs");
});

test("retention is exact executed role plus new regular-file inventory, never test-like basename alone", () => {
  for (const c of ["rm -f other-check.mjs", "rm -f /tmp/final-check.mjs", "rm -f fixture.json",
    "node final-check.mjs", "echo 'rm -f final-check.mjs'", "node -e \"console.log('rm -f final-check.mjs')\""]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(c, options), null, c);
  }
  for (const change of [{ witness: null }, { sourcePaths: ["context-packet.js"] },
    { initialSourcePaths: [...options.initialSourcePaths, "final-check.mjs"] },
    { initialSourcePaths: [...options.initialSourcePaths, "/workspace/final-check.mjs"] },
    { witness: { ...options.witness, turn: -1 } }, { witness: { ...options.witness, generation: NaN } },
    { sourcePaths: null }, { initialSourcePaths: null }]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(observed, { ...options, ...change }), null);
  }
  assert.equal(protectedAuditWitnessCleanupRefusal(observed, { ...options, sourcePaths: new Set(options.sourcePaths), initialSourcePaths: new Set(options.initialSourcePaths) })?.path, "final-check.mjs");
});

test("the witness must be one known direct script launcher, not inline code or an opaque compound", () => {
  for (const command of ["node --test --test-timeout=30000 final-check.mjs", "node --test --test-name-pattern='edge' final-check.mjs",
    "MODE=test node ./final-check.mjs", "python3 final-check.mjs", "ruby final-check.mjs"]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(observed, { ...options, witness: { ...options.witness, command } })?.path, "final-check.mjs", command);
  }
  for (const command of ["node -e 'const a=1'", "sh final-check.mjs", "npm test", "node --require final-check.mjs", "node --test a.mjs final-check.mjs",
    "cd /workspace && node final-check.mjs", "node /tmp/final-check.mjs", "node final-check.mjs; echo PASS", "node $CHECK", "node ../workspace/final-check.mjs"]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(observed, { ...options, witness: { ...options.witness, command } }), null, command);
  }
});

test("opaque deletion paths and shell setup are not guessed, while literal redirection in a later suffix is harmless", () => {
  for (const command of ["cd /tmp && rm -f final-check.mjs", "eval 'cd /tmp'; rm -f final-check.mjs",
    "source setup.sh; rm -f final-check.mjs", "sh -c 'rm -f final-check.mjs'", "rm -f $CHECK", "rm -f *.mjs",
    "rm -f $(echo final-check.mjs)", "rm -f `echo final-check.mjs`", "rm -f final-check.mjs | cat",
    "rm -f final-check.mjs &", "rm -f final-check.mjs || true", "rm -f final-check.mjs > /tmp/log",
    "rm --unknown final-check.mjs", "rm -f final-check.mjs && echo $VALUE",
    "node <<'EOF'\nrm -f final-check.mjs\nEOF", "rm -f 'final-check.mjs"]) {
    assert.equal(protectedAuditWitnessCleanupRefusal(command, options), null, command);
  }
  assert.ok(protectedAuditWitnessCleanupRefusal("rm -f final-check.mjs && npm test > /tmp/verify.log 2>&1", options));
});
