import assert from "node:assert/strict";
import test from "node:test";
import { extractBugSignature, assessBugStall, createBugStallState, BUG_STALL_DEFAULTS } from "../src/bug-stall.js";

const SUMMARY = "SUMMARY: AddressSanitizer: heap-buffer-overflow /app/gpt2.c:13 in gemm";
const FRAME = "==1==ERROR: AddressSanitizer: heap-buffer-overflow\n    #0 0x58 in gemm /app/gpt2.c:13\n    #1 0x58 in block /app/gpt2.c:25";
const UBSAN = "/app/gpt2.c:41:20: runtime error: signed integer overflow";

test("extractBugSignature parses ASAN SUMMARY, stack frame, and UBSAN", () => {
  assert.deepEqual(extractBugSignature(SUMMARY), { type: "heap-buffer-overflow", loc: "gpt2.c:13", fn: "gemm" });
  assert.deepEqual(extractBugSignature(FRAME), { type: "heap-buffer-overflow", loc: "gpt2.c:13", fn: "gemm" });
  assert.deepEqual(extractBugSignature(UBSAN), { type: "runtime-error", loc: "gpt2.c:41", fn: null });
  assert.equal(extractBugSignature("all good, exit 0"), null);
});

test("fires only after the SAME bug repeats, naming the exact function", () => {
  const s = createBugStallState();
  for (let i = 0; i < BUG_STALL_DEFAULTS.repeatToSteer - 1; i++) {
    assert.equal(assessBugStall(SUMMARY, s).steer, false);
  }
  const r = assessBugStall(SUMMARY, s);
  assert.equal(r.steer, true);
  assert.match(r.message, /\[bug-stall\]/);
  assert.match(r.message, /`gemm`/);
  assert.match(r.message, /ISOLATE/);
});

test("a DIFFERENT bug resets the streak (normal iterative fixing is not punished)", () => {
  const s = createBugStallState();
  assessBugStall(SUMMARY, s);
  assessBugStall(SUMMARY, s);
  const other = assessBugStall("SUMMARY: AddressSanitizer: stack-overflow /app/gpt2.c:60 in main", s);
  assert.equal(other.steer, false, "new bug → streak reset, no fire");
  assert.equal(s.streak, 1);
});

test("a clean run (no bug) resets the streak", () => {
  const s = createBugStallState();
  assessBugStall(SUMMARY, s); assessBugStall(SUMMARY, s);
  assessBugStall("exit 0\nThe quick brown fox", s);
  assert.equal(s.streak, 0);
});

test("fires at most twice, then quiet", () => {
  const s = createBugStallState();
  let fires = 0;
  for (let i = 0; i < 40; i++) if (assessBugStall(SUMMARY, s).steer) fires++;
  assert.equal(fires, 2);
});
