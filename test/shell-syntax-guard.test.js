import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { looksLikeShell, shellSyntaxHint } from "../src/logic/shell-syntax-guard.js";

// compile-compcert (2026-08-21) wrote build_compcert.sh with an unbalanced quote
// and found out at EXECUTION: "line 101: unexpected EOF while looking for
// matching '\"'" — after the configure step it wrapped had already run. bash -n
// names it at authoring time for one subprocess.

function ws() { return fs.mkdtempSync(path.join(os.tmpdir(), "bantam-sh-")); }

test("an unbalanced quote is caught at authoring time", () => {
  const w = ws();
  fs.writeFileSync(path.join(w, "build.sh"), '#!/bin/bash\necho "start\nmake all\n');
  const hint = shellSyntaxHint("build.sh", { workspace: w, readFile: (r) => fs.readFileSync(path.join(w, r), "utf8") });
  assert.ok(hint, "expected a syntax hint");
  assert.match(hint, /does not parse/);
  assert.match(hint, /gave up/i, "must warn the reported line is where bash stopped, not where the quote opened");
});

test("a valid script produces nothing", () => {
  const w = ws();
  fs.writeFileSync(path.join(w, "ok.sh"), '#!/bin/bash\nset -e\necho "fine"\nfor i in 1 2; do echo $i; done\n');
  assert.equal(shellSyntaxHint("ok.sh", { workspace: w, readFile: (r) => fs.readFileSync(path.join(w, r), "utf8") }), null);
});

test("non-shell files are ignored", () => {
  const w = ws();
  fs.writeFileSync(path.join(w, "a.py"), 'print("unbalanced\n');
  assert.equal(shellSyntaxHint("a.py", { workspace: w, readFile: (r) => fs.readFileSync(path.join(w, r), "utf8") }), null);
});

test("a shebang counts even without a .sh extension", () => {
  assert.equal(looksLikeShell("runner", "#!/bin/bash\necho hi"), true);
  assert.equal(looksLikeShell("runner", "#!/usr/bin/env python3"), false);
  assert.equal(looksLikeShell("build.sh", ""), true);
});

test("it never throws, whatever it is handed", () => {
  for (const p of [null, undefined, "", "/nonexistent/deep/x.sh"]) {
    assert.doesNotThrow(() => shellSyntaxHint(p, { workspace: "/tmp" }));
  }
});

// The guard sits on the edit path of every run in the sweep, so it must cost
// nothing on edits that cannot be shell scripts. Sniffing line 1 of every
// edited file would put a read on each one, including multi-megabyte data files.
test("costs ZERO reads on any extensioned non-shell file", () => {
  let reads = 0;
  const readFile = () => { reads += 1; return "#!/bin/bash\n"; };
  for (const f of ["big.csv", "mod.py", "a.json", "notes.md", "data.txt", "out.bin"]) {
    shellSyntaxHint(f, { workspace: "/tmp", readFile });
  }
  assert.equal(reads, 0, "a guard must not tax the path it watches");
});

test("but an EXTENSIONLESS file is still sniffed for a shebang", () => {
  let reads = 0;
  const readFile = () => { reads += 1; return "#!/usr/bin/env python3\n"; };
  shellSyntaxHint("runner", { workspace: "/tmp", readFile });
  assert.equal(reads, 1, "`runner` / `build` are the real shebang cases");
});
