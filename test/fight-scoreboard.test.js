import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildArmCommand, assemblePostmortem, cornerUsage, renderScoreboard, injectScoreboard, listArtifacts , laneValidity } from "../src/fight.js";

// A fight card must compare corners on more than wall clock and exit code:
// turns, input/output tokens, prefix reuse and success, from each corner's own
// evidence — BANTAM arms' run artifacts, the codex CLI's "tokens used" tail,
// Claude's stream-json result — never from a corner's narration.

test("the codexapi bridge arms run BANTAM on the chat dialect with sessions, under the extension trajectory", () => {
  const prev = { url: process.env.BANTAM_CODEXAPI_URL, key: process.env.BANTAM_CODEXAPI_KEY };
  process.env.BANTAM_CODEXAPI_URL = "http://bridge:8787/v1";
  process.env.BANTAM_CODEXAPI_KEY = "k";
  try {
    const spark = buildArmCommand("bantam-codexapi-spark", { task: "t" });
    assert.equal(spark.pool, "cloud");
    const a = spark.args.join(" ");
    assert.match(a, /--api-url http:\/\/bridge:8787\/v1 --api-key k --api-dialect chat --model gpt-5\.3-codex-spark:low/);
    assert.match(a, /--save-run=\.\.\/run\.json/, "the corner's own run artifact is the usage evidence");
    assert.equal(spark.env.BANTAM_PROMPT_TRAJECTORY, "extension", "sessions pay only under extension");
    assert.match(spark.env.BANTAM_CHAT_BODY_EXTRA, /chat_preamble/);
    const sol = buildArmCommand("bantam-codexapi-sol", { task: "t" });
    assert.match(sol.args.join(" "), /--model gpt-5\.6-sol:high/);
    // The series corners: same harness, same transport, the model is the variable.
    assert.match(buildArmCommand("bantam-codexapi-luna", { task: "t" }).args.join(" "), /--model gpt-5\.6-luna:medium/);
    assert.match(buildArmCommand("bantam-codexapi-terra", { task: "t" }).args.join(" "), /--model gpt-5\.6-terra:medium/);
  } finally {
    for (const [k, v] of [["BANTAM_CODEXAPI_URL", prev.url], ["BANTAM_CODEXAPI_KEY", prev.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("the opencode corner runs the same local 27B headlessly from its own arena config", () => {
  const c = buildArmCommand("opencode", { task: "fix it" });
  assert.equal(c.pool, "local", "same GPU as bantam and hermes — locals serialize");
  assert.equal(c.exe, "opencode");
  assert.deepEqual(c.args.slice(0, 3), ["run", "-m", "local/qwen"]);
  assert.equal(c.args.at(-1), "fix it");
  // FULL isolation — config, data and cache. A shared data dir carrying a
  // hard-killed WAL db hung every run at init (2026-08-25); the arena fixed it.
  // The arena location is env-overridable (launch repo); the INVARIANT is
  // isolation: all three XDG dirs live under one arena root, never the user's.
  assert.match(c.env.XDG_CONFIG_HOME, /opencode[\/\\]config$/);
  assert.match(c.env.XDG_DATA_HOME, /opencode[\/\\]data$/);
  assert.match(c.env.XDG_CACHE_HOME, /opencode[\/\\]cache$/);
});

test("the local bantam corner never silently enables a cloud teacher", () => {
  // Card 7 anatomy (2026-08-25): the stuck-test self-diagnosis FIRED and the
  // model still treadmilled ~230 s on its render test. The code's own A/B
  // says more self-diagnosis is null-to-negative and the validated escalation
  // is a STRONGER model (teacher, 2/5 -> 5/5 on gbnf-reach) — which is off
  // unless configured, and no fight arm configured it. The bridge is the
  // teacher: sol:high, one consult per stuck test, over LAN HTTP.
  const prev = { url: process.env.BANTAM_CODEXAPI_URL, key: process.env.BANTAM_CODEXAPI_KEY };
  process.env.BANTAM_CODEXAPI_URL = "http://bridge:8787/v1";
  process.env.BANTAM_CODEXAPI_KEY = "k";
  try {
    const c = buildArmCommand("bantam", { task: "t" });
    assert.equal(c.env.BANTAM_TEACHER, "0");
    assert.equal(c.env.BANTAM_TEACHER_CMD, "");
  } finally {
    for (const [k, v] of [["BANTAM_CODEXAPI_URL", prev.url], ["BANTAM_CODEXAPI_KEY", prev.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("the app-server sol corner is effort-matched to the bridge sol corner", () => {
  // Season 1 caveat: bantam-codex ran sol at the DEFAULT medium effort while
  // the bridge corner ran sol:high — every cross-transport sol comparison
  // carried that asterisk (cards 8R and 11). Series 2 removes it.
  const c = buildArmCommand("bantam-codex", { task: "t" });
  assert.match(c.args.join(" "), /--codex-effort high/);
});

test("the bantam corner trims clean-path thinks and caps repair-think length", () => {
  // Cards 16/17 wall decomposition (2026-08-25): 8.6 s of thinking on a 33.4 s
  // green-path run, and ONE 45.8 s repair think (4,096-token allowance) on a
  // 99.9 s run. TRIM is the measured-safe dial; the cap bounds a legitimate
  // failure think to ~1/4 of its old worst case.
  const c = buildArmCommand("bantam", { task: "t" });
  assert.equal(c.env.BANTAM_THINK_TRIM, "1");
  assert.equal(c.env.BANTAM_THINK_N_PREDICT, "1024");
});

test("the scoreboard flags any card where bantam trails a same-model local corner", () => {
  // Operator rule: bantam never loses to hermes or opencode — same weights,
  // so a slower wall is a HARNESS defect. The card itself must say so.
  const post = { task: "t", startedAt: "s", finishedAt: "e", corners: [
    { arm: "bantam", wallMs: 37400, exitCode: 0, artifacts: [] },
    { arm: "hermes", wallMs: 36600, exitCode: 0, artifacts: [] },
    { arm: "opencode", wallMs: 53100, exitCode: 0, artifacts: [] },
  ] };
  const cmds = [{ name: "bantam", corner: "BANTAM", color: "#e0a458" }, { name: "hermes", corner: "HERMES", color: "#7ec07a" }, { name: "opencode", corner: "OPENCODE", color: "#d48a9c" }];
  const html = renderScoreboard(post, cmds, { verdicts: {} });
  assert.match(html, /LOCAL RATCHET/);
  assert.match(html, /hermes by 0\.8s/);
  // 0.8s on a 37.4s wall is 2% — inside single-run noise. The banner keeps the
  // operator's rule but must say so, or it invites refight-until-the-coin-lands
  // (Deming's funnel; see control-limits.js).
  assert.match(html, /within single-run noise/);
  assert.match(html, /rematch median/);
  const wide = renderScoreboard({ ...post, corners: post.corners.map((c) => c.arm === "hermes" ? { ...c, wallMs: 20000 } : c) }, cmds, { verdicts: {} });
  assert.match(wide, /LOCAL RATCHET/);
  assert.doesNotMatch(wide, /within single-run noise/, "a 47% gap is a defect, not a marble");
  const ok = renderScoreboard({ ...post, corners: post.corners.map((c) => c.arm === "bantam" ? { ...c, wallMs: 30000 } : c) }, cmds, { verdicts: {} });
  assert.doesNotMatch(ok, /LOCAL RATCHET/);
});

test("a lane the bench never provisioned is INVALID, not a harness FAIL", async () => {
  // Operator rule (2026-08-25): a failure on the card must mean the harness
  // failed the TASK — never that the bench starved it. Validity is checked
  // from the lane's own artifacts: a materialized workspace, and (for
  // BANTAM-driven arms) the task bytes actually present in turn-0's request.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-validity-"));
  const task = "Make npm test pass by finishing two pieces of surgery on the ledger.";
  // bench fault: no workspace was ever materialized
  fs.mkdirSync(path.join(base, "empty"));
  assert.match(laneValidity({ armDir: path.join(base, "empty"), task }).reason, /workspace/i);
  // bench fault: bantam arm whose turn-0 request never carried the task
  const starved = path.join(base, "starved"); fs.mkdirSync(path.join(starved, "ws"), { recursive: true });
  fs.writeFileSync(path.join(starved, "ws", "a.js"), "x");
  fs.writeFileSync(path.join(starved, "run.json"), JSON.stringify({ modelCalls: [{ request: "no task here" }] }));
  assert.match(laneValidity({ armDir: starved, task }).reason, /task/i);
  // valid lane: provisioned AND prompted — a FAIL here is genuine
  const good = path.join(base, "good"); fs.mkdirSync(path.join(good, "ws"), { recursive: true });
  fs.writeFileSync(path.join(good, "ws", "a.js"), "x");
  fs.writeFileSync(path.join(good, "run.json"), JSON.stringify({ modelCalls: [{ request: "...\n" + task + "\n..." }] }));
  assert.equal(laneValidity({ armDir: good, task }).valid, true);
  // non-bantam arm with a workspace: valid without a run.json
  const cli = path.join(base, "cli"); fs.mkdirSync(path.join(cli, "ws"), { recursive: true });
  fs.writeFileSync(path.join(cli, "ws", "a.js"), "x");
  assert.equal(laneValidity({ armDir: cli, task }).valid, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("the hermes corner never restores a stale session cwd into the ring", () => {
  // Caught live on 7R round 3: hermes' session snapshot restored a repo-root
  // cwd from an EARLIER session and the lane ran `npm run test` against
  // BANTAM's own suite instead of its maze workspace. HERMES_HOME isolation
  // does not cover cwd restoration; the CLI's own flag does.
  const c = buildArmCommand("hermes", { task: "t" });
  assert.ok(c.args.includes("--no-restore-cwd"), "session cwd restoration must be off in the arena");
  assert.equal(c.env.HERMES_HOME && true, true, "home isolation stays");
});

test("every BANTAM-driven arm saves its run artifact beside its workspace", () => {
  for (const name of ["bantam", "bantam-codex", "bantam-codexapi-spark"]) {
    assert.match(buildArmCommand(name, { task: "t" }).args.join(" "), /--save-run=\.\.\/run\.json/, name);
  }
});

test("cornerUsage reads a BANTAM run artifact: turns, tokens, prefix reuse, pass", (t) => {
  const armDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fight-usage-"));
  t.after(() => fs.rmSync(armDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(armDir, "run.json"), JSON.stringify({
    metrics: { turns: 8, modelRequests: 9, durationMs: 26945, usage: { inputTokens: 103888, outputTokens: 2872, cacheHitTokens: 98944, reasoningTokens: 1882 } },
    result: { pass: true },
  }));
  const u = cornerUsage("bantam-codexapi-spark", { armDir, rawLines: [] });
  assert.deepEqual(u, { source: "run.json", turns: 8, requests: 9, inputTokens: 103888, outputTokens: 2872, cacheHitTokens: 98944, reasoningTokens: 1882, prefixReuse: 0.95, pass: true, durationMs: 26945 });
  // No verifier on the arm: unverified, which is not a failure.
  fs.writeFileSync(path.join(armDir, "run.json"), JSON.stringify({ metrics: { turns: 3, modelRequests: 3, usage: {} }, result: { pass: null, status: "unverified" } }));
  assert.equal(cornerUsage("bantam", { armDir, rawLines: [] }).pass, null);
  fs.writeFileSync(path.join(armDir, "run.json"), JSON.stringify({ modelCalls: [{}] }));
  assert.equal(cornerUsage("bantam", { armDir, rawLines: [] }), null, "unfinished checkpoints are not zero-token runs");
});

test('BANTAM usage is complete only when every request receipt accounts for the totals', t => {
  const armDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-usage-coverage-'));
  t.after(() => fs.rmSync(armDir, {recursive:true, force:true}));
  const usage = {inputTokens:100, outputTokens:20, cacheHitTokens:80};
  const run = {metrics:{modelRequests:1, usage}, modelCalls:[{status:'ok', response:{normalized:{usage}}}]};
  const read = () => {fs.writeFileSync(path.join(armDir,'run.json'),JSON.stringify(run));return cornerUsage('bantam-codex-astra',{armDir});};
  assert.equal(read().complete,true); assert.equal(read().measuredRequests,1);
  run.metrics.modelRequests = 2;
  assert.equal(read().complete,false, 'a missing request cannot look fully measured');
  run.metrics.modelRequests = 1; run.modelCalls[0].status = 'error';
  assert.equal(read().complete,false); assert.equal(read().measuredRequests,0);
  run.modelCalls[0].status = 'ok'; run.metrics.usage = {...usage,inputTokens:200};
  assert.equal(read().complete,false, 'aggregate and receipts must agree');
  run.metrics.usage = usage; run.modelCalls[0].attempts = [{status:'error'}, {status:'ok'}];
  assert.equal(read().complete,false, 'unmetered retry work remains unknown');
});

test("cornerUsage reads the codex CLI's 'tokens used' tail and Claude's stream-json result", () => {
  const codex = cornerUsage("codex-sol", { armDir: null, rawLines: ["+ assert x", "tokens used", "16,416", "Implemented loganalyze.py"] });
  assert.deepEqual(codex, { source: "cli", totalTokens: 16416 });
  const claude = cornerUsage("claude-sonnet", { armDir: null, rawLines: [
    '{"type":"assistant","message":{"content":[]}}',
    '{"type":"result","subtype":"success","usage":{"input_tokens":12,"output_tokens":3400,"cache_read_input_tokens":90000,"cache_creation_input_tokens":2000},"num_turns":14}',
  ] });
  assert.deepEqual(claude, { source: "stream-json", inputTokens: 92012, outputTokens: 3400, cacheHitTokens: 90000, prefixReuse: 0.98, turns: 14 });
  assert.equal(cornerUsage("hermes", { armDir: null, rawLines: ["hello"] }), null);
});

test("the postmortem carries usage and the scoreboard renders it, injected before the verdicts", () => {
  const post = assemblePostmortem({ task: "t", startedAt: "s", results: [
    { arm: "bantam", wallMs: 44700, exitCode: 0, lines: 10, artifacts: [], usage: { source: "run.json", turns: 6, requests: 7, inputTokens: 50000, outputTokens: 1500, cacheHitTokens: 40000, prefixReuse: 0.8, pass: true, durationMs: 44000 } },
    { arm: "codex-sol", wallMs: 77900, exitCode: 0, lines: 20, artifacts: [], usage: { source: "cli", totalTokens: 16416 } },
  ] });
  assert.equal(post.corners[0].usage.turns, 6);
  const cmds = [{ name: "bantam", corner: "BANTAM", color: "#e0a458" }, { name: "codex-sol", corner: "CODEX", color: "#6aa0e0" }];
  const html = renderScoreboard(post, cmds, { verdicts: { bantam: { outcome: "WIN" } } });
  assert.match(html, /<table class="scoreboard">/);
  assert.match(html, /BANTAM[\s\S]*44\.7s[\s\S]*6 turns[\s\S]*50,000[\s\S]*1,500[\s\S]*80%/);
  assert.match(html, /CODEX[\s\S]*77\.9s[\s\S]*16,416 total/);
  assert.match(html, /WIN/);
  const card = "<html><body><div class=\"verdicts\">x</div></body></html>";
  const out = injectScoreboard(card, html);
  assert.ok(out.indexOf("scoreboard") < out.indexOf('<div class="verdicts">'));
});

test("a corner stopped by a provider limit is reported as out-of-budget, never as a model loss", (t) => {
  // Card 11 attempt 1 (2026-08-25): the spark corner exited 1 on turn 6 with
  // "You've hit your usage limit for GPT-5.3-Codex-Spark". A scoreboard that
  // shows only FAILED turns a quota wall into a quality verdict.
  const armDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fight-limit-"));
  t.after(() => fs.rmSync(armDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(armDir, "run.json"), JSON.stringify({
    metrics: { turns: 5, modelRequests: 6, usage: { inputTokens: 65343, outputTokens: 1660, cacheHitTokens: 62848 } },
    result: { pass: null, status: "unverified", reachedDone: false, modelFailure: { message: "model returned HTTP 500: {\"error\":{\"message\":\"You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 4:26 AM.\"}}" } },
  }));
  const u = cornerUsage("bantam-codexapi-spark", { armDir, rawLines: [] });
  assert.equal(u.stopped, "out-of-budget");
  assert.match(u.failure, /usage limit for GPT-5\.3-Codex-Spark/);
  const post = assemblePostmortem({ task: "t", startedAt: "s", results: [{ arm: "bantam-codexapi-spark", wallMs: 73800, exitCode: 1, lines: 5, artifacts: [], usage: u }] });
  const html = renderScoreboard(post, [{ name: "bantam-codexapi-spark", corner: "BANTAM+BRIDGE", color: "#f0c987" }], { verdicts: { "bantam-codexapi-spark": { outcome: "FAIL" } } });
  assert.match(html, /OUT-OF-BUDGET/);
  assert.match(html, /usage limit/);
});

test("artifacts are what the corner produced or changed, not the materials it was handed", (t) => {
  // Card 11: every corner reported "72 artifacts" — the copied package. The
  // interesting number is files new or changed against the materials.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fight-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const materials = path.join(root, "materials"); const ws = path.join(root, "ws");
  fs.mkdirSync(path.join(materials, "src"), { recursive: true });
  fs.writeFileSync(path.join(materials, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(materials, "README.md"), "# m\n");
  fs.cpSync(materials, ws, { recursive: true });
  const t0 = Date.now();
  fs.writeFileSync(path.join(ws, "src", "a.js"), "export const a = 2;\n");       // changed
  fs.writeFileSync(path.join(ws, "src", "b.js"), "export const b = 1;\n");       // new
  const arts = listArtifacts(ws, t0 - 1000, { materialsDir: materials });
  assert.deepEqual(arts.map((x) => x.path).sort(), ["src/a.js", "src/b.js"]);
});

import { judgeFight } from "../src/fight.js";

test("judgeFight judges a Node package by its own suite, not only pytest (card 11)", (t) => {
  // Card 11 was a Node/ESM package; judgeFight only ran pytest, so every green
  // corner came back PARTIAL "no test suite to judge by" while the sealed check
  // said EXACT. The mechanical judge must speak `node --test` too.
  const fightDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-judge-node-"));
  const materials = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-judge-node-m-"));
  t.after(() => { fs.rmSync(fightDir, { recursive: true, force: true }); fs.rmSync(materials, { recursive: true, force: true }); });
  const pkg = JSON.stringify({ name: "x", type: "module", scripts: { test: "node --test test/" } });
  fs.mkdirSync(path.join(materials, "test"), { recursive: true });
  fs.writeFileSync(path.join(materials, "package.json"), pkg);
  fs.writeFileSync(path.join(materials, "test", "a.test.js"), 'import test from "node:test"; import assert from "node:assert/strict"; import { f } from "../src/f.js"; test("f", () => assert.equal(f(), 2));\n');

  const mk = (arm, fSrc, mutateTest = false) => {
    const ws = path.join(fightDir, arm, "ws");
    fs.cpSync(materials, ws, { recursive: true });
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "f.js"), fSrc);
    if (mutateTest) fs.writeFileSync(path.join(ws, "test", "a.test.js"), 'import test from "node:test"; test("noop", () => {});\n');
  };
  mk("winner", "export const f = () => 2;\n");
  mk("loser", "export const f = () => 3;\n");
  mk("cheat", "export const f = () => 3;\n", true);
  const post = { corners: [
    { arm: "winner", wallMs: 1000, exitCode: 0, artifacts: [{ path: "src/f.js", bytes: 20 }] },
    { arm: "loser", wallMs: 1000, exitCode: 0, artifacts: [{ path: "src/f.js", bytes: 20 }] },
    { arm: "cheat", wallMs: 1000, exitCode: 0, artifacts: [{ path: "src/f.js", bytes: 20 }] },
  ] };
  const cmds = [{ name: "winner" }, { name: "loser" }, { name: "cheat" }];
  const v = judgeFight({ fightDir, cmds, post, materialsDir: materials });
  assert.equal(v.winner.outcome, "WIN", v.winner.reason);
  assert.match(v.winner.tests, /pass 1/);
  assert.equal(v.loser.outcome, "FAIL");
  assert.equal(v.cheat.outcome, "FAIL");
  assert.match(v.cheat.reason, /tampered/, "a rewritten provided test is tampering, in any language");
});

import { ARMS, startFight } from "../src/fight.js";

test("a corner's process sees PWD equal to its own workspace, not the driver's directory", async (t) => {
  // Card 12 (2026-08-25): opencode trusted $PWD over cwd, walked the BANTAM
  // repo instead of its fight workspace, and spent 486s concluding the task's
  // package "was never provided". spawn() sets cwd but inherits the parent's
  // stale PWD; the arena must repoint it.
  // The probe must be node: bash rewrites PWD to its cwd on startup, so a bash
  // probe passes with or without the fix (watched happen — a tautological test).
  ARMS.pwdprobe = { pool: "local", corner: "PROBE", sub: "pwd probe", color: "#fff",
    cmd: () => ({ exe: "node", args: ["-e", "console.log('PROBE_PWD=' + process.env.PWD)"] }) };
  t.after(() => { delete ARMS.pwdprobe; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-pwd-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const fight = startFight({ task: "t", arms: ["pwdprobe"], dir, port: 18631, narrate: false,
    onEvent: (e) => { if (e.kind === "line") seen.push(e.text); } });
  await fight.done;
  fight.stop();
  const probe = seen.find((l) => l.startsWith("PROBE_PWD="));
  assert.equal(probe, `PROBE_PWD=${path.join(dir, "pwdprobe", "ws")}`);
});
