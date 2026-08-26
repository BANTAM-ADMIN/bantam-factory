import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactVerificationGateRejection,
  isIdleReconCommand,
} from "../src/progress-awareness.js";

// The artifact gate used to WHITELIST computation, so every tool the whitelist
// had not heard of became a false TERMINATION. Three runs died that way on three
// unrelated tasks, each with most of its budget unspent:
//
//   chess-best-move   `python3 << 'EOF'` heredocs      killed turn 20 / 200
//   polyglot-c-py     `gcc main.py.c -o cmain`         killed turn 11 / 200
//   mteb-leaderboard  `curl https://… | head`          killed turn 17 / 200
//
// Compiling, in a C task. Fetching, in a task whose answer lives on the web.
// Every prior repair added one more verb to the list, which is why the bug kept
// returning wearing a different tool's name. The gate's real job — break the
// idle-recon loop, stop a premature `done` — describes small closed sets, so it
// is the VIEWING that should be enumerated and everything else that runs.

const opts = { needsVerification: true, turnsSinceArtifact: 9, threshold: 2, knownArtifacts: ["/app/out.txt"] };
const gate = (c) => artifactVerificationGateRejection({ a: "shell", c }, opts);

test("the three commands that terminated real runs now RUN", () => {
  for (const c of [
    "cd /app && python3 << 'EOF'\nfrom PIL import Image\nprint(1)\nEOF",
    'rm -f /app/polyglot/cmain && gcc /app/polyglot/main.py.c -o /app/polyglot/cmain 2>&1; echo "gcc_exit=$?"',
    'curl -s "https://huggingface.co/spaces/mteb/leaderboard/raw/main/app.py" 2>/dev/null | head -100',
  ]) {
    assert.equal(isIdleReconCommand(c), false, `not recon: ${c.slice(0, 40)}`);
    assert.equal(gate(c), null, `gate must not reject: ${c.slice(0, 40)}`);
  }
});

test("tools nobody has added to any list yet also run", () => {
  for (const c of ["make -j4", "cargo build --release", "javac Main.java", "go test ./...", "wget https://x/y.tar.gz", "docker build ."]) {
    assert.equal(gate(c), null, `unknown-but-productive tool must run: ${c}`);
  }
});

test("idle recon is STILL gated — the loop this gate exists to break", () => {
  for (const c of ["cat /etc/passwd", "grep -r TODO src/", "ls -la /usr/lib", "find / -name '*.cfg'", "head -50 src/other.js"]) {
    assert.equal(isIdleReconCommand(c), true, `is recon: ${c}`);
    assert.match(String(gate(c) ?? ""), /Artifact verification gate/, `must stay gated: ${c}`);
  }
});

test("a compound command is recon only if EVERY segment is viewing", () => {
  assert.equal(isIdleReconCommand("head -5 a.txt | grep x"), true, "viewer piped into viewer");
  assert.equal(isIdleReconCommand("cat a.txt && python3 solve.py"), false, "one real command makes it work");
});

test("writing is never viewing, however the bytes get there", () => {
  assert.equal(isIdleReconCommand("cat > out.txt"), false, "a redirect is a write");
  assert.equal(isIdleReconCommand("echo hi >> log.txt"), false);
});

test("a heredoc BODY is data; what runs after the terminator still counts", () => {
  assert.equal(
    isIdleReconCommand("cat > t.py <<'EOF'\nprint(1)\nEOF\npython3 t.py"),
    false,
    "judging only the opening line would call this a `cat`",
  );
});

test("done still owes a real check", () => {
  assert.match(
    String(artifactVerificationGateRejection({ a: "done", summary: "x" }, opts) ?? ""),
    /Artifact verification gate/,
  );
});

// gcode-to-text (2026-08-21): the shell inversion did not cover `query`, so the
// gate refused `view_image /app/text_render.png` five times — the run's own
// rendered toolpath, the one thing it had to read — and it answered with a gcode
// object label instead. Looking at an image is reading evidence, not avoidance.
test("view_image on a run-produced render is READING, and runs", () => {
  for (const q of ["view_image /app/text_render.png", "view_image /tmp/crop_07.png", "view_image chess_board.png"]) {
    assert.equal(
      artifactVerificationGateRejection({ a: "query", q }, opts),
      null,
      `gate must not refuse ${q}`,
    );
  }
});
