import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCodexPromptDelivery,
  CodexAppServer,
  reconstructCodexPromptDelivery,
} from "../src/codex-transport.js";
import { actionJsonSchema } from "../src/grammar.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.js", import.meta.url),
);

function server(options = {}) {
  return new CodexAppServer({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 2000,
    ...options,
  });
}

test("Codex transport initializes, discovers its model, streams, and reports usage", async (t) => {
  const codex = server();
  t.after(() => codex.close());
  assert.equal(await codex.health(), true);

  const progress = [];
  const result = await codex.complete("respond through the schema", {
    outputSchema: actionJsonSchema(),
    onProgress: (event) => progress.push(event.content),
  });

  assert.equal(result.content, '{"a":"respond","text":"schema received"}');
  assert.deepEqual(progress, ['{"a":"re']);
  assert.deepEqual(result.usage, {
    provider: "codex",
    model: "gpt-5.6-sol",
    requests: 1,
    inputTokens: 120,
    outputTokens: 12,
    totalTokens: 132,
    cacheHitTokens: 20,
    cacheMissTokens: 100,
    reasoningTokens: 4,
    costUsd: 0,
    codexRequests: 1,
  });
  assert.deepEqual(result.codexThread, {
    threadId: result.codexThread.threadId,
    threadMode: "ephemeral",
    threadReused: false,
  });
  assert.match(result.codexThread.threadId, /^thread-\d+-1$/);
});

test("Codex image broker returns a saved path without raw image bytes", async (t) => {
  const codex = server();
  t.after(() => codex.close());
  const image = await codex.generateImage("synthetic image");
  assert.match(image.savedPath, /fake-codex-image-\d+\.png$/);
  assert.equal(image.revisedPrompt, "synthetic revised image prompt");
  assert.equal(Object.hasOwn(image, "result"), false);
});

test("run-scoped Codex mode reuses one thread only inside an explicit run", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "full" });
  t.after(() => codex.close());

  const firstRun = codex.beginRun();
  const first = await codex.complete("first");
  const second = await codex.complete("second");
  assert.equal(first.codexThread.threadId, second.codexThread.threadId);
  assert.equal(first.codexThread.threadReused, false);
  assert.equal(second.codexThread.threadReused, true);
  assert.equal(codex.endRun(firstRun), true);

  const secondRun = codex.beginRun();
  const isolated = await codex.complete("third");
  assert.notEqual(isolated.codexThread.threadId, first.codexThread.threadId);
  assert.equal(isolated.codexThread.threadReused, false);
  assert.equal(codex.endRun(secondRun), true);
});

test("run-scoped Codex mode validates lifecycle and model isolation", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "full" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  assert.throws(() => codex.beginRun(), /already has an active/);
  await codex.complete("first", { model: "gpt-5.6-sol" });
  await assert.rejects(
    codex.complete("switch", { model: "gpt-5.6-terra" }),
    /cannot change Codex models/,
  );
  assert.equal(codex.endRun(Symbol("wrong")), false);
  assert.equal(codex.endRun(token), true);
});

test("prompt deltas reconstruct the exact canonical prompt and fall back when not smaller", () => {
  const base = `${"stable λ section\n".repeat(300)}old suffix`;
  const canonical = `${"stable λ section\n".repeat(300)}new suffix with \"quotes\" and \\\\slashes`;
  const delivery = buildCodexPromptDelivery(canonical, {
    mode: "delta",
    basePrompt: base,
  });
  assert.equal(delivery.evidence.mode, "delta");
  assert.ok(delivery.evidence.deliveredChars < delivery.evidence.canonicalChars);
  assert.equal(reconstructCodexPromptDelivery(base, delivery.text), canonical);

  const fallback = buildCodexPromptDelivery("completely different", {
    mode: "delta",
    basePrompt: base,
  });
  assert.equal(fallback.evidence.mode, "full-fallback");
  assert.equal(fallback.evidence.reason, "small-common-prefix");
  assert.equal(reconstructCodexPromptDelivery(base, fallback.text), "completely different");
});

