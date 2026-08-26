// 7R synthesis interventions #1/#4 and the winners' opening, as stations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VerifyCadenceSentinel } from "../src/logic/verify-cadence.js";
import { importDontRetypeSteer, greenfieldBuildShapeNote } from "../src/logic/probe-discipline.js";

test("eight print-only probes with no verification draw the cadence steer, and it re-fires per drought", () => {
  const s = new VerifyCadenceSentinel();
  for (let i = 0; i < 7; i++) assert.equal(s.note({ probeOnly: true }), null);
  const note = s.note({ probeOnly: true });
  assert.match(note, /8 print-only probes have run/);
  for (let i = 0; i < 7; i++) assert.equal(s.note({ probeOnly: true }), null);
  assert.ok(s.note({ probeOnly: true }), "re-fires on the next drought window");
  s.note({ ranVerification: true });
  assert.equal(s.note({ probeOnly: true }), null, "verification resets the window");
});

test("cadence total steers are bounded", () => {
  const s = new VerifyCadenceSentinel({ threshold: 1, maxSteers: 2 });
  assert.ok(s.note({ editApplied: true }));
  assert.ok(s.note({ editApplied: true }));
  assert.equal(s.note({ editApplied: true }), null, "capped");
});

test("a probe that re-types definitions after source edits is steered to import", () => {
  const cmd = `python -c "def carve(m,r,c):\\n  ...\\nprint(carve(m,0,0))"`;
  assert.match(importDontRetypeSteer(cmd, { editedSourceFiles: 2 }), /import the real module/i);
  assert.equal(importDontRetypeSteer(cmd, { editedSourceFiles: 0 }), null, "no edits yet: exploration is fine");
  assert.equal(importDontRetypeSteer('python -c "import maze; print(maze.generate(3,3,1))"', { editedSourceFiles: 2 }), null, "importing probes are the good pattern");
  assert.equal(importDontRetypeSteer(cmd, { editedSourceFiles: 2, priorSteers: 2 }), null, "capped at two");
});

test("a greenfield write-X.py task gets the build-shape note; existing file or other tasks do not", () => {
  const task = "Write maze.py: generate(width, height, seed) builds a perfect maze...";
  const note = greenfieldBuildShapeNote(task, ["README.md"]);
  assert.match(note, /COMPLETE implementation file in ONE write/);
  assert.match(note, /import the implementation's own/);
  assert.equal(greenfieldBuildShapeNote(task, ["maze.py"]), null);
  assert.equal(greenfieldBuildShapeNote("Fix the failing suite in src/wrap.js", []), null);
});

test("a self-inverse round-trip probe is named a tautology (card 1 F2: decode(encode(emoji)) green over a broken encoder)", async () => {
  const { selfInverseProbeSteer } = await import("../src/logic/probe-discipline.js");
  const tauto = `node -e 'import("./src/rle.mjs").then(({encode,decode})=>{console.log("roundtrip:", decode(encode("abc")))})'`;
  const note = selfInverseProbeSteer(tauto, { priorSteers: 0 });
  assert.match(note, /tautolog/i);
  assert.match(note, /encoded form|expected literal/i);
  assert.equal(selfInverseProbeSteer(tauto, { priorSteers: 1 }), null, "single-fire");
  assert.equal(selfInverseProbeSteer(`node -e 'console.log(encode("abc"))'`, { priorSteers: 0 }), null, "plain probes are fine");
  assert.match(selfInverseProbeSteer(`python -c "print(parse(serialize(x)))"`, { priorSteers: 0 }) ?? "", /tautolog/i, "parse/serialize pairs too");
});

test("a code-point contract with code-unit indexing draws the unicode-unit gauge (card 23: 2 of 6 misses, one family)", async () => {
  const { unicodeUnitGauge } = await import("../src/logic/probe-discipline.js");
  const task = "Implement encode/decode, a run-length codec over Unicode code points (astral characters are one unit).";
  const bad = "export function encode(s){ let i=0; while(i<s.length){ const c=s[i]; i++; } }";
  const note = unicodeUnitGauge(task, bad, { priorSteers: 0 });
  assert.match(note, /code point/i);
  assert.match(note, /\[\.\.\.s\]|codePointAt/);
  assert.equal(unicodeUnitGauge(task, "const cps=[...s]; for (const c of cps) {}", { priorSteers: 0 }), null, "spread iteration is the good pattern");
  assert.equal(unicodeUnitGauge("Fix the boundary bug in pickZone.", bad, { priorSteers: 0 }), null, "no code-point contract, no gauge");
  assert.equal(unicodeUnitGauge(task, bad, { priorSteers: 1 }), null, "single-fire");
});

test("transcribing a formula-defined table draws ship-the-generator (card 4 T1: 0x2042 where 0x1021 belonged)", async () => {
  const { shipTheGeneratorSteer } = await import("../src/logic/probe-discipline.js");
  const task = "Restore the contract: every TABLE entry must equal the formula's output (poly 0x1021, MSB-first).";
  const bigLiteral = "export const TABLE = [\n" + Array.from({length: 32}, (_, i) => `  0x${(i*7).toString(16).padStart(4,"0")}, 0x1021, 0x2042, 0x3063, 0x4084, 0x50A5, 0x60C6, 0x70E7,`).join("\n") + "\n];";
  const note = shipTheGeneratorSteer(task, bigLiteral, { priorSteers: 0 });
  assert.match(note, /transcrib/i);
  assert.match(note, /compute|generator/i);
  const genFn = "function gen(){const t=[];for(let b=0;b<256;b++){let c=b<<8;for(let k=0;k<8;k++)c=(c&0x8000)?(((c<<1)^0x1021)&0xFFFF):((c<<1)&0xFFFF);t.push(c);}return t;}\nexport const TABLE = gen();";
  assert.equal(shipTheGeneratorSteer(task, genFn, { priorSteers: 0 }), null, "a computed table is the good pattern");
  assert.equal(shipTheGeneratorSteer("Fix the boundary bug.", bigLiteral, { priorSteers: 0 }), null, "no formula context, no steer");
  assert.equal(shipTheGeneratorSteer(task, bigLiteral, { priorSteers: 1 }), null, "single-fire");
});
