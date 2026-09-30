import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideJevAdaptive, derivedAfterChoice, entityTable, isChangeQuestion, noopChanges, parseChanges } from "../src/factory.js";

const state = {
  devices: [
    { id: "hall_light", kind: "light", power: true, brightness: 40 },
    { id: "den_thermostat", kind: "thermostat", power: true, temperature: 21 },
    { id: "den_plug", kind: "appliance", power: false },
  ],
  request: "Set the den thermostat to 23.",
};
const outcome = {
  type: "choice",
  instructions: "What is the concrete immediate outcome after applying the correct handling?",
  criteria: {
    k_a: "den_thermostat.temperature becomes 23",
    k_b: "hall_light.power becomes true",
    k_c: "no device property changes",
    k_d: "den_plug.power becomes true; den_plug.power becomes false",
  },
};
const after = (prop, id) => ({ type: "choice", instructions: `Immediately after correct handling, what is ${prop} for ${id}?`, criteria: { k1: "not applicable or not listed", k2: "21", k3: "23", k4: "true", k5: "false" } });

describe("factory state-transition gauge", () => {
  it("reads entities and change notation from the material", () => {
    assert.deepEqual([...entityTable(state).keys()], ["hall_light", "den_thermostat", "den_plug"]);
    assert.deepEqual(parseChanges("a.b becomes 3; c.d becomes \"x\""), [{ id: "a", prop: "b", value: 3 }, { id: "c", prop: "d", value: "x" }]);
    assert.equal(parseChanges("no device property changes"), null);
    assert.ok(isChangeQuestion(outcome));
  });

  it("rules out a change that changes nothing, and only that", () => {
    const noops = noopChanges(entityTable(state), outcome);
    assert.deepEqual(noops.map(({ key }) => key), ["k_b"], "hall_light is already on; den_plug on-then-off is a real sequence");
    assert.match(noops[0].note, /hall_light\.power is already true/);
  });

  it("derives an after-state answer from the chosen change and the listed state", () => {
    const entities = entityTable(state);
    const changed = parseChanges(outcome.criteria.k_a);
    assert.equal(derivedAfterChoice(entities, changed, after("temperature", "den_thermostat")), "k3", "changed by the outcome");
    assert.equal(derivedAfterChoice(entities, [], after("temperature", "den_thermostat")), "k2", "no change: the listed value");
    assert.equal(derivedAfterChoice(entities, changed, after("temperature", "hall_light")), "k1", "a property the entity does not have");
    assert.equal(derivedAfterChoice(entities, changed, { type: "choice", instructions: "Is hall_light in the target set?", criteria: { y: "yes", n: "no" } }), null, "not an after-state question");
  });

  it("adaptive: the after-state question follows the row's outcome answer, not its own read", async () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    // Reads favour the thermostat change for the outcome, and (wrongly) 21 for the after-state.
    const favour = (compiled, user, text) => {
      const hit = compiled.labels.find(({ label }) => user.includes(`[${label}] ${text}`));
      return Object.fromEntries(compiled.labels.map(({ label }) => [label, hit && label === hit.label ? 0.97 : 0.03 / (compiled.labels.length - 1)]));
    };
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => ({ probabilities: favour(compiled, user, user.includes("outcome") ? "k_a:" : "k2:"), promptTokens: 1 }),
    };
    const { answers, evidence } = await decideJevAdaptive({ reader, pool, state, questions: { outcome, temp: after("temperature", "den_thermostat") }, stateGauge: true });
    assert.equal(answers.outcome.choice, "k_a");
    assert.equal(answers.temp.choice, "k3", "derived from the outcome: 23");
    assert.equal(evidence.temp.at(-1).step, "derived");
  });
});
