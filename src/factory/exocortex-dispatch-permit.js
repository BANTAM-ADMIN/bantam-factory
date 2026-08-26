import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";
import { compileCacheAffineShiftPrompt, defineExocortexStandardWork } from "./cache-affine-exocortex.js";

/**
 * A supervisor-issued capability for one bounded station article.
 *
 * Shift packets are deliberately observe/propose-only. A dispatch permit is
 * the separate, content-addressed artifact that turns one proposal into one
 * executable operation without granting release authority.
 */
export function defineExocortexDispatchPermit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("dispatch permit must be an object");
  const fields = ["schema", "kind", "packetId", "chassisFingerprint", "standardWorkRef", "articleId", "workerRole", "operation", "tool", "scope", "authority"];
  const unknown = Object.keys(value).filter((key) => ![...fields, "permitId"].includes(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`dispatch permit fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`);
  if (value.schema !== 1 || value.kind !== "bantam.factory-exocortex-dispatch-permit") throw new Error("dispatch permit must use schema 1");

  const normalized = {
    schema: 1,
    kind: value.kind,
    packetId: ref(value.packetId, "repository-shift-packet", "packet id"),
    chassisFingerprint: text(value.chassisFingerprint, "chassis fingerprint"),
    standardWorkRef: ref(value.standardWorkRef, "exocortex-standard-work", "standard work ref"),
    articleId: token(value.articleId, "article id"),
    workerRole: text(value.workerRole, "worker role"),
    operation: token(value.operation, "operation"),
    tool: normalizeTool(value.tool),
    scope: normalizeScope(value.scope),
    authority: normalizeAuthority(value.authority),
  };
  const permitId = `exocortex-dispatch-permit:sha256:${digest(normalized)}`;
  if (value.permitId && value.permitId !== permitId) throw new Error("dispatch permit content hash does not match");
  return deepFreeze({ ...normalized, permitId });
}

/** Bind and append execution authority after the observe/propose chassis tail. */
export function compileDispatchedShiftPrompt({ packet, standardWork, permit, material = null } = {}) {
  const work = defineExocortexStandardWork(standardWork);
  const ticket = defineExocortexDispatchPermit(permit);
  if (ticket.packetId !== packet?.packetId) throw new Error("dispatch permit is bound to a different shift packet");
  if (ticket.chassisFingerprint !== packet?.chassis?.repositoryFingerprint) throw new Error("dispatch permit is bound to a different chassis");
  if (ticket.standardWorkRef !== work.ref) throw new Error("dispatch permit is bound to different standard work");
  const base = compileCacheAffineShiftPrompt({ packet, standardWork: work, material });
  const dispatchBody = {
    schema: "bantam.factory.exocortex-dispatch-tail.v1",
    instruction: "The supervisor has dispatched this exact article. Produce only the station input required by standard work. The named deterministic actuator holds the execution capability; the cognitive worker must not mutate the chassis. This grants no release authority.",
    permit: ticket,
  };
  const dispatch = ["", "# SUPERVISOR DISPATCH — EXECUTION CAPABILITY", canonicalEncode(dispatchBody), ""].join("\n");
  const body = {
    schema: "bantam.factory.dispatched-shift-prompt.v1",
    kind: "bantam.factory-dispatched-shift-prompt",
    packetId: packet.packetId,
    permitId: ticket.permitId,
    standardWorkRef: work.ref,
    prefixId: base.prefixId,
    tailId: base.tailId,
    prompt: `${base.prompt}${dispatch}`,
    metrics: {
      ...base.metrics,
      dispatchBytes: Buffer.byteLength(dispatch),
      totalBytes: Buffer.byteLength(base.prompt) + Buffer.byteLength(dispatch),
      estimatedDispatchTokens: Math.ceil(Buffer.byteLength(dispatch) / 4),
      estimatedTotalTokens: Math.ceil((Buffer.byteLength(base.prompt) + Buffer.byteLength(dispatch)) / 4),
    },
  };
  return deepFreeze({ ...body, promptId: `dispatched-shift-prompt:sha256:${digest(body)}` });
}

/**
 * Machine an exhaustive semantic packet into the small parts tray needed by a
 * bounded mutation station. Proof remains addressable; repeated tuples do not.
 */
export function compileExocortexMutationKit({ packet, permit } = {}) {
  if (!packet || packet.schema !== "bantam.factory.repository-shift-packet.v1") throw new TypeError("mutation kit requires a repository shift packet");
  const ticket = defineExocortexDispatchPermit(permit);
  if (ticket.packetId !== packet.packetId || ticket.chassisFingerprint !== packet.chassis?.repositoryFingerprint) throw new Error("mutation kit inputs disagree on packet or chassis");
  const relevant = packet.products.filter((row) => ["verification_work_order", "requirement_affected", "release_blocked_stale_evidence", "release_blocked_stale_authority"].includes(row.predicate));
  const values = (predicate, field) => [...new Set(relevant.filter((row) => row.predicate === predicate).map((row) => row.tuple?.[field]).filter((row) => typeof row === "string"))].sort();
  const requirements = [...new Set(relevant.filter((row) => row.predicate === "requirement_affected" || row.predicate.startsWith("release_blocked_")).map((row) => row.tuple?.requirement).filter((row) => typeof row === "string"))].sort();
  const blockers = relevant.filter((row) => row.predicate.startsWith("release_blocked_")).map((row) => ({ code: row.predicate === "release_blocked_stale_evidence" ? "stale-evidence" : "stale-authority", requirement: row.tuple.requirement, proof: row.conclusionId })).sort((a, b) => a.code.localeCompare(b.code) || a.requirement.localeCompare(b.requirement));
  const body = {
    schema: "bantam.factory.exocortex-mutation-kit.v1",
    kind: "bantam.factory-exocortex-mutation-kit",
    packetId: packet.packetId,
    permitId: ticket.permitId,
    chassisFingerprint: ticket.chassisFingerprint,
    operation: ticket.operation,
    targetPaths: ticket.scope.allowedPaths,
    routing: { affectedTests: values("verification_work_order", "test"), governedRequirements: requirements },
    blockers,
    proofRefs: [...new Set(relevant.map((row) => row.conclusionId))].sort(),
    omittedProducts: packet.omissions?.count ?? 0,
    stopConditions: ["Inspect the target source before manufacturing replacement material.", "Do not mutate the chassis; emit the fitted product.", "Independent gauges and release authority remain downstream."],
  };
  return deepFreeze({ ...body, kitId: `exocortex-mutation-kit:sha256:${digest(body)}` });
}