test("delta mode sends one full prompt then only acknowledged incremental suffixes", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const stable = "stable instructions\n".repeat(300);
  const firstPrompt = `${stable}turn one`;
  const secondPrompt = `${firstPrompt}\nturn two with observation`;
  const thirdPrompt = `${secondPrompt}\nturn three with new observation`;

  const first = await codex.complete(firstPrompt);
  const second = await codex.complete(secondPrompt);
  const third = await codex.complete(thirdPrompt);

  assert.equal(first.codexPromptDelivery.mode, "full");
  assert.equal(second.codexPromptDelivery.mode, "delta");
  assert.equal(second.codexPromptDelivery.baseReference, "previous");
  assert.ok(second.codexPromptDelivery.savedChars > 0);
  assert.equal(
    reconstructCodexPromptDelivery(firstPrompt, second.codexPromptDelivery.deliveredText),
    secondPrompt,
  );
  assert.equal(first.codexThread.threadId, second.codexThread.threadId);
  assert.equal(third.codexThread.threadId, first.codexThread.threadId);
  assert.equal(reconstructCodexPromptDelivery(secondPrompt, third.codexPromptDelivery.deliveredText), thirdPrompt);
  assert.throws(() => reconstructCodexPromptDelivery(firstPrompt, third.codexPromptDelivery.deliveredText), /base checksum mismatch/);
  assert.ok(!third.codexPromptDelivery.deliveredText.includes("turn two with observation"));
  assert.equal(codex.runLastPrompt, thirdPrompt);
  assert.equal(codex.endRun(token), true);
});

test("delta mode periodically rebases onto a fresh canonical thread", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta", rebaseEvery: 2 });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const stable = "stable checkpoint instructions\n".repeat(300);

  const first = await codex.complete(`${stable}turn one`);
  const second = await codex.complete(`${stable}turn one\nturn two`);
  const third = await codex.complete(`${stable}turn one\nturn two\nturn three`);
  const fourth = await codex.complete(`${stable}turn one\nturn two\nturn three\nturn four`);

  assert.equal(first.codexPromptDelivery.mode, "full");
  assert.equal(second.codexPromptDelivery.mode, "delta");
  assert.equal(third.codexPromptDelivery.mode, "full");
  assert.equal(third.codexPromptDelivery.rebaseReason, "periodic");
  assert.equal(third.codexThread.threadRebaseReason, "periodic");
  assert.notEqual(third.codexThread.threadId, second.codexThread.threadId);
  assert.equal(third.codexThread.threadReused, false);
  assert.equal(fourth.codexThread.threadId, third.codexThread.threadId);
  assert.equal(fourth.codexPromptDelivery.mode, "delta");
  assert.equal(codex.endRun(token), true);
});

test("an inefficient delta rebases instead of retaining a stale base", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const first = await codex.complete("alpha base\n".repeat(300));
  const rebased = await codex.complete("entirely different canonical state\n".repeat(300));
  const continued = await codex.complete(
    `${"entirely different canonical state\n".repeat(300)}next observation`,
  );

  assert.equal(rebased.codexPromptDelivery.mode, "full");
  assert.equal(rebased.codexPromptDelivery.rebaseReason, "canonical-not-extension");
  assert.notEqual(rebased.codexThread.threadId, first.codexThread.threadId);
  assert.equal(continued.codexThread.threadId, rebased.codexThread.threadId);
  assert.equal(continued.codexPromptDelivery.mode, "delta");
  assert.equal(codex.endRun(token), true);
});

