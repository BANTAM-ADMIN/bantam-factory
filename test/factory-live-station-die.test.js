import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG, FIXTURES, parseAnswer } from "../scripts/live-station-cohort.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// These pin the station's output die and its one named repair. They need no
// model: the live cohort is run on demand, but a die that silently changes an
// answer would be a defect nobody could see from the cohort's summary.
describe("live station output die", () => {
  it("accepts a bare JSON emission unchanged", () => {
    const { parsed, repaired } = parseAnswer('{"edgeCaseId":"missing-key"}');
    assert.equal(parsed.edgeCaseId, "missing-key");
    assert.equal(repaired, false);
  });

  it("recovers a fenced emission and records that it repaired one", () => {
    // The live worker wraps its JSON in a markdown fence. The first run of the
    // cohort had no repair and scored 23 of 24 answers as null, which read as a
    // capability result and was a measurement of the adapter.
    for (const fenced of [
      '```json\n{"edgeCaseId":"zero-divisor"}\n```',
      '```\n{"edgeCaseId":"zero-divisor"}\n```',
      '  ```json\n{"edgeCaseId":"zero-divisor"}\n```  ',
    ]) {
      const { parsed, repaired } = parseAnswer(fenced);
      assert.equal(parsed.edgeCaseId, "zero-divisor", fenced);
      assert.equal(repaired, true, fenced);
    }
  });

  it("cannot turn a malformed emission into an answer", () => {
    // A repair that invents a decision is worse than no repair at all.
    for (const malformed of ["", "no json here", "```json\n{not json}\n```", '{"edgeCaseId":']) {
      assert.equal(parseAnswer(malformed).parsed, null, malformed);
    }
  });

  it("keeps every fixture's expected answer inside the published catalog", () => {
    const ids = new Set(CATALOG.map((entry) => entry.id));
    for (const fixture of FIXTURES) {
      assert.ok(ids.has(fixture.expected), `${fixture.id} expects an uncatalogued id`);
    }
    // More catalog entries than fixtures, so a worker cannot be right by
    // exhausting the options.
    assert.ok(CATALOG.length > FIXTURES.length);
  });

  it("fails closed and says so when no worker is serving", () => {
    // The cohort must not report a result it did not measure.
    const result = spawnSync(process.execPath, [
      path.join(repositoryRoot, "scripts/live-station-cohort.mjs"),
      "--endpoint", "http://127.0.0.1:59999/v1/chat/completions",
    ], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /no model at/);
  });
});
