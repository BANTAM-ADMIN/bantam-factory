import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { formatNumericContractWitness, numericContractWitness } from "../src/logic/numeric-contract-witness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";

test("initial model context receives the witness once and events preserve its receipt", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-numeric-witness-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const prompts = [], events = [];
  await runAgent({ task: "Explain JavaScript safe integers.", workspace, maxTurns: 1,
    interactive: true, grounding: false, shellSandbox: "host", verificationPolicy: "after_edit",
    model: { assistantPrefill: "", async complete(prompt) {
      prompts.push(prompt);
      return { content: JSON.stringify({ a: "respond", text: "Safe integers have exact distinguishable adjacent integer values." }), tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: (event) => events.push(event),
  });
  assert.equal(prompts[0].split("[public-numeric-contract]").length - 1, 1);
  const receipts = events.filter((event) => event.type === "numeric_contract_witness");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].witness.candidateVerified, false);
});

test("grounds public safe-integer wording without inventing a callable API", () => {
  const task = "Node.js builtins only. Each entry has a nonnegative safe-integer\n`byteCount`. Invalid entries throw Error.";
  const witness = numericContractWitness(task);
  assert.equal(witness.scope, "language-semantics-only");
  assert.equal(witness.candidateVerified, false);
  assert.equal(witness.source.kind, "public-task");
  assert.equal(witness.source.sha256, createHash("sha256").update(task).digest("hex"));
  assert.deepEqual(witness.source.terms.map((term) => task.slice(term.start, term.end)), ["safe-integer"]);
  assert.deepEqual(witness.language, { name: "javascript", establishedBy: "public-task" });
  assert.equal(witness.runtime.node, process.version);
  assert.equal(witness.runtime.v8, process.versions.v8);
  assert.equal(Object.hasOwn(witness, "fn"), false);
  assert.equal(Object.hasOwn(witness, "status"), false);
});

test("records independently specified positive, fractional and unsafe boundaries", () => {
  const witness = numericContractWitness("JavaScript: accepts a safe integer.");
  assert.deepEqual(witness.observations.map(({ value, isInteger, isSafeInteger, isNonnegativeSafeInteger }) =>
    [value, isInteger, isSafeInteger, isNonnegativeSafeInteger]), [
    [0, true, true, true],
    [1.5, false, false, false],
    [9007199254740991, true, true, true],
    [9007199254740992, true, false, false],
    [9007199254740992, true, false, false],
    [-9007199254740991, true, true, false],
    [-9007199254740992, true, false, false],
  ]);
  assert.equal(witness.adjacentUnsafeValuesCollide, true);
  assert.equal(witness.observations.length, 7);
});

test("supports bounded public spelling variants and an independently supplied JS stack", () => {
  for (const phrase of ["safe integer", "safe-integer", "SAFE INTEGERS", "safe\ninteger"]) {
    const task = `Each count must be a ${phrase}.`;
    for (const language of ["javascript", "js", "node", "Node.js", "ecmascript"]) {
      const witness = numericContractWitness(task, { language });
      assert.equal(witness.language.establishedBy, "supplied-stack");
      assert.equal(witness.source.terms[0].text, phrase);
    }
  }
  assert.ok(numericContractWitness("Implement safe integers. Run node tool.mjs."));
});

test("does not fire for natural-language or non-JS tasks, unrelated integers or local negations", () => {
  for (const task of [
    "Keep each tree node size a safe integer.",
    "Python: require a safe integer.",
    "JavaScript: accepts a nonnegative integer.",
    "Node.js: do not require safe integers.",
    "Node.js: safe integers are not required.",
    "JavaScript: safe-integer validation is unnecessary.",
    "Node.js: implementation without enforcing safe integers.",
    "",
    null,
  ]) assert.equal(numericContractWitness(task), null, String(task));
  assert.equal(numericContractWitness("JavaScript safe integer example", { language: "python" }), null);
  assert.equal(formatNumericContractWitness(null), "");
});

test("skips negated clauses without dropping a later explicit public boundary", () => {
  const task = "Node.js: do not require safe integers for labels. The record count must be a safe-integer.";
  const witness = numericContractWitness(task);
  assert.deepEqual(witness.source.terms.map((term) => term.text), ["safe-integer"]);
});

test("receipt is reproducible, JSON serializable and bound to all public task bytes", () => {
  const task = "Node.js: the count is a safe integer.";
  const a = numericContractWitness(task);
  assert.deepEqual(a, numericContractWitness(task));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.notEqual(a.id, numericContractWitness(`${task}\n`).id);
  const { id, ...body } = a;
  assert.equal(id, `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`);
});

test("formats bounded evidence without promoting it to candidate correctness", () => {
  const witness = numericContractWitness("JavaScript: " + "safe integers. ".repeat(1000));
  const text = formatNumericContractWitness(witness);
  assert.equal(witness.source.terms.length, 3);
  assert.ok(text.length < 1400, text.length);
  assert.match(text, /NOT candidate verification/);
  assert.match(text, /Number\.isInteger\(9007199254740992\) = true/);
  assert.match(text, /Number\.isSafeInteger\(9007199254740992\) = false/);
  assert.match(text, /only where the public contract says nonnegative/);
  assert.match(text, /actual API and run project verification/);
  assert.doesNotMatch(text, /snapshot|manifest|grader|TypeError|all tests pass/i);
});
