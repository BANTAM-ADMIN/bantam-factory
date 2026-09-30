import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { createExecCell, decideJevAdaptive, execGaugeChoice, findPythonCall } from "../src/factory.js";

const dockerReady = spawnSync("docker", ["image", "inspect", "bantam/exec-cell:1"], { stdio: "ignore" }).status === 0;

describe("factory execution gauge", () => {
  it("finds a function and its call arguments in structured material", () => {
    assert.deepEqual(findPythonCall({ code: "def f(a, b):\n    return a + b", input: "1, 2" }), { code: "def f(a, b):\n    return a + b", call: "f(1, 2)" });
    assert.equal(findPythonCall({ code: "def helper(x):\n    return x\ndef main(s):\n    return helper(s)", args: "'q'" }).call, "main('q')", "the last top-level function is the entry point");
    assert.equal(findPythonCall({ code: "print(1)", input: "1" }), null, "no function, no call");
    assert.equal(findPythonCall({ code: "def f(x): return x" }), null, "no arguments, no call");
    assert.equal(findPythonCall("def f(x): return x"), null, "plain-text material is not parsed");
  });

  it("releases only when exactly one candidate equals the value", async () => {
    const cell = { run: async ({ candidates }) => ({ ok: true, value: "'ab'", matches: candidates.flatMap((c, i) => (c === "'ab'" ? [i] : [])) }) };
    const state = { code: "def f(s):\n    return s", input: "'ab'" };
    assert.equal((await execGaugeChoice(cell, state, ["'ba'", "'ab'"])).index, 1);
    assert.equal((await execGaugeChoice(cell, state, ["'ab'", "'ab'"])).index, -1, "two equal candidates is no release");
    assert.equal((await execGaugeChoice(cell, state, ["'x'", "'y'"])).index, -1);
    assert.deepEqual(await execGaugeChoice(cell, { note: "no code" }, ["'x'"]), { index: -1, applies: false });
  });

  it("adaptive: an execution release answers without any model read", async () => {
    const reader = { compileLabels: async () => { throw new Error("the model must not be asked"); } };
    const execCell = { run: async () => ({ ok: true, value: "'aa___bb'", matches: [1] }) };
    const { answers, evidence } = await decideJevAdaptive({
      reader, pool: [], execCell,
      state: { code: "def f(t):\n    return t", input: "'x'" },
      questions: { answer: { type: "choice", criteria: { option_0: "'aa+++bb'", option_1: "'aa___bb'" } } },
    });
    assert.equal(answers.answer.choice, "option_1");
    assert.deepEqual(evidence.answer, [{ step: "exec", value: "'aa___bb'" }]);
  });

  it("runs calls in a sealed cell: exact values, typed literal matching, no network, no writes, bounded time", { skip: !dockerReady && "bantam/exec-cell:1 image not present (docker build -t bantam/exec-cell:1 docker/exec-cell)" }, async () => {
    const cell = createExecCell();
    try {
      const rsplit = await cell.run({ code: "def f(text, sep, num):\n    return '___'.join(text.rsplit(sep, num))", call: "f('aa+++bb', '+', 1)", candidates: ["'aa___bb'", "'aa++___bb'"] });
      assert.deepEqual([rsplit.ok, rsplit.matches], [true, [1]]);
      const typed = await cell.run({ code: "def f():\n    return (1, 2)", call: "f()", candidates: ["[1, 2]", "(1, 2)"] });
      assert.deepEqual(typed.matches, [1], "a tuple is not a list");
      const net = await cell.run({ code: "def f():\n    import socket\n    socket.create_connection(('1.1.1.1', 80), timeout=1)\n    return 'reached'", call: "f()" });
      assert.equal(net.ok, false, "the network is unreachable");
      const write = await cell.run({ code: "def f():\n    open('/tmp/x', 'w').write('x')\n    return 'wrote'", call: "f()" });
      assert.equal(write.ok, false, "the filesystem is read-only");
      const spin = await cell.run({ code: "def f():\n    while True: pass", call: "f()" });
      assert.equal(spin.ok, false, "a runaway call is killed");
      const after = await cell.run({ code: "def f():\n    return 3", call: "f()", candidates: ["3"] });
      assert.deepEqual(after.matches, [0], "the cell keeps serving after a killed job");
    } finally {
      cell.close();
    }
  });
});
