import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArmCommand, parseClaudeStreamLine, sseFrame, assemblePostmortem, startFight, ARMS } from "../src/fight.js";

test("every registered arm builds a runnable command with the task embedded", () => {
  for (const name of Object.keys(ARMS)) {
    const c = buildArmCommand(name, { task: "build the thing" });
    assert.ok(c.exe, name);
    const all = [...c.args, c.stdinText ?? ""].join(" ");
    assert.match(all, /build the thing/, `${name} carries the task`);
  }
  assert.throws(() => buildArmCommand("rooster-zero", { task: "x" }), /unknown arm/);
});

test("bantam and hermes corners share the same local endpoint — the direct comparison", () => {
  const b = buildArmCommand("bantam", { task: "t" });
  const h = buildArmCommand("hermes", { task: "t" });
  assert.match(b.env.BANTAM_ENDPOINT, /127\.0\.0\.1:8085/);
  assert.ok(/[\/\\](arenas[\/\\]hermes|HERMES_ARENA)[\/\\]/.test(h.env.HERMES_HOME + "/"), "hermes runs from its isolated arena home");
});

test("claude stream-json lines render as text and tool calls; plumbing hides", () => {
  assert.equal(parseClaudeStreamLine(JSON.stringify({ type: "system", subtype: "init" })), null);
  const a = parseClaudeStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }));
  assert.match(a, /hello/);
  assert.match(a, /⏵ Bash/);
  assert.match(parseClaudeStreamLine("not json at all"), /not json at all/);
});

test("SSE frames and the postmortem shape", () => {
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
  const post = assemblePostmortem({ task: "t", startedAt: "x", results: [{ arm: "bantam", wallMs: 5000, exitCode: 0, lines: 12, artifacts: [{ path: "a.txt", bytes: 3 }] }] });
  assert.equal(post.corners[0].artifacts[0].path, "a.txt");
  assert.ok(post.finishedAt);
});

test("a live fight with stub arms streams lines, records artifacts, and ends", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fight-t-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // stub arm: a shell that echoes and writes an artifact
  ARMS["stub-a"] = { corner: "A", sub: "stub", color: "#fff", cmd: () => ({ exe: "bash", args: ["-c", "echo round one; echo made > out.txt"] }) };
  ARMS["stub-b"] = { corner: "B", sub: "stub", color: "#fff", cmd: () => ({ exe: "bash", args: ["-c", "echo swing; exit 3"] }) };
  t.after(() => { delete ARMS["stub-a"]; delete ARMS["stub-b"]; });
  const events = [];
  const f = startFight({ task: "spar", arms: ["stub-a", "stub-b"], dir, port: 18461, narrate: false, onEvent: (e) => events.push(e) });
  const post = await f.done;
  f.stop();
  assert.equal(post.corners.length, 2);
  const a = post.corners.find((c) => c.arm === "stub-a");
  const b = post.corners.find((c) => c.arm === "stub-b");
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 3, "losses are recorded, not hidden");
  assert.deepEqual(a.artifacts.map((x) => x.path), ["out.txt"]);
  assert.ok(events.some((e) => e.kind === "line" && e.text === "round one"));
  assert.ok(events.some((e) => e.kind === "over"));
  assert.ok(fs.existsSync(path.join(dir, "fight.json")));
});

test("local corners fight one at a time; cloud corners overlap", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fight-s-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = (pool, ms) => ({ corner: "x", sub: "stub", color: "#fff", pool,
    cmd: () => ({ exe: "bash", args: ["-c", `echo start $(date +%s%3N); sleep ${ms / 1000}; echo end $(date +%s%3N)`] }) });
  ARMS["l1"] = mk("local", 300); ARMS["l2"] = mk("local", 300);
  ARMS["c1"] = mk("cloud", 300); ARMS["c2"] = mk("cloud", 300);
  t.after(() => { for (const k of ["l1", "l2", "c1", "c2"]) delete ARMS[k]; });
  const spans = {};
  const f = startFight({ task: "t", arms: ["l1", "l2", "c1", "c2"], dir, port: 18462, narrate: false, onEvent: (e) => {
    if (e.kind === "line" && /^(start|end) \d+$/.test(e.text)) {
      const [w, ts] = e.text.split(" ");
      (spans[e.arm] ??= {})[w] = Number(ts);
    }
  } });
  await f.done; f.stop();
  assert.ok(spans.l2.start >= spans.l1.end - 50, "l2 enters the ring only after l1 leaves");
  assert.ok(spans.c2.start < spans.c1.end, "cloud corners overlap");
});

