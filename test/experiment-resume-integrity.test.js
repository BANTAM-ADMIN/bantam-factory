import assert from "node:assert/strict";
import test from "node:test";

import { assertSameHarnessSnapshot } from "../src/experiment-resume.js";

const hash = (character) => character.repeat(64);

function clean(sha = hash("a")) {
  return {
    schema: 1,
    sha,
    dirty: false,
    dirtyHash: null,
    statusSha256: hash("b"),
    worktreeDiffSha256: hash("c"),
    stagedDiffSha256: hash("d"),
    untrackedSha256: hash("e"),
  };
}

function dirty(override = {}) {
  return {
    ...clean(),
    dirty: true,
    dirtyHash: hash("f"),
    ...override,
  };
}

test("resume accepts clean and exactly matching dirty harness snapshots", () => {
  assert.doesNotThrow(() => assertSameHarnessSnapshot(clean(), clean()));
  assert.doesNotThrow(() => assertSameHarnessSnapshot(dirty(), dirty()));
});

test("resume rejects every changed dirty harness component", () => {
  for (const field of [
    "dirtyHash",
    "statusSha256",
    "worktreeDiffSha256",
    "stagedDiffSha256",
    "untrackedSha256",
  ]) {
    assert.throws(
      () => assertSameHarnessSnapshot(dirty(), dirty({ [field]: hash("9") })),
      /dirty harness snapshot does not match/,
    );
  }
  assert.throws(
    () => assertSameHarnessSnapshot(dirty(), clean()),
    /cleanliness does not match/,
  );
  assert.throws(
    () => assertSameHarnessSnapshot(dirty(), dirty({ dirtyHash: null })),
    /lacks complete integrity fingerprints/,
  );
});

test("resume still rejects a different committed revision", () => {
  assert.throws(
    () => assertSameHarnessSnapshot(dirty(), dirty({ sha: hash("9") })),
    /revision does not match/,
  );
});
