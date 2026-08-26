// Context is one dial with three positions, driven by two environment variables
// that used to be set independently and reported in two vocabularies: the
// banner said "context rebuild", the knob said BANTAM_IMMUTABLE_HISTORY, and
// nothing connected them. Remembering the choice across sessions makes it
// invisible state, so resolution reports its SOURCE and the session announces
// what is active.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  CONTEXT_MODES,
  DEFAULT_CONTEXT_MODE,
  contextModeEnv,
  contextModeFromEnv,
  contextModeIsImmutable,
  describeContextMode,
  normalizeContextMode,
  renderModeLine,
  renderModeTable,
  resolveContextMode,
} from "../src/logic/session-modes.js";
import { loadUserSettings, saveUserSetting } from "../src/logic/user-settings.js";

const madeDirs = [];
after(() => { for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true }); });

test("mode names accept the words an operator actually types", () => {
  for (const word of ["extension", "Extension", "cache", "fast", "prefix"]) {
    assert.equal(normalizeContextMode(word), "extension", word);
  }
  for (const word of ["immutable", "append", "append-only"]) {
    assert.equal(normalizeContextMode(word), "immutable", word);
  }
  for (const word of ["rebuild", "recompute", "fresh", "clean", "full"]) {
    assert.equal(normalizeContextMode(word), "rebuild", word);
  }
  assert.equal(normalizeContextMode("sideways"), null);
  assert.equal(normalizeContextMode(""), null);
});

test("rebuild is the default, matching a bare run with neither variable set", () => {
  const r = resolveContextMode({});
  assert.equal(r.mode, DEFAULT_CONTEXT_MODE);
  assert.equal(r.mode, "rebuild");
  assert.match(r.source, /default/);
  assert.deepEqual(CONTEXT_MODES, ["rebuild", "immutable", "extension"]);
});

test("each mode maps onto the two environment variables the agent reads", () => {
  assert.deepEqual(contextModeEnv("rebuild"), { BANTAM_PROMPT_TRAJECTORY: "rebuild", BANTAM_IMMUTABLE_HISTORY: "0" });
  assert.deepEqual(contextModeEnv("immutable"), { BANTAM_PROMPT_TRAJECTORY: "rebuild", BANTAM_IMMUTABLE_HISTORY: "1" });
  // src/agent.js forces immutable history under the extension trajectory; the
  // mapping must say so rather than leave the two knobs disagreeing.
  assert.deepEqual(contextModeEnv("extension"), { BANTAM_PROMPT_TRAJECTORY: "extension", BANTAM_IMMUTABLE_HISTORY: "1" });
  for (const mode of CONTEXT_MODES) {
    assert.equal(contextModeFromEnv(contextModeEnv(mode)), mode, `${mode} must round-trip through the environment`);
    assert.equal(contextModeIsImmutable(mode), mode !== "rebuild");
  }
});

test("precedence runs flag > env > remembered > default, and names the source", () => {
  assert.deepEqual(
    resolveContextMode({ contextModeFlag: "extension", envImmutable: "0", saved: "rebuild" }),
    { mode: "extension", source: "--context-mode extension" },
  );
  assert.deepEqual(
    resolveContextMode({ immutableFlag: true, saved: "rebuild" }),
    { mode: "immutable", source: "--immutable-history" },
  );
  assert.deepEqual(
    resolveContextMode({ recomputeFlag: true, saved: "extension" }),
    { mode: "rebuild", source: "--recompute" },
  );
  assert.deepEqual(
    resolveContextMode({ envTrajectory: "extension", saved: "rebuild" }),
    { mode: "extension", source: "BANTAM_PROMPT_TRAJECTORY" },
  );
  assert.deepEqual(
    resolveContextMode({ envImmutable: "1", saved: "rebuild" }),
    { mode: "immutable", source: "BANTAM_IMMUTABLE_HISTORY" },
  );
  assert.deepEqual(
    resolveContextMode({ saved: "extension" }),
    { mode: "extension", source: "remembered" },
  );
  // A variable set to a falsey value is an explicit answer, not silence.
  assert.deepEqual(
    resolveContextMode({ envImmutable: "0", saved: "extension" }),
    { mode: "rebuild", source: "BANTAM_IMMUTABLE_HISTORY" },
  );
});

test("an unreadable remembered mode falls back instead of throwing", () => {
  assert.equal(resolveContextMode({ saved: "gibberish" }).mode, "rebuild");
  assert.match(resolveContextMode({ saved: "gibberish" }).source, /default/);
});

test("every mode explains both what it buys and what it costs", () => {
  for (const mode of CONTEXT_MODES) {
    const text = describeContextMode(mode);
    assert.ok(text && text.length > 20, `${mode} needs a real description`);
  }
  assert.match(describeContextMode("extension"), /stale/i);
  assert.match(describeContextMode("rebuild"), /reprefill/i);
});

test("the startup line names every optional mode and how to change them", () => {
  const line = renderModeLine([
    { key: "context", value: "rebuild", command: ":context" },
    { key: "stream", value: "off", command: ":stream" },
    { key: "rooster", value: "on", command: ":rooster" },
  ]);
  assert.match(line, /context=rebuild/);
  assert.match(line, /stream=off/);
  assert.match(line, /rooster=on/);
  assert.match(line, /:modes/, "the line must say where the full list lives");
});

test("the mode table explains each mode and the command that flips it", () => {
  const text = renderModeTable([
    { key: "context", value: "extension", command: ":context [rebuild|immutable|extension]", detail: describeContextMode("extension") },
    { key: "rooster", value: "on", command: ":rooster [on|off]", detail: "mood labels and a crow when work lands" },
  ]).join("\n");
  assert.match(text, /:context \[rebuild\|immutable\|extension\]/);
  assert.match(text, /:rooster \[on\|off\]/);
  assert.match(text, /context=extension/);
});

test("a chosen mode survives into the next session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-modes-"));
  madeDirs.push(home);
  const file = path.join(home, ".bantam", "settings.json");
  saveUserSetting("contextMode", "extension", file);
  assert.equal(loadUserSettings(file).contextMode, "extension");
  assert.equal(resolveContextMode({ saved: loadUserSettings(file).contextMode }).mode, "extension");
});