test("the fight brief carries the conversation and the same bytes for all", async () => {
  const { composeFightBrief } = await import("../src/fight.js");
  const brief = composeFightBrief({ sessionLog: [{ request: "build the parser", summary: "landed, tests green" }], request: "now optimize it" });
  assert.match(brief, /CONTEXT — prior work/);
  assert.match(brief, /build the parser/);
  assert.match(brief, /TASK: now optimize it/);
  assert.equal(composeFightBrief({ request: "solo" }), "TASK: solo");
});

test("the finished object: one static file with transcripts and a working zip", async (t) => {
  const { finalizeFightCard } = await import("../src/fight.js");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fight-f-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, "stub", "ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "built.py"), "print('hi')\n");
  const cmds = [{ name: "stub", corner: "STUB", sub: "s", color: "#fff" }];
  const history = [ 'data: {"arm":"stub","kind":"line","text":"round one"}\n\n' ];
  const post = { startedAt: "2026-08-19T00:00:00Z", finishedAt: "2026-08-19T00:01:00Z",
    corners: [{ arm: "stub", wallMs: 60000, exitCode: 0, lines: 1, artifacts: [{ path: "built.py", bytes: 12 }] }] };
  const card = finalizeFightCard({ fightDir: dir, task: "the task", cmds, history, post });
  const html = fs.readFileSync(card, "utf8");
  assert.match(html, /round one/, "transcript embedded");
  assert.match(html, /FIGHT CARD/);
  assert.match(html, /scrappy little terminal agent/);
  assert.match(html, /data:application\/zip;base64,/, "zip embedded as data URI");
  // the embedded zip is REAL: decode and list it
  const b64 = html.match(/base64,([A-Za-z0-9+/=]+)"/)[1];
  const zpath = path.join(dir, "roundtrip.zip");
  fs.writeFileSync(zpath, Buffer.from(b64, "base64"));
  const listing = execFileSync("python3", ["-m", "zipfile", "-l", zpath], { encoding: "utf8" });
  assert.match(listing, /built\.py/, "workspace file inside the zip");
});

test("the judge trusts nothing: reruns suites, catches tampering", async (t) => {
  const { judgeFight } = await import("../src/fight.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const materials = path.join(dir, "materials");
  fs.mkdirSync(materials);
  fs.writeFileSync(path.join(materials, "test_x.py"), "def test_a():\n    assert x() == 1\n");
  const mk = (name, body, testBody) => {
    const ws = path.join(dir, name, "ws");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "x.py"), body);
    fs.writeFileSync(path.join(ws, "test_x.py"), testBody);
    fs.writeFileSync(path.join(ws, "conftest.py"), "import sys, os\nsys.path.insert(0, os.path.dirname(__file__))\n");
  };
  mk("winner", "def x():\n    return 1\n", "from x import x\ndef test_a():\n    assert x() == 1\n");
  mk("loser", "def x():\n    return 2\n", "from x import x\ndef test_a():\n    assert x() == 1\n");
  const post = { corners: [
    { arm: "winner", exitCode: 0, wallMs: 1000, artifacts: [{ path: "x.py", bytes: 1 }] },
    { arm: "loser", exitCode: 0, wallMs: 1000, artifacts: [{ path: "x.py", bytes: 1 }] }] };
  const cmds = [{ name: "winner" }, { name: "loser" }];
  const v = judgeFight({ fightDir: dir, cmds, post });
  assert.equal(v.winner.outcome, "WIN");
  assert.equal(v.loser.outcome, "FAIL");
  // tamper: both corners changed the provided test file relative to materials
  const v2 = judgeFight({ fightDir: dir, cmds, post, materialsDir: materials });
  assert.equal(v2.winner.outcome, "FAIL");
  assert.match(v2.winner.reason, /tampered/);
});

test("the reporter narrates with injected calls; verdicts pass through untouched", async () => {
  const { narratePostmortem } = await import("../src/fight.js");
  const calls = [];
  const n = await narratePostmortem({
    task: "t", cmds: [{ name: "a", corner: "A" }], post: {},
    verdicts: { a: { outcome: "WIN", reason: "5 passed" } },
    laneText: { a: "did things" },
    callModel: async (p) => { calls.push(p); return "a fine showing"; },
  });
  assert.equal(n.accounts.a, "a fine showing");
  assert.equal(n.overall, "a fine showing");
  assert.match(calls[0], /verdict: WIN/);
  assert.match(calls[0], /Do not re-judge/);
});
