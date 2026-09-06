import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";
import {
  GENERIC_ASSISTANT_PREFILL,
  QWEN_ASSISTANT_PREFILL,
} from "../src/profiles.js";
import { deriveThinkPrefills } from "../src/thinking.js";

test("Codex defaults to the generic profile and relies on native reasoning", (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    codexEffort: "high",
  });
  t.after(() => client.close());

  assert.equal(client.profileName, "generic");
  assert.equal(client.assistantPrefill, GENERIC_ASSISTANT_PREFILL);
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, false);
  assert.equal(client.codexThreadMode, "run");
  assert.equal(client.metadata().codexThreadMode, "run");
  assert.equal(client.metadata().codexPromptMode, "delta");
  assert.equal(client.metadata().codexRebaseEvery, 0);
  assert.equal(client.metadata().codexRebaseMinSavings, 0);
});

test("explicit Astra uses native Codex reasoning without local sampling or Qwen's think rail", t => {
  const client = new ModelClient({ codex: true, model: "gpt-6-astra", codexEffort: "medium" });
  t.after(() => client.close());
  assert.equal(client.profileName, "generic");
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, false);
  const request = client.buildRequest("Return the requested action.");
  const body = JSON.parse(request.body);
  assert.equal(request.url, "codex-app-server://local/gpt-6-astra");
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.effort, "medium");
  for (const key of ["temperature", "top_p", "top_logprobs", "logprobs"]) assert.equal(Object.hasOwn(body, key), false);
  assert.equal(JSON.parse(client.buildRequest("Next action.", { codexEffort: "low" }).body).effort, "low");
  client.switchTo("http://localhost:8085");
  client.switchToCodex({ model: "gpt-6-astra", effort: "medium" });
  assert.equal(client.modelName, "gpt-6-astra");
  assert.equal(client.profileName, "generic");
});

test("explicit ephemeral Codex mode selects its compatible full-prompt rollback", (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    codexThreadMode: "ephemeral",
  });
  t.after(() => client.close());

  assert.equal(client.metadata().codexThreadMode, "ephemeral");
  assert.equal(client.metadata().codexPromptMode, "full");
});

test("Codex delta prompts require run-scoped threads", (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    codexThreadMode: "run",
    codexPromptMode: "delta",
    codexRebaseEvery: 4,
    codexRebaseMinSavings: 0.2,
  });
  t.after(() => client.close());
  assert.equal(client.metadata().codexPromptMode, "delta");
  assert.equal(client.metadata().codexRebaseEvery, 4);
  assert.equal(client.metadata().codexRebaseMinSavings, 0.2);
  assert.equal(
    JSON.parse(client.buildRequest("ordinary turn").body).adaptiveRebase,
    true,
  );
  assert.equal(
    JSON.parse(client.buildRequest("completion audit", {
      codexAdaptiveRebase: false,
    }).body).adaptiveRebase,
    false,
  );
  const inferredRun = new ModelClient({ codex: true, codexPromptMode: "delta" });
  t.after(() => inferredRun.close());
  assert.equal(inferredRun.metadata().codexThreadMode, "run");
  assert.throws(
    () => new ModelClient({
      codex: true,
      codexThreadMode: "ephemeral",
      codexPromptMode: "delta",
    }),
    /requires thread mode run/,
  );
  assert.throws(
    () => new ModelClient({ codex: true, codexRebaseEvery: -1 }),
    /expected a non-negative integer/,
  );
  assert.throws(
    () => new ModelClient({ codex: true, codexRebaseMinSavings: 2 }),
    /expected a number from 0 to 1/,
  );
});

test("Codex run-scoped threads are explicit and invalid modes fail early", (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    codexThreadMode: "run",
  });
  t.after(() => client.close());

  assert.equal(client.metadata().codexThreadMode, "run");
  assert.throws(
    () => new ModelClient({ codex: true, codexThreadMode: "forever" }),
    /expected ephemeral or run/,
  );
});

test("switching from local to Codex removes Qwen thinking and switching back restores it", (t) => {
  const client = new ModelClient({ endpoint: "http://localhost:8085", apiUrl: null });
  t.after(() => client.close());

  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, true);
  client.switchToCodex({ model: "gpt-5.6-sol", effort: "high" });
  assert.equal(client.profileName, "generic");
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, false);
  assert.equal(client.metadata().codexThreadMode, "run");
  assert.equal(client.metadata().codexPromptMode, "delta");
  client.switchTo("http://localhost:8085");
  assert.equal(client.profileName, "qwen");
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, true);
});

test("switching from local to DeepSeek selects neutral non-thinking actions and switching back restores Qwen", () => {
  const client = new ModelClient({
    endpoint: "http://localhost:8085",
    apiUrl: null,
  });

  client.switchToApi({
    url: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    key: "test-key",
    deepseek: true,
  });
  assert.equal(client.profileName, "generic");
  assert.equal(client.deepseekThinking, false);
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, false);

  client.switchTo("http://localhost:8085");
  assert.equal(client.profileName, "qwen");
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, true);
});

test("switching models preserves an explicitly selected Codex rollback mode", (t) => {
  const client = new ModelClient({
    endpoint: "http://localhost:8085",
    codexThreadMode: "ephemeral",
  });
  t.after(() => client.close());

  client.switchToCodex({ model: "gpt-5.6-terra", effort: "medium" });
  assert.equal(client.metadata().codexThreadMode, "ephemeral");
  assert.equal(client.metadata().codexPromptMode, "full");

  client.switchToCodex({ model: "gpt-5.6-sol", effort: "high" });
  assert.equal(client.metadata().codexThreadMode, "ephemeral");
  assert.equal(client.metadata().codexPromptMode, "full");
});

test("an explicit Codex profile remains authoritative", (t) => {
  const client = new ModelClient({
    codex: true,
    model: "gpt-5.6-sol",
    profile: "qwen",
  });
  t.after(() => client.close());

  assert.equal(client.profileName, "qwen");
  assert.equal(client.assistantPrefill, QWEN_ASSISTANT_PREFILL);
});

test("the local unconfigured model keeps the Qwen dogfood profile", (t) => {
  const client = new ModelClient({
    endpoint: "http://localhost:8085",
    apiUrl: null,
  });
  t.after(() => client.close());

  assert.equal(client.profileName, "qwen");
  assert.equal(deriveThinkPrefills(client.assistantPrefill).canThink, true);
});
