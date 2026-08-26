import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";
import { trimSiteList } from "../src/edit-context.js";

// 34 of 42 stored runs issued ZERO `query` actions, and 332 of 1,464 search ops
// (23%) were the third-or-later search for the SAME bare identifier in one run.
// One run made 81 searches, 37 against a single file. tb26 searched
// `impossibleScope` six times — a symbol it had introduced itself two turns
// earlier, whose definition and call sites `defines`/`uses` return in one turn.
//
// The KB is built at startup and advertised in the menu. This says so at the
// point the model is demonstrably not using it.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-symbol-search-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "src/a.js"), "export function widgetHandler() { return 1; }\n");
  fs.writeFileSync(path.join(dir, "src/b.js"), 'import { widgetHandler } from "./a.js";\nexport const run = () => widgetHandler();\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const act = (o) => JSON.stringify(o);
const model = (script) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: script.shift() ?? act({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});
const hints = (r) => r.turns.filter((t) => /\[capability\] That is your \d+rd search for/.test(String(t.observation ?? ""))).length;

const run = (dir, script, grounding) => runAgent({
  task: "Find where widgetHandler lives.",
  workspace: dir,
  model: model(script),
  maxTurns: script.length + 2,
  interactive: true,
  useGrammar: false,
  grounding,
  shellSandbox: "host",
});

describe("searching the same symbol repeatedly", () => {
  it("counts search ops inside an inspect batch", async (t) => {
    // 1,324 of the corpus's 1,466 search ops are inspect sub-ops, and one batch
    // routinely repeats an identifier twice inside itself. Counting only
    // top-level `search` actions would miss nearly every real case — tb27
    // searched `impossibleEditableScope` seven times, all of them inspect ops,
    // and the first version of this steer stayed silent throughout.
    const dir = workspace(t);
    const batch = act({ a: "inspect", ops: [
      { a: "search", q: "widgetHandler", p: "src" },
      { a: "search", q: "widgetHandler", p: "src/b.js" },
    ] });
    const result = await run(dir, [batch, batch], true);
    assert.equal(hints(result), 1, "the third op across two batches must trip it, once");
  });

  it("names the KB verbs on the third search, once", async (t) => {
    const dir = workspace(t);
    const script = Array.from({ length: 5 }, () => act({ a: "search", q: "widgetHandler", p: "src" }));
    const result = await run(dir, script, true);
    assert.equal(hints(result), 1, "once per identifier, not on every later search");
    const note = result.turns.map((x) => String(x.observation ?? "")).find((o) => /\[capability\]/.test(o));
    assert.match(note, /query defines widgetHandler/);
    assert.match(note, /query uses widgetHandler/);
    // It carries the answer, not only the way to ask for it.
    assert.match(note, /src\/a\.js:1/);
  });

  it("stays quiet for the first two", async (t) => {
    const dir = workspace(t);
    const result = await run(dir, [act({ a: "search", q: "widgetHandler", p: "src" }), act({ a: "search", q: "widgetHandler", p: "src" })], true);
    assert.equal(hints(result), 0);
  });

  it("does not fire for a regex, which the KB cannot answer", async (t) => {
    // `defines`/`uses` take a bare identifier. Pointing at them for a pattern
    // search would be advice that does not work.
    const dir = workspace(t);
    const script = Array.from({ length: 4 }, () => act({ a: "search", q: "widget.*Handler\\(", p: "src" }));
    assert.equal(hints(await run(dir, script, true)), 0);
  });

  it("stays quiet when there is no KB to point at", async (t) => {
    const dir = workspace(t);
    const script = Array.from({ length: 4 }, () => act({ a: "search", q: "widgetHandler", p: "src" }));
    assert.equal(hints(await run(dir, script, false)), 0, "advice to run a query is worse than silence with no query tool");
  });
});

describe("the steer delivers the answer rather than prescribing an action", () => {
  it("carries the definition site into the observation", async (t) => {
    // Advice costs a turn to act on, and `query` is the one read-only action
    // `inspect` cannot batch — three searches cost one turn, one query costs
    // one. ta4 ran ticket A for 48 turns on the improved query menu example and
    // issued zero query actions. Nothing in the harness consumes `defines` or
    // `uses` internally either (src/agent.js:2523 is the only caller), so a KB
    // answer the model never asks for is an answer that never arrives.
    //
    // The steer already knows the symbol and already holds the tool registry.
    // Delivering costs the model nothing.
    const dir = workspace(t);
    const one = act({ a: "search", q: "widgetHandler", p: "src" });
    const r = await run(dir, [one, one, one], true);
    const steered = r.turns.map((x) => String(x.observation ?? "")).filter((o) => /\[capability\]/.test(o));
    assert.equal(steered.length, 1, "one steer");
    assert.match(
      steered[0],
      /src\/a\.js:1/,
      `the definition site belongs in the observation, not behind an action; got: ${steered[0]}`,
    );
  });

  it("delivers absence too, because absence is the answer", async (t) => {
    // tb27 searched `impossibleEditableScope` seven times — a name it had
    // invented, checking whether it was already taken. Nothing settled it. The
    // KB can settle it outright, and that is worth more than the hit case:
    // 12 of the 33 identifiers this steer targets are names that occur nowhere.
    const dir = workspace(t);
    const one = act({ a: "search", q: "notAThingAnywhere", p: "src" });
    const r = await run(dir, [one, one, one], true);
    const steered = r.turns.map((x) => String(x.observation ?? "")).filter((o) => /\[capability\]/.test(o));
    assert.equal(steered.length, 1, "one steer");
    assert.match(steered[0], /does not appear in any of the \d+ file/, `got: ${steered[0]}`);
  });
});

describe("what the delivery costs the prompt", () => {
  it("keeps the count and the first sites, not all sixty", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/f${i}.js:${i + 1}`).join(", ");
    const line = `"widgetHandler" is used at 40 site(s) (defined at src/a.js:1) — 30 in source, 10 in tests: ${many}.`;
    const out = trimSiteList(line, "widgetHandler");
    assert.match(out, /is used at 40 site\(s\)/, "the count is the part that reframes the task");
    assert.match(out, /src\/f0\.js:1/, "the first sites are where to start");
    assert.doesNotMatch(out, /src\/f39\.js/, "the tail is one query away");
    assert.match(out, /\+34 more/);
    assert.ok(out.length < line.length / 2, `should be well under half: ${out.length} vs ${line.length}`);
  });

  it("leaves a short answer exactly as it is", () => {
    const line = '"widgetHandler" is used at 1 site(s) (defined at src/a.js:1): src/b.js:2.';
    assert.equal(trimSiteList(line, "widgetHandler"), line);
  });
});
