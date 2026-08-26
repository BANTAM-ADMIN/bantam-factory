import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactVerificationGateRejection,
  isComputeShellCommand,
  isProductiveShellCommand,
  progressGateRejection,
} from "../src/progress-awareness.js";

// Binary parsing + chess-best-move (TB2, 2026-08-20): both were force-TERMINATED
// at turn 16-17 of a 200-turn budget because the artifact gate refused to
// execute their read-only COMPUTE commands (parsing an input header;
// evaluating a board with python-chess) as "avoiding validation." Code
// execution is the task's actual work, not recon.

const opts = { needsVerification: true, turnsSinceArtifact: 5, threshold: 2, knownArtifacts: ["out.txt"] };

test("the artifact gate lets code-execution shell run (the real un-trap)", () => {
  const binaryParser = { a: "shell", c: `python3 -c "data=open('fixture.bin','rb').read(); print(data[:4].hex())"` };
  const chess = { a: "shell", c: `python3 -c "import chess; b=chess.Board('r1bq2r1/1p2pp2/p1n1p3/3nkb1P/4P3/1N6/1PQPP3/R1B2R2 w - - 0 1'); print(b.is_valid())"` };
  assert.equal(artifactVerificationGateRejection(binaryParser, opts), null, "binary parsing compute must not be gated");
  assert.equal(artifactVerificationGateRejection(chess, opts), null, "chess compute must not be gated");
});

test("pure file-viewing of a NON-output file is STILL gated (the recon loop)", () => {
  // Viewing the output artifact itself is allowed ("reading it IS checking it").
  // The recon loop the gate breaks is viewing OTHER files without producing or
  // verifying the deliverable — so use a source file that is not a known output.
  const view = { a: "shell", c: "cat helper_notes.py" };
  const rej = artifactVerificationGateRejection(view, opts);
  assert.ok(rej && /Artifact verification gate/.test(rej), "cat of a non-output source should still be gated");
});

test("done without verification is STILL blocked (the essential guardrail)", () => {
  const done = { a: "done", summary: "finished" };
  const rej = artifactVerificationGateRejection(done, opts);
  assert.ok(rej && /Artifact verification gate/.test(rej), "done must still be blocked pre-verification");
});

test("isComputeShellCommand: interpreters/binaries/tools yes, viewers no", () => {
  for (const c of [
    `python3 -c "print(1)"`, "python -m pytest", "node -e 'console.log(1)'",
    "./solver input.bin", "hashcat -m 11600 hash.txt wordlist", "7z l secrets.7z",
    "openssl dgst -sha256 f", "Rscript fit.R", "objdump -d ./a.out",
  ]) assert.equal(isComputeShellCommand(c), true, `should be compute: ${c}`);
  for (const c of [
    "cat out.txt", "head -n5 data.csv", "tail -f log", "ls -la", "grep foo bar",
    "wc -l file", "less README",
  ]) assert.equal(isComputeShellCommand(c), false, `should NOT be compute: ${c}`);
});

test("pure package setup stays nonproductive before the first artifact", () => {
  for (const c of [
    "npm install",
    "pip install py7zr",
    "python -m pip install py7zr",
    "apt-get install -y libcompress-raw-lzma-perl 2>&1 | tail -5",
  ]) {
    assert.equal(isProductiveShellCommand(c), false, `setup alone must not earn progress: ${c}`);
    assert.match(
      progressGateRejection({ a: "shell", c }, { progresslessTurns: 8, threshold: 8 }),
      /analysis-only shell command/,
      `setup alone must remain gated: ${c}`,
    );
  }
});

test("recorded install plus 7z2john extraction remains productive", () => {
  const c = "apt-get install -y libcompress-raw-lzma-perl 2>&1 | tail -5 && perl john/run/7z2john.pl secrets.7z 2>&1";
  assert.equal(isProductiveShellCommand(c), true, "the later Perl extractor is genuine compute");
  assert.equal(
    progressGateRejection({ a: "shell", c }, { progresslessTurns: 12, threshold: 8 }),
    null,
    "the pre-write gate must execute the compound setup+compute action",
  );
});

test("recorded install plus hash materialization remains productive", () => {
  const c = "apt-get install -y libcompress-raw-lzma-perl 2>&1 | tail -3; perl john/run/7z2john.pl secrets.7z > /tmp/hash.txt 2>&1; cat /tmp/hash.txt";
  assert.equal(isProductiveShellCommand(c), true, "the later extraction materializes task evidence");
  assert.equal(
    progressGateRejection({ a: "shell", c }, { progresslessTurns: 13, threshold: 8 }),
    null,
    "the pre-write gate must execute the compound setup+materialization action",
  );
});

test("authoring the deliverable or a test is NOT gated (filter-js un-trap)", () => {
  // editing the deliverable, and writing/patching a test to validate it, are
  // productive work — the gate must not reject them mid-iteration.
  for (const a of [
    { a: "write_file", p: "/app/_test.py", content: "assert True" },
    { a: "replace", p: "/app/filter.py", old: "x", new: "y" },
    { a: "edit_lines", p: "/app/filter.py", start: 1, end: 1, new: "z" },
    { a: "patch", p: "/app/filter.py" },
  ]) assert.equal(artifactVerificationGateRejection(a, opts), null, `authoring must pass: ${a.a}`);
});

test("heredoc/newline compute is recognized (the delimiter gap)", () => {
  // the interpreter follows a NEWLINE after a heredoc terminator, not a ; & |
  const heredoc = { a: "shell", c: "cat > t.py <<'EOF'\nprint(1)\nEOF\npython3 t.py" };
  assert.equal(isComputeShellCommand(heredoc.c), true, "python3 after a newline is still compute");
  assert.equal(artifactVerificationGateRejection(heredoc, opts), null, "heredoc test-run must not be gated");
});

test("delete/move stay gated (cannot guarantee the artifact survives for the check)", () => {
  const del = { a: "delete_file", p: "out.txt" };
  const rej = artifactVerificationGateRejection(del, opts);
  assert.ok(rej && /Artifact verification gate/.test(rej), "delete of the artifact should still be gated");
});
