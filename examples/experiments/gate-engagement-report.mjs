// Report gate engagement across recorded artifacts.
// Usage: node examples/experiments/gate-engagement-report.mjs [.bantam]
import fs from "node:fs";
import path from "node:path";
import { summarizeGateEngagement } from "../../src/logic/gate-engagement.js";

function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/run.*\.json$/.test(e.name)) out.push(p);
  }
  return out;
}
const metrics = [];
for (const f of walk(process.argv[2] || ".bantam")) {
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    if (d?.metrics && !d.partial) metrics.push(d.metrics);
  } catch { /* skip */ }
}
console.log(`runs with metrics: ${metrics.length}\n`);
console.log(summarizeGateEngagement(metrics).format());