test("delta mode adaptively rebases only after delivery savings decay below the configured floor", async (t) => {
  const codex = server({
    threadMode: "run",
    promptMode: "delta",
    rebaseMinSavings: 0.2,
  });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const stable = "stable adaptive instructions\n".repeat(300);
  const firstPrompt = `${stable}${"x".repeat(1500)}`;
  const grownPrompt = `${firstPrompt}${"more".repeat(10000)}`;

  const first = await codex.complete(firstPrompt);
  const rebased = await codex.complete(grownPrompt);
  const continuedPrompt = `${grownPrompt}next compact observation`;
  const continued = await codex.complete(continuedPrompt);

  assert.equal(first.codexPromptDelivery.mode, "full");
  assert.notEqual(rebased.codexThread.threadId, first.codexThread.threadId);
  assert.equal(rebased.codexThread.threadReused, false);
  assert.equal(rebased.codexThread.threadRebaseReason, "low-delta-savings");
  assert.equal(rebased.codexPromptDelivery.mode, "full");
  assert.equal(rebased.codexPromptDelivery.rebaseReason, "low-delta-savings");
  assert.equal(continued.codexThread.threadId, rebased.codexThread.threadId);
  assert.equal(continued.codexPromptDelivery.mode, "delta");
  assert.equal(
    reconstructCodexPromptDelivery(grownPrompt, continued.codexPromptDelivery.deliveredText),
    continuedPrompt,
  );
  assert.equal(codex.endRun(token), true);
});

test("a completion boundary can suppress only the optional low-savings rebase", async (t) => {
  const codex = server({
    threadMode: "run",
    promptMode: "delta",
    rebaseMinSavings: 0.2,
  });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const firstPrompt = `${"stable completion instructions\n".repeat(300)}${"x".repeat(1500)}`;
  const auditPrompt = `${firstPrompt}${"audit observation".repeat(3000)}`;

  const first = await codex.complete(firstPrompt);
  const audit = await codex.complete(auditPrompt, { adaptiveRebase: false });

  assert.equal(audit.codexThread.threadId, first.codexThread.threadId);
  assert.equal(audit.codexThread.threadReused, true);
  assert.equal(audit.codexThread.threadRebaseReason, undefined);
  assert.equal(audit.codexPromptDelivery.mode, "delta");
  assert.equal(
    reconstructCodexPromptDelivery(firstPrompt, audit.codexPromptDelivery.deliveredText),
    auditPrompt,
  );
  assert.equal(codex.endRun(token), true);
});

test("forty incremental turns deliver linear new context without history replay or forced rebases", async (t) => {
  const continuous = server({ threadMode: "run", promptMode: "delta" });
  const adaptive = server({
    threadMode: "run",
    promptMode: "delta",
    rebaseMinSavings: 0.2,
  });
  t.after(() => {
    continuous.close();
    adaptive.close();
  });
  const stable = "S".repeat(6500);
  const prompts = Array.from({ length: 40 }, (_, turn) => (
    `${stable}\n${Array.from(
      { length: turn + 1 },
      (_value, observation) => `OBS${observation}:${"x".repeat(1490)}`,
    ).join("\n")}`
  ));

  const exercise = async (runtime) => {
    const token = runtime.beginRun();
    let deliveredChars = 0;
    const rebases = [];
    for (let index = 0; index < prompts.length; index++) {
      const result = await runtime.complete(prompts[index]);
      deliveredChars += result.codexPromptDelivery.deliveredChars;
      if (index > 0) {
        const wire = result.codexPromptDelivery.deliveredText;
        assert.equal(reconstructCodexPromptDelivery(prompts[index - 1], wire), prompts[index]);
        const payload = JSON.parse(wire.split("\n").find(line => line.startsWith("{")));
        assert.equal(payload.replaceSuffix, prompts[index].slice(prompts[index - 1].length));
        assert.ok(!payload.replaceSuffix.includes(`OBS${index - 1}:`));
      }
      if (result.codexThread.threadRebaseReason) rebases.push(index + 1);
    }
    assert.equal(runtime.endRun(token), true);
    return { deliveredChars, rebases };
  };

  const baseline = await exercise(continuous);
  const candidate = await exercise(adaptive);

  assert.deepEqual(baseline.rebases, []);
  assert.deepEqual(candidate.rebases, []);
  assert.equal(candidate.deliveredChars, baseline.deliveredChars);
  // One copy of each new observation plus a bounded per-turn envelope. No
  // O(N^2) suffix history and no periodic reset needed to achieve this bound.
  assert.ok(baseline.deliveredChars < prompts.at(-1).length + prompts.length * 1000);
  const legacyWire = prompts.reduce((chars, prompt, index) => chars + buildCodexPromptDelivery(prompt, {
    mode: index ? "delta" : "full", basePrompt: prompts[0],
  }).evidence.deliveredChars, 0);
  assert.ok(baseline.deliveredChars < legacyWire * 0.15);
});

