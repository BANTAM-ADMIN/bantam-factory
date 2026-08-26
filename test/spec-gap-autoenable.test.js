import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deliveryFor, BLOCK, OFF, WARN, defaultPolicy } from "../src/gate-policy.js";
import { workspaceExports } from "../src/logic/workspace-exports.js";

// The type_contract gate now follows the detector instead of a standing flag.
//
// It is worth ~2x turns only where it converts: measured n=3 per arm on
// gpt-5.6-terra, channel-filter went 0/3 -> 3/3 on the hidden contract with the
// gate on, and the seven fixtures whose tasks already state their contracts scored
// identically with and without it. A gate that costs turns everywhere and pays on
// one task in eight has to know which task it is on.

const noFlags = defaultPolicy({});

describe("type_contract follows the spec gap", () => {
  it("stays off when the task states its contracts", () => {
    assert.equal(deliveryFor("type_contract", { specGap: false, policy: noFlags }), OFF);
  });

  it("blocks an autonomous run when the task under-specifies", () => {
    assert.equal(deliveryFor("type_contract", { specGap: true, policy: noFlags }), BLOCK);
  });

  // Interactive runs warn rather than block, matching every other gate here: a
  // human is present to overrule it.
  it("only warns interactively", () => {
    assert.equal(deliveryFor("type_contract", { specGap: true, interactive: true, policy: noFlags }), WARN);
  });

  it("leaves other gates untouched", () => {
    const before = deliveryFor("premature_done", { specGap: false, policy: noFlags });
    assert.equal(deliveryFor("premature_done", { specGap: true, policy: noFlags }), before);
  });

  // The env var stays authoritative so A/B arms can force the gate on regardless of
  // what the detector thinks.
  it("still honours the explicit flag when no gap is detected", () => {
    const forced = defaultPolicy({ BANTAM_TYPE_CONTRACT_GATE: "1" });
    assert.equal(deliveryFor("type_contract", { specGap: false, policy: forced }), BLOCK);
  });
});

describe("workspaceExports", () => {
  let dir;
  const write = (rel, body) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  it("finds declared and assigned exports and skips tests and vendor code", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-wsx-"));
    try {
      write("src/a.js", "export function normalizeChannels(x) {}\nexport class Pool {}\n");
      write("src/b.js", "export const parseCount = (v) => v;\n");
      // A test file exports nothing the task asked for.
      write("test/a.test.js", "export function helperOnlyInTests() {}\n");
      write("node_modules/dep/index.js", "export function vendored() {}\n");
      const names = workspaceExports(dir).sort();
      assert.deepEqual(names, ["Pool", "normalizeChannels", "parseCount"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list rather than throwing on a missing workspace", () => {
    assert.deepEqual(workspaceExports(path.join(os.tmpdir(), "bantam-does-not-exist-xyz")), []);
    assert.deepEqual(workspaceExports(null), []);
  });
});

// A kill switch that does nothing is worse than no kill switch.
//
// An A/B on adapter-migration was run with BANTAM_SPEC_GAP_AUTO=0 set on the
// control arm before that variable existed. Both arms ran identically, produced
// near-identical turn counts (7/8/11 vs 7/9/11), and the "comparison" measured
// nothing at all. The real answer came from the gate's own evaluation and rejection
// counters instead. A control that is a silent copy of the treatment is the most
// expensive kind of instrument defect, because it looks like a result.
describe("BANTAM_SPEC_GAP_AUTO", () => {
  const detectorRuns = (env) => !/^(0|false|no|off)$/i.test(String(env.BANTAM_SPEC_GAP_AUTO ?? ""));

  it("is on by default", () => {
    assert.equal(detectorRuns({}), true);
  });

  for (const value of ["0", "false", "no", "off", "OFF"]) {
    it(`is suppressed by ${JSON.stringify(value)}`, () => {
      assert.equal(detectorRuns({ BANTAM_SPEC_GAP_AUTO: value }), false);
    });
  }

  it("stays on for any other value", () => {
    assert.equal(detectorRuns({ BANTAM_SPEC_GAP_AUTO: "1" }), true);
  });

  // The source must actually read it -- the point of this suite.
  it("is read by the agent", () => {
    const src = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
    assert.match(src, /BANTAM_SPEC_GAP_AUTO/,
      "the kill switch must exist in the code, not only in the test");
  });
});
