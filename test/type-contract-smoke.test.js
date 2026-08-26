import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { typeContractSmokeWorkspace, formatTypeContractSmoke, acceptedTypesByFunction } from "../src/logic/type-contract-smoke.js";

// Recorded specimen: adapter-migration, local 27B, 2026-07-30. Across the six
// lexical-smoke-gate-ab runs -- all of which wrote a CORRECT parseEnabled -- the
// hidden contract still failed 6/6 on "normalizes collections without mutation or
// prototype hazards". Probing the reconstructed trees found three missing
// rejections, all the same shape: the model COERCES where the contract requires a
// throw.
//
//   normalizeTags("a")        -> ["a"]         (a bare string is not an array)
//   normalizeTags(["ok", 2])  -> ["ok","2"]    (coerced a number to a string)
//   normalizeHeaders([])      -> {}            (an array is not a plain object)
const TASK = "normalizeTags accepts an array of strings, trims entries, removes empty entries and "
  + "duplicates while preserving first-seen order, and never mutates the input. "
  + "normalizeHeaders accepts a plain object, lowercases and trims header names, trims string values, "
  + "rejects non-string values, and ignores __proto__, prototype, and constructor.";

const PERMISSIVE = `export function normalizeTags(value) {
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of arr) {
    const s = String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
export function normalizeHeaders(value) {
  const out = {};
  for (const [k, v] of Object.entries(value ?? {})) {
    if (typeof v !== "string") throw new TypeError("non-string value");
    out[String(k).toLowerCase().trim()] = v.trim();
  }
  return out;
}
`;

const STRICT = `export function normalizeTags(value) {
  if (!Array.isArray(value)) throw new TypeError("array required");
  const out = [];
  for (const v of value) {
    if (typeof v !== "string") throw new TypeError("string entries required");
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
export function normalizeHeaders(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("plain object required");
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new TypeError("non-string value");
    out[String(k).toLowerCase().trim()] = v.trim();
  }
  return out;
}
`;

function workspaceWith(source, t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-type-smoke-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "src", "adapters"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(ws, "src", "adapters", "collections.js"), source);
  return ws;
}

test("parses accepted-type contracts per naming clause", () => {
  const map = acceptedTypesByFunction(TASK);
  assert.deepEqual(map.get("normalizeTags"), ["array-of-strings"]);
  assert.deepEqual(map.get("normalizeHeaders"), ["plain-object"]);
});

// adapter-migration phrases two of its contracts as "an OPTIONAL plain object"
// (normalizePage, normalizeRetry). Both still fail the hidden grader on
// normalizePage([]) and normalizeRetry([]) -- an array is not a plain object,
// optional or not. "Optional" governs whether the ARGUMENT may be omitted, not
// which types are accepted when one is supplied, and this probe never passes
// undefined.
test("recognises an optional plain object as the same accepted type", () => {
  const map = acceptedTypesByFunction(
    "normalizePage accepts an optional plain object, defaults offset=0 and limit=50.",
  );
  assert.deepEqual(map.get("normalizePage"), ["plain-object"]);
});

test("derives named finite-numeric property obligations", () => {
  const map = acceptedTypesByFunction(
    "normalizeCoordinates accepts a plain object with finite numeric latitude and longitude in range.",
  );
  assert.deepEqual(map.get("normalizeCoordinates"), [
    "plain-object",
    "finite-numeric-fields:latitude,longitude",
  ]);
});

test("catches property coercion where finite numeric values are required", async (t) => {
  const source = `export function normalizeCoordinates(value) {
  return { latitude: Number(value.latitude), longitude: Number(value.longitude) };
}\n`;
  const task = "normalizeCoordinates accepts a plain object with finite numeric latitude and longitude.";
  const findings = await typeContractSmokeWorkspace(workspaceWith(source, t), task);
  const calls = findings.map((finding) => `${finding.fn}(${JSON.stringify(finding.probe)})`);
  assert.ok(calls.includes('normalizeCoordinates({"latitude":"0","longitude":0})'));
  assert.ok(calls.includes('normalizeCoordinates({"latitude":0,"longitude":"0"})'));
  assert.match(formatTypeContractSmoke(findings), /finite numeric latitude and longitude/);
});

test("catches coercion where the contract requires rejection", async (t) => {
  const findings = await typeContractSmokeWorkspace(workspaceWith(PERMISSIVE, t), TASK);
  const got = findings.map((f) => `${f.fn}(${JSON.stringify(f.probe)})`).sort();

  assert.ok(got.includes('normalizeTags("a")'), `expected bare-string probe, got ${JSON.stringify(got)}`);
  assert.ok(got.includes('normalizeTags(["ok",2])'), `expected non-string-entry probe, got ${JSON.stringify(got)}`);
  assert.ok(got.includes("normalizeHeaders([])"), `expected array-for-object probe, got ${JSON.stringify(got)}`);
  for (const f of findings) assert.equal(f.returned !== undefined, true);
});

test("stays silent on a strict implementation", async (t) => {
  const findings = await typeContractSmokeWorkspace(workspaceWith(STRICT, t), TASK);
  assert.deepEqual(findings, []);
});

test("stays silent when the task names no accepted type", async (t) => {
  const findings = await typeContractSmokeWorkspace(workspaceWith(PERMISSIVE, t), "normalizeTags tidies up the tags.");
  assert.deepEqual(findings, []);
});

test("scopes each accepted type to the function its clause names", async (t) => {
  // normalizeHeaders is permissive about arrays, but only normalizeTags' clause
  // is present -- headers must not be probed or reported.
  const findings = await typeContractSmokeWorkspace(
    workspaceWith(PERMISSIVE, t),
    "normalizeTags accepts an array of strings and trims entries.",
  );
  assert.deepEqual(findings.filter((f) => f.fn === "normalizeHeaders"), []);
  assert.ok(findings.some((f) => f.fn === "normalizeTags"));
});

test("formats a done-gate bounce naming the exact accepted call", () => {
  const text = formatTypeContractSmoke([
    { fn: "normalizeTags", file: "src/adapters/collections.js", accepts: "array-of-strings", probe: "a", returned: '["a"]' },
  ]);
  assert.match(text, /\[type-contract-smoke\]/);
  assert.match(text, /normalizeTags\("a"\)/);
  assert.match(text, /array of strings/);
  assert.equal(formatTypeContractSmoke([]), "");
});
