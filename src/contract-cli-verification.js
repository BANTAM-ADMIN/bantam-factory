// A CLI route is a separate public-contract obligation. API assertions and
// echoed child statuses cannot establish it. This validates controller-owned
// receipts, not arbitrary foreign logs or the correctness of a model's oracle.
import crypto from "node:crypto";
import path from "node:path";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { validateAssertionProbeReceipt } from "./contract-assertion-station.js";
import { parseCliAssertionSpec, buildCliAssertionProbe } from "./contract-cli-assertion-spec.js";

const HASH = /^[a-f0-9]{64}$/;
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha(canonicalEncode(value));
const probeDigest = value => `sha256:${digest(value)}`;
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const badFlags = value => ["blocked", "invalidated", "interrupted", "aborted", "timedOut", "bufferExceeded", "error", "signal", "uncertainty"].some(key => Boolean(value?.[key]));
const relative = value => typeof value === "string" && value.length > 0 && value.length <= 4096
  && !/[\\:\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value)
  && value !== "." && path.posix.normalize(value) === value && !value.startsWith("../");

function validContract(contract) {
  return record(contract) && contract.schema === "bantam.cli-contract.v1"
    && HASH.test(contract.taskSha256 ?? "") && relative(contract.module)
    && /\.[cm]?js$/.test(contract.module) && contract.inputKind === "json-file"
    && same(contract.success, { exitCode: 0, stdout: "single-json-newline", stderr: "empty" })
    && (contract.arity === null || (record(contract.arity) && contract.arity.arguments === 1
      && Number.isSafeInteger(contract.arity.exitCode) && contract.arity.exitCode > 0 && contract.arity.exitCode < 256
      && same(contract.arity, { arguments: 1, exitCode: contract.arity.exitCode, stdout: "empty", stderr: "nonempty" })))
    && Array.isArray(contract.evidence) && contract.evidence.length > 0 && contract.evidence.length <= 16
    && contract.evidence.every(value => typeof value === "string" && value.trim())
    && contract.evidence.reduce((sum, value) => sum + value.length, 0) <= 16000;
}

/** Validate fixed-runner child measurements; this does not confer task proof. */
export function validateCliCaseMeasurements(stdout, { contract, spec, status = "complete" } = {}) {
  try {
    if (!validContract(contract) || !parseCliAssertionSpec(JSON.stringify(spec), { contract, sourcePaths: [contract.module] })
      || !["complete", "failed"].includes(status)
      || typeof stdout !== "string" || stdout.length > 262144) return false;
    const packet = JSON.parse(stdout), names = ["valid-input", ...(contract.arity ? ["missing-argument", "extra-argument"] : [])];
    if (!record(packet) || packet.schema !== "bantam.cli-assertion-check.v1" || packet.status !== status
      || !Array.isArray(packet.cases) || packet.cases.length !== names.length) return false;
    let failures = 0;
    for (const [index, measured] of packet.cases.entries()) {
      if (!record(measured) || measured.case !== names[index] || measured.signal !== null || measured.error !== null
        || !Number.isInteger(measured.status) || measured.status < 0 || measured.status > 255
        || !["passed", "failed"].includes(measured.result)) return false;
      const streams = {};
      for (const stream of ["stdout", "stderr"]) {
        const encoded = measured[`${stream}Base64`], count = measured[`${stream}Bytes`];
        if (typeof encoded !== "string" || encoded.length > 23000
          || !Number.isSafeInteger(count) || count < 0 || count > 16384 || !HASH.test(measured[`${stream}Sha256`] ?? "")) return false;
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded || bytes.length !== count || sha(bytes) !== measured[`${stream}Sha256`]) return false;
        streams[stream] = bytes;
      }
      let matches;
      if (index === 0) {
        matches = measured.status === 0 && streams.stderr.length === 0;
        try {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(streams.stdout);
          matches &&= text.endsWith("\n") && same(JSON.parse(text.slice(0, -1)), spec.expected);
        } catch { matches = false; }
      } else matches = measured.status === contract.arity.exitCode && streams.stdout.length === 0 && streams.stderr.length > 0;
      if (measured.result !== (matches ? "passed" : "failed")) return false;
      if (!matches) failures++;
    }
    return status === "complete" ? failures === 0 : failures > 0;
  } catch { return false; }
}

