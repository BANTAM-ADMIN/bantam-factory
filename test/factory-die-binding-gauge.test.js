import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyDieBindingHttpFailure,
  DIE_BINDING_DECOY,
  DIE_BINDING_SENTINEL,
  dieBindingRequest,
  dieBindingVerdict,
  readDieBinding,
} from "../src/factory.js";

describe("factory die-binding gauge", () => {
  it("makes the prompt and native sampler die disagree", () => {
    const request = dieBindingRequest({ model: "fixture", constraint: "grammar" });
    assert.match(request.messages[0].content, new RegExp(DIE_BINDING_DECOY));
    assert.match(request.messages[0].content, /Catalog \(choose exactly one id\)/);
    assert.match(request.messages[0].content, /GET \/orders\/17/);
    assert.match(request.grammar, new RegExp(DIE_BINDING_SENTINEL));
    assert.equal(request.chat_template_kwargs.enable_thinking, false);
  });

  it("emits current vLLM structured-output mechanisms separately from removed guided fields", () => {
    assert.deepEqual(dieBindingRequest({ model: "fixture", constraint: "structured_choice" }).structured_outputs, { choice: [DIE_BINDING_SENTINEL] });
    assert.match(dieBindingRequest({ model: "fixture", constraint: "structured_grammar" }).structured_outputs.grammar, new RegExp(DIE_BINDING_SENTINEL));
    assert.equal(dieBindingRequest({ model: "fixture", constraint: "structured_regex" }).structured_outputs.regex, DIE_BINDING_SENTINEL);
    assert.deepEqual(dieBindingRequest({ model: "fixture", constraint: "guided_choice" }).guided_choice, [DIE_BINDING_SENTINEL]);
  });

  it("distinguishes a bound die, an ignored die, and an invalid empty observation", () => {
    assert.equal(readDieBinding({ constraint: "grammar", content: DIE_BINDING_SENTINEL }).verdict, "die-won");
    assert.equal(readDieBinding({ constraint: "grammar", content: DIE_BINDING_DECOY }).verdict, "prompt-won-constraint-ignored");
    assert.equal(readDieBinding({ constraint: "grammar", content: "status401" }).verdict, "constraint-violating-output");
    assert.equal(readDieBinding({ constraint: "grammar", content: "-401" }).verdict, "constraint-violating-output");
    assert.equal(readDieBinding({ constraint: "grammar", content: "" }).verdict, "neither-present");
  });

  it("never reports the die bound when its no-die control failed", () => {
    const verdict = dieBindingVerdict([
      { constraint: "none", ...readDieBinding({ constraint: "none", content: "" }) },
      { constraint: "grammar", ...readDieBinding({ constraint: "grammar", content: DIE_BINDING_SENTINEL }) },
    ]);
    assert.equal(verdict.probeValid, false);
    assert.equal(verdict.dieBound, false);
  });

  it("reports intermittent enforcement without promoting it to bound", () => {
    const verdict = dieBindingVerdict([
      { constraint: "none", ...readDieBinding({ constraint: "none", content: DIE_BINDING_DECOY }) },
      { constraint: "grammar", ...readDieBinding({ constraint: "grammar", content: DIE_BINDING_SENTINEL }) },
      { constraint: "grammar", ...readDieBinding({ constraint: "grammar", content: DIE_BINDING_DECOY }) },
    ]);
    assert.equal(verdict.probeValid, true);
    assert.equal(verdict.mechanisms[0].binding, "intermittent");
    assert.equal(verdict.dieBound, false);
  });

  it("does not launder a serving crash into a healthy constraint refusal", () => {
    assert.deepEqual(classifyDieBindingHttpFailure(400), { transport: "refused", verdict: "constraint-refused" });
    assert.deepEqual(classifyDieBindingHttpFailure(422), { transport: "refused", verdict: "constraint-refused" });
    assert.deepEqual(classifyDieBindingHttpFailure(500), { transport: "server-error", verdict: "server-error" });
    assert.deepEqual(classifyDieBindingHttpFailure(503), { transport: "server-error", verdict: "server-error" });
    assert.deepEqual(classifyDieBindingHttpFailure(302), { transport: "unexpected-http-status", verdict: "transport-error" });
    assert.throws(() => classifyDieBindingHttpFailure(200), /failure status/);
  });
});
