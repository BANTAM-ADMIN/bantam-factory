import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import {
  authoredAltDescriptions,
  visualAltCoverageGap,
  visualAltCoverageHint,
} from "../src/visual-alt-coverage.js";

const observation = [
  "[view_image:codex] scene.png:",
  "- **Moon:** A large cream crescent in the upper-right.",
  "- **Birds:** Three orange origami birds cross the sky.",
  "- **Person:** A gardener holds seedlings.",
].join("\n");

test("visual alt coverage flags the demonstrated moon-and-birds omission", () => {
  const gap = visualAltCoverageGap({
    viewObservation: observation,
    source: '<img src="scene.png" alt="A gardener beside a glowing greenhouse over a city at night.">',
  });
  assert.deepEqual(gap?.missing, ["distinctive sky subject"]);
  assert.match(visualAltCoverageHint(gap), /saved view_image evidence/);
});

test("visual alt coverage accepts either grounded distinctive sky subject", () => {
  for (const alt of [
    "A gardener beside a greenhouse beneath a crescent moon.",
    "A rooftop greenhouse with three orange birds above it.",
  ]) {
    assert.equal(visualAltCoverageGap({
      viewObservation: observation,
      source: `<img src="scene.png" alt="${alt}">`,
    }), null);
  }
});

test("visual alt coverage stays silent without explicit evidence or authored alt", () => {
  assert.equal(visualAltCoverageGap({
    viewObservation: "A vague night scene.",
    source: '<img src="scene.png" alt="A rooftop at night.">',
  }), null);
  assert.equal(visualAltCoverageGap({
    viewObservation: observation,
    source: "<img src=\"scene.png\">",
  }), null);
  assert.deepEqual(
    authoredAltDescriptions("<img alt=' first  alt '><img alt=\"second\">"),
    ["first alt", "second"],
  );
});

test("agent wiring delivers the coverage hint on the first incomplete authored alt", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-alt-coverage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const outputs = [
    {
      a: "write_file",
      p: "index.html",
      content: '<img src="scene.png" alt="A gardener beside a greenhouse over a city at night.">',
    },
    {
      a: "replace",
      p: "index.html",
      old: "alt=\"A gardener beside a greenhouse over a city at night.\"",
      new: "alt=\"A gardener beside a greenhouse beneath a crescent moon.\"",
    },
    { a: "done", summary: "Built the page." },
  ];
  let call = 0;
  const model = {
    codex: false,
    endpoint: null,
    metadata: () => ({ runtime: "test", model: "scripted" }),
    async complete() {
      return {
        content: JSON.stringify(outputs[Math.min(call++, outputs.length - 1)]),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
  const result = await runAgent({
    task: "Use view_image on scene.png, then build index.html with an accurate image alt description.",
    workspace,
    model,
    maxTurns: 4,
    preGate: false,
    grounding: false,
    completionAudit: false,
    visualAltCoverage: true,
    resumeTurns: [{
      action: { a: "query", q: "view_image scene.png" },
      observation,
    }],
  });

  assert.equal(result.metrics.visualAltCoverageHints, 1);
  assert.equal(result.metrics.visualAltCoverageRevisions, 1);
  assert.match(result.turns[1].observation, /\[visual-alt-coverage\]/);
});
