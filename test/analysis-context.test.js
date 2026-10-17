import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Executor } from "../src/executor.js";
import { buildPrompt } from "../src/prompt.js";
import { budgetTurns } from "../src/history-budget.js";
import { runAgent } from "../src/agent.js";
import { ADVISORY_EXCLUDED_ACTIONS } from "../src/task-intent.js";

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-analysis-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("analysis delivers complete requested source ranges and batched reads through the model prompt", t => {
  const dir = workspace(t);
  const source = Array.from({ length: 500 }, (_, i) => `export const field${i} = ${JSON.stringify("x".repeat(90))};`).join("\n");
  fs.writeFileSync(path.join(dir, "source.js"), source);
  const action = { a: "inspect", ops: [{ a: "read_file", p: "source.js", start: 1, limit: 500 }] };
  const executor = new Executor(dir, { fullReadContext: true });
  const observation = executor.inspect(action);
  const defaultPage = executor.readFile({ p: "source.js" });
  assert.match(defaultPage, /showing 1-160/);
  assert.doesNotMatch(defaultPage, /161\texport/);
  assert.ok(observation.length > 24000);
  assert.ok(observation.includes("500\texport const field499"));
  assert.doesNotMatch(observation, /clipped ops|chars clipped|next unread line/);
  const turn = { i: 0, action, observation };
  const prompt = buildPrompt({ task: "Inspect source", env: "", turns: [turn], fullReadContext: true });
  assert.ok(prompt.includes(observation));
  const next = { i: 1, action: { a: "respond", text: "Finished" }, observation: "" };
  assert.deepEqual(budgetTurns([turn, next], { charBudget: 5000, fullReadContext: true }).map(t => t.i), [1]);
});

test("unattended analysis rejects mutation/shell actions and accepts an evidence answer", async t => {
  const dir = workspace(t);
  const outputs = [
    { a: "shell", c: "touch forbidden.txt" },
    { a: "write_file", p: "forbidden.txt", content: "bad" },
    { a: "respond", text: "The source observation is the requested deliverable." },
  ];
  const model = { assistantPrefill: "", actTemperature: null, prompts: [],
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: JSON.stringify(outputs.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } };
  const result = await runAgent({ task: "Inspect this source and report findings, without edits.",
    workspace: dir, model, maxTurns: 4, interactive: false, advisoryMode: true,
    fullReadContext: true, excludeActions: ADVISORY_EXCLUDED_ACTIONS.filter(v => v !== "rea_tool"),
    grounding: false, useGrammar: false, progressAwareness: false, verificationPolicy: "after_edit" });
  assert.equal(result.responded, true);
  assert.equal(result.reachedDone, true);
  assert.equal(result.metrics.implementationRespondRejections, 0);
  assert.equal(result.metrics.workspaceChanged, false);
  assert.equal(fs.existsSync(path.join(dir, "forbidden.txt")), false);
  assert.ok(model.prompts.some(p => /excluded|not (?:allowed|available)|disabled/i.test(p)));
});

test("context overflow does not resend an unchanged oversized prompt", async t => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "source.js"), "export const value = 1;\n");
  let calls = 0;
  const model = { assistantPrefill: "", actTemperature: null,
    async complete() {
      if (++calls === 1) return { content: JSON.stringify({ a: "read_file", p: "source.js" }), tokens: 1, stoppedEos: true, timings: {} };
      throw Object.assign(new Error("request exceeds context size"), { code: "context_overflow" });
    } };
  const result = await runAgent({ task: "Inspect source.js", workspace: dir, model, maxTurns: 2,
    interactive: false, advisoryMode: true, fullReadContext: true,
    excludeActions: ADVISORY_EXCLUDED_ACTIONS, grounding: false, useGrammar: false,
    progressAwareness: false, thinkMode: "off" });
  assert.equal(result.reachedDone, false);
  assert.ok(calls <= 3, `unchanged rejected prompt was sent ${calls - 1} times`);
  assert.match(result.modelFailure.message, /exceeds context/);
});

test("text reads reject binary inputs without inventing byte evidence", t => {
 const dir=workspace(t), ex=new Executor(dir);
 fs.writeFileSync(path.join(dir,"rom.smc"),Buffer.from([2,254,194,16,0,32,255]));
 const message=ex.readFile({p:"rom.smc"});
 assert.match(message,/contains binary bytes.*UTF-8 text tool/);
 assert.match(message,/0x00 at byte 4/);
 assert.doesNotMatch(message,/Use rea_tools/);
 fs.writeFileSync(path.join(dir,"ordinary.txt"),"hello\nworld\n");
 assert.match(ex.readFile({p:"ordinary.txt"}),/hello/);
});

test("binary-read advice names only the byte routes this run has", t => {
 const dir=workspace(t);
 fs.writeFileSync(path.join(dir,"rom.smc"),Buffer.from([2,254,194,16,0,32,255]));
 const advice=opts=>new Executor(dir,opts).readFile({p:"rom.smc"});
 const analysis=advice({shellAvailable:false,reaMcpDiscover:()=>""});
 assert.match(analysis,/Use rea_tools/);assert.match(analysis,/shell is not available/);assert.doesNotMatch(analysis,/xxd/);
 assert.match(advice({reaMcpDiscover:()=>""}),/Use rea_tools.*xxd/);
 assert.match(advice({shellAvailable:false}),/No byte-level tool is available/);
});

test('full-context coding preserves shell output through execution and model replay', async t => {
 const dir=workspace(t),ex=new Executor(dir,{fullReadContext:true,shellSandbox:'host'});
 const payload='A'.repeat(12000)+'MIDDLE_EVIDENCE'+'Z'.repeat(12000);
 const action={a:'shell',c:`node -e 'process.stdout.write(${JSON.stringify(payload)})'`};
 const result=await ex.execute(action);
 assert.ok(result.observation.includes(payload),'executor must preserve stdout, including middle evidence');
 const turn={i:0,action,observation:result.observation};
 assert.equal(budgetTurns([turn],{charBudget:5000,fullReadContext:true})[0].observation,result.observation);
 const prompt=buildPrompt({task:'Implement and verify',env:'',turns:[turn],fullReadContext:true});
 assert.ok(prompt.includes(payload),'model must receive the complete executed output');
});
