// Assemble analyzer output into DRAFT FINDINGS — mechanism guesses matched
// against the jig catalog, each carrying its evidence and a suggested next
// step. The report never rules; it hands a human the same byte-grounded
// starting point the factory's operators used, in seconds instead of an hour.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wallDecomposition, prefixBreaks, thrashAudit, steerEfficacy, oracleAudit, thinkAudit } from "./analyzers.js";

const CATALOG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "jig-catalog.json"), "utf8"));

export function supervise(film) {
  const wall = wallDecomposition(film);
  const breaks = prefixBreaks(film);
  const thrash = thrashAudit(film);
  const steers = steerEfficacy(film);
  const oracle = oracleAudit(film);
  const think = thinkAudit(film);
  const findings = [];
  const fam = (id) => CATALOG.families.find((f) => f.id === id);

  // Severity by COST, not by count: every run breaks the prefix somewhere
  // (early turns sit at the head checkpoint by definition). What earns a
  // human's hour is an EXPENSIVE break — deep in the transcript, tens of
  // thousands of tokens reprocessed. Measured contrast that set these bars:
  // pre-fix timegrid broke 113k chars deep for 43k tokens / 24s; the healthy
  // post-fix film broke 2k chars from the tail for 7.6k tokens / 3.5s.
  const expensive = breaks.detected.filter((b) => (b.prompt_n ?? 0) >= 20000 || (b.costMs ?? 0) >= 10000);
  const cheap = breaks.detected.filter((b) => !expensive.includes(b));
  if (expensive.length || breaks.gaugedBreaks > 0) {
    findings.push({ family: "retroactive-rewrite", severity: "high",
      evidence: expensive.length ? expensive : `gauge counted ${breaks.gaugedBreaks} break(s)`,
      next: `byte-diff the prompts across the break (calls ${expensive.map((b) => b.call).join(", ") || "per gauge events"}) to name the rewriter; countermeasure on file: ${fam("retroactive-rewrite").countermeasure.name}` });
  }
  if (cheap.length) {
    findings.push({ family: "prefix-break-cheap", severity: "info", evidence: cheap,
      next: "early/tail-region cache resets — normal while the run is short; watch only if they grow deep (divergeAtChar far from promptChars) or costly (prompt_n in the tens of thousands)" });
  }
  if (thrash.chains.length) {
    findings.push({ family: "patch-thrash", severity: "medium", evidence: thrash.chains,
      next: `read the red span around ${thrash.chains[0].path}; if repour fired and was ignored, that is escalation fuel (advice -> gate)` });
  }
  for (const f of steers.flags) findings.push({ family: f.family, severity: "medium", evidence: f.detail,
    next: fam("ignored-advice").countermeasure.name });
  if (oracle.suiteRuns === 0 && (film.turns ?? []).length > 4) {
    findings.push({ family: "oracle-swap", severity: "high", evidence: `0 suite runs in ${(film.turns ?? []).length} turns; ${oracle.probeOnly} print-only probes`,
      next: "nothing registered pass/fail this run — check the verifier wiring before judging the model" });
  }
  if (think.truncations >= 3) {
    findings.push({ family: "think-pressure", severity: "low", evidence: think,
      next: "repeated severed thinks precede re-edits (the thrash engine); consider BANTAM_THINK_N_PREDICT_FIRST for the analysis phase (A/B before adopting)" });
  }
  const slowShare = wall.slow.reduce((n, c) => n + (c.wallMs ?? 0), 0);
  if (wall.slow.length && slowShare > wall.modelMs * 0.4) {
    findings.push({ family: "wall-concentration", severity: "info",
      evidence: { slowCalls: wall.slow.length, slowMs: slowShare, modelMs: wall.modelMs, worst: wall.slow.slice(0, 4) },
      next: "over 40% of model wall sits in a few calls — read their cache_n/prompt_n/gen_n columns: big prompt_n = reprocessing (context problem), big gen_n = emission (output volume)" });
  }
  return { wall, breaks, thrash, steers, oracle, think, findings };
}

export function renderSupervisorReport(r, { source = "" } = {}) {
  const L = [];
  L.push(`SUPERVISOR REPORT${source ? ` — ${source}` : ""}`);
  L.push(`  wall: ${r.wall.calls} calls · model ${(r.wall.modelMs / 1000).toFixed(1)}s · prompt-tokens processed ${r.wall.promptProcessed.toLocaleString()} · generated ${r.wall.generated.toLocaleString()}`);
  L.push(`  oracle: ${r.oracle.suiteRuns} suite runs (last pass ${r.oracle.lastPass ?? "?"}/fail ${r.oracle.lastFail ?? "?"}) · ${r.oracle.probeOnly} print-only probes`);
  L.push(`  stations fired: ${r.steers.fired.map((f) => `${f.metric}=${f.count}`).join(" ") || "none"}`);
  if (!r.findings.length) L.push("\n  No findings — the film reads healthy. (A healthy film is data too.)");
  for (const f of r.findings) {
    L.push(`\n  [${f.severity}] ${f.family}`);
    L.push(`    evidence: ${typeof f.evidence === "string" ? f.evidence : JSON.stringify(f.evidence)}`);
    L.push(`    next: ${f.next}`);
  }
  L.push("\n  These are DRAFTS with evidence, not verdicts. The judgment is yours;");
  L.push("  the catalog of named mechanisms is src/supervisor/jig-catalog.json.");
  return L.join("\n");
}
