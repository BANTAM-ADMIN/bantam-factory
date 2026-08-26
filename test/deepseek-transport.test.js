import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";
import {
  deepSeekMessagesFromPrompt,
  extractCompletionText,
  extractStreamDelta,
} from "../src/openai-transport.js";

test("DeepSeek uses chat completions and maps the retired reasoner alias", () => {
  const client = new ModelClient({
    apiUrl: "https://api.deepseek.com/v1/",
    apiKey: "test-key",
    model: "deepseek-reasoner",
    deepseek: true,
  });

  const request = client.buildRequest("emit json", {
    grammar: 'root ::= "{}"',
    nPredict: 64,
  });
  const body = JSON.parse(request.body);

  assert.equal(request.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.messages, [{ role: "user", content: "emit json" }]);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal("grammar" in body, false);
  assert.equal("top_k" in body, false);
  assert.equal("seed" in body, false);
});

test("DeepSeek V4 defaults to neutral prompting and non-thinking action turns", () => {
  const client = new ModelClient({
    apiUrl: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    deepseek: true,
  });
  const request = client.buildRequest(
    '<|im_start|>system\nrules<|im_end|>\n'
      + '<|im_start|>user\nTask: fix it<|im_end|>\n'
      + '<|im_start|>assistant\n',
    {
      grammar: 'root ::= "{}"',
      jsonSchema: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    },
  );
  const body = JSON.parse(request.body);

  assert.equal(client.profileName, "generic");
  assert.equal(client.deepseekThinking, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "rules" },
    { role: "user", content: "Task: fix it" },
  ]);
  assert.equal(body.tools[0].function.name, "bantam_action");
  assert.equal(body.tool_choice.function.name, "bantam_action");
  assert.equal("response_format" in body, false);
  assert.equal("reasoning_effort" in body, false);
});

test("DeepSeek transcript conversion preserves completed semantic turns", () => {
  assert.deepEqual(deepSeekMessagesFromPrompt(
    '<|im_start|>system\nS<|im_end|>\n'
      + '<|im_start|>user\nU1<|im_end|>\n'
      + '<|im_start|>assistant\n{"a":"read_file"}<|im_end|>\n'
      + '<|im_start|>user\nO1<|im_end|>\n'
      + '<|im_start|>assistant\n',
  ), [
    { role: "system", content: "S" },
    { role: "user", content: "U1" },
    { role: "assistant", content: '{"a":"read_file"}' },
    { role: "user", content: "O1" },
  ]);
});

test("DeepSeek tool calls expose action arguments in complete and streamed responses", () => {
  assert.equal(extractCompletionText({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ function: { name: "bantam_action", arguments: '{"a":"respond","text":"ok"}' } }],
      },
    }],
  }), '{"a":"respond","text":"ok"}');
  assert.equal(extractStreamDelta({
    choices: [{
      delta: {
        tool_calls: [{ function: { arguments: '{"a":"read' } }],
      },
    }],
  }), '{"a":"read');
});

test("native endpoint selection disables API mode and keeps GBNF grammar", () => {
  const previous = process.env.BANTAM_API_URL;
  process.env.BANTAM_API_URL = "https://api.example/v1";
  try {
    const client = new ModelClient({
      endpoint: "http://localhost:8085/",
      apiUrl: null,
    });
    const request = client.buildRequest("prompt", { grammar: 'root ::= "OK"' });
    const body = JSON.parse(request.body);

    assert.equal(client.apiMode, false);
    assert.equal(request.url, "http://localhost:8085/completion");
    assert.equal(body.grammar, 'root ::= "OK"');
  } finally {
    if (previous === undefined) delete process.env.BANTAM_API_URL;
    else process.env.BANTAM_API_URL = previous;
  }
});

test("switching between API and local transports updates the active mode", () => {
  const client = new ModelClient({ endpoint: "http://localhost:8085", apiUrl: null });
  client.switchToApi({
    url: "https://api.deepseek.com/v1/",
    model: "deepseek-chat",
    key: "test-key",
    deepseek: true,
  });
  assert.equal(client.apiMode, true);
  assert.equal(client.modelName, "deepseek-v4-flash");
  assert.equal(client.deepseekThinking, false);

  client.switchTo("http://localhost:18086/");
  assert.equal(client.apiMode, false);
  assert.equal(client.apiUrl, null);
  assert.equal(client.endpoint, "http://localhost:18086");
});

test("switching to Codex uses an app-server request and switching local clears it", () => {
  const client = new ModelClient({ endpoint: "http://localhost:8085", apiUrl: null });
  client.switchToCodex({ model: "gpt-5.6-sol", effort: "high" });

  const request = client.buildRequest("assembled BANTAM prompt", {
    grammar: 'root ::= "{}"',
  });
  const body = JSON.parse(request.body);
  assert.equal(client.codex, true);
  assert.equal(client.apiMode, false);
  assert.equal(request.url, "codex-app-server://local/gpt-5.6-sol");
  assert.equal(body.prompt, "assembled BANTAM prompt");
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.effort, "high");
  assert.equal(body.jsonMode, true);

  client.switchTo("http://localhost:18086/");
  assert.equal(client.codex, false);
  assert.equal(client.apiMode, false);
  assert.equal(client.endpoint, "http://localhost:18086");
});

test("DeepSeek accepts its standard API-key environment variable", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "environment-key";
  try {
    const client = new ModelClient({
      apiUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      deepseek: true,
    });
    assert.equal(client.apiKey, "environment-key");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});
