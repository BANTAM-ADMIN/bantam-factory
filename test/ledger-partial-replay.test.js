import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// Measured across tb7, tb9 and tb10 (2026-08-16): 77-92% of all read ops were
// exact repeats or overlaps of ranges already delivered. tb7 alone issued 132
// read ops of which 87 were byte-identical repeats — while the whole-batch
// guards fired 9 times.
//
// The guards key on the WHOLE action. `inspect` is the dominant verb (25-32 of
// ~43 mid-run turns), and a batch mixing one new op with two repeats does not
// match any prior action, so all three run and two re-deliver bytes already in
// the prompt. The batch is the unit of dedup; the op is the unit of waste.

function workspaceWithFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-partial-ledger-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const name of ["a.js", "b.js", "c.js"]) {
    const body = Array.from({ length: 300 }, (_, i) => `const ${name[0]}${i} = ${i};`).join("\n");
    fs.writeFileSync(path.join(dir, "src", name), `${body}\n`);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedModel(actions) {
  const queue = [...actions];
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      const next = queue.shift() ?? { a: "done", summary: "out of script" };
      return { content: JSON.stringify(next), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

const read = (p, start, limit) => ({ a: "read_file", p, start, limit });

async function run(t, actions) {
  const workspace = workspaceWithFiles(t);
  return runAgent({
    task: "Inspect the sources.",
    workspace,
    model: scriptedModel(actions),
    maxTurns: actions.length + 2,
    interactive: true,
    useGrammar: false,
    grounding: false,
    shellSandbox: "host",
  });
}

describe("partial ledger replay", () => {
  it("runs only the ops the ledger does not already cover", async (t) => {
    const result = await run(t, [
      { a: "inspect", ops: [read("src/a.js", 1, 50), read("src/b.js", 1, 50)] },
      { a: "inspect", ops: [read("src/a.js", 1, 50), read("src/b.js", 1, 50), read("src/c.js", 1, 50)] },
      { a: "done", summary: "done" },
    ]);

    assert.equal(result.metrics.ledgerPartialReplays, 1);
    assert.equal(result.metrics.ledgerPartialOpsSkipped, 2);

    const second = String(result.turns[1].observation);
    assert.match(second, /\[ledger\] Skipped 2 read op\(s\)/);
    assert.match(second, /src\/a\.js 1-50, src\/b\.js 1-50/, "it names exactly what it skipped");
    assert.match(second, /const c0 = 0;/, "the new op still runs and delivers its bytes");
    const afterNote = second.split("[ledger]")[1] ?? "";
    assert.ok(!/const a0 = 0;/.test(afterNote), "the covered op's bytes are not re-delivered");
  });

  it("leaves a batch of entirely new ops alone", async (t) => {
    const result = await run(t, [
      { a: "inspect", ops: [read("src/a.js", 1, 50), read("src/b.js", 1, 50)] },
      { a: "inspect", ops: [read("src/a.js", 100, 50), read("src/c.js", 1, 50)] },
      { a: "done", summary: "done" },
    ]);
    assert.equal(result.metrics.ledgerPartialReplays, undefined,
      "nothing was already covered, so nothing is skipped");
    assert.match(String(result.turns[1].observation), /const a100 = 100;/);
  });

  it("does not touch a single-op inspect (the whole-batch guards own that)", async (t) => {
    const result = await run(t, [
      { a: "inspect", ops: [read("src/a.js", 1, 50)] },
      { a: "inspect", ops: [read("src/a.js", 1, 50)] },
      { a: "done", summary: "done" },
    ]);
    assert.equal(result.metrics.ledgerPartialReplays, undefined);
  });

  it("re-reads freely after an edit invalidates the ledger", async (t) => {
    // An edit makes prior reads stale: re-reading changed state is real work.
    const result = await run(t, [
      { a: "inspect", ops: [read("src/a.js", 1, 50), read("src/b.js", 1, 50)] },
      { a: "replace", p: "src/a.js", old: "const a0 = 0;", new: "const a0 = 99;" },
      { a: "inspect", ops: [read("src/a.js", 1, 50), read("src/b.js", 1, 50), read("src/c.js", 1, 50)] },
      { a: "done", summary: "done" },
    ]);
    const third = String(result.turns[2].observation);
    assert.match(third, /const a0 = 99;/, "the edited file must be re-delivered, not skipped");
  });

  it("recognizes a request window longer than the file", async (t) => {
    // The ledger records what was SHOWN. A read of lines 1-200 in a 150-line
    // file is answered "showing 1-150", so an identical later request computed
    // end=200, covers() said no, and the re-read ran again. Measured tb12
    // (2026-08-16, .bantam/runs/2026-08-16T20-03-47-692Z.json): 32 exact repeats
    // inside inspect batches, only 12 skipped — request space and shown space
    // disagreeing.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ledger-clamp-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src/short.js"),
      `${Array.from({ length: 150 }, (_, i) => `const s${i} = ${i};`).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(workspace, "src/other.js"),
      `${Array.from({ length: 400 }, (_, i) => `const o${i} = ${i};`).join("\n")}\n`,
    );

    const result = await runAgent({
      task: "Inspect the sources.",
      workspace,
      model: scriptedModel([
        { a: "inspect", ops: [read("src/short.js", 1, 200), read("src/other.js", 1, 50)] },
        { a: "inspect", ops: [read("src/short.js", 1, 200), read("src/other.js", 1, 50), read("src/other.js", 200, 50)] },
        { a: "done", summary: "done" },
      ]),
      maxTurns: 5,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    assert.equal(result.metrics.ledgerPartialOpsSkipped, 2,
      "the over-length request is covered by the recorded 1-150, and must be skipped");
    assert.match(String(result.turns[1].observation), /src\/short\.js 1-200/);
  });

  it("records every op when one batch reads the same file at several ranges", async (t) => {
    // Parsing the observation keyed on the PATH, and an inspect commonly reads
    // one file at several windows — so every op matched the first header and
    // the ledger recorded that one range repeatedly, never learning the others.
    // Clipping compounded it: with three ops the third header fell outside the
    // 4,000-char observation entirely. tb13 turn 9 read src/agent.js at 294,
    // 2380 and 2820; turn 10 re-read 2820
    // (.bantam/runs/2026-08-16T20-40-12-127Z.json — 84 of 86 within-epoch
    // repeats were multi-op inspects, 85 of them this one file).
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ledger-samefile-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    // 600 lines, not 5,667: the skip now requires the packet to actually render
    // the range, and no panel holds a 5,667-line file. The three ops still make
    // the observation long enough to clip past the third header, which is the
    // parsing hazard under test.
    fs.writeFileSync(
      path.join(workspace, "src/agent.js"),
      `${Array.from({ length: 600 }, (_, i) => `const g${i} = ${i};`).join("\n")}\n`,
    );

    const result = await runAgent({
      task: "Inspect the giant.",
      workspace,
      model: scriptedModel([
        { a: "inspect", ops: [read("src/agent.js", 40, 120), read("src/agent.js", 300, 40), read("src/agent.js", 420, 40)] },
        { a: "inspect", ops: [read("src/agent.js", 300, 60), read("src/agent.js", 420, 40)] },
        { a: "done", summary: "done" },
      ]),
      maxTurns: 5,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    assert.equal(result.metrics.ledgerPartialOpsSkipped, 1,
      "420-459 was delivered on the previous turn and is rendered, so it must be skipped");
    assert.match(String(result.turns[1].observation), /src\/agent\.js 420-459/);
    assert.match(String(result.turns[1].observation), /showing 300-359/,
      "300-359 reaches past what was read and must still run");
  });
});

describe("the ledger only withholds bytes the prompt actually carries", () => {
  it("serves a deep range in a file the panel cannot hold", async (t) => {
    // The ledger reasons about RANGES; residency was asked of the FILE. On a
    // 5,853-line src/agent.js the packet holds a slice, so "the file is in the
    // panel" was true while the wanted lines were nowhere in the prompt.
    //
    // Measured across the stored runs: 330 of 460 ledger-refused read ops
    // (71.7%) named a range in neither packet nor history. tb25 (2026-08-17)
    // asked for src/agent.js 5485-5544 five times, was refused every time with
    // "those bytes are already in this prompt", and never received them. It hit
    // the 60-turn cap with a green tree and no `done`.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ledger-deep-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src/huge.js"),
      `${Array.from({ length: 5800 }, (_, i) => `const h${i} = ${i};`).join("\n")}\n`,
    );
    fs.writeFileSync(path.join(workspace, "src/small.js"), "const s = 1;\n");

    const result = await runAgent({
      task: "Inspect the giant.",
      workspace,
      // tb25's shape: read the deep range, read a DIFFERENT range of the same
      // file (which supersedes the first observation in history), then ask for
      // the deep one again. An immediate repeat is a different case — there the
      // first read IS the newest and its bytes are genuinely still in history,
      // so refusing it is right.
      model: scriptedModel([
        { a: "inspect", ops: [read("src/huge.js", 5485, 60), read("src/small.js", 1, 5)] },
        { a: "inspect", ops: [read("src/huge.js", 100, 60), read("src/small.js", 1, 5)] },
        { a: "inspect", ops: [read("src/huge.js", 5485, 60), read("src/small.js", 1, 5)] },
        { a: "done", summary: "done" },
      ]),
      maxTurns: 6,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    const second = String(result.turns[2].observation);
    assert.match(second, /const h5484 = 5484;/,
      "the deep range is not in the packet, so the re-read must be served");
    assert.doesNotMatch(second, /Skipped .* src\/huge\.js 5485-5544/,
      "and must not be withheld as already present");
  });
});
