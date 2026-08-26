import assert from "node:assert/strict";
import test from "node:test";
import { classifyCrashSanitizer } from "../src/offline-install.js";

test("steers to a sanitizer on a segfault of a locally-run binary", () => {
  assert.ok(classifyCrashSanitizer("timeout 30 ./a.out gpt2-124M.ckpt vocab.bpe \"Hi\"", 139, ""));
  assert.ok(classifyCrashSanitizer("./a.out in.txt", 0, "Segmentation fault (core dumped)"));
  assert.ok(classifyCrashSanitizer("gcc -O3 x.c -o x -lm && ./x", 134, "double free or corruption"));
  const r = classifyCrashSanitizer("./a.out", 139, "");
  assert.match(r.message, /\[sanitizer\]/);
  assert.match(r.message, /-fsanitize=address,undefined/);
});

test("does NOT fire when already sanitized or not a crash", () => {
  assert.equal(classifyCrashSanitizer("gcc -g -fsanitize=address x.c -o d && ./d", 1, "AddressSanitizer: heap-buffer-overflow"), null);
  assert.equal(classifyCrashSanitizer("./a.out gpt2-124M.ckpt vocab.bpe \"Hi\"", 0, "The quick brown fox"), null);
  // a non-crash exit code with no crash text
  assert.equal(classifyCrashSanitizer("./a.out", 1, "wrong output"), null);
});

test("does NOT fire when the crash word came from a tool, not a local binary run", () => {
  // grep printing the word, or a compile-only command — no ./binary run
  assert.equal(classifyCrashSanitizer("grep -c 'Segmentation fault' log.txt", 0, "3"), null);
  assert.equal(classifyCrashSanitizer("gcc x.c -o x", 0, ""), null);
});
