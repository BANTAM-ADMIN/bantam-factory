// The persistent KB cache: save-restore round-trips the fact image, the load
// path treats staleness as ordinary reconcile work, and a moved root or a
// version bump invalidates cleanly instead of misreading.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGrounding, reconcileGrounding, saveGroundingCache, loadGroundingCache, kbCachePath } from "../src/logic/grounding.js";

function ws(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbcache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "alpha.js"), "export function greet(name) { return `hi ${name}`; }\n");
  fs.writeFileSync(path.join(dir, "beta.js"), "export function add(a, b) { return a + b; }\n");
  return dir;
}

function count(db, rel) {
  return db.rels.get(rel)?.rows?.length ?? (db.rels.get(rel)?.size ?? 0);
}

test("save then load round-trips the fact image and stamps", (t) => {
  const dir = ws(t);
  const g = buildGrounding(dir);
  reconcileGrounding(g); // seed stamps
  assert.equal(saveGroundingCache(g), true);
  assert.ok(fs.existsSync(kbCachePath(dir)));
  const back = loadGroundingCache(dir);
  assert.ok(back, "cache loads");
  assert.ok(back.fileStamps.size >= 2, "stamps restored");
  assert.equal(JSON.stringify(back.db.snapshot()), JSON.stringify(g.db.snapshot()), "fact image identical");
});

test("a file edited after the save is refreshed by ordinary reconcile", (t) => {
  const dir = ws(t);
  const g = buildGrounding(dir);
  reconcileGrounding(g);
  saveGroundingCache(g);
  fs.writeFileSync(path.join(dir, "beta.js"), "export function multiply(a, b) { return a * b; }\n");
  const back = loadGroundingCache(dir);
  const r = reconcileGrounding(back);
  assert.deepEqual(r.changed, ["beta.js"], "exactly the edited file refreshes");
  const snap = JSON.stringify(back.db.snapshot());
  assert.match(snap, /multiply/);
});

test("a moved root or foreign version invalidates instead of misreading", (t) => {
  const dir = ws(t);
  const g = buildGrounding(dir);
  reconcileGrounding(g);
  saveGroundingCache(g);
  const moved = dir + "-moved";
  fs.renameSync(dir, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.equal(loadGroundingCache(moved), null, "moved folder rebuilds");
  const raw = JSON.parse(fs.readFileSync(kbCachePath(moved), "utf8"));
  raw.version = 999;
  raw.root = path.resolve(moved);
  fs.writeFileSync(kbCachePath(moved), JSON.stringify(raw));
  assert.equal(loadGroundingCache(moved), null, "future schema rebuilds");
});

test("corrupt cache reads as absent", (t) => {
  const dir = ws(t);
  fs.mkdirSync(path.join(dir, ".bantam"), { recursive: true });
  fs.writeFileSync(kbCachePath(dir), "{nope");
  assert.equal(loadGroundingCache(dir), null);
});