test("a rewritten canonical history rebases even when its static prefix is large", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const stable = "stable instructions\n".repeat(300);
  const first = await codex.complete(`${stable}old file contents`);
  const replacement = `${stable}current file contents`;
  const second = await codex.complete(replacement, { adaptiveRebase: false });
  assert.equal(second.codexPromptDelivery.mode, "full");
  assert.equal(second.codexPromptDelivery.rebaseReason, "canonical-not-extension");
  assert.notEqual(second.codexThread.threadId, first.codexThread.threadId);
  assert.equal(codex.runLastPrompt, replacement);
  codex.endRun(token);
});

test("an acknowledged but interrupted delta never commits its cursor and recovers full", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const base = "stable cancellation instructions\n".repeat(300);
  const first = await codex.complete(base);
  const originalRequest = codex.request.bind(codex);
  let acknowledge;
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  codex.request = async (method, params) => {
    if (method !== "turn/start") return originalRequest(method, params);
    const response = await originalRequest(method, { ...params, input: [{ type: "text", text: "silent turn" }] });
    acknowledge();
    return response;
  };
  const controller = new AbortController();
  const pending = codex.complete(`${base}uncommitted observation`, { signal: controller.signal });
  await acknowledged;
  assert.equal(codex.runLastPrompt, base);
  await assert.rejects(codex.complete("concurrent rewritten canonical state"), /cannot execute concurrent/);
  assert.equal(codex.runLastPrompt, base);
  controller.abort();
  await assert.rejects(pending, error => error.code === "aborted");
  assert.equal(codex.runLastPrompt, null);
  codex.request = originalRequest;
  const recovered = await codex.complete(`${base}recovered observation`);
  assert.equal(recovered.codexPromptDelivery.mode, "full");
  assert.notEqual(recovered.codexThread.threadId, first.codexThread.threadId);
  codex.endRun(token);
});

test("a failed incremental turn clears its cursor before the full retry", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const base = "stable failure instructions\n".repeat(300);
  const first = await codex.complete(base);
  const originalRequest = codex.request.bind(codex);
  let failedWire;
  codex.request = (method, params) => {
    if (method !== "turn/start") return originalRequest(method, params);
    failedWire = params.input[0].text;
    return originalRequest(method, { ...params, input: [{ type: "text", text: "failed turn" }] });
  };
  const retryPrompt = `${base}new observation`;
  await assert.rejects(codex.complete(retryPrompt), /synthetic turn failure/);
  assert.match(failedWire, /^BANTAM_PROMPT_DELTA_V2\n/);
  assert.equal(codex.runLastPrompt, null);
  codex.request = originalRequest;
  const recovered = await codex.complete(retryPrompt);
  assert.equal(recovered.codexPromptDelivery.mode, "full");
  assert.notEqual(recovered.codexThread.threadId, first.codexThread.threadId);
  assert.equal(codex.runLastPrompt, retryPrompt);
  codex.endRun(token);
});

test("auxiliary image calls do not replace the acknowledged run context", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const base = "stable worker instructions\n".repeat(300);
  const first = await codex.complete(base);
  await codex.generateImage("synthetic image");
  assert.equal(codex.runLastPrompt, base);
  const second = await codex.complete(`${base}worker observation`);
  assert.equal(second.codexThread.threadId, first.codexThread.threadId);
  assert.equal(second.codexPromptDelivery.mode, "delta");
  codex.endRun(token);
});

