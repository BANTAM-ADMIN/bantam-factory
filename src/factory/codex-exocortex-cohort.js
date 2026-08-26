import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";

/** Independent exact answer derived from the shift packet's typed products. */
export function repositoryAssessmentGauge(packet) {
  if (!packet || packet.schema !== "bantam.factory.repository-shift-packet.v1") throw new TypeError("repository assessment gauge requires a shift packet");
  const affectedTests = values(packet.products, "verification_work_order", "test");
  const affectedRequirements = [...new Set([
    ...values(packet.products, "requirement_affected", "requirement"),
    ...packet.products.filter((row) => row.predicate.startsWith("release_blocked_")).map((row) => row.tuple.requirement),
  ])].sort();
  const blockers = packet.products.filter((row) => row.predicate.startsWith("release_blocked_")).map((row) => ({
    code: row.predicate === "release_blocked_stale_evidence" ? "stale-evidence" : "stale-authority",
    requirement: row.tuple.requirement,
  })).sort(compareBlocker);
  return deepFreeze({
    affectedTests,
    affectedRequirements,
    releaseDisposition: packet.summary.releaseDisposition,
    blockers,
    nextOperations: [...new Set(packet.buttons.map((row) => row.operation))].sort(),
  });
}

export function scoreRepositoryAssessment(answer, expected) {
  const normalized = normalizeAnswer(answer);
  const target = normalizeAnswer(expected);
  if (!normalized) return deepFreeze({ valid: false, exact: false, fieldScores: {}, expected: target, returned: answer ?? null });
  const fieldScores = {
    affectedTests: equal(normalized.affectedTests, target.affectedTests),
    affectedRequirements: equal(normalized.affectedRequirements, target.affectedRequirements),
    releaseDisposition: normalized.releaseDisposition === target.releaseDisposition,
    blockers: equal(normalized.blockers, target.blockers),
    nextOperations: equal(normalized.nextOperations, target.nextOperations),
  };
  return deepFreeze({ valid: true, exact: Object.values(fieldScores).every(Boolean), fieldScores, expected: target, returned: normalized });
}

/** Parse Codex JSONL without assuming every CLI version emits every item type. */
export function parseCodexCohortRun(stdout) {
  let answer = null, usage = null;
  const itemTypes = {}, commands = [], messages = [];
  for (const line of String(stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "item.completed" && event.item) {
      const type = event.item.type ?? "unknown"; itemTypes[type] = (itemTypes[type] ?? 0) + 1;
      if (type === "agent_message") { messages.push(event.item.text ?? ""); try { answer = JSON.parse(event.item.text); } catch { /* independently scored invalid */ } }
      if (type === "command_execution") commands.push({ command: event.item.command ?? null, status: event.item.status ?? null, exitCode: event.item.exit_code ?? null });
    }
    if (event.type === "turn.completed") usage = event.usage ?? usage;
  }
  const body = { answer, usage, itemTypes: Object.fromEntries(Object.entries(itemTypes).sort()), commands, agentMessages: messages.length };
  return deepFreeze({ ...body, traceId: `codex-cohort-trace:sha256:${digest(body)}` });
}

function normalizeAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.affectedTests) || !Array.isArray(value.affectedRequirements) || !Array.isArray(value.blockers) || !Array.isArray(value.nextOperations) || typeof value.releaseDisposition !== "string") return null;
  if (![...value.affectedTests, ...value.affectedRequirements, ...value.nextOperations].every((row) => typeof row === "string")) return null;
  if (!value.blockers.every((row) => row && typeof row === "object" && typeof row.code === "string" && typeof row.requirement === "string")) return null;
  return {
    affectedTests: [...new Set(value.affectedTests)].sort(),
    affectedRequirements: [...new Set(value.affectedRequirements)].sort(),
    releaseDisposition: value.releaseDisposition,
    blockers: value.blockers.map((row) => ({ code: row.code, requirement: row.requirement })).sort(compareBlocker),
    nextOperations: [...new Set(value.nextOperations)].sort(),
  };
}
function values(products, predicate, field) { return [...new Set(products.filter((row) => row.predicate === predicate).map((row) => row.tuple[field]).filter((row) => typeof row === "string"))].sort(); }
function compareBlocker(a, b) { return a.code.localeCompare(b.code) || a.requirement.localeCompare(b.requirement); }
function equal(a, b) { return canonicalEncode(a) === canonicalEncode(b); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
