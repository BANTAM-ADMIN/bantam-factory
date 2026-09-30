// Execution gauge: when the material carries a Python function and the
// arguments of a call, run the call in a sealed cell and compare the value with
// each candidate answer as a Python literal. Like the calculator gauge, the
// model never has to simulate what a machine can compute exactly.
//
// The cell (scripts/exec-cell.py) is one long-lived container with no network,
// a read-only filesystem, memory and pid limits and no capabilities; each job
// runs in a forked child with CPU, memory and wall-clock limits. The image
// (docker/exec-cell) is python:3.13-slim plus python-chess, installed at build
// time; `-I` isolates the interpreter from the environment.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CELL_SCRIPT = fileURLToPath(new URL("../../scripts/exec-cell.py", import.meta.url));
const ARGUMENT_FIELDS = ["input", "inputs", "args", "arguments"];

/**
 * Start a sealed execution cell. `run({ code, call, candidates })` resolves to
 * `{ ok, value, matches }` or `{ ok: false, error }`; `close()` stops the cell.
 */
export function createExecCell({ image = "bantam/exec-cell:1", docker = "docker", timeoutMs = 10_000 } = {}) {
  const child = spawn(docker, [
    "run", "-i", "--rm", "--network", "none", "--read-only", "--memory", "512m", "--pids-limit", "64",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${CELL_SCRIPT}:/cell.py:ro`,
    image, "python3", "-I", "/cell.py",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  let nextId = 0;
  let closed = false;
  const failAll = (error) => {
    closed = true;
    for (const { resolve, timer } of waiting.values()) { clearTimeout(timer); resolve({ ok: false, error }); }
    waiting.clear();
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let result;
    try { result = JSON.parse(line); } catch { return; }
    const entry = waiting.get(result.id);
    if (!entry) return;
    waiting.delete(result.id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  });
  child.on("exit", () => failAll("execution cell exited"));
  child.on("error", (error) => failAll(`execution cell failed: ${error.message}`));
  return Object.freeze({
    run({ code, call, candidates = [], json = false }) {
      if (closed) return Promise.resolve({ ok: false, error: "execution cell closed" });
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: "execution cell timeout" }); }, timeoutMs);
        waiting.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ id, code, call, candidates, json })}\n`);
      });
    },
    close() { closed = true; child.stdin.end(); },
  });
}

/**
 * Find a Python call in structured material: a string field that defines a
 * function and a field holding that call's arguments. Returns `{ code, call }`
 * or null. Only a single top-level function name is called, never arbitrary text.
 */
export function findPythonCall(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const code = Object.values(state).find((value) => typeof value === "string" && /^\s*def [A-Za-z_]\w*\(/m.test(value));
  const argsField = ARGUMENT_FIELDS.find((field) => typeof state[field] === "string");
  if (!code || !argsField) return null;
  const names = [...code.matchAll(/^def ([A-Za-z_]\w*)\(/gm)].map((m) => m[1]);
  if (!names.length) return null;
  // The entry point is the last top-level function (helpers come first).
  return { code, call: `${names.at(-1)}(${state[argsField]})` };
}

/**
 * Run the gauge for one question: returns the index of the single candidate
 * equal to the call's value, with the cell's result, or `{ index: -1 }` when
 * the material has no call, the call fails, or zero or several candidates match.
 */
export async function execGaugeChoice(cell, state, candidateTexts) {
  const found = findPythonCall(state);
  if (!found) return { index: -1, applies: false };
  const result = await cell.run({ ...found, candidates: candidateTexts });
  const index = result.ok && result.matches?.length === 1 ? result.matches[0] : -1;
  return { index, applies: true, result };
}
