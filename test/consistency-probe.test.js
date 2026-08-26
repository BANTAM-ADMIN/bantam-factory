import test from "node:test";
import assert from "node:assert";
import { sampleAnswers, stabilityReport, renderStabilityReport } from "../src/logic/consistency-probe.js";

test("known facts read STABLE: 5/5 agreement on one value", () => {
  const samples = Array.from({ length: 5 }, () => "TaskGroup was introduced in Python 3.11 for structured concurrency.");
  const r = stabilityReport(samples);
  const atom = r.atoms.find((a) => a.cls === "version" && a.anchor === "python");
  assert.equal(atom?.verdict, "STABLE");
  assert.equal(atom.agreement, 1);
  assert.equal(atom.topValue, "3.11");
  assert.equal(r.recommendResearch, false);
});

test("the q5k live result reads SCATTERED: 4 values in 5 samples", () => {
  // Verbatim shape of the 2026-08-18 live probe: temp-0 answered "13" at
  // 0.994 confidence; resampling revealed a guess.
  const samples = ["GGML_TYPE_Q5_K = 13.", "GGML_TYPE_Q5_K = 17.", "GGML_TYPE_Q5_K = 22.", "GGML_TYPE_Q5_K = 20.", "GGML_TYPE_Q5_K = 13."];
  const r = stabilityReport(samples);
  const atom = r.atoms.find((a) => a.anchor === "ggml_type_q5_k");
  assert.equal(atom?.verdict, "SCATTERED");
  assert.ok(r.recommendResearch);
  assert.ok(r.scattered.length === 1);
  const line = renderStabilityReport(r);
  assert.match(line, /SCATTERED/);
  assert.match(line, /:research/);
});

test("an atom absent from most samples stays unjudged — phrasing, not instability", () => {
  const samples = ["It was introduced in Python 3.11.", "The version history is long.", "Many releases shipped it.", "It arrived at some point.", "Docs cover this."];
  const r = stabilityReport(samples);
  assert.equal(r.atoms.length, 0);
  assert.match(renderStabilityReport(r), /inconclusive/);
});

test("sampleAnswers: k distinct-seed decodes, empties dropped, question in prompt", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return { json: async () => ({ content: calls.length === 2 ? "  " : `answer ${calls.length}` }) };
  };
  const out = await sampleAnswers({ endpoint: "http://x", question: "What is Q5_K?", k: 3, fetchImpl });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url === "http://x/completion"));
  assert.ok(calls[0].body.prompt.includes("What is Q5_K?"));
  assert.equal(new Set(calls.map((c) => c.body.seed)).size, 3);
  assert.ok(calls[0].body.temperature > 0, "probe must sample, not decode greedily");
  assert.deepEqual(out, ["answer 1", "answer 3"]);
});
