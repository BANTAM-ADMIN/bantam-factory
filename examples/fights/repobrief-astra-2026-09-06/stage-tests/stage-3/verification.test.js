import assert from "node:assert/strict";
import test from "node:test";
import { childArgs, cli, expectedCapture, receipts, repository, write } from "./helpers.js";

test("stable command receipts are durable, exact, and become stale only when content changes", t => {
  const root = repository(t);
  assert.deepEqual(receipts(root), []);
  const argv = childArgs('console.log("verified"); console.error("diagnostic");');
  const before = expectedCapture(root, ["tracked.txt"]).treeDigest;
  const result = cli(root, ["verify", "--label", "unit checks", "--", ...argv]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "verified\n");
  assert.equal(result.stderr, "diagnostic\n");
  let saved = receipts(root);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 1);
  assert.equal(saved[0].label, "unit checks");
  assert.deepEqual(saved[0].argv, argv);
  assert.equal(saved[0].stdout, result.stdout);
  assert.equal(saved[0].stderr, result.stderr);
  assert.equal(saved[0].exitCode, 0);
  assert.equal(saved[0].passed, true);
  assert.equal(saved[0].current, true);
  assert.equal(saved[0].treeDigestBefore, before);
  assert.equal(saved[0].treeDigestAfter, before);
  write(root, "tracked.txt", "later edit\n");
  assert.equal(receipts(root)[0].current, false);
  write(root, "tracked.txt", "original\n");
  assert.equal(receipts(root)[0].current, true);
});

test("failed commands remain recorded without overwriting a repeated label", t => {
  const root = repository(t);
  for (const code of [0, 7]) {
    const result = cli(root, ["verify", "--label", "same label", "--", ...childArgs(`process.exit(${code})`)]);
    assert.equal(result.status, code);
  }
  const saved = receipts(root);
  assert.deepEqual(saved.map(r => r.id), [1, 2]);
  assert.deepEqual(saved.map(r => r.label), ["same label", "same label"]);
  assert.deepEqual(saved.map(r => r.exitCode), [0, 7]);
  assert.deepEqual(saved.map(r => r.passed), [true, false]);
  assert.deepEqual(saved.map(r => r.current), [true, true]);
});
