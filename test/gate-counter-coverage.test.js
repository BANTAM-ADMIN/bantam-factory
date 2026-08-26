import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { GATE_REJECTION_METRICS, OPT_IN_GATE_ENV } from "../src/logic/gate-rejection-counts.js";

// Every gate the agent counts must be visible to experiments.
//
// gate-rejection-counts.js says why in its own header: experiments need one
// mergeable map "so a pass-rate delta cannot be mistaken for an intervention that
// never happened." Two gates were missing from it -- lexical_smoke and
// type_contract -- while being counted by the agent and written into artifacts.
//
// That was found the hard way. Measuring type_contract against Codex on 2026-08-01
// turned a 0/3 hidden-contract failure into 3/3, and the experiment-facing view had
// no counter to attribute the win to. The evidence was in the artifacts (one fire
// on each passing run, zero on each failing one) and invisible in the aggregate --
// a mechanism that works but cannot be shown to work is indistinguishable from luck.
//
// Derived from source rather than hard-coded, so adding a gate to the agent without
// a counter fails here instead of silently producing unattributable A/B results.

const agentSource = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");

function gatesTheAgentCounts() {
  const start = agentSource.indexOf("  empty_done:");
  assert.ok(start > 0, "could not locate the agent's gate->metric map");
  const end = agentSource.indexOf("};", start);
  const block = agentSource.slice(start, end);
  return [...block.matchAll(/^\s*(\w+):\s*"(\w+)"/gm)].map((m) => ({ gate: m[1], metric: m[2] }));
}

describe("gate rejection counters", () => {
  it("exposes every gate the agent counts to the experiment aggregate", () => {
    const missing = gatesTheAgentCounts()
      .filter(({ metric }) => !Object.hasOwn(GATE_REJECTION_METRICS, metric))
      .map(({ gate }) => gate);
    assert.deepEqual(missing, [],
      `gates counted by the agent but invisible to experiments: ${missing.join(", ")}`);
  });

  it("maps each metric to the gate id the agent uses for it", () => {
    for (const { gate, metric } of gatesTheAgentCounts()) {
      if (!Object.hasOwn(GATE_REJECTION_METRICS, metric)) continue;
      assert.equal(GATE_REJECTION_METRICS[metric], gate,
        `${metric} is reported as "${GATE_REJECTION_METRICS[metric]}" but the agent calls it "${gate}"`);
    }
  });

  // An opt-in gate whose env var is unrecorded produces an arm that cannot say
  // what it enabled.
  it("records the opt-in env var for the gates measured on Codex", () => {
    assert.equal(OPT_IN_GATE_ENV.BANTAM_TYPE_CONTRACT_GATE, "type_contract");
  });
});
