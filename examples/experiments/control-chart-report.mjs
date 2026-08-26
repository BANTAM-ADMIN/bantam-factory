// Establish process control limits from a baseline run directory, then classify
// any later subgroups against them.
//
// Usage: node control-chart-report.mjs <baseline-log-dir> [subgroup] [<later-dir> ...]
import fs from "node:fs";
import path from "node:path";
import { controlLimits, classifyPoint, formatControlChart } from "../../src/logic/control-limits.js";

function tally(dir) {
  let passes = 0, runs = 0;
  const turns = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".log"))) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    const m = /^([A-Z]{4,5})\s+\S+\s+\((\d+) turns/m.exec(t);
    if (!m) continue;
    runs += 1;
    if (m[1] === "PASS") passes += 1;
    turns.push(Number(m[2]));
  }
  return { passes, runs, turns };
}

const [baselineDir, subgroupArg, ...later] = process.argv.slice(2);
const subgroup = Number(subgroupArg) || 6;
const base = tally(baselineDir);
const limits = controlLimits({ ...base, subgroup });
const points = later.map((d) => classifyPoint(limits, tally(d)));
console.log(formatControlChart(limits, points));
if (base.turns.length) {
  const mean = base.turns.reduce((a, b) => a + b, 0) / base.turns.length;
  const sd = Math.sqrt(base.turns.reduce((a, t) => a + (t - mean) ** 2, 0) / base.turns.length);
  console.log(`\nturns: mean ${mean.toFixed(1)}, sd ${sd.toFixed(1)}, range ${Math.min(...base.turns)}-${Math.max(...base.turns)}`);
  console.log("turn spread is the other process signal: a wide spread means the station under-constrains the work.");
}
