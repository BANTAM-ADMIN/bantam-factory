import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactVerificationGateRejection,
  isVerificationShellCommand,
  runsArtifact,
} from "../src/progress-awareness.js";

// polyglot-c-py (2026-08-21) built a Python/C polyglot and checked it exactly the
// way the task documents — `python3 main.py.c 10` and `gcc main.py.c -o cmain &&
// ./cmain 10` — then had `done` refused five times and the run TERMINATED at turn
// 13. The gate's own lecture asks for "run the artifact against the provided
// input and inspect semantic output"; ARTIFACT_DIAGNOSTIC_RE looks for
// assert/diff/cmp/jq, and none of those appear when the proof is "it prints 55".
// The run had done the work and was killed while trying to say so.

const KA = ["/app/polyglot/main.py.c"];
const opts = { needsVerification: true, turnsSinceArtifact: 9, threshold: 2, knownArtifacts: KA };

// NB: an un-named path only reads as an artifact when it has BOTH an artifact
// extension (json|py|c|txt|csv|db|…) AND an artifact-ish stem (solution/result/
// output/…) — a property of the artifact model, not of this gate. A path the task
// actually NAMED needs neither, which is the normal case.
test("running the deliverable counts as checking it", () => {
  for (const c of [
    "python3 /app/polyglot/main.py.c 10",
    "gcc /app/polyglot/main.py.c -o /app/polyglot/cmain && ./cmain 10",
    "./cmain 42",
    "python3 /app/solution.py < input.txt",
  ]) assert.equal(isVerificationShellCommand(c, { knownArtifacts: KA }), true, c);
});

test("the compiled binary names no source path — the form that was missed", () => {
  assert.equal(runsArtifact("./cmain 42", KA), true, "checked before the artifact-path gate");
  assert.equal(runsArtifact("./a.out", []), true, "no known artifacts needed to exercise a build");
});

test("viewing the deliverable is still not running it", () => {
  for (const c of ["cat /app/polyglot/main.py.c", "ls -la", "find / -name mteb", "grep -r TODO src/"]) {
    assert.equal(isVerificationShellCommand(c, { knownArtifacts: KA }), false, c);
  }
});

test("SEAM: a done that follows a real execution is no longer refused", () => {
  // The gate still refuses done on its own; what changed is that the run's
  // execution now REGISTERS as the verification the gate demands.
  assert.equal(
    artifactVerificationGateRejection({ a: "shell", c: "./cmain 10" }, opts),
    null,
    "exercising the build must not be gated as avoidance",
  );
});
