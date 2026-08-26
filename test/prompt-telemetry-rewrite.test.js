import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifySectionChange } from "../src/prompt-telemetry.js";

// `firstChangedSection` compares section hashes against a FIXED SECTION_ORDER, so
// it names the earliest section in that list that differs AT ALL. actionHistory
// sits third and gains a new action every turn by definition, so it was reported
// as the first changed section on 8 of 8 turns -- a fact that is true by
// construction and carries no information.
//
// A report built on it (shipped earlier the same day) told readers that section
// was "where prompt assembly is rewriting history". It was not: the raw prefix
// actually broke inside <open_files> on most of those turns.
//
// The distinction that matters is whether a section GREW or was REWRITTEN. Growth
// is the cost of progress and is cache-friendly, because everything already sent
// stays valid. A rewrite invalidates the prefix from that point and is paid twice
// under delta delivery.

describe("telling a section that grew from one that was rewritten", () => {
  it("calls untouched content unchanged", () => {
    assert.equal(classifySectionChange("abc", "abc"), "unchanged");
  });

  it("calls pure growth an append", () => {
    assert.equal(classifySectionChange("abc", "abcdef"), "appended");
  });

  it("calls altered existing bytes a rewrite", () => {
    assert.equal(classifySectionChange("abcdef", "abXdef"), "rewritten");
  });

  // The case that matters most: a section that both loses and gains content, e.g.
  // a file body replaced by a pointer while a new action is appended.
  it("calls shrink-and-regrow a rewrite, not an append", () => {
    assert.equal(classifySectionChange("aaaaBODYaaaa", "aaaaPTRaaaaEXTRA"), "rewritten");
  });

  it("calls pure shrinkage a rewrite", () => {
    assert.equal(classifySectionChange("abcdef", "abc"), "rewritten");
  });

  it("treats appearing from nothing as an append", () => {
    assert.equal(classifySectionChange("", "new content"), "appended");
  });

  it("treats disappearing entirely as a rewrite", () => {
    assert.equal(classifySectionChange("was here", ""), "rewritten");
  });
});
