// Candidate imports are execution, even when a helper calls them inspection.
// Run every smoke helper through the same sandbox as workspace shell actions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShellProcess } from "./executor.js";

const HELPERS = Object.freeze({
  edge_smoke: new URL("./edge-smoke.js", import.meta.url),
  spec_example: new URL("./spec-examples.js", import.meta.url),
  lexical_smoke: new URL("./logic/lexical-smoke.js", import.meta.url),
  type_contract: new URL("./logic/type-contract-smoke.js", import.meta.url),
});

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export async function runWorkspaceProbe({
  workspace,
  kind,
  task = null,
  timeoutMs = 10_000,
  shellSandbox = process.env.BANTAM_SHELL_SANDBOX ?? "docker",
  shellNetwork = false,
  dockerImage,
  signal = null,
  processRunner,
} = {}) {
  if (!Object.hasOwn(HELPERS, kind)) throw new Error(`unknown workspace probe: ${kind}`);
  if (!["docker", "host"].includes(shellSandbox)) {
    return { status: "error", detail: `Unknown shell sandbox: ${shellSandbox}; no probe ran.` };
  }
  let stage = null;
  try {
    if (signal?.aborted) return { status: "interrupted", detail: "Workspace probe was interrupted before execution." };
    const root = fs.realpathSync(path.resolve(workspace));
    const parent = stagingParent(root);
    stage = fs.mkdtempSync(path.join(parent, `${kind}-`));
    // These four helpers import Node builtins only. Copy trusted bytes into the
    // candidate mount; no host source-tree mount or candidate-selected helper.
    const helper = path.join(stage, "probe.mjs");
    fs.writeFileSync(helper, fs.readFileSync(fileURLToPath(HELPERS[kind])), { mode: 0o400, flag: "wx" });
    const args = [helper, root];
    if (kind !== "edge_smoke") {
      const taskFile = path.join(stage, "task.txt");
      fs.writeFileSync(taskFile, typeof task === "string" ? task : JSON.stringify(task ?? ""), { mode: 0o400, flag: "wx" });
      args.push(taskFile);
    }
    const command = `node ${args.map(quote).join(" ")}`;
    const result = await runShellProcess(root, command, {
      timeoutMs, shellSandbox, shellNetwork, dockerImage, signal, processRunner,
      workspaceReadOnly: true,
      pipefail: true,
    });
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 4000);
    const evidence = { sandbox: result.sandbox, exitCode: result.code ?? null };
    if (result.aborted) return { status: "interrupted", detail: detail || "Workspace probe was interrupted.", ...evidence };
    if (result.timedOut) return { status: "timeout", detail: detail || "Workspace probe exceeded its time limit.", ...evidence };
    if (result.error || result.bufferExceeded || result.code !== 0) {
      return { status: "error", detail: detail || `Workspace probe exited ${result.code ?? "without a verdict"}.`, ...evidence };
    }
    let findings;
    try { findings = JSON.parse(result.stdout); } catch {
      return { status: "error", detail: "Workspace probe did not return a JSON findings array.", ...evidence };
    }
    if (!Array.isArray(findings)) {
      return { status: "error", detail: "Workspace probe returned an invalid findings record.", ...evidence };
    }
    return { status: "ok", findings, ...evidence };
  } catch (error) {
    return { status: signal?.aborted ? "interrupted" : "error", detail: String(error?.message ?? error) };
  } finally {
    // Only the directory this call created is ours to remove.
    if (stage) {
      try { fs.rmSync(stage, { recursive: true, force: true }); }
      catch (error) {
        // Cleanup is infrastructure evidence too. Preserve the result protocol
        // instead of throwing out of finally and crashing the agent loop.
        return { status: signal?.aborted ? "interrupted" : "error", detail: `Workspace probe staging cleanup failed: ${error.message}` };
      }
    }
  }
}

function stagingParent(root) {
  let current = root;
  for (const part of [".bantam", "probes"]) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workspace probe staging path must be a real directory: ${current}`);
    }
    const real = fs.realpathSync(current);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error("Workspace probe staging path escapes the workspace.");
  }
  return current;
}
