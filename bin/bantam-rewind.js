#!/usr/bin/env node
// Rewind a bantam run to any turn with the exact workspace prepped.
//   bantam-rewind <run.json> --list            # turn-by-turn index (pick a point)
//   bantam-rewind <run.json> --to N --out DIR   # materialize workspace at turn N
import fs from "node:fs";
import path from "node:path";
import { summarizeTurns, rewindPlan } from "../src/rewind.js";

const [, , runPath, ...rest] = process.argv;
if (!runPath) {
  console.error("usage: bantam-rewind <run.json> [--list] [--to N] [--out DIR]");
  process.exit(2);
}
const artifact = JSON.parse(fs.readFileSync(runPath, "utf8"));
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--list") args.list = true;
  else if (rest[i] === "--to") args.to = Number(rest[++i]);
  else if (rest[i] === "--out") args.out = rest[++i];
}

if (args.list || args.to === undefined) {
  for (const s of summarizeTurns(artifact)) {
    console.log(`${String(s.i).padStart(4)} ${s.ok} ${String(s.kind).padEnd(11)} ${String(s.target).padEnd(14)} ${s.note}${s.obs ? "  ::" + s.obs : ""}`);
  }
  console.log(`\n${(artifact.turns || []).length} turns (runId ${artifact.runId ?? "?"}). Rewind: bantam-rewind ${runPath} --to <N> --out <dir>`);
  process.exit(0);
}

const plan = rewindPlan(artifact, args.to, {
  artifactPath: path.resolve(runPath),
  workspace: args.out ? path.resolve(args.out) : "<dir>",
});
if (args.out) {
  fs.mkdirSync(args.out, { recursive: true });
  for (const [p, content] of Object.entries(plan.files)) {
    const dest = path.join(args.out, p.replace(/^\/app\//, "").replace(/^\//, ""));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  console.log(`rewound to turn ${args.to}: wrote ${plan.fileCount} file(s) into ${args.out}`);
}
console.log(`files at turn ${args.to}: ${Object.keys(plan.files).join(", ") || "(none)"}`);
console.log("continue with:\n  " + plan.command);
