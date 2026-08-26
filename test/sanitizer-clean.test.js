import assert from "node:assert/strict";
import test from "node:test";
import { stripSanitizerNoise } from "../src/offline-install.js";

const ASAN = `==590==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x51f000000c80
    #0 0x582 in gemm /app/gpt2.c:13
    #1 0x582 in block /app/gpt2.c:25
    #2 0x582 in main /app/gpt2.c:60
SUMMARY: AddressSanitizer: heap-buffer-overflow /app/gpt2.c:13 in gemm
Shadow bytes around the buggy address:
  0x51f000000980: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  0x51f000000c80: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
Shadow byte legend (one shadow byte represents 8 application bytes):
  Addressable:           00
==590==ABORTING`;

test("keeps the actionable bug lines, drops the shadow hex dump", () => {
  const cleaned = stripSanitizerNoise(ASAN);
  assert.ok(cleaned.includes("heap-buffer-overflow"), "keeps ERROR");
  assert.ok(cleaned.includes("gemm /app/gpt2.c:13"), "keeps the stack frame with file:line");
  assert.ok(cleaned.includes("SUMMARY: AddressSanitizer"), "keeps SUMMARY");
  assert.ok(!cleaned.includes("fa fa fa"), "drops the shadow hex");
  assert.ok(!cleaned.includes("Shadow byte legend"), "drops the legend");
  assert.ok(cleaned.includes("shadow-memory hex dump omitted"), "leaves a pointer note");
  assert.ok(cleaned.length < ASAN.length, "shorter than the original");
});

test("non-sanitizer output is returned untouched", () => {
  const normal = "hello world\nexit 0\n";
  assert.equal(stripSanitizerNoise(normal), normal);
});

test("handles empty/undefined safely", () => {
  assert.equal(stripSanitizerNoise(""), "");
  assert.equal(stripSanitizerNoise(undefined), "");
});