/** Admit a model-authored product before a deterministic actuator can consume it. */
export function admitExocortexMutationProduct({ answer, permit, maxBytes = 65_536 } = {}) {
  const ticket = defineExocortexDispatchPermit(permit);
  const reasons = [];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) reasons.push("invalid-answer");
  const row = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
  if (row.status !== "completed") reasons.push("worker-not-completed");
  if (row.permitId !== ticket.permitId) reasons.push("permit-mismatch");
  if (!ticket.scope.allowedPaths.includes(row.targetPath)) reasons.push("target-out-of-scope");
  if (typeof row.replacementSource !== "string" || !row.replacementSource.trim()) reasons.push("missing-replacement-source");
  const bytes = typeof row.replacementSource === "string" ? Buffer.byteLength(row.replacementSource) : 0;
  if (bytes > maxBytes) reasons.push("replacement-too-large");
  if (typeof row.replacementSource === "string" && row.replacementSource.includes("\0")) reasons.push("replacement-contains-nul");
  const body = {
    schema: "bantam.factory.exocortex-mutation-product.v1",
    kind: "bantam.factory-exocortex-mutation-product",
    permitId: ticket.permitId,
    articleId: ticket.articleId,
    targetPath: typeof row.targetPath === "string" ? row.targetPath : null,
    replacementSource: typeof row.replacementSource === "string" ? row.replacementSource : null,
    bytes,
    proposedVerification: Array.isArray(row.testsRun) ? row.testsRun.filter((value) => typeof value === "string") : [],
    disposition: reasons.length ? "contained" : "admitted-for-actuation",
    reasons,
  };
  return deepFreeze({ ...body, productId: `exocortex-mutation-product:sha256:${digest(body)}` });
}

/** Independent pre-use check shared by station adapters and test gauges. */
export function inspectExocortexDispatchPermit({ permit, packetId, chassisFingerprint, standardWorkRef, operation, toolPath, toolSha256, targetPath } = {}) {
  let ticket;
  try { ticket = defineExocortexDispatchPermit(permit); } catch (error) { return deepFreeze({ pass: false, reasons: [`invalid-permit:${error.message}`] }); }
  const checks = [
    [ticket.packetId === packetId, "packet-mismatch"],
    [ticket.chassisFingerprint === chassisFingerprint, "chassis-mismatch"],
    [ticket.standardWorkRef === standardWorkRef, "standard-work-mismatch"],
    [ticket.operation === operation, "operation-mismatch"],
    [ticket.tool.path === toolPath, "tool-path-mismatch"],
    [ticket.tool.sha256 === toolSha256, "tool-hash-mismatch"],
    [ticket.scope.allowedPaths.includes(targetPath), "target-out-of-scope"],
    [ticket.authority.execute === "granted", "execution-not-granted"],
    [ticket.authority.release === "withheld", "release-authority-invalid"],
  ];
  const reasons = checks.filter(([pass]) => !pass).map(([, reason]) => reason);
  return deepFreeze({ pass: reasons.length === 0, reasons, permitId: ticket.permitId, articleId: ticket.articleId });
}

function normalizeTool(value) {
  exact(value, ["id", "path", "sha256", "invocation"], "dispatch tool");
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("dispatch tool sha256 must be a lowercase SHA-256 digest");
  return { id: token(value.id, "tool id"), path: path(value.path, "tool path"), sha256: value.sha256, invocation: text(value.invocation, "tool invocation") };
}
function normalizeScope(value) {
  exact(value, ["allowedPaths"], "dispatch scope");
  if (!Array.isArray(value.allowedPaths) || !value.allowedPaths.length) throw new TypeError("dispatch scope allowedPaths must be a non-empty array");
  return { allowedPaths: [...new Set(value.allowedPaths.map((row) => path(row, "allowed path")))].sort() };
}
function normalizeAuthority(value) {
  exact(value, ["execute", "release", "uses"], "dispatch authority");
  if (value.execute !== "granted" || value.release !== "withheld" || value.uses !== 1) throw new Error("dispatch authority must grant one execution and withhold release");
  return { execute: "granted", release: "withheld", uses: 1 };
}
function exact(value, fields, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); const unknown = Object.keys(value).filter((key) => !fields.includes(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function ref(value, prefix, label) { const result = text(value, label); if (!result.startsWith(`${prefix}:`) || !result.includes(":sha256:")) throw new Error(`${label} has invalid format`); return result; }
function path(value, label) { const result = text(value, label); if (result.startsWith("/") || result.split("/").includes("..")) throw new Error(`${label} must be workspace-relative`); return result; }
function token(value, label) { const result = text(value, label); if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error(`${label} has invalid format`); return result; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