test("a lost runtime forgets its cursor and resumes from the full canonical prompt", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const base = "stable recovery instructions\n".repeat(300);
  const first = await codex.complete(base);
  codex.close();
  assert.equal(codex.runLastPrompt, null);
  const recovered = await codex.complete(`${base}after process loss`);
  assert.equal(recovered.codexPromptDelivery.mode, "full");
  assert.notEqual(recovered.codexThread.threadId, first.codexThread.threadId);
  codex.endRun(token);
});

test("a failed run-thread turn clears delta state and recovers from a full canonical prompt", async (t) => {
  const codex = server({ threadMode: "run", promptMode: "delta" });
  t.after(() => codex.close());
  const token = codex.beginRun();
  const first = await codex.complete("recovery base\n".repeat(300));
  await assert.rejects(codex.complete("failed turn"), /synthetic turn failure/);
  const recovered = await codex.complete("recovered canonical state\n".repeat(300));

  assert.notEqual(recovered.codexThread.threadId, first.codexThread.threadId);
  assert.equal(recovered.codexThread.threadReused, false);
  assert.equal(recovered.codexPromptDelivery.mode, "full");
  assert.equal(codex.endRun(token), true);
});

test("delta prompt mode fails closed without run-scoped threads", () => {
  assert.throws(
    () => server({ threadMode: "ephemeral", promptMode: "delta" }),
    /requires thread mode run/,
  );
  assert.throws(
    () => server({ threadMode: "run", promptMode: "delta", rebaseEvery: -1 }),
    /expected a non-negative integer/,
  );
  assert.throws(
    () => server({ threadMode: "run", promptMode: "delta", rebaseMinSavings: 1.1 }),
    /expected a number from 0 to 1/,
  );
});

test("Codex transport aborts even when turn/start never acknowledges", async (t) => {
  const codex = server({ timeoutMs: 10000 });
  t.after(() => codex.close());
  const turnStarted = interceptPendingTurnStart(codex);
  const controller = new AbortController();
  const completion = codex.complete("hold turn/start", {
    signal: controller.signal,
    outputSchema: actionJsonSchema(),
  });
  await turnStarted;
  controller.abort();

  await assert.rejects(
    completion,
    (error) => error?.code === "aborted" && error.message === "model request interrupted",
  );
});

test("closing Codex rejects a turn that is waiting on the app-server", async () => {
  const codex = server({ timeoutMs: 10000 });
  const turnStarted = interceptPendingTurnStart(codex);
  const completion = codex.complete("hold turn/start", {
    outputSchema: actionJsonSchema(),
  });
  await turnStarted;
  codex.close();

  await assert.rejects(completion, /Codex app-server closed/);
});

function interceptPendingTurnStart(codex) {
  const originalRequest = codex.request.bind(codex);
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  codex.request = (method, params) => {
    if (method === "turn/start") {
      resolveStarted();
      return new Promise(() => {});
    }
    return originalRequest(method, params);
  };
  return started;
}

test("Codex transport retires a silent turn at the inactivity deadline", async () => {
  const codex = server({ timeoutMs: 1000, idleTimeoutMs: 30 });
  const startedAt = Date.now();

  await assert.rejects(
    codex.complete("silent turn"),
    (error) => (
      error?.code === "model_timeout"
      && error?.provider === "codex"
      && error?.timeoutKind === "idle"
      && error?.retryable === false
    ),
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(codex.child, null);
  codex.close();
});

test("Codex activity extends the inactivity deadline without extending the hard ceiling", async (t) => {
  const codex = server({ timeoutMs: 500, idleTimeoutMs: 35 });
  t.after(() => codex.close());

  const result = await codex.complete("active slow turn");

  assert.equal(result.content, "still alive");
});

test("Codex control-plane requests are bounded and recycle ambiguous protocol state", async () => {
  const codex = server({
    model: "hold-thread-start",
    timeoutMs: 1000,
    idleTimeoutMs: 500,
    controlTimeoutMs: 30,
  });

  await assert.rejects(
    codex.complete("never starts"),
    (error) => error?.code === "model_timeout" && error?.timeoutKind === "control",
  );
  assert.equal(codex.child, null);
  codex.close();
});
