// The run-evidence store — the first live consumer of the fact log.
//
// Every completed fixture run becomes a handful of provenanced facts in one durable
// log (.bantam/facts.jsonl at the harness root). Pure observability: nothing on the
// model path reads these facts, they only make cross-run questions exact instead of
// hand-rolled — "which fixtures are flaky", "did any run violate its contract",
// "how did arm X do on fixture Y", each as a query with a proof tree behind it,
// rather than a bespoke reducer over ledger JSONL (the hand-rolled kind that once
// misattributed an experiment arm by joining rows on array index).
//
// Facts per run (strings; absent values simply not asserted):
//   run(R)                       run_fixture(R, F)          run_status(R, S)
//   run_passed(R) | run_failed(R)                           run_verify(R, V)
//   run_contract(R, C)           run_turns(R, N)            run_tokens(R, N)
//   run_duration_ms(R, N)        run_model(R, M)            run_prompt(R, P)
//   run_experiment(R, E)         run_arm(R, A)              run_round(R, N)
//   run_seed(R, S)               run_gate(R, G, N)          (only gates that fired)
//
// Recording is idempotent per runId, so retries and ledger backfills cannot
// double-count. Evidence must never break a run: callers wrap in try/catch.

import fs from "node:fs";
import path from "node:path";
import { FactLog } from "./fact-log.js";

export function defaultFactsPath(root = process.cwd()) {
  return path.join(root, ".bantam", "facts.jsonl");
}

let _defaultLog = null;
/** One shared durable log per process — the single governed writer. */
export function defaultRunEvidenceLog() {
  if (!_defaultLog) _defaultLog = FactLog.open(defaultFactsPath());
  return _defaultLog;
}

const GATE_COUNTERS = [
  ["premature_done", "doneRejections"],
  ["unverified_edit", "unverifiedEditRejections"],
  ["secret_cleanup", "secretAuditRejections"],
  ["immutable_file", "selfCheckRejections"],
  ["evidence", "evidenceGateRejections"],
  ["preview", "previewGateRejections"],
  ["requirement_ledger", "ledgerRejections"],
  ["report_shape", "reportShapeRejections"],
];

/**
 * Record one run's evidence. `ev` tolerates partial input (backfilled ledger rows lack
 * newer fields). Returns the number of facts asserted (0 if this runId is already known).
 */
export function recordRunEvidence(log, ev, { src = "fixture-runner" } = {}) {
  const runId = String(ev.runId ?? "");
  if (!runId) return 0;
  if (log.view().has("run", runId)) return 0;   // idempotent per run

  const meta = { src, kind: "observation" };
  let n = 0;
  const put = (rel, ...args) => {
    if (args.some((a) => a === null || a === undefined || a === "")) return;
    log.assert(rel, [runId, ...args], meta);
    n++;
  };

  log.assert("run", [runId], meta); n++;
  put("run_fixture", ev.fixture);
  const status = ev.status ?? null;
  put("run_status", status);
  if (status) log.assert(status === "pass" ? "run_passed" : "run_failed", [runId], meta), n++;
  put("run_verify", ev.verify);
  put("run_contract", ev.contract);
  put("run_turns", num(ev.turns));
  put("run_tokens", num(ev.genTok));
  put("run_duration_ms", num(ev.durationMs));
  put("run_model", ev.modelId);
  put("run_prompt", ev.promptVersion);
  if (Number(ev.autoPreviews ?? 0) > 0) { log.assert("run_auto_previews", [runId, String(ev.autoPreviews)], meta); n++; }
  if (Number(ev.previewRuns ?? 0) > 0) put("run_preview_runs", num(ev.previewRuns));
  if (Number(ev.previewPasses ?? 0) > 0) put("run_preview_passes", num(ev.previewPasses));
  if (Number(ev.previewFailures ?? 0) > 0) put("run_preview_failures", num(ev.previewFailures));
  if (Number(ev.outputLimitRecoveries ?? 0) > 0) {
    put("run_output_limit_recoveries", num(ev.outputLimitRecoveries));
  }
  put("run_experiment", ev.experiment?.name ?? ev.experiment?.id);
  put("run_arm", ev.experiment?.arm);
  put("run_round", num(ev.experiment?.round));
  put("run_seed", num(ev.experiment?.seed));
  for (const [gate, key] of GATE_COUNTERS) {
    const count = Number(ev.gates?.[key] ?? 0);
    if (count > 0) { log.assert("run_gate", [runId, gate, String(count)], meta); n++; }
  }
  return n;
}

function num(v) { return (v === null || v === undefined) ? null : String(v); }

/** The standard derived vocabulary over run evidence. Register, then db.run(). */
export function evidenceRules(db) {
  db.rule("fixture_passed(F) :- run_fixture(R, F), run_passed(R)");
  db.rule("fixture_failed(F) :- run_fixture(R, F), run_failed(R)");
  db.rule("flaky(F) :- fixture_passed(F), fixture_failed(F)");
  db.rule("contract_violated(R) :- run_contract(R, fail)");
  db.rule("arm_failure(A, F) :- run_arm(R, A), run_fixture(R, F), run_failed(R)");
  db.rule("gate_fired(G) :- run_gate(R, G, N)");
  return db;
}

/** A ready-to-query view: current facts + standard rules, fixpoint computed. */
export function evidenceView(log) {
  return evidenceRules(log.view()).run();
}

/** Sweep every experiment evidence dir's ledger.jsonl under .bantam/experiments. Idempotent. */
export function backfillFromExperiments(log, experimentsDir) {
  let names = [];
  try { names = fs.readdirSync(experimentsDir); } catch { return 0; }
  let imported = 0;
  for (const name of names) {
    imported += backfillFromLedger(log, path.join(experimentsDir, name, "ledger.jsonl"));
  }
  return imported;
}

/** Import historic fixtures/ledger.jsonl rows. Idempotent; returns runs imported. */
export function backfillFromLedger(log, ledgerPath) {
  let raw = "";
  try { raw = fs.readFileSync(ledgerPath, "utf8"); } catch { return 0; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn/corrupt line: skip */ }
  }
  let imported = 0;
  for (const row of rows) {
    const n = recordRunEvidence(log, {
      runId: row.runId,
      fixture: row.fixture,
      status: row.status ?? (row.pass ? "pass" : "fail"),
      turns: row.turns,
      genTok: row.genTok,
      durationMs: row.totalMs,
      modelId: row.modelId,
      promptVersion: row.promptVersion,
      previewRuns: row.previewRuns,
      previewPasses: row.previewPasses,
      previewFailures: row.previewFailures,
      outputLimitRecoveries: row.outputLimitRecoveries,
      contract: row.contractStatus,
      experiment: {
        id: row.experimentId, arm: row.experimentArm,
        round: row.experimentRound, seed: row.experimentSeed,
      },
      gates: row,
    }, { src: "backfill:ledger" });
    if (n > 0) imported++;
  }
  return imported;
}
