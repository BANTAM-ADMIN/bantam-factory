// This test exercises BANTAMBOOKFACTORY/src/genre.js — it belongs in the book
// project's own suite and should migrate there; it sits here because it was
// committed into the shared tree without its imports (red since 2026-08-17,
// wired green 2026-08-18 at the operator's request).
import { test } from "node:test";
import assert from "node:assert/strict";
import { statePathSkipReason } from "./helpers/env-guards.js";

// The module graph itself is the prerequisite: genre.js statically imports
// vocabulary.js, so a static import here would throw before any {skip} option
// is consulted. Gate first, then import dynamically.
const _stateSkip = statePathSkipReason("BANTAMBOOKFACTORY/src/genre.js")
  || statePathSkipReason("BANTAMBOOKFACTORY/src/vocabulary.js");
const { checkContract } = _stateSkip ? { checkContract: null } : await import("../BANTAMBOOKFACTORY/src/genre.js");


test("a book too short for acts is not judged on act structure", { skip: _stateSkip }, () => {
  // `within: 0.25` of four beats is one beat. The obligations describe where a
  // promise sits in a BOOK, and below a dozen chapters there is no there there.
  // Caught by the route smoke test, which builds a 4-chapter novella from
  // placeholder beats and was stopped by a bar with no room to mean anything.
  const tiny = [{ beat: "Kell files a report." }, { beat: "Kell goes home." }, { beat: "Kell files another." }, { beat: "The week ends." }];
  assert.deepEqual(checkContract(tiny, "thriller"), []);
  assert.deepEqual(checkContract(tiny, "romance"), []);
});
