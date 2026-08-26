import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { strictBest, describeBest } from "../src/logic/strict-best.js";

// Two comparison tools in this repo independently made the same three mistakes on
// the same day, all favouring the subject: a tie reported as a win, an unmeasured
// row treated as a zero and therefore winning, and a lone contender crowned over
// competitors that never ran. Both were fixed separately, which left the same
// logic written twice and free to drift apart. This is the one copy.

const rows = [
  { id: "a", ms: 100 },
  { id: "b", ms: 200 },
  { id: "c", ms: null },
];
const ms = (r) => r.ms;
const label = (r) => r.id;

describe("unmeasured never competes", () => {
  it("does not let a null value win a minimum", () => {
    const r = strictBest(rows, ms);
    assert.equal(r.winner.id, "a");
  });

  it("reports how many rows actually measured the metric", () => {
    const r = strictBest(rows, ms);
    assert.equal(r.measured, 2);
    assert.equal(r.total, 3);
  });

  it("treats undefined and NaN the same as null", () => {
    const r = strictBest(
      [{ id: "a", ms: 5 }, { id: "b" }, { id: "c", ms: NaN }, { id: "d", ms: 9 }],
      ms,
    );
    assert.equal(r.winner.id, "a");
    assert.equal(r.measured, 2);
  });

  // The distinction the fix must not destroy.
  it("lets a recorded zero win", () => {
    const r = strictBest([{ id: "a", ms: 0 }, { id: "b", ms: 50 }], ms);
    assert.equal(r.winner.id, "a", "0 is a measurement, not an absence");
  });

  it("finds no winner when nothing was measured", () => {
    const r = strictBest([{ id: "a" }, { id: "b" }], ms);
    assert.equal(r.winner, null);
    assert.equal(r.best, null);
    assert.equal(r.measured, 0);
  });
});

describe("a tie is not a win", () => {
  it("returns no winner and lists the leaders", () => {
    const r = strictBest([{ id: "a", ms: 50 }, { id: "b", ms: 50 }, { id: "c", ms: 90 }], ms);
    assert.equal(r.winner, null);
    assert.deepEqual(r.tied.map(label), ["a", "b"]);
  });

  it("does not depend on the order the rows arrive in", () => {
    const forward = strictBest([{ id: "a", ms: 50 }, { id: "b", ms: 50 }], ms);
    const reverse = strictBest([{ id: "b", ms: 50 }, { id: "a", ms: 50 }], ms);
    assert.equal(forward.winner, null);
    assert.equal(reverse.winner, null);
  });
});

describe("one contender is not a comparison", () => {
  it("reports a sole measured row as uncontested rather than as the winner", () => {
    const r = strictBest([{ id: "a", ms: 42 }, { id: "b" }, { id: "c" }], ms);
    assert.equal(r.winner, null, "beating rows that never measured anything is not winning");
    assert.equal(r.uncontested.id, "a");
  });

  // Refusing to crown it must not become denying it measured anything.
  it("still reports the value it measured", () => {
    assert.equal(strictBest([{ id: "a", ms: 42 }, { id: "b" }], ms).best, 42);
  });
});

describe("direction", () => {
  it("maximises when asked", () => {
    const r = strictBest(rows, ms, { direction: "max" });
    assert.equal(r.winner.id, "b");
  });
});

describe("describeBest", () => {
  const say = (input, opts) => describeBest(strictBest(input, ms, opts), { label, name: "Fastest" });

  it("names a real winner", () => {
    assert.match(say([{ id: "a", ms: 1 }, { id: "b", ms: 2 }]), /Fastest: a$/);
  });

  it("says tie on a draw", () => {
    assert.match(say([{ id: "a", ms: 1 }, { id: "b", ms: 1 }]), /Fastest: tie — a, b/);
  });

  it("flags an uncontested award", () => {
    assert.match(say([{ id: "a", ms: 1 }, { id: "b" }]), /uncontested/);
  });

  it("flags partial coverage when a real winner beat only some of the field", () => {
    assert.match(say([{ id: "a", ms: 1 }, { id: "b", ms: 2 }, { id: "c" }]), /only 2 of 3 measured it/);
  });

  it("says n/a when nothing was measured", () => {
    assert.match(say([{ id: "a" }, { id: "b" }]), /n\/a \(no row measured it\)/);
  });
});
