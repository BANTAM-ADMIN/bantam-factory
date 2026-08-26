import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOperatorProfile } from "../src/operator-profile.js";
import { buildPrompt } from "../src/prompt.js";

// Mined from 1,500 of the operator's real sessions: the same standing
// instructions restated across hundreds of them — TDD in 120 distinct
// sessions, stay-in-this-directory in 91, document-as-you-go in 64,
// show-me-it-working in 52. A preference said a hundred times belongs in
// context by default, not in the human's next message.

test("the profile loads from an explicit path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-profile-"));
  fs.writeFileSync(path.join(dir, "p.md"), "- TDD by default\n- stay in the given directory\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = loadOperatorProfile({ env: { BANTAM_PROFILE: path.join(dir, "p.md") } });
  assert.match(p.text, /TDD by default/);
});

test("BANTAM_PROFILE=0 switches it off", () => {
  assert.equal(loadOperatorProfile({ env: { BANTAM_PROFILE: "0" } }), null);
});

test("no file is a fine state, not an error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-nohome-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadOperatorProfile({ env: {}, home: dir }), null);
});

test("an oversized profile is clipped, not rejected", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-bigprof-"));
  fs.writeFileSync(path.join(dir, "p.md"), "- rule\n".repeat(1000));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = loadOperatorProfile({ env: { BANTAM_PROFILE: path.join(dir, "p.md") } });
  assert.ok(p.text.length <= 1600, String(p.text.length));
});

test("the prompt carries the preferences as a standing block", () => {
  const p = buildPrompt({ task: "t", env: "e", turns: [], interactive: true, profileText: "- show it working" });
  assert.match(p, /Operator preferences \(standing/);
  assert.match(p, /show it working/);
  assert.doesNotMatch(buildPrompt({ task: "t", env: "e", turns: [] }), /Operator preferences/);
});
