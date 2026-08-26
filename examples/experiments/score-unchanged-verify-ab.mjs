// Scorer for the PRE-REGISTERED unchanged-verify-progress-ab metrics.
// Written before any result existed.
//
// PRIMARY   turns to termination (baseline spiral cost 26 of 40 turns)
// ENGAGED   progressGateRejections / Terminations must be non-zero in candidate;
//           if they are 0 the fix never engaged and nothing else is interpretable
// HARM      pre-registered: a gate firing during legitimate edit->verify->inspect
//           cycles would show as fewer edits, or early termination without done
//
// Usage: node score-unchanged-verify-ab.mjs <experiment-runs-dir>

import fs from "node:fs";
import path from "node:path";

const EDIT_VERBS = new Set(["write_file", "replace", "edit_lines", "patch"]);

function runFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/-run-.*\.json$/.test(e.name)) out.push(p);
    }
  };
  try { walk(root); } catch { /* not started */ }
  return out.sort();
}

const rows = [];
for (const f of runFiles(process.argv[2])) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const m = d.metrics ?? {};
  const r = d.result ?? {};
  const turns = d.turns ?? [];
  let edits = 0;
  for (const t of turns) {
    const a = t.parsedAction ?? {};
    if (EDIT_VERBS.has(a.a)) edits += 1;
  }
  rows.push({
    arm: f.split("/runs/")[1]?.split("/")[0] ?? "?",
    round: /round-(\d+)/.exec(f)?.[1] ?? "?",
    turns: m.turns ?? turns.length,
    gateRej: m.progressGateRejections ?? 0,
    gateTerm: m.progressGateTerminations ?? 0,
    maxProgressless: m.maxProgresslessTurns ?? 0,
    dupes: (m.duplicateActionRejections ?? 0) + (m.duplicateShellRejections ?? 0),
    edits,
    reachedDone: r.reachedDone === true,
    pass: r.pass === true,
  });
}

console.log("arm       rnd turns gateRej gateTerm maxProgless dupes edits done pass");
for (const r of rows.sort((a, b) => (a.arm + a.round).localeCompare(b.arm + b.round))) {
  console.log(
    `${r.arm.padEnd(9)} ${r.round.padEnd(3)} ${String(r.turns).padStart(5)} ${String(r.gateRej).padStart(7)} ${String(r.gateTerm).padStart(8)} ${String(r.maxProgressless).padStart(11)} ${String(r.dupes).padStart(5)} ${String(r.edits).padStart(5)} ${String(r.reachedDone).padStart(5)} ${String(r.pass).padStart(4)}`,
  );
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log();
for (const arm of ["control", "candidate"]) {
  const a = rows.filter((r) => r.arm === arm);
  if (!a.length) continue;
  console.log(
    `${arm.padEnd(9)} n=${a.length}  turns ${mean(a.map((r) => r.turns)).toFixed(1)}  `
    + `gateRej ${mean(a.map((r) => r.gateRej)).toFixed(1)}  edits ${mean(a.map((r) => r.edits)).toFixed(1)}  `
    + `done ${a.filter((r) => r.reachedDone).length}/${a.length}  pass ${a.filter((r) => r.pass).length}/${a.length}`,
  );
}

const cand = rows.filter((r) => r.arm === "candidate");
if (cand.length && cand.every((r) => r.gateRej === 0 && r.gateTerm === 0)) {
  console.log("\nENGAGEMENT CHECK FAILED: the gate never fired in the candidate arm.");
  console.log("The fix did not engage; turn differences are not attributable to it.");
}
