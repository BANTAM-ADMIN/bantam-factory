import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactVerificationGateRejection,
  isComputeShellCommand,
} from "../src/progress-awareness.js";

// chess-best-move (2026-08-20), turns 12/13/14 of a 200-turn budget: three
// `python3 << 'EOF'` turns decoding the board were all rejected as "avoiding
// validation", the model rewrote the same work as `python3 -c` to get through,
// and the run was terminated at turn 20. Heredoc IS the long form of -c.

const HEREDOCS = {
  "quoted heredoc": "cd /app && python3 << 'EOF'\nfrom PIL import Image\nprint(1)\nEOF",
  "bare heredoc": "python3 <<EOF\nprint(1)\nEOF",
  "stdin dash form": "python3 - <<EOF\nprint(1)\nEOF",
  "unquoted delimiter": 'python3 <<PY\nprint(1)\nPY',
  "node heredoc": "node <<'EOF'\nconsole.log(1)\nEOF",
  "versioned python": "python3.11 << 'EOF'\nprint(1)\nEOF",
};

test("a heredoc-fed interpreter is computation, exactly like -c", () => {
  for (const [name, command] of Object.entries(HEREDOCS)) {
    assert.equal(isComputeShellCommand(command), true, name);
  }
  assert.equal(isComputeShellCommand('python3 -c "print(1)"'), true, "the short form still counts");
});

test("recognition did not widen to idle recon", () => {
  for (const command of ["cat /app/move.txt", "ls -la", "head -20 out.csv", "grep -r foo .", "echo hi"]) {
    assert.equal(isComputeShellCommand(command), false, command);
  }
});

// The seam: the widened recognition must actually reach the gate's decision.
test("SEAM: the artifact gate lets a heredoc compute turn RUN", () => {
  const opts = {
    needsVerification: true,
    turnsSinceArtifact: 9,
    threshold: 2,
    knownArtifacts: ["/app/move.txt"],
  };
  for (const [name, command] of Object.entries(HEREDOCS)) {
    assert.equal(
      artifactVerificationGateRejection({ a: "shell", c: command }, opts),
      null,
      `gate must not reject ${name}`,
    );
  }
});

test("SEAM: the gate still stops idle recon and premature done", () => {
  const opts = {
    needsVerification: true,
    turnsSinceArtifact: 9,
    threshold: 2,
    knownArtifacts: ["/app/move.txt"],
  };
  assert.ok(
    artifactVerificationGateRejection({ a: "shell", c: "cat /etc/passwd" }, opts),
    "unrelated read-only recon is still the loop this gate was built to break",
  );
  assert.ok(
    artifactVerificationGateRejection({ a: "done", summary: "finished" }, opts),
    "done still owes a real check",
  );
});
