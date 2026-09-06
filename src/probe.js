// Fixture-backed experiments. Commands design the experiment, not its verdict:
// the controller owns isolation, stage order, process receipts, and input identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runShellProcess } from "./executor.js";
import { runProcess } from "./process-runner.js";
import { clipText } from "./clip.js";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { projectProbeEvidence } from "./probe-evidence.js";

const PHASES = Object.freeze(["setup", "witness", "check"]);
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_CHARS = 24000;

export async function runProbe(workspace, action, {
  signal = null,
  dockerImage,
  processRunner = runProcess,
  timeoutMs = 15000,
  maxBuffer = 65536,
} = {}) {
  validateAction(action);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("probe timeout must be 1..30000 ms");
  if (!Number.isInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 262144) throw new Error("probe output limit must be 1..262144 bytes");
  const source = fs.realpathSync(workspace);
  // Read and hash exactly the same bytes that will be copied; no size/mtime proxy.
  const material = readInputs(source, action.inputs);
  const inputs = material.map(({ bytes, ...entry }) => entry);
  const sourceDigest = digest(inputs);
  const specDigest = digest(action);
  const experimentId = `probe:${crypto.randomUUID()}`;
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-probe-"));
  const root = path.join(ownedRoot, "fixture");
  const scratch = path.join(ownedRoot, "tmp");
  const stages = [];
  let stopped = false;
  let sourceAfterDigest = sourceDigest;
  let sourceAfterError = null;
  const startedAt = new Date().toISOString();
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(scratch);
    fs.mkdirSync(path.join(root, "subject"));
    for (const input of material) {
      const destination = path.join(root, "subject", input.p);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, input.bytes, { flag: "wx", mode: input.mode & 0o777 });
      fs.chmodSync(destination, input.mode);
    }
    for (const stage of PHASES) {
      const command = action[stage];
      const entry = {
        stage, experimentId, sourceDigest, command, commandDigest: digest(command),
        executed: false, code: null, signal: null, timedOut: false, aborted: false,
        bufferExceeded: false, error: null, stdout: "", stderr: "",
      };
      if (!stopped && !signal?.aborted) {
        entry.executed = true;
        const stageStart = Date.now();
        try {
          const result = await runShellProcess(root, command, {
            // A probe never inherits explicit host mode or online shell permission.
            shellSandbox: "docker", shellNetwork: false, dockerImage,
            readOnlyWorkspacePaths: ["subject"], fixtureScratch: scratch,
            pipefail: true, timeoutMs, signal,
            processRunner: (file, args, opts) => processRunner(file, args, { ...opts, maxBuffer }),
          });
          Object.assign(entry, {
            code: Number.isInteger(result.code) ? result.code : null,
            signal: result.signal ?? null,
            timedOut: Boolean(result.timedOut), aborted: Boolean(result.aborted),
            bufferExceeded: Boolean(result.bufferExceeded),
            error: result.error !== null && result.error !== undefined ? String(result.error.message ?? result.error) : null,
            stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""),
            sandbox: result.sandbox,
          });
        } catch (error) {
          entry.error = String(error.message ?? error);
        }
        entry.durationMs = Date.now() - stageStart;
      } else if (signal?.aborted && !stopped) {
        entry.aborted = true;
      }
      entry.stdoutDigest = digest(entry.stdout);
      entry.stderrDigest = digest(entry.stderr);
      stages.push(entry);
      // This is scheduling only. The proof-bearing conclusion is the Datalog
      // projection, not this execution controller's Boolean predicate.
      stopped ||= !cleanExit(entry);
    }
    try {
      sourceAfterDigest = digest(readInputs(source, action.inputs).map(({ bytes, ...entry }) => entry));
    } catch (error) {
      sourceAfterError = String(error.message ?? error);
      sourceAfterDigest = `unavailable:${digest(sourceAfterError)}`;
    }
  } finally {
    // Only the exact directory owned by this invocation; never a user path.
    // rm does not follow fixture-created symlinks.
    removeFixture(ownedRoot);
  }
  const receipt = {
    schema: "bantam.probe-receipt.v1", experimentId, specDigest,
    sourceDigest, sourceAfterDigest, sourceAfterError,
    question: action.question, inputs, startedAt, finishedAt: new Date().toISOString(),
    stages, authority: "model-designed-experiment",
    sandboxContract: "bantam.probe-sandbox.v2",
    layout: { workspace: "/probe", scratch: "/tmp", lifetime: "one-experiment" },
    limits: { timeoutMs, maxBuffer, maxInputBytes: MAX_INPUT_BYTES },
  };
  // Receipt and proof never live in a directory writable by experiment commands.
  const projection = projectProbeEvidence(receipt);
  const probeEvidence = { ...receipt, projection };
  return {
    observation: renderProbeEvidence(probeEvidence), probeEvidence,
    verificationEvidence: null, shellExecution: null,
    ...(stages.some((entry) => entry.aborted) || signal?.aborted ? { interrupted: true } : {}),
  };
}

