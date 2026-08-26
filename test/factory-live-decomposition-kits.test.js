import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATALOG, FIXTURES, allPrompt, onePrompt, parseAnswer } from "../scripts/live-decomposition-cohort.mjs";

// These pin the experiment's fixtures and kits. They need no worker. The cohort
// they guard produced two conclusions in a row that were about the experiment
// rather than the model — a fenced-JSON adapter, then an ambiguous fixture — so
// the design itself is what gets asserted here.
describe("live decomposition kits", () => {
  it("issues one function per station and never the whole job", () => {
    for (const fixture of FIXTURES) {
      const kit = onePrompt(fixture);
      const carried = FIXTURES.filter((other) => kit.includes(other.source));
      assert.equal(carried.length, 1, `${fixture.id} kit carries ${carried.length} functions`);
      assert.equal(carried[0].id, fixture.id);
    }
    // The monolith, by contrast, carries all of them — that is what makes it the
    // control rather than another station.
    const whole = allPrompt();
    assert.equal(FIXTURES.filter((fixture) => whole.includes(fixture.source)).length, FIXTURES.length);
  });

  it("never leaks the expected answer into any kit", () => {
    // The gauge holds the expected id. A kit that named it would be measuring
    // the prompt, not the worker.
    for (const fixture of FIXTURES) {
      const kit = onePrompt(fixture);
      const named = CATALOG.filter((entry) => kit.includes(entry.id));
      // The whole catalog is published to the worker by design, so presence of
      // every id is expected — what must not happen is the kit pairing this
      // function with its answer.
      assert.equal(named.length, CATALOG.length);
      assert.ok(!kit.includes(`${fixture.id} -> ${fixture.expected}`));
      assert.ok(!kit.toLowerCase().includes("expected"));
    }
  });

  it("keeps every fixture's answer unique and inside the catalog", () => {
    const ids = new Set(CATALOG.map((entry) => entry.id));
    const expected = FIXTURES.map((fixture) => fixture.expected);
    for (const fixture of FIXTURES) assert.ok(ids.has(fixture.expected), `${fixture.id} expects an uncatalogued id`);
    // One catalog entry per fixture: a worker cannot be right by repeating an id.
    assert.equal(new Set(expected).size, expected.length);
  });

  it("guards the alternatives so exactly one catalog entry fits each fixture", () => {
    // The lesson from the sumParsed defect: a fixture whose code could plausibly
    // fail two catalogued ways is measuring the fixture, not the worker. Each
    // fixture must either exclude the alternative in code or state it.
    const sumParsed = FIXTURES.find((fixture) => fixture.id === "sumParsed");
    assert.match(sumParsed.source, /always present/, "sumParsed must exclude missing-key explicitly");
    const ratio = FIXTURES.find((fixture) => fixture.id === "ratio");
    assert.match(ratio.source, /typeof/, "ratio must exclude non-numeric by guarding it");
    const sqrtAll = FIXTURES.find((fixture) => fixture.id === "sqrtAll");
    assert.match(sqrtAll.source, /length === 0/, "sqrtAll must exclude empty-input by guarding it");
    const register = FIXTURES.find((fixture) => fixture.id === "register");
    assert.match(register.source, /typeof/, "register must exclude non-numeric by guarding it");
  });

  it("recovers a fenced emission without inventing one", () => {
    assert.equal(parseAnswer('```json\n{"edgeCaseId":"empty-input"}\n```').parsed.edgeCaseId, "empty-input");
    assert.equal(parseAnswer('{"edgeCaseId":"empty-input"}').repaired, false);
    assert.equal(parseAnswer("```json\n{broken}\n```").parsed, null);
  });
});
