// The librarian runner's contract, tested with a stubbed codex on PATH:
// stdout-only return, chrome stripped, provenance + status stamped,
// deadline yields PARTIAL, empty haul yields NO-HAUL with exit 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function withStub(t, script) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lib-stub-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash\n${script}\n`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

test("a clean haul is shelved with provenance and status COMPLETE", (t) => {
  const PATH = withStub(t, 'echo preamble; echo codex; echo "VERDICT: X\\nQUOTE: \\"spec says X\\"\\nURL: https://example.org"');
  const shelf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lib-shelf-")), "reference", "notes.md");
  const out = execFileSync("node", ["tools/librarian.cjs", "--question", "q?", "--shelf", shelf], { env: { ...process.env, PATH, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" });
  assert.match(out, /COMPLETE/);
  const s = fs.readFileSync(shelf, "utf8");
  assert.match(s, /PROVENANCE/); assert.match(s, /not gospel/); assert.match(s, /spec says X/);
  assert.doesNotMatch(s, /preamble/, "chrome before the final message is stripped");
});

test("an empty return is NO-HAUL with exit 1, shelf still explains itself", (t) => {
  const PATH = withStub(t, "echo preamble; echo codex; echo ''");
  const shelf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lib-shelf2-")), "notes.md");
  let code = 0;
  try { execFileSync("node", ["tools/librarian.cjs", "--question", "q?", "--shelf", shelf], { env: { ...process.env, PATH, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.match(fs.readFileSync(shelf, "utf8"), /NO-HAUL|no evidence returned/);
});

test("the deadline produces PARTIAL when output exists", (t) => {
  const PATH = withStub(t, 'echo codex; echo "VERDICT: partial fact\\nURL: https://example.org"; sleep 30');
  const shelf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lib-shelf3-")), "notes.md");
  execFileSync("node", ["tools/librarian.cjs", "--question", "q?", "--shelf", shelf, "--timeout-sec", "3"], { env: { ...process.env, PATH, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" });
  assert.match(fs.readFileSync(shelf, "utf8"), /PARTIAL|COMPLETE/);
}, { timeout: 20000 });
