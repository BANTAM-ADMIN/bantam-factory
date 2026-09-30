// The jobs toolset: BANTAM workers run on an isolated copy of a workspace,
// can be steered mid-run, and reach the live files only through job_apply
// (candidate verification → workspace transaction → live verification).
//
// Workers:
//   local         `bantam run` on the local llama.cpp model   (steerable)
//   codex         `bantam run` with Codex as its model        (steerable)
//   codex-native  `codex exec`, Codex's own agent loop          (not steerable)
// One job per lane at a time; the local lane matches the one-slot model server.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../atomic-file.js";
import { createWorkerControl, queueWorkerSteering, readWorkerFeedback } from "../../foreman-worker-control.js";
import { parseCodexJsonl } from "../../codex-delegate.js";
import { runProcess } from "../../process-runner.js";
import { listWorkspaceFiles, WorkspaceStore } from "../../workspace-store.js";
import { planWorkspaceTransaction, recoverWorkspaceTransactions, WorkspaceTransaction } from "../../workspace-transaction.js";
import { ToolError } from "../protocol.js";

const BANTAM_BIN = fileURLToPath(new URL("../../../bin/bantam.js", import.meta.url));
// Native Codex inside an outer Docker boundary, for hosts where its own
// bubblewrap sandbox cannot start (the same launcher the fight harness uses).
const CODEX_CONTAINER = fileURLToPath(new URL("../../../scripts/astra-container-cli.mjs", import.meta.url));
export const WORKERS = Object.freeze({
  local: { lane: "local", steerable: true },
  codex: { lane: "codex", steerable: true },
  "codex-native": { lane: "codex", steerable: false },
});
export const LIMITS = Object.freeze({ maxFiles: 20_000, maxBytes: 512 * 1024 * 1024, diffBytes: 64 * 1024 });
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const ALWAYS_EXCLUDED = [".bantam", ".crew", ".git", "node_modules"];
const FINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export function nativeCodexPrompt(task, verify) {
  return [
    "Work as the native Codex agent in this isolated copy of the operator's workspace. Your changes are reviewed and applied by BANTAM only after independent verification.",
    "All file paths you edit must be relative to this workspace.",
    verify ? `Before finishing, run this verifier and report its result: ${verify}` : "Before finishing, check your own changes against the task.",
    "",
    `Task: ${task}`,
  ].join("\n");
}

/** The exact process a job runs. Pure: no filesystem access. */
export function workerCommand({ worker, task, ws, control, runFile, verify = null, model = null, effort = null, maxTurns = 60,
  localEndpoint = "http://127.0.0.1:8085", bantamBin = BANTAM_BIN, codexCommand = "codex", codexSandbox = "docker",
  containerDir = null, codexContainer = CODEX_CONTAINER }) {
  if (worker === "codex-native") {
    const exec = [
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
      "--cd", ws, nativeCodexPrompt(task, verify),
    ];
    if (codexSandbox === "host") return { exe: codexCommand, env: {}, args: [...exec.slice(0, 4), "--sandbox", "workspace-write", ...exec.slice(4)] };
    // Docker is the boundary; the launcher mounts only the copy (read-write),
    // Codex's auth (read-only) and its runtime. The job's own timeout governs.
    if (!containerDir) throw new Error("codex-native in Docker needs a container directory");
    return { exe: process.execPath, args: [codexContainer, ...exec.slice(0, 4), "--dangerously-bypass-approvals-and-sandbox", ...exec.slice(4)],
      env: { ASTRA_CONTAINER_CID_DIR: containerDir, ASTRA_CONTAINER_TIMEOUT_SECONDS: "0" } };
  }
  const args = [bantamBin, "run", "--task", task, "--workspace", ws, "--autonomous", "--max-turns", String(maxTurns),
    `--save-run=${runFile}`, "--supervisor-control", control];
  const env = {};
  if (worker === "local") {
    args.push("--endpoint", localEndpoint, "--profile", "qwen");
    env.BANTAM_ENDPOINT = localEndpoint;
  } else if (worker === "codex") {
    args.push("--codex", ...(model ? ["--model", model] : []), ...(effort ? ["--codex-effort", effort] : []));
  } else throw new Error(`unknown worker: ${worker}`);
  if (verify) args.push("--verify", verify);
  return { exe: process.execPath, args, env };
}

function childEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["NODE_TEST_CONTEXT", "NODE_OPTIONS", "NODE_PATH", "BANTAM_ENDPOINT"].includes(key)));
  return { ...env, ...extra };
}

async function runVerifier(cwd, command, { timeoutMs = 600_000, signal = null } = {}) {
  const started = Date.now();
  const result = await runProcess("/bin/bash", ["-o", "pipefail", "-c", command], { cwd, timeoutMs, signal, maxBuffer: 8 * 1024 * 1024, env: childEnv({}) });
  const status = result.timedOut ? "timeout" : result.aborted ? "interrupted" : result.error ? "error" : result.code === 0 ? "pass" : "fail";
  const tail = (text) => (text ?? "").slice(-2000);
  return { command, status, pass: status === "pass", exitCode: result.code ?? null, ms: Date.now() - started, stdout: tail(result.stdout), stderr: tail(result.stderr) };
}

const excerpt = (text, max = 1500) => {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max * 0.7)}\n…\n${value.slice(-max * 0.3)}`;
};

export function createJobsToolset({
  localEndpoint = "http://127.0.0.1:8085",
  bantamBin = BANTAM_BIN,
  codexCommand = "codex",
  codexSandbox = "docker",
  commandFor = null,
  lanes = { local: 1, codex: 1 },
  pollMs = 1000,
  killGraceMs = 10_000,
  limits = LIMITS,
} = {}) {
  let ctx = null, store = null, jobsDir = null, stopping = false;
  const jobs = new Map();
  const queues = { local: [], codex: [] };
  const running = new Map(); // id → { child, timer, poll, cancelled, timedOut, exited }
  const launches = new Map(); // id → the promise that settles the job
  const applies = new Set(); // in-flight job_apply promises
  const applyLocks = new Map(); // live workspace → tail of its apply chain
  const halt = new AbortController(); // aborts verifiers when the server stops

  const dirOf = (id) => path.join(jobsDir, id);
  const paths = (id) => {
    const dir = dirOf(id);
    return { dir, ws: path.join(dir, "ws"), control: path.join(dir, "control"), baseline: path.join(dir, "baseline"),
      candidate: path.join(dir, "candidate"), runFile: path.join(dir, "run.json"), log: path.join(dir, "worker.log"),
      transactions: path.join(dir, "transactions"), containers: path.join(dir, "containers") };
  };
  const persist = (job) => writeJsonAtomic(path.join(dirOf(job.id), "job.json"), job);
  const log = (job, detail = null) => ctx.log({ event: "job", job: job.id, state: job.state, detail });
  const notify = (job, text, to = [job.createdBy]) => {
    try { ctx.room.post("bantam", { to, kind: "event", text, ...(job.roomTask && ctx.room.tasks.has(job.roomTask) ? { task: job.roomTask } : {}) }); }
    catch (error) { ctx.log({ event: "job_notify_failed", job: job.id, error: error.message }); }
  };
  const requireJob = (id) => {
    const job = jobs.get(id);
    if (!job) throw new ToolError(`no job ${id}`);
    return job;
  };
  const exclusions = (root, extra = []) => [...ALWAYS_EXCLUDED, ...extra].map((rel) => path.resolve(root, rel));
  const duration = (job) => {
    const ms = (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt ?? job.createdAt);
    return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  };

  function recoverJobs() {
    for (const id of fs.readdirSync(jobsDir)) {
      let job;
      try { job = JSON.parse(fs.readFileSync(path.join(dirOf(id), "job.json"), "utf8")); } catch { continue; }
      if (!FINAL.has(job.state)) {
        job.state = "interrupted";
        job.finishedAt = new Date().toISOString();
        job.error = "the MCP server stopped while this job was active; it was not re-run";
        persist(job);
        notify(job, `Job ${job.id} (${job.worker}) was interrupted when the BANTAM MCP server stopped. It was not re-run; start a new job if it is still needed. Its copy is kept at ${paths(job.id).ws}.`);
      }
      recoverApply(job);
      jobs.set(job.id, job);
    }
  }

  // An apply cut off mid-way (crash, kill) is rolled back from its journal,
  // or committed if it had already been promoted.
  function recoverApply(job) {
    const root = paths(job.id).transactions;
    if (!fs.existsSync(root) || !fs.readdirSync(root).length) return;
    let outcome;
    try {
      const recovered = recoverWorkspaceTransactions({ workspace: job.workspace, transactionRoot: root });
      if (!recovered.length) return;
      outcome = recovered.some((r) => r.action === "committed")
        ? { state: "applied", at: new Date().toISOString(), note: "completed during recovery after the server stopped" }
        : { state: "rolled_back", at: new Date().toISOString(), note: "the server stopped during apply; the live folder was restored" };
    } catch (error) {
      outcome = { state: "conflict", at: new Date().toISOString(), error: error.message };
    }
    job.apply = { ...job.apply, ...outcome };
    persist(job);
    notify(job, `Job ${job.id}'s interrupted apply was recovered: ${outcome.state}${outcome.error ? ` (${outcome.error}; inspect ${job.workspace} by hand)` : ""}.`);
  }

  // Directory names count too: a setup that failed leaves no job.json behind.
  function nextId() {
    let max = 0;
    for (const id of [...jobs.keys(), ...fs.readdirSync(jobsDir)]) if (/^j\d+$/.test(id)) max = Math.max(max, Number(id.slice(1)));
    return `j${max + 1}`;
  }

  function checkSize(workspace, exclude) {
    const files = listWorkspaceFiles(workspace, { excludePaths: [...exclusions(workspace, exclude), ctx.runtimeDir], gitDir: store.gitDir });
    if (files.length > limits.maxFiles) throw new ToolError(`${workspace} has ${files.length} files (limit ${limits.maxFiles}); point the job at a focused folder or add exclude paths`);
    let bytes = 0;
    for (const rel of files) {
      let stat;
      try { stat = fs.lstatSync(path.join(workspace, rel)); } catch { continue; /* vanished */ }
      // Results are applied file by file; a link or device cannot be, so say
      // so now rather than after the worker has spent its run.
      if (!stat.isFile()) throw new ToolError(`${rel} is ${stat.isSymbolicLink() ? "a symbolic link" : "not a regular file"}; job results can only be applied to plain files. Add it to exclude (exclude: [${JSON.stringify(rel)}]) or point the job at a folder without links`);
      try { fs.accessSync(path.join(workspace, rel), fs.constants.R_OK); }
      catch { throw new ToolError(`${rel} is not readable; fix its permissions or add it to exclude`); }
      bytes += stat.size;
      if (bytes > limits.maxBytes) throw new ToolError(`${workspace} holds more than ${Math.round(limits.maxBytes / 1048576)} MiB; point the job at a focused folder or add exclude paths`);
    }
    return files.length;
  }

  function startJob(caller, a) {
    if (stopping) throw new ToolError("the server is stopping");
    const spec = WORKERS[a.worker];
    const workspace = path.resolve(a.workspace);
    if (!path.isAbsolute(a.workspace)) throw new ToolError("workspace must be an absolute path");
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new ToolError(`workspace is not a directory: ${workspace}`);
    const runtime = path.resolve(ctx.runtimeDir), crew = path.dirname(runtime);
    if (workspace === crew || workspace.startsWith(crew + path.sep)) throw new ToolError("workspace cannot be inside the room's .crew directory");
    const exclude = (a.exclude ?? []).map((rel) => {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new ToolError(`exclude paths are relative to the workspace: ${rel}`);
      return rel;
    });
    if (a.worker === "local" && (a.effort || a.model)) throw new ToolError("model and effort apply to Codex workers only; the local worker uses the served local model");
    if (a.room_task && !ctx.room.tasks.has(a.room_task)) throw new ToolError(`no task ${a.room_task}`);
    const files = checkSize(workspace, exclude);
    const id = nextId();
    const p = paths(id);
    let baseline;
    try {
      fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(p.control, { mode: 0o700 });
      baseline = store.capture(workspace, { message: `mcp job ${id} baseline`, excludePaths: [...exclusions(workspace, exclude), runtime] });
      store.materialize(baseline.commit, p.baseline);
      store.materialize(baseline.commit, p.ws);
      if (spec.steerable) createWorkerControl(p.control, p.ws);
    } catch (error) {
      fs.rmSync(p.dir, { recursive: true, force: true });
      throw new ToolError(`could not prepare ${id}'s copy of ${workspace}: ${error.message}`);
    }
    const job = {
      schema: 1, id, worker: a.worker, lane: spec.lane, steerable: spec.steerable,
      task: a.task, workspace, verify: a.verify ?? null, model: a.model ?? null, effort: a.effort ?? null,
      maxTurns: a.max_turns ?? 60, timeoutMs: (a.timeout_min ?? 120) * 60_000, exclude, roomTask: a.room_task ?? null,
      createdBy: caller, createdAt: new Date().toISOString(), state: "queued", files,
      baselineCommit: baseline.commit, candidateCommit: null, startedAt: null, finishedAt: null, exitCode: null,
      outcome: null, verification: null, changes: [], progress: null, steering: [], apply: null, error: null,
    };
    jobs.set(id, job);
    persist(job);
    queues[spec.lane].push(id);
    log(job, `${job.worker}: ${job.task.split("\n")[0].slice(0, 80)}`);
    pump(spec.lane);
    return { job: id, state: job.state, worker: job.worker, files, position: job.state === "queued" ? queues[spec.lane].indexOf(id) + 1 : 0,
      note: `You will get a room message when ${id} finishes; call room_wait to block for it.` };
  }

  function pump(lane) {
    if (stopping) return;
    const active = [...running.keys()].filter((id) => jobs.get(id).lane === lane).length;
    if (active >= (lanes[lane] ?? 1) || !queues[lane].length) return;
    const id = queues[lane].shift();
    const done = launch(jobs.get(id)).catch((error) => finishWithError(jobs.get(id), error)).finally(() => launches.delete(id));
    launches.set(id, done);
  }

  async function launch(job) {
    const p = paths(job.id);
    const command = commandFor ? commandFor(job, p) : workerCommand({ worker: job.worker, task: job.task, ws: p.ws, control: p.control,
      runFile: p.runFile, verify: job.verify, model: job.model, effort: job.effort, maxTurns: job.maxTurns, localEndpoint, bantamBin, codexCommand,
      codexSandbox, containerDir: p.containers });
    if (job.worker === "codex-native" && codexSandbox !== "host") fs.mkdirSync(p.containers, { recursive: true, mode: 0o700 });
    const out = fs.openSync(p.log, "a", 0o600);
    job.state = "running";
    job.startedAt = new Date().toISOString();
    persist(job);
    log(job);
    const child = spawn(command.exe, command.args, { cwd: p.ws, env: childEnv(command.env ?? {}), stdio: ["ignore", out, out] });
    fs.closeSync(out);
    const entry = { child, cancelled: false, timedOut: false };
    running.set(job.id, entry);
    entry.poll = setInterval(() => readProgress(job), pollMs);
    entry.timer = setTimeout(() => { entry.timedOut = true; terminate(entry); }, job.timeoutMs);
    const exit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    });
    clearInterval(entry.poll);
    clearTimeout(entry.timer);
    clearTimeout(entry.kill);
    // The process is gone; from here the result is captured and checked.
    entry.exited = true;
    job.state = "finishing";
    persist(job);
    try { await settle(job, entry, exit); }
    finally {
      running.delete(job.id);
      pump(job.lane);
    }
  }

  function terminate(entry) {
    entry.child.kill("SIGTERM");
    entry.kill = setTimeout(() => entry.child.kill("SIGKILL"), killGraceMs);
    entry.kill.unref?.();
  }

  function readProgress(job) {
    if (!job.steerable) return;
    let feedback;
    try { feedback = readWorkerFeedback(paths(job.id).control, paths(job.id).ws); } catch { return; }
    if (!feedback?.revision || feedback.revision === job.progress?.revision) return;
    job.progress = {
      revision: feedback.revision, turn: feedback.action?.turn ?? null,
      action: feedback.action ? Object.fromEntries(Object.entries(feedback.action).filter(([k]) => k !== "turn")) : null,
      observation: feedback.observation ? excerpt(feedback.observation.text) : null,
      at: new Date().toISOString(),
    };
    for (const s of job.steering) {
      if (s.state === "queued" && s.sequence <= (feedback.steeringRead ?? 0)) { s.state = "delivered"; s.deliveredAt = new Date().toISOString(); }
    }
    persist(job);
  }

  async function settle(job, entry, exit) {
    const p = paths(job.id);
    readProgress(job);
    job.exitCode = exit.code;
    job.finishedAt = new Date().toISOString();
    job.outcome = readOutcome(job, p);
    if (exit.error) job.error = `could not start the worker: ${exit.error.message}`;
    const candidate = store.capture(p.ws, { parent: job.baselineCommit, message: `mcp job ${job.id} candidate`, excludePaths: exclusions(p.ws) });
    job.candidateCommit = candidate.commit;
    store.materialize(candidate.commit, p.candidate);
    job.changes = planWorkspaceTransaction(p.baseline, p.candidate).changes.map((c) => ({ path: c.path, kind: c.kind }));
    if (job.verify && !entry.cancelled && !exit.error) {
      // Independent of the worker's own claim: a fresh copy of the candidate.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-mcp-verify-${job.id}-`));
      try {
        store.materialize(candidate.commit, path.join(scratch, "ws"));
        job.verification = await runVerifier(path.join(scratch, "ws"), job.verify, { signal: halt.signal });
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    }
    if (entry.cancelled || stopping) job.state = stopping ? "interrupted" : "cancelled";
    else if (entry.timedOut) { job.state = "failed"; job.error = `timed out after ${Math.round(job.timeoutMs / 60_000)} min`; }
    else if (exit.code === 0 && job.outcome?.reachedDone === false) {
      job.state = "failed";
      job.error = `the worker stopped without finishing${job.outcome.blocked ? ` (blocked: ${excerpt(job.outcome.blocked, 300)})` : " (turn limit?)"}`;
    }
    else if (exit.code === 0 && (!job.verify || job.verification?.pass)) job.state = "succeeded";
    else {
      job.state = "failed";
      job.error ??= exit.code !== 0 ? `worker exited ${exit.code ?? exit.signal}` : `verification ${job.verification?.status}`;
    }
    persist(job);
    log(job, job.error);
    const changed = job.changes.length ? `${job.changes.length} file${job.changes.length === 1 ? "" : "s"} changed: ${job.changes.slice(0, 8).map((c) => c.path).join(", ")}${job.changes.length > 8 ? ", …" : ""}` : "no files changed";
    const verified = job.verification ? ` Verification (${job.verify}): ${job.verification.status}.` : "";
    const summary = job.outcome?.summary ? ` Summary: ${excerpt(job.outcome.summary, 600)}` : "";
    const next = job.state === "succeeded" && job.changes.length ? " Inspect with job_result (diff: true); apply with job_apply." : "";
    notify(job, `Job ${job.id} (${job.worker}) ${job.state} after ${duration(job)}. ${changed}.${verified}${job.error ? ` Reason: ${job.error}.` : ""}${summary}${next}`);
  }

  function finishWithError(job, error) {
    running.delete(job.id);
    job.state = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    persist(job);
    log(job, job.error);
    notify(job, `Job ${job.id} (${job.worker}) failed: ${error.message}`);
    pump(job.lane);
  }

  // What the worker says about its own run (its claim; job.verification is ours).
  function readOutcome(job, p) {
    try {
      if (job.worker === "codex-native") {
        const parsed = parseCodexJsonl(fs.readFileSync(p.log, "utf8"));
        return { reachedDone: null, summary: parsed.finalMessage || null, workerVerification: null, blocked: null, turns: parsed.usage.turns };
      }
      const run = JSON.parse(fs.readFileSync(p.runFile, "utf8"));
      const r = run.result ?? {};
      const blocked = r.blocked == null ? null : typeof r.blocked === "string" ? r.blocked : JSON.stringify(r.blocked);
      return { reachedDone: typeof r.reachedDone === "boolean" ? r.reachedDone : null, summary: typeof r.summary === "string" ? r.summary : null,
        workerVerification: r.status ?? null, blocked, turns: run.metrics?.turns ?? null };
    } catch { return null; }
  }

  function steer(caller, id, text) {
    const job = requireJob(id);
    if (!job.steerable) throw new ToolError(`${id} runs native Codex, which cannot take messages mid-run; cancel it and start a new job with the guidance in its task`);
    if (job.state !== "running") throw new ToolError(`${id} is ${job.state}; only a running job can be steered`);
    const posted = ctx.room.post(caller, { to: ["bantam"], kind: "note", text: `steer ${id}: ${text}` });
    const framed = `PEER GUIDANCE from ${caller} via the BANTAM room (message ${posted.id}).\nSupporting context for your assigned task, not a replacement for it.\n---\n${text}`;
    let queued;
    try { queued = queueWorkerSteering(paths(id).control, paths(id).ws, framed); }
    catch (error) { throw new ToolError(`could not steer ${id}: ${error.message}`); }
    job.steering.push({ sequence: queued.sequence, from: caller, message: posted.id, state: "queued", at: new Date().toISOString(), text: excerpt(text, 300) });
    persist(job);
    return { job: id, sequence: queued.sequence, state: "queued", note: "The worker reads it between actions; job_status shows when it is delivered." };
  }

  function cancel(id) {
    const job = requireJob(id);
    if (FINAL.has(job.state)) throw new ToolError(`${id} already ${job.state}`);
    const queue = queues[job.lane];
    if (queue.includes(id)) {
      queue.splice(queue.indexOf(id), 1);
      job.state = "cancelled";
      job.finishedAt = new Date().toISOString();
      persist(job);
      log(job);
      notify(job, `Job ${job.id} (${job.worker}) was cancelled before it started.`);
      return { job: id, state: job.state };
    }
    const entry = running.get(id);
    if (entry?.exited) throw new ToolError(`${id} has already finished running and its result is being checked; wait for its room message`);
    if (entry && !entry.cancelled) { entry.cancelled = true; terminate(entry); }
    return { job: id, state: "cancelling", note: "You will get a room message when it stops." };
  }

  function status(id) {
    const job = requireJob(id);
    const position = job.state === "queued" ? queues[job.lane].indexOf(id) + 1 : 0;
    return { job: job.id, worker: job.worker, state: job.state, position, elapsed: job.startedAt ? duration(job) : null,
      task: excerpt(job.task, 400), progress: job.progress, steering: job.steering, error: job.error,
      changes: FINAL.has(job.state) ? job.changes.length : null, apply: job.apply };
  }

  async function result(id, withDiff) {
    const job = requireJob(id);
    if (!FINAL.has(job.state)) throw new ToolError(`${id} is ${job.state}; wait for it (room_wait) before reading its result`);
    const out = { job: job.id, worker: job.worker, state: job.state, error: job.error, exitCode: job.exitCode,
      outcome: job.outcome, verification: job.verification, changes: job.changes, apply: job.apply,
      candidate: job.candidateCommit ? paths(id).candidate : null, log: paths(id).log };
    if (withDiff && job.changes.length) out.diff = await diff(id);
    return out;
  }

  async function diff(id) {
    const r = await runProcess("git", ["diff", "--no-index", "--no-color", "--", "baseline", "candidate"], { cwd: dirOf(id), timeoutMs: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const text = (r.stdout ?? "").replaceAll(" a/baseline/", " a/").replaceAll(" b/candidate/", " b/").replaceAll("--- a/baseline/", "--- a/").replaceAll("+++ b/candidate/", "+++ b/");
    return Buffer.byteLength(text) <= limits.diffBytes ? text : `${text.slice(0, limits.diffBytes)}\n[diff truncated at ${limits.diffBytes} bytes; the full candidate is at ${paths(id).candidate}]`;
  }

  // One apply at a time per live folder, so one job's live check never runs
  // over another job's unverified files. The server waits for these on stop.
  function apply(caller, id, verifyOverride) {
    const job = requireJob(id);
    const previous = applyLocks.get(job.workspace) ?? Promise.resolve();
    const run = previous.then(() => applyNow(caller, id, verifyOverride));
    const tail = run.catch(() => {});
    applyLocks.set(job.workspace, tail);
    applies.add(tail);
    tail.finally(() => { applies.delete(tail); if (applyLocks.get(job.workspace) === tail) applyLocks.delete(job.workspace); });
    return run;
  }

  async function applyNow(caller, id, verifyOverride) {
    if (stopping) throw new ToolError("the server is stopping");
    const job = requireJob(id);
    if (job.state !== "succeeded") throw new ToolError(`${id} is ${job.state}; only a succeeded job can be applied`);
    if (job.apply?.state === "applied") throw new ToolError(`${id} was already applied at ${job.apply.at}`);
    if (!job.changes.length) throw new ToolError(`${id} changed no files; nothing to apply`);
    const verify = verifyOverride ?? job.verify;
    if (!verify) throw new ToolError(`${id} has no verifier. Pass verify (a shell command run on the candidate and then on the live files), or verify: "true" to apply without a check.`);
    const p = paths(id);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-mcp-apply-${id}-`));
    try {
      store.materialize(job.candidateCommit, path.join(scratch, "ws"));
      const candidateCheck = await runVerifier(path.join(scratch, "ws"), verify, { signal: halt.signal });
      if (!candidateCheck.pass) throw new ToolError(`apply refused: the verifier ${candidateCheck.status} on the candidate.\n${candidateCheck.stderr || candidateCheck.stdout}`);
      const transaction = new WorkspaceTransaction({ workspace: job.workspace, baselineRoot: p.baseline, candidateRoot: p.candidate,
        transactionRoot: p.transactions, id: `apply-${id}-${crypto.randomBytes(6).toString("hex")}`,
        metadata: { kind: "bantam-mcp-job-apply", job: id, by: caller } });
      try { transaction.prepare(); }
      catch (error) { throw new ToolError(`apply refused, nothing written: ${error.message}. Someone changed that file after ${id} started; start a new job from the current files.`); }
      transaction.apply();
      const liveCheck = await runVerifier(job.workspace, verify, { signal: halt.signal });
      if (!liveCheck.pass) {
        try { transaction.rollback({ reason: `live verifier ${liveCheck.status}` }); }
        catch (error) {
          job.apply = { state: "conflict", at: new Date().toISOString(), by: caller, verify, verification: liveCheck, error: error.message };
          persist(job);
          throw new ToolError(`apply failed its live check (${liveCheck.status}) and could not be rolled back cleanly: ${error.message}. Inspect ${job.workspace} by hand; the transaction record is under ${p.transactions}.`);
        }
        job.apply = { state: "rolled_back", at: new Date().toISOString(), by: caller, verify, verification: liveCheck };
        persist(job);
        throw new ToolError(`apply rolled back: the verifier ${liveCheck.status} on the live files after applying.\n${liveCheck.stderr || liveCheck.stdout}`);
      }
      transaction.markVerified(liveCheck);
      transaction.markPromoted({ kind: "mcp-job-apply", by: caller });
      transaction.commit();
      job.apply = { state: "applied", at: new Date().toISOString(), by: caller, verify, verification: { status: liveCheck.status, ms: liveCheck.ms }, transaction: transaction.id, files: job.changes.length };
      persist(job);
      log(job, `applied by ${caller}`);
      return { job: id, applied: job.changes, workspace: job.workspace, verification: job.apply.verification };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  const listJobs = (state) => ({ jobs: [...jobs.values()].filter((j) => !state || j.state === state)
    .map((j) => ({ job: j.id, worker: j.worker, state: j.state, createdBy: j.createdBy, createdAt: j.createdAt, task: excerpt(j.task.split("\n")[0], 120), changes: FINAL.has(j.state) ? j.changes.length : null, applied: j.apply?.state === "applied" })) });

  return {
    name: "jobs",
    start(context) {
      ctx = context;
      jobsDir = path.join(ctx.runtimeDir, "jobs");
      fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
      store = new WorkspaceStore(path.join(ctx.runtimeDir, "store"));
      // Jev hands the GPU straight back while the local model has work.
      ctx.localJobRunning = () => [...running.keys()].some((id) => jobs.get(id)?.lane === "local");
      recoverJobs();
    },
    async stop() {
      stopping = true;
      for (const lane of Object.values(queues)) {
        for (const id of lane.splice(0)) {
          const job = jobs.get(id);
          job.state = "interrupted";
          job.error = "the MCP server stopped before this job started";
          job.finishedAt = new Date().toISOString();
          persist(job);
          notify(job, `Job ${job.id} (${job.worker}) was interrupted: the BANTAM MCP server stopped before it started.`);
        }
      }
      for (const entry of running.values()) {
        entry.cancelled = true;
        if (!entry.exited) terminate(entry);
      }
      // Verifiers (on a result or inside an apply) are cut short; an apply
      // whose live check is interrupted rolls itself back.
      halt.abort();
      await Promise.all([...launches.values(), ...applies]);
    },
    tools: [
      {
        name: "job_start",
        description: "Start a BANTAM worker on an isolated copy of a workspace folder. Workers: local (BANTAM on the local model; steerable), codex (BANTAM driven by Codex; steerable), codex-native (Codex's own agent; strongest, not steerable). Returns at once; you get a room message when it finishes (use room_wait). Nothing touches the live folder until job_apply. Point it at a focused folder, not a whole disk tree.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["worker", "task", "workspace"],
          properties: {
            worker: { type: "string", enum: Object.keys(WORKERS) },
            task: { type: "string", minLength: 1, maxLength: 32_000, description: "The complete assignment: goal, constraints, what done means." },
            workspace: { type: "string", description: "Absolute path of the folder to work on (copied; the original is untouched)." },
            verify: { type: "string", maxLength: 2000, description: "Shell command that must pass for success (run on a fresh copy of the result), e.g. \"python -m pytest tests/test_x.py\"." },
            model: { type: "string", maxLength: 80, description: "Codex model for codex/codex-native workers." },
            effort: { type: "string", enum: EFFORTS, description: "Codex reasoning effort." },
            max_turns: { type: "integer", minimum: 1, maximum: 400, description: "BANTAM turn limit (default 60)." },
            timeout_min: { type: "integer", minimum: 1, maximum: 480, description: "Wall-clock limit (default 120)." },
            exclude: { type: "array", items: { type: "string" }, maxItems: 64, description: "Workspace-relative paths to leave out of the copy." },
            room_task: { type: "string", description: "Room task id (t<n>) this job serves." },
          },
        },
        handler: async (a, { caller }) => startJob(caller, a),
      },
      {
        name: "job_status",
        description: "A job's state, queue position, latest worker action and observation, and whether your steering messages were delivered.",
        inputSchema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: { type: "string" } } },
        handler: async (a) => status(a.job),
      },
      {
        name: "job_result",
        description: "A finished job's outcome: state, verification, changed files, the worker's summary, and with diff: true the unified diff of the candidate against its starting copy.",
        inputSchema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: { type: "string" }, diff: { type: "boolean" } } },
        handler: async (a) => result(a.job, a.diff === true),
      },
      {
        name: "job_steer",
        description: "Send guidance to a running local or codex job. The worker reads it between actions as peer guidance for its current task (not a new task). Use it to correct course early; check delivery with job_status.",
        inputSchema: { type: "object", additionalProperties: false, required: ["job", "text"], properties: { job: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 7000 } } },
        handler: async (a, { caller }) => steer(caller, a.job, a.text),
      },
      {
        name: "job_cancel",
        description: "Cancel a queued or running job.",
        inputSchema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: { type: "string" } } },
        handler: async (a) => cancel(a.job),
      },
      {
        name: "job_apply",
        description: "Apply a succeeded job's changes to the live folder: the verifier runs on the candidate, the files are written transactionally (refused if any of them changed live since the job started), the verifier runs again on the live folder, and everything rolls back if it fails. Uses the job's verify unless you pass one; pass verify: \"true\" to apply without a check.",
        inputSchema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: { type: "string" }, verify: { type: "string", maxLength: 2000 } } },
        handler: async (a, { caller }) => apply(caller, a.job, a.verify ?? null),
      },
      {
        name: "job_list",
        description: "List jobs, optionally by state.",
        inputSchema: { type: "object", additionalProperties: false, properties: { state: { type: "string", enum: ["queued", "running", "finishing", "succeeded", "failed", "cancelled", "interrupted"] } } },
        handler: async (a) => listJobs(a.state ?? null),
      },
    ],
  };
}
