// Controller-projected observations for the independent reviewer. These facts
// describe executed cases, not inferred API correctness or completion credit.
import crypto from "node:crypto";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { cliVerificationPassed } from "./contract-cli-verification.js";

const hash = value => crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex");
const HASH = /^[a-f0-9]{64}$/;

export function contractAuditMeasuredFacts({ generation, sources, cliContract, cliReceipt, projectEvidence }) {
  if (!Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(sources)
      || !sources.length || sources.some(s => typeof s.path !== "string" || !HASH.test(s.sha256 ?? ""))) return [];
  const bound = sources.map(({ path, sha256 }) => ({ path, sha256 }));
  const facts = [];
  // Reuse the actual station's full receipt validator. A status string or
  // worker-supplied stdout alone is not an observation from the fixed station.
  if (cliVerificationPassed(cliContract, cliReceipt, { generation })
      && cliReceipt.sources.every(s => bound.some(b => b.path === s.path && b.sha256 === s.sha256))) {
    const stage = cliReceipt.probeEvidence.stages.find(s => s.stage === "check");
    const cases = JSON.parse(stage.stdout).cases;
    for (const item of cases.slice(0, 3)) facts.push({
      kind: "cli-case", generation, sources: cliReceipt.sources.map(({ path, sha256 }) => ({ path, sha256 })),
      receiptSha256: hash(cliReceipt), status: item.result === "passed" ? "pass" : "fail",
      case: item.case, exitCode: item.status, stdoutBytes: item.stdoutBytes, stderrBytes: item.stderrBytes,
    });
  }
  const proof = projectEvidence;
  if (proof?.schema === 1 && proof.generation === generation && proof.status === "pass"
      && proof.exitCode === 0 && proof.statusScope === "execution"
      && proof.configuredCommand && HASH.test(proof.outputSha256 ?? "")
      && !["blocked", "invalidated", "interrupted", "aborted", "timedOut", "bufferExceeded", "error", "signal", "uncertainty"].some(k => proof[k])
      && !(proof.counts?.failed > 0) && proof.counts?.total !== 0) {
    facts.push({ kind: "project-verification", generation, sources: bound, receiptSha256: hash(proof),
      status: "pass", exitCode: 0, command: proof.configuredCommand,
      workspaceReadOnly: proof.workspaceReadOnly === true,
      ...(proof.counts ? { counts: { passed: proof.counts.passed, failed: proof.counts.failed, total: proof.counts.total } } : {}),
    });
  }
  return facts;
}
