import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditOrphans, formatOrphanAudit } from "../src/logic/orphan-audit.js";

// integration-audit answers "is this wired?" only for files named in the
// self-improve proposal registry. Everything outside that list was invisible, so
// the ratchet built on it guarded 1,587 lines while 2,995 sat unwatched --
// including three modules nothing imports at all, not even a test.
//
// A guard that only watches where you already looked is not a guard. That is the
// same defect this codebase spent a day finding in its other instruments, sitting
// in the one built to prevent it.

// Removed when this file finishes -- see the note in open-files-stable-order.test.js.
// A leaked directory per run is invisible until the disk is full, and then it
// shows up as someone else's test failing.
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-"));
  madeDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

describe("finding modules nothing runs", () => {
  it("does not flag a module a production file imports", () => {
    const root = repo({
      "src/used.js": "export const a = 1;\n",
      "src/main.js": 'import { a } from "./used.js";\n',
    });
    assert.deepEqual(auditOrphans(root).orphans.map((o) => o.file), ["src/main.js"]);
  });

  // The blind spot that made a first version of this scan wrong: several live
  // tools are invoked only from examples/, and were reported as orphans.
  it("counts examples/ as a real consumer", () => {
    const root = repo({
      "src/tool.js": "export const t = 1;\n",
      "examples/run.mjs": 'import { t } from "../src/tool.js";\n',
    });
    assert.deepEqual(auditOrphans(root).orphans, []);
  });

  it("separates test-only from imported-by-nothing", () => {
    const root = repo({
      "src/tested.js": "export const a = 1;\n",
      "src/dead.js": "export const b = 2;\n",
      "test/tested.test.js": 'import { a } from "../src/tested.js";\n',
    });
    const kinds = Object.fromEntries(auditOrphans(root).orphans.map((o) => [path.basename(o.file), o.kind]));
    assert.equal(kinds["tested.js"], "test-only");
    assert.equal(kinds["dead.js"], "unreferenced");
  });

  // A bare mention in prose or a registry string is not an import. Counting those
  // is exactly what made turn-parallelism.js look wired while nothing ran it.
  it("does not count a filename mentioned in a comment as an import", () => {
    const root = repo({
      "src/lonely.js": "export const a = 1;\n",
      "src/registry.js": '// proposal targets lonely.js when absent\nexport const files = ["lonely.js"];\n',
    });
    const orphans = auditOrphans(root).orphans.map((o) => path.basename(o.file));
    assert.ok(orphans.includes("lonely.js"),
      "a name inside a string or comment must not count as running the module");
  });

  it("names the imported-by-nothing modules in the report", () => {
    const root = repo({ "src/dead.js": "export const b = 2;\n" });
    assert.match(formatOrphanAudit(auditOrphans(root)), /imported by NOTHING/);
  });
});

// preview-runner.mjs and lock-recovery-child.js are never imported: they are
// SPAWNED by path with execFileSync. Their filename appears in a plain string,
// which is indistinguishable from the proposal registry's `files: ["x.js"]`
// arrays. Reporting a spawned entry point as dead code would invite deleting
// something load-bearing -- the confident-wrong-answer failure this audit exists
// to catch, in the audit itself.
describe("not guessing about modules named only in strings", () => {
  it("separates possibly-spawned from imported-by-nothing", () => {
    const root = repo({
      "src/spawned.js": "console.log('child');\n",
      "src/dead.js": "export const x = 1;\n",
      "src/parent.js": 'const RUNNER = "spawned.js";\nexecFileSync(process.execPath, [RUNNER]);\n',
    });
    const kinds = Object.fromEntries(
      auditOrphans(root).orphans.map((o) => [path.basename(o.file), o.kind]),
    );
    assert.equal(kinds["spawned.js"], "possibly-spawned");
    assert.equal(kinds["dead.js"], "unreferenced");
  });

  it("says plainly that it cannot tell which", () => {
    const root = repo({
      "src/spawned.js": "console.log('child');\n",
      "src/parent.js": 'const RUNNER = "spawned.js";\n',
    });
    assert.match(formatOrphanAudit(auditOrphans(root)), /cannot tell, and does not guess/);
  });
});

// health-dashboard.js is nobody's import and entirely alive: it declares
// `Usage: node src/health-dashboard.js [--json]` and produces real output when
// run. Calling it dead would have been the THIRD false-positive class in this
// audit, after omitting examples/ and matching bare quoted filenames.
describe("recognising standalone entry points", () => {
  it("does not call a documented CLI dead", () => {
    const root = repo({
      "src/tool.js": "// Usage: node src/tool.js [--json]\nconsole.log('{}');\n",
      "src/dead.js": "export const x = 1;\n",
    });
    const kinds = Object.fromEntries(
      auditOrphans(root).orphans.map((o) => [path.basename(o.file), o.kind]),
    );
    assert.equal(kinds["tool.js"], "cli-entry");
    assert.equal(kinds["dead.js"], "unreferenced");
  });

  it("recognises a shebang too", () => {
    const root = repo({ "src/script.js": "#!/usr/bin/env node\nconsole.log(1);\n" });
    assert.equal(auditOrphans(root).orphans[0].kind, "cli-entry");
  });
});

