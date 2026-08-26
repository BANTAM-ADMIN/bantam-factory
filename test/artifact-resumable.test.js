import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildArtifact } from "../src/artifact.js";
import { restoreWorkspace, snapshotWorkspace } from "../src/workspace-snapshot.js";

// A saved run artifact carried the DIALOGUE and none of the FILES, so
// `--resume-run` restored a conversation into an empty directory. The consumer
// half already existed in bin/bantam.js; only the producer was missing.
//
// That gap is the whole OUT-OF-BUDGET class. On 2026-08-21, three of nine
// standing terminal-bench reds were runs cut mid-work — gcode-to-text at turn 22
// holding a parsed toolpath, write-compressor at 80 holding a half-built
// arithmetic coder — and every one had to start again from zero, because its
// files died with its container.

test("a snapshot round-trips through an artifact into a fresh directory", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ws-"));
  fs.writeFileSync(path.join(src, "solve.py"), "print('half done')\n");
  fs.mkdirSync(path.join(src, "lib"));
  fs.writeFileSync(path.join(src, "lib", "coder.py"), "# arithmetic coder\n");

  const artifact = buildArtifact({
    runId: "r", stamp: "s", model: {}, result: { turns: [], metrics: {} },
    workspaceSnapshot: snapshotWorkspace(src),
  });
  assert.ok(artifact.workspaceSnapshot, "artifact must carry the snapshot");

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ws2-"));
  restoreWorkspace(artifact.workspaceSnapshot, dest, { skipExisting: true });
  assert.equal(fs.readFileSync(path.join(dest, "solve.py"), "utf8"), "print('half done')\n");
  assert.equal(fs.readFileSync(path.join(dest, "lib", "coder.py"), "utf8"), "# arithmetic coder\n");
});

test("an artifact with no snapshot omits the key entirely", () => {
  const a = buildArtifact({ runId: "r", stamp: "s", model: {}, result: { turns: [], metrics: {} } });
  assert.equal(a.workspaceSnapshot, undefined, "absent, not null — older readers must be unaffected");
  const b = buildArtifact({
    runId: "r", stamp: "s", model: {}, result: { turns: [], metrics: {} },
    workspaceSnapshot: { files: [] },
  });
  assert.equal(b.workspaceSnapshot, undefined, "an empty snapshot is not worth a key");
});

test("weights and binaries stay OUT — the snapshot must never bloat", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ws3-"));
  fs.writeFileSync(path.join(src, "keep.py"), "x = 1\n");
  fs.writeFileSync(path.join(src, "model.ckpt"), Buffer.from([0x00, 0x01, 0x00, 0x02, 0x00]));
  fs.mkdirSync(path.join(src, "node_modules"));
  fs.writeFileSync(path.join(src, "node_modules", "junk.js"), "junk\n");

  const snap = snapshotWorkspace(src);
  const kept = snap.files.map((f) => f.path);
  assert.ok(kept.includes("keep.py"), "agent-authored source is the point");
  assert.ok(!kept.some((p) => p.includes("model.ckpt")), "NUL-byte sniff must reject binaries");
  assert.ok(!kept.some((p) => p.includes("node_modules")), "regenerable trees stay out");
});
