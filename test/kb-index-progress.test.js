// The first chat request on a big repository sat behind an invisible KB build
// and felt unresponsive (operator taste report, 2026-08-18). The index build
// now reports progress with a known denominator: walk first, then extract,
// calling onProgress throttled and always on the final file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodeFactIndex } from "../src/logic/codefacts.js";

test("index build reports done/total and always finishes at total", (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kbprog-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  for (let i = 0; i < 45; i++) fs.writeFileSync(path.join(ws, `m${i}.js`), `export function f${i}() { return ${i}; }`);
  const seen = [];
  const index = createCodeFactIndex(ws, { onProgress: (p) => seen.push(p) });
  assert.equal(index.records.size, 45);
  assert.ok(seen.length >= 2, "throttled progress still fires more than once");
  const last = seen[seen.length - 1];
  assert.equal(last.done, last.total, "final callback lands at total");
  assert.equal(last.total, 45);
});

test("a throwing progress callback never breaks the build", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kbprog2-"));
  fs.writeFileSync(path.join(ws, "a.js"), "export const x = 1;");
  const index = createCodeFactIndex(ws, { onProgress: () => { throw new Error("ui hiccup"); } });
  assert.equal(index.records.size, 1);
  fs.rmSync(ws, { recursive: true, force: true });
});