// D14: the citation audit above cannot distinguish "unwired by design" from
// "unwired by drift" — one barrel import certifies every module the barrel
// re-exports. Reachability answers the question the ratchet actually needs:
// starting from things a person can run (bin/, CLI entries, examples/, and —
// in its own tier — scripts/), which modules can execution actually reach?
// Barrel edges are export-level: importing { A } from the barrel reaches only
// the module that A is re-exported from, not the whole island.
import { auditReachability } from "../src/logic/orphan-audit.js";

describe("reachability from entry points (D14)", () => {
  it("walks export-level edges through a barrel instead of certifying the island", () => {
    const root = repo({
      "bin/run.js": 'import { A } from "../src/barrel.js";\n',
      "src/barrel.js": 'export { A } from "./a.js";\nexport { B } from "./b.js";\n',
      "src/a.js": 'import { helper } from "./c.js";\nexport const A = () => helper();\n',
      "src/b.js": "export const B = 2;\n",
      "src/c.js": "export const helper = () => 3;\n",
    });
    const audit = auditReachability(root);
    const tier = Object.fromEntries(audit.modules.map((m) => [m.file, m.tier]));
    assert.equal(tier["src/a.js"], "production");
    assert.equal(tier["src/c.js"], "production", "transitive import of a used export is reachable");
    assert.equal(tier["src/barrel.js"], "production");
    assert.equal(tier["src/b.js"], "unreachable", "an unused barrel re-export does not certify its module");
  });

  it("reaches the whole island when the barrel is imported as a namespace", () => {
    const root = repo({
      "bin/run.js": 'import * as all from "../src/barrel.js";\nall;\n',
      "src/barrel.js": 'export { B } from "./b.js";\n',
      "src/b.js": "export const B = 2;\n",
    });
    const audit = auditReachability(root);
    assert.equal(audit.modules.find((m) => m.file === "src/b.js").tier, "production");
  });

  it("separates script-reachable from production-reachable and from unreachable", () => {
    const root = repo({
      "bin/run.js": 'import { A } from "../src/a.js";\n',
      "src/a.js": "export const A = 1;\n",
      "src/lab-only.js": "export const L = 1;\n",
      "scripts/lab.mjs": 'import { L } from "../src/lab-only.js";\n',
      "src/dead.js": "export const D = 1;\n",
    });
    const audit = auditReachability(root);
    const tier = Object.fromEntries(audit.modules.map((m) => [m.file, m.tier]));
    assert.equal(tier["src/a.js"], "production");
    assert.equal(tier["src/lab-only.js"], "script");
    assert.equal(tier["src/dead.js"], "unreachable");
    assert.equal(audit.totals.unreachableLines > 0, true);
  });

  it("treats CLI entry points and examples as production roots", () => {
    const root = repo({
      "src/dash.js": "// Usage: node src/dash.js [--json]\nimport { h } from \"./h.js\";\nexport const d = () => h;\n",
      "src/h.js": "export const h = 1;\n",
      "src/ex-tool.js": "export const t = 1;\n",
      "examples/demo.mjs": 'import { t } from "../src/ex-tool.js";\n',
    });
    const audit = auditReachability(root);
    const tier = Object.fromEntries(audit.modules.map((m) => [m.file, m.tier]));
    assert.equal(tier["src/dash.js"], "production");
    assert.equal(tier["src/h.js"], "production");
    assert.equal(tier["src/ex-tool.js"], "production");
  });

  it("moves a named exemption out of unreachable and refuses an unused exemption", () => {
    const root = repo({
      "bin/run.js": 'import { A } from "../src/a.js";\n',
      "src/a.js": "export const A = 1;\n",
      "src/held.js": "export const H = 1;\n",
    });
    const audit = auditReachability(root, { exemptions: [{ file: "src/held.js", reason: "kept for the S2 persistence build" }] });
    const held = audit.modules.find((m) => m.file === "src/held.js");
    assert.equal(held.tier, "exempted");
    assert.equal(held.reason, "kept for the S2 persistence build");
    assert.throws(
      () => auditReachability(root, { exemptions: [{ file: "src/ghost.js", reason: "stale" }] }),
      /exemption does not match/,
      "a stale exemption is itself drift and must fail loudly",
    );
  });
});

  it("reaches identically from a relative root (the mkdtemp fixtures cannot catch this)", () => {
    const root = repo({
      "bin/run.js": 'import { A } from "../src/a.js";\n',
      "src/a.js": "export const A = 1;\n",
    });
    const relative = path.relative(process.cwd(), root);
    const audit = auditReachability(relative);
    assert.equal(audit.modules.find((m) => m.file === "src/a.js").tier, "production");
  });
