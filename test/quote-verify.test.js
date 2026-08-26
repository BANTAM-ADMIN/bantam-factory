// Citation checking turns [S] ink into a property: a fabricated quote's URL
// never contains it (2026-08-19 falsifier). Stubbed codex verdicts drive the
// shelf's VERIFICATION section and the exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SHELF = `# notes
1. Version

VERDICT: X was added in 3.9.

QUOTE:
> "New in version 3.9: asyncio.TaskGroup"

URL: https://docs.python.org/3.9/whatsnew/3.9.html
DATE ACCESSED: 2026-08-19
`;

function withStub(t, verdictLine) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "qv-stub-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash\necho preamble; echo codex; echo "${verdictLine}"\n`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

function shelfFile(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qv-shelf-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, "notes.md");
  fs.writeFileSync(f, SHELF);
  return f;
}

test("a NOT-FOUND citation fails the check and poisons the [S] ink explicitly", (t) => {
  const PATH = withStub(t, "1: NOT-FOUND (page loaded, quote absent)");
  const f = shelfFile(t);
  let code = 0;
  try { execFileSync("node", ["tools/quote-verify.cjs", "--shelf", f], { env: { ...process.env, PATH, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
  const s = fs.readFileSync(f, "utf8");
  assert.match(s, /NOT-FOUND/);
  assert.match(s, /Treat their claims as UNSOURCED regardless of \[S\] ink/);
});

test("a VERIFIED citation passes and stamps the shelf", (t) => {
  const PATH = withStub(t, "1: VERIFIED");
  const f = shelfFile(t);
  const out = execFileSync("node", ["tools/quote-verify.cjs", "--shelf", f], { env: { ...process.env, PATH, BANTAM_GOVERNOR_FORCE: "1" }, encoding: "utf8" });
  assert.match(out, /1\/1 verified/);
  assert.match(fs.readFileSync(f, "utf8"), /All citations verified/);
});