export function renderProbeEvidence(receipt) {
  const { projection } = receipt;
  const lines = [
    `[probe] ${projection.status}: ${projection.reason}`,
    "Scope: model-designed experiment on copied inputs; NOT task verification.",
    "A passed witness means its assertion exited zero, not independent proof of semantic coverage.",
    "Fixture files and /tmp persist across stages of this experiment; a new probe starts empty.",
    `Evidence: ${receipt.experimentId}; input ${receipt.sourceDigest}`,
  ];
  // Front-load every phase before any model-produced output can consume space.
  for (const entry of receipt.stages) {
    const state = !entry.executed ? "SKIPPED"
      : cleanExit(entry) ? "ASSERTION PASSED (exit 0)"
        : entry.error !== null || entry.signal !== null || entry.timedOut || entry.aborted || entry.bufferExceeded || entry.code === null || [125, 126, 127].includes(entry.code)
          ? "UNRESOLVED (execution incomplete/infrastructure)"
          : `ASSERTION FAILED (exit ${entry.code})`;
    lines.push(`${entry.stage}: ${state}`);
  }
  for (const entry of receipt.stages) {
    if (entry.stdout || entry.stderr || entry.error) {
      lines.push(`${entry.stage} output (untrusted, excerpt):\n${clipText([entry.stdout, entry.stderr, entry.error].filter(Boolean).join("\n"), 700)}`);
    }
  }
  return lines.join("\n");
}

function cleanExit(entry) {
  return entry.executed && entry.code === 0 && entry.signal === null && entry.error === null
    && !entry.timedOut && !entry.aborted && !entry.bufferExceeded;
}

function validateAction(action) {
  if (!action || action.a !== "probe") throw new Error("expected probe action");
  const keys = ["a", "question", "inputs", ...PHASES];
  if (Object.keys(action).some((key) => !keys.includes(key))) throw new Error("unknown probe field");
  if (typeof action.question !== "string" || !action.question.trim() || action.question.length > 2000) throw new Error("probe question must be 1..2000 characters");
  if (!Array.isArray(action.inputs) || action.inputs.length > 16) throw new Error("probe inputs must contain 0..16 file paths");
  for (const phase of PHASES) {
    if (typeof action[phase] !== "string" || !action[phase].trim() || action[phase].length > MAX_COMMAND_CHARS || action[phase].includes("\0")) {
      throw new Error(`probe ${phase} must be a nonempty command of at most ${MAX_COMMAND_CHARS} characters without NUL`);
    }
  }
}

function readInputs(workspace, inputs) {
  const seen = new Set();
  let total = 0;
  return inputs.map((input) => {
    const relative = input?.p;
    if (!input || Object.keys(input).length !== 1 || typeof relative !== "string" || !relative
      || relative.includes("\0") || relative.includes("\\") || relative.includes(":")
      || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
      || relative === "." || relative.startsWith("../") || seen.has(relative)) {
      throw new Error("probe input must be a unique normalized relative file path");
    }
    seen.add(relative);
    let current = workspace;
    const parts = relative.split("/");
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`probe input cannot use symlinks: ${relative}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`probe input parent must be a directory: ${relative}`);
      if (index === parts.length - 1 && !stat.isFile()) throw new Error(`probe input must be a regular file: ${relative}`);
    }
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error(`probe input must be a regular file: ${relative}`);
      // Check the opened object itself still resides inside the selected source.
      const real = fs.realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : current);
      if (!real.startsWith(workspace + path.sep)) throw new Error(`probe input escaped workspace: ${relative}`);
      const named = fs.statSync(current);
      if (stat.dev !== named.dev || stat.ino !== named.ino) throw new Error(`probe input changed while opening: ${relative}`);
      if (total + stat.size > MAX_INPUT_BYTES) throw new Error("probe input exceeds 2 MiB total limit");
      // Read at most the remaining allowance + 1 even if a concurrent writer
      // grows a file between fstat and read. Avoid unbounded readFile allocation.
      const buffer = Buffer.alloc(MAX_INPUT_BYTES - total + 1);
      let count = 0;
      while (count < buffer.length) {
        const got = fs.readSync(fd, buffer, count, buffer.length - count, null);
        if (!got) break;
        count += got;
      }
      total += count;
      if (total > MAX_INPUT_BYTES) throw new Error("probe input exceeds 2 MiB total limit");
      const bytes = buffer.subarray(0, count);
      return { p: relative, size: count, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), mode: stat.mode & 0o777, bytes };
    } finally { fs.closeSync(fd); }
  }).sort((a, b) => a.p.localeCompare(b.p));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex")}`;
}

function removeFixture(root) {
  // An experiment can chmod its own scratch directories. Restore traversal
  // only inside this owned tree, without following symlinks, before removing it.
  function unlock(directory) {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(path.join(directory, entry.name));
    }
  }
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}
