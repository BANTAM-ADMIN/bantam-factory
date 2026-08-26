// The governor's teeth: with the kill switch on, NO codex process spawns —
// the stub writes a marker file if it ever runs, and the marker must not
// exist after a governed refusal. Force does not argue with the kill switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-rig-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "codex-ran");
  fs.writeFileSync(path.join(dir, "codex"), `#!/usr/bin/env bash\ntouch ${marker}\necho codex\necho "VERDICT: x\\nURL: https://example.org"\n`);
  fs.chmodSync(path.join(dir, "codex"), 0o755);
  return { dir, marker, PATH: `${dir}:${process.env.PATH}` };
}

test("halted root: librarian refuses with exit 3 and codex never spawns", (t) => {
  const { dir, marker, PATH } = rig(t);
  fs.mkdirSync(path.join(dir, ".bantam"));
  fs.writeFileSync(path.join(dir, ".bantam", "no-spend"), "operator said stop\n");
  let code = 0, out = "";
  try {
    execFileSync("node", ["tools/librarian.cjs", "--question", "q?", "--shelf", path.join(dir, "notes.md")],
      { env: { ...process.env, PATH, BANTAM_GOVERNOR_ROOT: dir, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" });
  } catch (e) { code = e.status; out = String(e.stdout); }
  assert.equal(code, 3, "governed refusal is exit 3");
  assert.match(out, /governor refused/);
  assert.equal(fs.existsSync(marker), false, "no codex process may spawn under halt — even forced");
});

test("env kill switch halts quote-verify the same way", (t) => {
  const { dir, marker, PATH } = rig(t);
  const shelf = path.join(dir, "shelf.md");
  fs.writeFileSync(shelf, '> "a quoted claim"\nhttps://example.org/doc\n');
  let code = 0;
  try {
    execFileSync("node", ["tools/quote-verify.cjs", "--shelf", shelf],
      { env: { ...process.env, PATH, BANTAM_GOVERNOR_ROOT: dir, BANTAM_NO_SPEND: "1" }, encoding: "utf8" });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.equal(fs.existsSync(marker), false);
});

test("clean root with force: the errand proceeds and codex runs", (t) => {
  const { dir, marker, PATH } = rig(t);
  const out = execFileSync("node", ["tools/librarian.cjs", "--question", "q?", "--shelf", path.join(dir, "notes.md")],
    { env: { ...process.env, PATH, BANTAM_GOVERNOR_ROOT: dir, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" });
  assert.match(out, /COMPLETE/);
  assert.equal(fs.existsSync(marker), true);
});
