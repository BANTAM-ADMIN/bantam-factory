// Scorer for the PRE-REGISTERED lexical-smoke-gate-ab primary metric.
// Written before any result existed, so the metric cannot be chosen post hoc.
//
// PRIMARY: does the arm's FINAL tree still contain a lexical-smoke finding?
// Reconstructed faithfully: copy the pristine fixture repo, `git apply` the run's
// recorded finalDiff, then re-run lexicalSmokeWorkspace against the result.
// If the diff cannot be applied the run is reported UNSCORABLE, never as a pass.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lexicalSmokeWorkspace } from "";

const ROOT = "";
const FIXTURE = path.join(ROOT, "gauntlet/fixtures/adapter-migration");
const TASK = JSON.parse(fs.readFileSync(path.join(FIXTURE, "task.json"), "utf8")).task;

function runDirs(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/adapter-migration-run-.*\.json$/.test(e.name)) out.push(p);
    }
  };
  try { walk(root); } catch { /* nothing yet */ }
  return out.sort();
}

async function scoreRun(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const arm = file.split("/runs/")[1]?.split("/")[0] ?? "?";
  const round = /round-(\d+)/.exec(file)?.[1] ?? "?";
  const m = d.metrics ?? {};
  const diff = (d.finalDiff && (d.finalDiff.text ?? d.finalDiff)) || "";

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ab-score-"));
  let findings = null, note = "";
  try {
    fs.cpSync(path.join(FIXTURE, "repo"), ws, { recursive: true });
    if (String(diff).trim()) {
      const patch = path.join(ws, ".patch");
      fs.writeFileSync(patch, String(diff).endsWith("\n") ? String(diff) : String(diff) + "\n");
      execFileSync("git", ["init", "-q"], { cwd: ws });
      execFileSync("git", ["apply", "--whitespace=nowarn", ".patch"], { cwd: ws, stdio: ["ignore", "ignore", "pipe"] });
      fs.rmSync(patch, { force: true });
      fs.rmSync(path.join(ws, ".git"), { recursive: true, force: true });
    } else {
      note = "empty diff";
    }
    findings = await lexicalSmokeWorkspace(ws, TASK);
  } catch (e) {
    note = "UNSCORABLE: " + String(e.message || e).split("\n")[0].slice(0, 80);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  return {
    arm, round,
    turns: m.turns,
    rejections: m.lexicalSmokeRejections ?? 0,
    lexAudit: m.lexicalContractAuditHints ?? 0,
    pass: d.result?.pass === true,
    narrowingShipped: findings === null ? null : findings.length > 0,
    findings: findings === null ? null : findings.length,
    note,
  };
}

const dir = process.argv[2];
const rows = [];
for (const f of runDirs(dir)) rows.push(await scoreRun(f));

console.log("arm        rnd turns rej lexAudit narrowingShipped findings pass note");
for (const r of rows.sort((a, b) => (a.arm + a.round).localeCompare(b.arm + b.round))) {
  console.log(
    `${r.arm.padEnd(10)} ${String(r.round).padEnd(3)} ${String(r.turns).padStart(5)} ${String(r.rejections).padStart(3)} ${String(r.lexAudit).padStart(8)} ${String(r.narrowingShipped).padStart(16)} ${String(r.findings).padStart(8)} ${String(r.pass).padStart(5)} ${r.note}`,
  );
}

const by = (arm) => rows.filter((r) => r.arm === arm && r.narrowingShipped !== null);
for (const arm of ["control", "candidate"]) {
  const a = by(arm);
  if (!a.length) continue;
  const shipped = a.filter((r) => r.narrowingShipped).length;
  console.log(`\n${arm}: narrowing shipped in ${shipped}/${a.length} scorable runs`);
}
const unscorable = rows.filter((r) => r.narrowingShipped === null);
if (unscorable.length) console.log(`\nUNSCORABLE runs (not counted either way): ${unscorable.length}`);