function measuredCliProjection(contract, receipt, generation) {
  try {
    if (!validContract(contract) || !Number.isSafeInteger(generation) || generation < 0
      || !record(receipt) || receipt.schema !== "bantam.contract-cli-station.v1"
      || !["complete", "failed"].includes(receipt.status) || badFlags(receipt)
      || receipt.generation !== generation || receipt.sourceUnchanged !== true
      || receipt.taskSha256 !== contract.taskSha256 || !same(receipt.contract, contract)
      || receipt.contractSha256 !== digest(contract) || !HASH.test(receipt.promptSha256 ?? "")) return null;
    if (!Array.isArray(receipt.sources) || receipt.sources.length < 1 || receipt.sources.length > 4) return null;
    const sources = new Map();
    for (const source of receipt.sources) {
      if (!record(source) || !relative(source.path) || !HASH.test(source.sha256 ?? "") || sources.has(source.path)) return null;
      sources.set(source.path, source.sha256);
    }
    if (!sources.has(contract.module)) return null;
    const spec = parseCliAssertionSpec(JSON.stringify(receipt.spec), { contract, sourcePaths: [...sources.keys()] });
    if (!spec || spec.module !== contract.module || receipt.specSha256 !== digest(spec)) return null;
    if (!Array.isArray(receipt.inputs) || receipt.inputs.length < 1 || receipt.inputs.length > 5) return null;
    const inputs = new Map(); let bytes = 0;
    for (const input of receipt.inputs) {
      if (!record(input) || !relative(input.p) || inputs.has(input.p) || !HASH.test(input.sha256 ?? "")
        || !Number.isSafeInteger(input.size) || input.size < 0
        || !Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 511
        || (!sources.has(input.p) && input.p !== "package.json")) return null;
      inputs.set(input.p, input.sha256); bytes += input.size;
    }
    if (bytes > 2 * 1024 * 1024 || [...sources].some(([name, hash]) => inputs.get(name) !== hash)
      || receipt.inputDigest !== probeDigest(receipt.inputs)
      || typeof receipt.question !== "string" || !receipt.question.trim() || receipt.question.length > 2000) return null;
    const action = buildCliAssertionProbe(spec, { contract, inputs: receipt.inputs.map(({ p }) => ({ p })), question: receipt.question });
    if (receipt.probeSpecDigest !== probeDigest(action)) return null;
    const raw = receipt.probeEvidence;
    if (!Array.isArray(raw?.stages) || raw.stages.some(stage => typeof stage?.stdout !== "string"
      || typeof stage?.stderr !== "string" || stage.stdout.length > 262144 || stage.stderr.length > 262144)) return null;
    if (!validateCliCaseMeasurements(raw.stages[2]?.stdout, { contract, spec, status: receipt.status })) return null;
    // Exact generated commands, copied-input metadata, stage/output digests and
    // source-after binding are checked again; cached projection is not authority.
    const projection = validateAssertionProbeReceipt(raw, { action, inputs: receipt.inputs });
    if (!projection || (receipt.status === "complete" ? projection.status !== "assertion_passed"
      : projection.status !== "assertion_failed")) return null;
    return projection;
  } catch { return null; }
}

/** Current-generation scoped CLI evidence only; never a whole-task PASS. */
export function cliVerificationPassed(contract, receipt, { generation } = {}) {
  return measuredCliProjection(contract, receipt, generation)?.status === "assertion_passed";
}

// Data stays quoted and template controls are neutralized before this text is
// rendered as an unclipped controller block. Diagnostics remain untrusted.
function quoted(value, max = 350) {
  let text = String(value ?? "").slice(0, max);
  const encode = input => JSON.stringify(input).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  let encoded = encode(text);
  while (encoded.length > max) {
    text = text.slice(0, Math.max(0, Math.floor(text.length * (max - 3) / encoded.length) - 1));
    encoded = encode(text + "…");
  }
  return encoded;
}

export function cliVerificationDecisionContext(contract, receipt, { generation } = {}) {
  try {
    if (!validContract(contract) || !Number.isSafeInteger(generation) || generation < 0) return null;
    const projection = measuredCliProjection(contract, receipt, generation);
    if (projection?.status === "assertion_passed") return null;
    const failed = projection?.status === "assertion_failed";
    let text = `CLI VERIFICATION REQUIRED: ${quoted(contract.module, 160)} has no passing current-generation CLI receipt (generation ${generation}). API-only assertions, a green project suite, and printed/echoed exit codes do not prove this entrypoint. DONE is not available until the CLI obligation is satisfied.\n`;
    if (failed) {
      text += "The fixed real-child CLI check failed:\n";
      const check = receipt.probeEvidence.stages.find(stage => stage.stage === "check");
      const cases = JSON.parse(check.stdout).cases;
      // Show every actual route, with failures first. A large valid-input JSON
      // or Base64 field must not hide the no-argument/extra-argument outcomes.
      for (const item of [...cases].sort((a, b) => Number(b.result === "failed") - Number(a.result === "failed"))) {
        const expectedExit = item.case === "valid-input" ? contract.success.exitCode : contract.arity.exitCode;
        text += `${item.case}: ${item.result}; actual exit ${item.status}, required ${expectedExit}; stdout ${item.stdoutBytes} bytes, stderr ${item.stderrBytes} bytes.`;
        if (item.reason) text += ` Diagnostic (untrusted): ${quoted(item.reason, 65)}.`;
        text += "\n";
      }
      text += "Repair a demonstrated implementation defect. A model-designed input/expectation may itself be invalid; it is not an oracle and the worker cannot edit the controller's case.\n";
    } else if (receipt?.generation !== undefined && receipt.generation !== generation) {
      text += "Earlier CLI evidence belongs to a different source generation and is stale. Preserve intended checks.\n";
    } else {
      text += "No complete, source-bound CLI check is available; missing, malformed, interrupted, or unbound receipts cannot establish success.\n";
      if (typeof receipt?.reason === "string" && receipt.reason.trim()) text += `Recorded unavailable reason (untrusted): ${quoted(receipt.reason, 200)}.\n`;
    }
    text += "Next: run the configured project verifier to trigger the controller CLI station. There is no worker station verb. It runs once per source generation; repeating an unchanged check does not retry a failed/unavailable station. Do not make gratuitous edits merely to force a retry.\n";
    text += "The real CLI must return the model-declared JSON plus newline, exit 0, and no stderr for its proposed valid input.";
    if (contract.arity) text += ` Public missing/extra arguments: exit ${contract.arity.exitCode}, empty stdout, nonempty stderr.`;
    return { schema: 1, phase: "cli", generation, text };
  } catch { return null; }
}
