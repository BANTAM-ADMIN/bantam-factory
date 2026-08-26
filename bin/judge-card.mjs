#!/usr/bin/env node
// One judge for every card (instrument manifests — the bench's enforcement
// half, 2026-08-26). Two hand-wired-judge faults in one night — a missing
// holdout data file that read 0-for-3 on a 9-for-9 card, and a self-graded
// oracle that filed a wrong 104s render — were both the SAME defect: each
// sweep re-invented its judge. A card's strongest instrument is now DATA
// (<kit>/instrument.json), and this is the only runner.
//
// usage: node bin/judge-card.mjs <kitDir> <workspace>
// prints {"verdict":"EXACT"|"MISS","legs":{...}}; exit 0 on EXACT.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";

const [kitDir, ws] = process.argv.slice(2).map((p) => path.resolve(p));
if (!kitDir || !ws) { console.error("usage: judge-card.mjs <kitDir> <workspace>"); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(kitDir, "instrument.json"), "utf8"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["NODE_TEST_CONTEXT", "NODE_OPTIONS"].includes(k)));
const legs = {};
let ok = true;

const runSuite = () => {
  let out = "";
  try { out = execSync("npm test --silent 2>&1", { cwd: ws, timeout: 240000, encoding: "utf8", env }); }
  catch (e) { out = String(e.stdout ?? e.message); }
  const pass = /^# pass (\d+)/m.exec(out)?.[1];
  const fail = /^# fail (\d+)/m.exec(out)?.[1];
  return { green: fail === "0" && pass != null, tests: `pass ${pass ?? "?"} fail ${fail ?? "?"}` };
};

for (const check of manifest.checks) {
  try {
    if (check.kind === "npm-suite") {
      const r = runSuite();
      legs.suiteGreen = r.green; legs.tests = r.tests; ok = ok && r.green;
    } else if (check.kind === "holdout") {
      const src = path.join(kitDir, check.test);
      const dst = path.join(ws, "test", `.holdout${path.extname(check.test)}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (check.data) fs.copyFileSync(path.join(kitDir, check.data), path.join(ws, check.dataAs ?? "test/holdout.data.json"));
      const r = runSuite();
      fs.rmSync(dst, { force: true });
      if (check.data) fs.rmSync(path.join(ws, check.dataAs ?? "test/holdout.data.json"), { force: true });
      legs.holdoutGreen = r.green; legs.tests = r.tests; ok = ok && r.green;
    } else if (check.kind === "reference-bytes") {
      let all = true;
      for (const arg of check.args) {
        const ref = execSync(check.reference.replaceAll("{arg}", arg), { cwd: kitDir, encoding: "utf8", timeout: 60000, env });
        const got = execSync(check.run.replaceAll("{arg}", arg), { cwd: ws, encoding: "utf8", timeout: 60000, env });
        if (ref !== got) { all = false; (legs.referenceMismatch ??= []).push(arg); }
      }
      legs.referenceBytes = all; ok = ok && all;
    } else if (check.kind === "truth-file") {
      const truth = fs.readFileSync(path.join(kitDir, check.file), "utf8");
      const got = execSync(check.run, { cwd: ws, encoding: "utf8", timeout: 60000, env });
      const match = got.replace(/\n$/, "") === truth.replace(/\n$/, "");
      legs.truthFile = match; ok = ok && match;
    } else if (check.kind === "judge-py") {
      const out = execFileSync("python3", [path.join(kitDir, check.script), ws], { encoding: "utf8", timeout: 240000, env });
      const v = JSON.parse(out.trim().split("\n").pop());
      legs.judgePy = v.verdict === "EXACT"; legs.judgePyLegs = v.legs ?? null; ok = ok && legs.judgePy;
    } else if (check.kind === "region-sha") {
      const src = fs.readFileSync(path.join(ws, check.file), "utf8");
      const m = new RegExp(check.pattern).exec(src);
      const want = fs.readFileSync(path.join(kitDir, check.sha256), "utf8").trim();
      const got = crypto.createHash("sha256").update(m ? m[0] : "NONE").digest("hex");
      legs.regionIntact = got === want; ok = ok && legs.regionIntact;
    } else if (check.kind === "confine") {
      const conf = execFileSync("python3", [path.join(kitDir, check.script), path.join(kitDir, check.pristine), path.join(ws, check.corner)], { encoding: "utf8", timeout: 30000, env }).trim();
      const edited = fs.readFileSync(path.join(kitDir, check.pristine), "utf8") !== fs.readFileSync(path.join(ws, check.corner), "utf8");
      let cited = true;
      if (edited && check.citation) {
        let dec = ""; try { dec = fs.readFileSync(path.join(ws, check.citation.file), "utf8"); } catch { /* absent */ }
        cited = new RegExp(check.citation.regex).test(dec);
      }
      legs.confined = conf === "CONFINED"; legs.cited = cited; ok = ok && legs.confined && cited;
    } else { legs[`unknown:${check.kind}`] = false; ok = false; }
  } catch (e) { legs[`${check.kind}Error`] = String(e.message).slice(0, 120); ok = false; }
}
console.log(JSON.stringify({ verdict: ok ? "EXACT" : "MISS", legs }));
process.exit(ok ? 0 : 1);
