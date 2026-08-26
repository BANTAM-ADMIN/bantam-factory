import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";

/** Independent release gauge for one externally mutated workspace article. */
export function auditCodexMutationArticle({ before, after, allowedPaths, publicVerification, hiddenVerification, modelAnswer = null } = {}) {
  const baseline = normalizeHashes(before, "mutation baseline"), candidate = normalizeHashes(after, "mutation candidate");
  const allowed = strings(allowedPaths, "allowed mutation path");
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  const changed = paths.filter((file) => baseline[file] !== candidate[file]);
  const added = changed.filter((file) => !Object.hasOwn(baseline, file));
  const removed = changed.filter((file) => !Object.hasOwn(candidate, file));
  const modified = changed.filter((file) => Object.hasOwn(baseline, file) && Object.hasOwn(candidate, file));
  const scopeViolations = changed.filter((file) => !allowed.includes(file));
  const testTampering = changed.filter((file) => /(^|\/)test(s)?\//.test(file) || /[._-]test\.[cm]?[jt]s$/i.test(file));
  const publicPass = inspectionPass(publicVerification), hiddenPass = inspectionPass(hiddenVerification);
  const expectedMutation = changed.length > 0 && changed.every((file) => allowed.includes(file));
  const released = expectedMutation && scopeViolations.length === 0 && testTampering.length === 0 && publicPass && hiddenPass;
  const body = {
    schema: "bantam.factory.codex-mutation-audit.v1",
    kind: "bantam.factory-codex-mutation-audit",
    authority: "independent-gauge",
    allowedPaths: allowed,
    changed, added, removed, modified, scopeViolations, testTampering,
    publicVerification: summarizeInspection(publicVerification),
    hiddenVerification: summarizeInspection(hiddenVerification),
    modelAnswer,
    disposition: released ? "released" : "contained",
    reasons: [
      ...(changed.length ? [] : ["no-product-change"]),
      ...(scopeViolations.length ? ["scope-violation"] : []),
      ...(testTampering.length ? ["test-tampering"] : []),
      ...(publicPass ? [] : ["public-verification-failed"]),
      ...(hiddenPass ? [] : ["hidden-verification-failed"]),
    ],
  };
  return deepFreeze({ ...body, auditId: `codex-mutation-audit:sha256:${digest(body)}` });
}

export function summarizeCodexMutationArm(articles) {
  if (!Array.isArray(articles) || !articles.length) throw new TypeError("mutation arm summary requires articles");
  const usage = (row, key) => Number(row.run?.usage?.[key] ?? 0);
  const values = (fn) => stats(articles.map(fn));
  return deepFreeze({
    articles: articles.length,
    released: articles.filter((row) => row.audit?.disposition === "released").length,
    yield: articles.filter((row) => row.audit?.disposition === "released").length / articles.length,
    durationMs: values((row) => row.run.durationMs),
    commands: values((row) => row.run.commands.length),
    inputTokens: values((row) => usage(row, "input_tokens")),
    cachedInputTokens: values((row) => usage(row, "cached_input_tokens")),
    uncachedInputTokens: values((row) => Math.max(0, usage(row, "input_tokens") - usage(row, "cached_input_tokens"))),
    outputTokens: values((row) => usage(row, "output_tokens")),
    reasoningOutputTokens: values((row) => usage(row, "reasoning_output_tokens")),
  });
}

function normalizeHashes(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a hash map`);
  const result = {};
  for (const [file, hash] of Object.entries(value)) {
    if (typeof file !== "string" || !file || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} has invalid entry: ${file}`);
    result[file] = hash;
  }
  return Object.fromEntries(Object.entries(result).sort());
}
function inspectionPass(value) { return Boolean(value && value.pass === true && value.status === "pass"); }
function summarizeInspection(value) { return value ? { pass: value.pass === true, status: value.status ?? null, exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null, durationMs: Number.isFinite(value.durationMs) ? value.durationMs : null, command: value.command ?? null, detail: typeof value.detail === "string" ? value.detail.slice(0, 4000) : "" } : null; }
function strings(value, label) { if (!Array.isArray(value) || !value.length) throw new TypeError(`${label}s must be a non-empty array`); return [...new Set(value.map((row) => { if (typeof row !== "string" || !row.trim()) throw new TypeError(`${label} must be non-empty`); return row.trim(); }))].sort(); }
function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: sorted[Math.ceil(sorted.length / 2) - 1], max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length }; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
