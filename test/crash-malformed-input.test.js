import test from "node:test";
import assert from "node:assert/strict";

import { classifyCrashSanitizer } from "../src/offline-install.js";

const SEGV = "Segmentation fault (core dumped)";

test("a given binary crashing on piped/redirected input blames the INPUT, not the binary", () => {
  for (const cmd of [
    "cat data.comp | ./decomp > out.txt",
    "./decomp < data.comp > out.txt; echo exit=$?",
    "python3 enc.py && ./decomp < data.comp > out.txt; cmp data.txt out.txt",
  ]) {
    const r = classifyCrashSanitizer(cmd, 139, SEGV);
    assert.ok(r, cmd);
    assert.equal(r.kind, "crash-malformed-input", cmd);
    assert.match(r.message, /your stream is malformed/);
    assert.doesNotMatch(r.message, /fsanitize/);
  }
});

test("a binary run on its own still gets the sanitizer steer", () => {
  const r = classifyCrashSanitizer("./a.out", 139, SEGV);
  assert.equal(r.kind, "crash-sanitizer");
  assert.match(r.message, /fsanitize/);
  const r2 = classifyCrashSanitizer("./solver input.txt", 134, "Aborted (core dumped)");
  assert.equal(r2.kind, "crash-sanitizer");
});

test("no crash, no steer; already-sanitized, no steer", () => {
  assert.equal(classifyCrashSanitizer("cat x | ./decomp", 0, "ok"), null);
  assert.equal(classifyCrashSanitizer("./dbg < in", 139, "AddressSanitizer: heap-buffer-overflow"), null);
});

test("the crashing binary's name stops at shell punctuation", () => {
  const r = classifyCrashSanitizer("cat data.comp | ./decomp; echo exit=$?", 139, SEGV);
  assert.match(r.message, /\[crash\] \.\/decomp crashed/);
  assert.doesNotMatch(r.message, /decomp;/);
});
