import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { createJobsToolset, workerCommand } from "../src/mcp/toolsets/jobs.js";
import { WorkspaceTransaction } from "../src/workspace-transaction.js";
import { Room } from "../src/mcp/room.js";
import { RoomStore } from "../src/mcp/room-store.js";

const FAKE = fileURLToPath(new URL("./fixtures/mcp-fake-worker.mjs", import.meta.url));
const temporary = [], toolsets = [];
afterEach(async () => {
  while (toolsets.length) await toolsets.pop().stop();
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

// Behaviour is chosen in the task text: "mode:fail", "wait:2000", "stop-after-steer".
const fakeCommand = (job, p) => ({
  exe: process.execPath,
  args: [FAKE, "--ws", p.ws, ...(job.steerable ? ["--control", p.control] : []), "--run", p.runFile,
    "--mode", /mode:(\w+)/.exec(job.task)?.[1] ?? "ok", "--steer-wait", /wait:(\d+)/.exec(job.task)?.[1] ?? "0",
    ...(job.task.includes("stop-after-steer") ? ["--stop-after-steer", "1"] : [])],
  env: {},
});

function setup({ roomDir = temp("bantam-mcp-jobs-room-"), options = {} } = {}) {
  const runtimeDir = path.join(roomDir, ".crew", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const store = new RoomStore(path.join(roomDir, ".crew", "room.jsonl"));
  const room = new Room(store);
  const toolset = createJobsToolset({ commandFor: fakeCommand, pollMs: 25, killGraceMs: 500, ...options });
  toolset.start({ room, store, roomDir, runtimeDir, log: () => {}, toolsets: ["jobs"] });
  toolsets.push(toolset);
  const tool = (name) => toolset.tools.find((t) => t.name === name).handler;
  const call = (name, args = {}, caller = "claude") => tool(name)(args, { caller, signal: new AbortController().signal });
  return { roomDir, runtimeDir, room, toolset, call };
}
function sourceWorkspace() {
  const ws = temp("bantam-mcp-jobs-src-");
  fs.writeFileSync(path.join(ws, "story.txt"), "It was a dark night.\n");
  return ws;
}
async function finished(call, job, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await call("job_status", { job });
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(s.state)) return s;
    if (Date.now() > deadline) throw new Error(`job ${job} still ${s.state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("worker commands", () => {
  const base = { task: "T", ws: "/r/ws", control: "/r/ctl", runFile: "/r/run.json", bantamBin: "/b/bantam.js" };
  it("runs local BANTAM on the local endpoint with the steering mailbox", () => {
    const c = workerCommand({ ...base, worker: "local", verify: "npm test", localEndpoint: "http://127.0.0.1:8085" });
    assert.equal(c.exe, process.execPath);
    assert.deepEqual(c.args, ["/b/bantam.js", "run", "--task", "T", "--workspace", "/r/ws", "--autonomous", "--max-turns", "60",
      "--save-run=/r/run.json", "--supervisor-control", "/r/ctl", "--endpoint", "http://127.0.0.1:8085", "--profile", "qwen", "--verify", "npm test"]);
    assert.equal(c.env.BANTAM_ENDPOINT, "http://127.0.0.1:8085");
  });
  it("runs Codex-backed BANTAM with an optional model and effort", () => {
    const c = workerCommand({ ...base, worker: "codex", model: "gpt-6-astra", effort: "high" });
    assert.deepEqual(c.args.slice(-5), ["--codex", "--model", "gpt-6-astra", "--codex-effort", "high"]);
    assert.ok(c.args.includes("--supervisor-control"));
    assert.deepEqual(workerCommand({ ...base, worker: "codex" }).args.slice(-1), ["--codex"]);
  });
  it("runs native Codex in the copy inside Docker by default, without the operator's config", () => {
    const c = workerCommand({ ...base, worker: "codex-native", model: "gpt-5.6-sol", effort: "high", verify: "make check", containerDir: "/r/containers", codexContainer: "/b/launcher.mjs" });
    assert.equal(c.exe, process.execPath);
    assert.deepEqual(c.args.slice(0, 12), ["/b/launcher.mjs", "exec", "--json", "--ephemeral", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="high"', "--cd"]);
    assert.equal(c.args[12], "/r/ws");
    assert.match(c.args.at(-1), /Task: T/);
    assert.match(c.args.at(-1), /make check/);
    assert.deepEqual(c.env, { ASTRA_CONTAINER_CID_DIR: "/r/containers", ASTRA_CONTAINER_TIMEOUT_SECONDS: "0" });
    assert.throws(() => workerCommand({ ...base, worker: "codex-native" }), /container directory/);
  });
  it("can run native Codex with its own host sandbox where bubblewrap works", () => {
    const c = workerCommand({ ...base, worker: "codex-native", codexSandbox: "host", codexCommand: "codex" });
    assert.equal(c.exe, "codex");
    assert.deepEqual(c.args.slice(0, 7), ["exec", "--json", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
  });
});

describe("jobs", () => {
  it("runs a job on a copy, verifies it independently and reports to its creator", async () => {
    const { call, room } = setup();
    const ws = sourceWorkspace();
    const started = await call("job_start", { worker: "local", task: "revise", workspace: ws, verify: "test -f new-note.md" });
    assert.equal(started.job, "j1");
    assert.equal(started.files, 1);
    const done = await finished(call, "j1");
    assert.equal(done.state, "succeeded");
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\n", "the live folder is untouched");
    const result = await call("job_result", { job: "j1", diff: true });
    assert.deepEqual(result.changes, [{ path: "new-note.md", kind: "added" }, { path: "story.txt", kind: "modified" }]);
    assert.equal(result.verification.status, "pass");
    assert.deepEqual(result.outcome, { reachedDone: true, summary: "fake worker summary", workerVerification: "pass", blocked: null, turns: 2 });
    assert.match(result.diff, /\+\+\+ b\/story\.txt/);
    assert.match(result.diff, /\+edited by worker/);
    const inbox = room.inbox("claude").messages;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, "bantam");
    assert.match(inbox[0].text, /Job j1 \(local\) succeeded after \d+s\. 2 files changed: new-note\.md, story\.txt\. Verification \(test -f new-note\.md\): pass\. Summary: fake worker summary/);
  });

  it("fails a job whose independent verification fails, or whose worker fails", async () => {
    const { call, room } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "x", workspace: ws, verify: "test -f missing.txt" });
    await call("job_start", { worker: "codex", task: "mode:fail", workspace: ws });
    assert.equal((await finished(call, "j1")).error, "verification fail");
    const second = await finished(call, "j2");
    assert.equal(second.state, "failed");
    assert.equal(second.error, "worker exited 1");
    await call("job_start", { worker: "local", task: "mode:undone", workspace: ws });
    const third = await finished(call, "j3");
    assert.equal(third.state, "failed");
    assert.equal(third.error, "the worker stopped without finishing (blocked: needs the operator's canon notes)");
    assert.match(room.inbox("claude").messages.map((m) => m.text).join("\n"), /Job j2 \(codex\) failed .*Reason: worker exited 1/);
  });

  it("runs one job per lane and queues the rest in order", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    const a = await call("job_start", { worker: "local", task: "wait:400", workspace: ws });
    const b = await call("job_start", { worker: "local", task: "wait:10", workspace: ws });
    const c = await call("job_start", { worker: "codex-native", task: "wait:10", workspace: ws });
    assert.deepEqual([a.state, b.state, c.state], ["running", "queued", "running"]);
    assert.equal(b.position, 1);
    assert.equal((await call("job_status", { job: "j2" })).position, 1);
    await finished(call, "j3");
    assert.equal((await call("job_status", { job: "j2" })).state, "queued", "codex finishing does not free the local lane");
    await finished(call, "j1");
    assert.equal((await finished(call, "j2")).state, "succeeded");
  });

  it("steers a running job through the worker mailbox and records delivery", async () => {
    const { call, room, runtimeDir } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "wait:5000 stop-after-steer", workspace: ws });
    await new Promise((r) => setTimeout(r, 150));
    const steered = await call("job_steer", { job: "j1", text: "Keep the narrator in past tense." });
    assert.deepEqual([steered.sequence, steered.state], [1, "queued"]);
    const done = await finished(call, "j1");
    assert.equal(done.steering[0].state, "delivered");
    const heard = fs.readFileSync(path.join(runtimeDir, "jobs", "j1", "candidate", "steered.txt"), "utf8");
    assert.match(heard, /^supervisor: PEER GUIDANCE from claude via the BANTAM room \(message m1\)\.\nSupporting context for your assigned task, not a replacement for it\.\n---\nKeep the narrator in past tense\./);
    assert.equal(room.history().messages[0].text, "steer j1: Keep the narrator in past tense.");
  });

  it("refuses to steer a finished job or a native Codex job", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "x", workspace: ws });
    await finished(call, "j1");
    await assert.rejects(call("job_steer", { job: "j1", text: "late" }), /j1 is succeeded; only a running job can be steered/);
    await call("job_start", { worker: "codex-native", task: "wait:2000", workspace: ws });
    await assert.rejects(call("job_steer", { job: "j2", text: "hi" }), /cannot take messages mid-run/);
    await call("job_cancel", { job: "j2" });
    await assert.rejects(call("job_steer", { job: "nope", text: "hi" }), /no job nope/);
  });

  it("cancels running and queued jobs", async () => {
    const { call, room } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "mode:hang", workspace: ws });
    await call("job_start", { worker: "local", task: "x", workspace: ws });
    assert.deepEqual(await call("job_cancel", { job: "j2" }), { job: "j2", state: "cancelled" });
    assert.match(room.inbox("claude").messages.at(-1).text, /Job j2 \(local\) was cancelled before it started/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call("job_cancel", { job: "j1" })).state, "cancelling");
    assert.equal((await finished(call, "j1")).state, "cancelled");
    assert.match(room.inbox("claude").messages.at(-1).text, /Job j1 \(local\) cancelled/);
    await assert.rejects(call("job_cancel", { job: "j1" }), /already cancelled/);
  });

  it("validates job requests", async () => {
    const { call, runtimeDir } = setup();
    const ws = sourceWorkspace();
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: "relative/path" }), /absolute/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: path.join(ws, "missing") }), /not a directory/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: runtimeDir }), /\.crew directory/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: path.dirname(runtimeDir) }), /\.crew directory/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws, effort: "high" }), /Codex workers only/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws, exclude: ["../etc"] }), /relative to the workspace/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws, room_task: "t9" }), /no task t9/);
  });

  it("refuses workspaces over the size limits", async () => {
    const { call } = setup({ options: { limits: { maxFiles: 1, maxBytes: 10, diffBytes: 1000 } } });
    const ws = sourceWorkspace();
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws }), /more than 0 MiB|limit/);
    fs.writeFileSync(path.join(ws, "second.txt"), "2");
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws }), /2 files \(limit 1\)/);
  });

  it("marks jobs interrupted when the server restarts mid-job and tells their creators", async () => {
    const roomDir = temp("bantam-mcp-jobs-room-");
    const first = setup({ roomDir });
    const ws = sourceWorkspace();
    await first.call("job_start", { worker: "local", task: "mode:hang", workspace: ws });
    // Simulate a crash: the record says running, but nobody owns the process.
    const record = path.join(first.runtimeDir, "jobs", "j1", "job.json");
    const snapshot = fs.readFileSync(record, "utf8");
    await toolsets.pop().stop();
    fs.writeFileSync(record, snapshot);
    const second = setup({ roomDir });
    const status = await second.call("job_status", { job: "j1" });
    assert.equal(status.state, "interrupted");
    assert.match(status.error, /not re-run/);
    assert.match(second.room.inbox("claude").messages.at(-1).text, /Job j1 \(local\) was interrupted/);
    assert.equal((await second.call("job_start", { worker: "local", task: "x", workspace: ws })).job, "j2");
  });
});

describe("jobs: review regressions", () => {
  it("refuses links and unreadable files up front, and a refused setup does not block later jobs", async () => {
    const { call, runtimeDir } = setup();
    const ws = sourceWorkspace();
    fs.symlinkSync("story.txt", path.join(ws, "link"));
    await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws }), /link is a symbolic link; .*exclude: \["link"\]/);
    fs.rmSync(path.join(ws, "link"));
    fs.writeFileSync(path.join(ws, "secret.txt"), "x", { mode: 0o000 });
    if (process.getuid?.() !== 0) await assert.rejects(call("job_start", { worker: "local", task: "x", workspace: ws }), /secret\.txt is not readable/);
    fs.chmodSync(path.join(ws, "secret.txt"), 0o644);
    fs.mkdirSync(path.join(runtimeDir, "jobs", "j1")); // left behind by a crash mid-setup
    assert.equal((await call("job_start", { worker: "local", task: "x", workspace: ws })).job, "j2");
    assert.equal((await finished(call, "j2")).state, "succeeded");
  });

  it("stops promptly while a finished job's verifier is still running", async () => {
    const { call, toolset } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "x", workspace: ws, verify: "sleep 20" });
    for (let i = 0; i < 400 && (await call("job_status", { job: "j1" })).state !== "finishing"; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal((await call("job_status", { job: "j1" })).state, "finishing");
    await assert.rejects(call("job_cancel", { job: "j1" }), /already finished running/);
    await assert.rejects(call("job_steer", { job: "j1", text: "late" }), /j1 is finishing/);
    const started = Date.now();
    await toolsets.pop().stop();
    assert.ok(Date.now() - started < 5000, `stop took ${Date.now() - started} ms`);
    assert.equal((await call("job_status", { job: "j1" })).state, "interrupted");
  });

  it("rolls back an apply that a crash left half-done, on the next start", async () => {
    const roomDir = temp("bantam-mcp-jobs-room-");
    const first = setup({ roomDir });
    const ws = sourceWorkspace();
    await first.call("job_start", { worker: "local", task: "x", workspace: ws });
    await finished(first.call, "j1");
    await toolsets.pop().stop();
    // Crash after the files were written, before the live check finished.
    const dir = path.join(first.runtimeDir, "jobs", "j1");
    const transaction = new WorkspaceTransaction({ workspace: ws, baselineRoot: path.join(dir, "baseline"), candidateRoot: path.join(dir, "candidate"),
      transactionRoot: path.join(dir, "transactions"), id: "apply-j1-crashed" });
    transaction.prepare();
    transaction.apply();
    assert.ok(fs.existsSync(path.join(ws, "new-note.md")));
    const second = setup({ roomDir });
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\n");
    assert.equal(fs.existsSync(path.join(ws, "new-note.md")), false);
    assert.equal((await second.call("job_status", { job: "j1" })).apply.state, "rolled_back");
    assert.match(second.room.inbox("claude").messages.at(-1).text, /j1's interrupted apply was recovered: rolled_back/);
  });

  it("applies one job at a time per live folder", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "x", workspace: ws });
    await call("job_start", { worker: "codex", task: "x", workspace: ws });
    await finished(call, "j1");
    await finished(call, "j2");
    // Both changed story.txt. Serialized, the second finds the first's change
    // and is refused cleanly instead of verifying over half-applied files.
    const [a, b] = await Promise.allSettled([call("job_apply", { job: "j1", verify: "sleep 0.3" }), call("job_apply", { job: "j2", verify: "true" })]);
    assert.equal(a.status, "fulfilled");
    assert.match(b.reason.message, /apply refused, nothing written: live workspace changed since baseline/);
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\nedited by worker\n");
  });
});

describe("follow-up jobs (from_job)", () => {
  it("continues from an earlier result and applies the whole chain against the original live snapshot", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "x", workspace: ws });
    await finished(call, "j1");
    const follow = await call("job_start", { worker: "codex", task: "x", from_job: "j1", verify: "test $(grep -c 'edited by worker' story.txt) -eq 2" });
    assert.equal(follow.from, "j1");
    assert.equal((await finished(call, "j2")).state, "succeeded");
    const result = await call("job_result", { job: "j2", diff: true });
    assert.deepEqual(result.changes.map((c) => c.path), ["new-note.md", "story.txt"]);
    assert.match(result.diff, /\+edited by worker\n\+edited by worker/);
    await call("job_apply", { job: "j2" });
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\nedited by worker\nedited by worker\n");
  });

  it("refuses follow-ups from unfinished jobs, other folders, or with a new exclude list", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "wait:1500", workspace: ws });
    await assert.rejects(call("job_start", { worker: "local", task: "x", from_job: "j1" }), /j1 has no result to continue from \(it is running\)/);
    await finished(call, "j1");
    await assert.rejects(call("job_start", { worker: "local", task: "x", from_job: "j1", workspace: sourceWorkspace() }), /same folder/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", from_job: "j1", exclude: ["a"] }), /keeps its source job's exclude list/);
    await assert.rejects(call("job_start", { worker: "local", task: "x" }), /workspace is required/);
    await assert.rejects(call("job_start", { worker: "local", task: "x", from_job: "j9" }), /no job j9/);
  });
});

describe("jobs in Jev mode", () => {
  it("runs local jobs as BANTAM with a Codex stand-in, and keeps them off Jev's GPU count", async () => {
    const seen = [];
    const { call, room, toolset } = setup({ options: { standInModel: "gpt-6.1-sol", commandFor: (job, p) => { seen.push(job); return fakeCommand(job, p); } } });
    const ws = sourceWorkspace();
    const started = await call("job_start", { worker: "local", task: "wait:300", workspace: ws });
    assert.equal(started.worker, "local → gpt-6.1-sol stand-in");
    assert.equal(seen[0].standIn, "gpt-6.1-sol");
    assert.equal((await call("job_status", { job: "j1" })).worker, "local → gpt-6.1-sol stand-in");
    await finished(call, "j1");
    assert.match(room.inbox("claude").messages[0].text, /^Job j1 \(local → gpt-6\.1-sol stand-in\) succeeded/);
    void toolset;
  });
  it("builds the stand-in's command as Codex-backed BANTAM on that model", () => {
    const c = workerCommand({ worker: "codex", model: "gpt-5.6-luna", task: "T", ws: "/r/ws", control: "/r/ctl", runFile: "/r/run.json", bantamBin: "/b/bantam.js" });
    assert.deepEqual(c.args.slice(-3), ["--codex", "--model", "gpt-5.6-luna"]);
    assert.ok(c.args.includes("--supervisor-control"), "still steerable");
  });
});

describe("job_apply", () => {
  async function succeededJob(extra = {}) {
    const env = setup();
    const ws = sourceWorkspace();
    await env.call("job_start", { worker: "local", task: "x", workspace: ws, ...extra });
    assert.equal((await finished(env.call, "j1")).state, "succeeded");
    return { ...env, ws };
  }

  it("applies a verified candidate to the live folder exactly once", async () => {
    const { call, ws } = await succeededJob({ verify: "grep -q 'edited by worker' story.txt" });
    const applied = await call("job_apply", { job: "j1" });
    assert.equal(applied.verification.status, "pass");
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\nedited by worker\n");
    assert.ok(fs.existsSync(path.join(ws, "new-note.md")));
    assert.equal((await call("job_status", { job: "j1" })).apply.state, "applied");
    await assert.rejects(call("job_apply", { job: "j1" }), /already applied/);
  });

  it("requires a verifier, or an explicit verify: \"true\"", async () => {
    const { call, ws } = await succeededJob();
    await assert.rejects(call("job_apply", { job: "j1" }), /verify: "true"/);
    await call("job_apply", { job: "j1", verify: "true" });
    assert.ok(fs.existsSync(path.join(ws, "new-note.md")));
  });

  it("refuses, writing nothing, when a changed file was edited live after the job started", async () => {
    const { call, ws } = await succeededJob();
    fs.writeFileSync(path.join(ws, "story.txt"), "The operator rewrote this.\n");
    await assert.rejects(call("job_apply", { job: "j1", verify: "true" }), /apply refused, nothing written: live workspace changed since baseline: story\.txt/);
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "The operator rewrote this.\n");
    assert.equal(fs.existsSync(path.join(ws, "new-note.md")), false);
  });

  it("refuses when the verifier fails on the candidate", async () => {
    const { call, ws } = await succeededJob();
    await assert.rejects(call("job_apply", { job: "j1", verify: "false" }), /verifier fail on the candidate/);
    assert.equal(fs.existsSync(path.join(ws, "new-note.md")), false);
  });

  it("rolls back when the verifier fails on the live folder", async () => {
    const { call, ws } = await succeededJob({ exclude: ["LIVE_ONLY"] });
    fs.writeFileSync(path.join(ws, "LIVE_ONLY"), "present only in the live folder");
    await assert.rejects(call("job_apply", { job: "j1", verify: "test ! -f LIVE_ONLY" }), /rolled back: the verifier fail on the live files/);
    assert.equal(fs.readFileSync(path.join(ws, "story.txt"), "utf8"), "It was a dark night.\n");
    assert.equal(fs.existsSync(path.join(ws, "new-note.md")), false);
    assert.equal((await call("job_status", { job: "j1" })).apply.state, "rolled_back");
  });

  it("only applies succeeded jobs with changes", async () => {
    const { call } = setup();
    const ws = sourceWorkspace();
    await call("job_start", { worker: "local", task: "mode:fail", workspace: ws });
    await finished(call, "j1");
    await assert.rejects(call("job_apply", { job: "j1", verify: "true" }), /j1 is failed/);
  });
});


describe("codex lanes", () => {
  it("runs as many codex jobs at once as there are codex lanes, and queues the rest", async () => {
    const sleeper = () => ({ exe: process.execPath, args: ["-e", "setTimeout(() => {}, 1200)"], env: {} });
    const { call } = setup({ options: { lanes: { local: 1, codex: 2 }, commandFor: sleeper } });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await call("job_start", { worker: "codex", task: `t${i}`, workspace: sourceWorkspace() })).job);
    await new Promise((r) => setTimeout(r, 300));
    const states = [];
    for (const id of ids) states.push((await call("job_status", { job: id })).state);
    assert.equal(states.filter((s) => s === "running").length, 2, `states: ${states}`);
    assert.equal(states.filter((s) => s === "queued").length, 1, `states: ${states}`);
    for (const id of ids) await finished(call, id);
  });
});
