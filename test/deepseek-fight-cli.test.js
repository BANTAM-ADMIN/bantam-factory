import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDockerArgs, buildPatch, normalizeEndpoint, parseArgs, readNativeSessions, summarizeSessionTexts } from "../scripts/deepseek-fight-cli.mjs";
import { runProcess } from "../src/process-runner.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = () => ["--workspace", "/tmp/candidate", "--task-file", "/tmp/task.txt", "--output", "/tmp/attempt",
  "--endpoint", "http://127.0.0.1:45678", "--model", "/models/local27b.gguf"];
const docker = (overrides = {}) => buildDockerArgs({ workspace: "/tmp/candidate", home: "/tmp/attempt/native-home",
  patchFile: "/tmp/attempt/fight.patch.yml", cidfile: "/tmp/attempt/container.cid", name: "deepseek-fight-123-abc",
  image: `sha256:${"a".repeat(64)}`, task: "Read and fix this fixture.", ...overrides });
const header = (extra = {}) => ({ type: "session", version: 0, id: "parent", createdAt: 1, delegationDepth: 0, ...extra });
const message = (seq, usage) => ({ type: "assistant/message", seq, data: { usage } });
const session = (records, file = "session.jsonl") => ({ file, text: records.map((record) => JSON.stringify(record)).join("\n") + "\n" });

test("DeepSeek CLI requires explicit inputs and rejects duplicate/unknown flags", () => {
  const parsed = parseArgs(args());
  assert.equal(parsed.timeoutSeconds, 600);
  assert.equal(parsed.maxOutputTokens, 8192);
  assert.equal(parsed.model, "/models/local27b.gguf");
  assert.throws(() => parseArgs([...args(), "--output", "/tmp/other"]), /duplicate/);
  assert.throws(() => parseArgs([...args(), "--bad", "x"]), /unknown/);
  assert.throws(() => parseArgs([...args(), "--timeout-seconds", "0"]), /timeout/);
  assert.throws(() => parseArgs(args().slice(2)), /missing workspace/);
});

test("DeepSeek optional output cap is bounded and changes no other provider settings", () => {
  assert.equal(parseArgs([...args(), "--max-output-tokens", "32768"]).maxOutputTokens, 32768);
  assert.equal(parseArgs([...args(), "--max-output-tokens", "1024"]).maxOutputTokens, 1024);
  for (const value of ["0", "1023", "32769", "8192.5", "NaN", "Infinity"]) {
    assert.throws(() => parseArgs([...args(), "--max-output-tokens", value]), /max output tokens/);
  }
  const base = { endpoint: "http://localhost:1234", model: "/models/local27b.gguf" };
  const original = JSON.parse(buildPatch(base));
  const raised = JSON.parse(buildPatch({ ...base, maxOutputTokens: 32768 }));
  const raisedModel = raised.find(row => row.id === "llm-pi-ai").config.providers["local-fight"].models[0];
  assert.equal(raisedModel.maxTokens, 32768);
  assert.equal(raisedModel.contextWindow, 65536);
  raisedModel.maxTokens = 8192;
  assert.deepEqual(raised, original);
  assert.throws(() => buildPatch({ ...base, maxOutputTokens: "32768" }), /max output tokens/);
});

test("DeepSeek loopback proxy URL preserves arbitrary port and existing API prefix", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:45678"), "http://127.0.0.1:45678/v1");
  assert.equal(normalizeEndpoint("http://localhost:45678/v1/"), "http://localhost:45678/v1");
  assert.equal(normalizeEndpoint("http://[::1]:45678/custom"), "http://[::1]:45678/custom");
  for (const value of ["http://example.com", "http://user:pass@localhost", "file:///tmp", "http://localhost/?secret=x"]) {
    assert.throws(() => normalizeEndpoint(value), /endpoint/);
  }
});

test("DeepSeek patch selects exact local model without injecting YAML or cloud fallback", () => {
  const model = '/models/a "quoted" !!js model.gguf';
  const patch = JSON.parse(buildPatch({ endpoint: "http://localhost:1234", model }));
  assert.deepEqual(patch.find((row) => row.id === "agent-default-model").config, { provider: "local-fight", model });
  assert.equal(patch.find((row) => row.id === "llm-deepseek").disabled, true);
  const route = patch.find((row) => row.id === "llm-pi-ai").config.providers["local-fight"];
  assert.equal(route.baseURL, "http://localhost:1234/v1");
  assert.deepEqual(route.models, [{ id: model, contextWindow: 65536, maxTokens: 8192 }]);
  assert.equal(route.compat.maxTokensField, "max_tokens");
  assert.equal(route.compat.supportsUsageInStreaming, true);
  assert.equal(patch.find((row) => row.id === "session-persistence-jsonl").config.compression, "none");
});

test("DeepSeek Docker mounts only disposable candidate, native home and read-only config", () => {
  const built = docker();
  const mounts = built.filter((value, index) => built[index - 1] === "--mount");
  assert.deepEqual(mounts, [
    "type=bind,src=/tmp/candidate,dst=/workspace",
    "type=bind,src=/tmp/attempt/native-home,dst=/dsh",
    "type=bind,src=/tmp/attempt/fight.patch.yml,dst=/run/fight.patch.yml,readonly",
  ]);
  assert.ok(built.includes("--read-only"));
  assert.ok(built.includes("no-new-privileges"));
  assert.ok(built.includes("DSH_TELEMETRY_DISABLED=1"));
  assert.ok(built.includes("DSH_PERMISSION_MODE=danger-full-access"));
  assert.equal(built[built.indexOf("--network") + 1], "host");
  assert.deepEqual(built.slice(-6), ["--profile", "headless", "--patch", "/run/fight.patch.yml", "--", "Read and fix this fixture."]);
  assert.equal(built.some((value) => value.includes("auth.json") || value.includes("docker.sock")), false);
});

test("DeepSeek container builder rejects broad, ambiguous, or overlapping targets", () => {
  for (const workspace of ["/", os.homedir(), REPO, path.dirname(REPO), "/tmp/a,b", "relative"]) {
    assert.throws(() => docker({ workspace }));
  }
  assert.throws(() => docker({ image: "node:latest" }), /immutable/);
  assert.throws(() => docker({ name: "unowned-container" }), /owned/);
  assert.throws(() => docker({ home: "/tmp/candidate/state" }), /outside/);
  assert.throws(() => docker({ task: "\0" }), /task/);
});

test("DeepSeek native accounting uses disjoint cache categories and excludes inherited/stream duplicates", () => {
  const summary = summarizeSessionTexts([
    session([header(), { ...message(1, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 3 }),
      data: { usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 3 },
        message: { content: [{ type: "tool-call", name: "bash" }] } } },
      { type: "assistant/chunk", seq: 2, data: { chunk: { type: "usage", usage: { inputTokens: 999 } } } },
      { type: "tool/call", seq: 3, data: {} }, { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } }]),
    session([header({ id: "child", parentSession: "parent", seedLength: 4 }),
      message(1, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 3 }),
      message(5, { inputTokens: 7, outputTokens: 2 })], "child/session.jsonl"),
  ]);
  assert.equal(summary.inputTokens, 130);
  assert.equal(summary.freshInputTokens, 30);
  assert.equal(summary.cachedInputTokens, 100);
  assert.equal(summary.cacheWriteTokens, 3);
  assert.equal(summary.inputTokens - summary.cachedInputTokens, summary.freshInputTokens);
  assert.equal(summary.outputTokens, 7);
  assert.equal(summary.assistantMessages, 2);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.usageAvailable, true);
});

test("DeepSeek native usage is unavailable on malformed/unknown/duplicate logs", () => {
  assert.equal(summarizeSessionTexts([]).usageAvailable, false);
  const valid = session([header(), message(1, { inputTokens: 4, outputTokens: 2 })]);
  const duplicate = summarizeSessionTexts([valid, valid]);
  assert.equal(duplicate.inputTokens, 4);
  assert.equal(duplicate.usageAvailable, false);
  assert.equal(duplicate.errors.length, 1);
  assert.equal(summarizeSessionTexts([session([header({ version: 9 })])]).errors.length, 1);
  assert.equal(summarizeSessionTexts([session([header(), message(1, { inputTokens: -1, outputTokens: 2 })])]).usageAvailable, false);
});

test("DeepSeek session collector does not follow worker-created symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-native-logs-"));
  try {
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions);
    fs.mkdirSync(path.join(root, "outside"));
    fs.writeFileSync(path.join(root, "outside", "session.jsonl"), session([header()]).text);
    fs.symlinkSync(path.join(root, "outside"), path.join(sessions, "redirect"));
    const receipt = readNativeSessions(sessions);
    assert.deepEqual(receipt.artifacts, []);
    assert.deepEqual(receipt.skipped, ["redirect"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("published DeepSeek standard profile transmits 32K cap and persists scripted tool/usage evidence", {
  skip: process.env.BANTAM_TEST_DEEPSEEK_DOCKER !== "1", timeout: 90000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-runtime-smoke-"));
  const workspace = path.join(root, "candidate");
  const output = path.join(root, "attempt");
  const taskFile = path.join(root, "task.txt");
  fs.mkdirSync(workspace);
  fs.writeFileSync(taskFile, "Create smoke.txt containing exactly DEEPSEEK_SMOKE_OK followed by a newline, then report completion.");
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ url: request.url, body: parsed });
    const toolResult = parsed.messages.some((message) => message.role === "tool");
    const bash = parsed.tools?.find((tool) => tool.function.name === "bash");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish = null, usage) => response.write(`data: ${JSON.stringify({ id: "smoke-response", object: "chat.completion.chunk", created: 1,
      model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
    if (bash && !toolResult) {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: "smoke-bash", type: "function", function: {
        name: "bash", arguments: JSON.stringify({
          command: "test ! -e /home/operator/.codex && test ! -e /var/run/docker.sock && test ! -w /opt/deepseek/package-lock.json && printf 'DEEPSEEK_SMOKE_OK\\n' > smoke.txt",
          description: "Check isolation and create smoke fixture",
        }),
      } }] });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "DEEPSEEK_SMOKE_OK" });
      emit({}, "stop");
    }
    emit({}, null, { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 100 } });
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runProcess(process.execPath, [path.join(REPO, "scripts/deepseek-fight-cli.mjs"),
      "--workspace", workspace, "--task-file", taskFile, "--output", output,
      "--endpoint", `http://127.0.0.1:${server.address().port}`, "--model", "/models/exact-local27b.gguf", "--timeout-seconds", "45",
      "--max-output-tokens", "32768"],
    { cwd: REPO, timeoutMs: 70000, maxBuffer: 4 * 1024 * 1024 });
    const saved = fs.existsSync(path.join(output, "result.json")) ? JSON.parse(fs.readFileSync(path.join(output, "result.json"))) : null;
    const nativeError = fs.existsSync(path.join(output, "stderr.log")) ? fs.readFileSync(path.join(output, "stderr.log"), "utf8") : "";
    assert.equal(result.code, 0, `${result.stderr}\n${nativeError}\n${JSON.stringify(saved)}`);
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((request) => request.body.model === "/models/exact-local27b.gguf" && request.url === "/v1/chat/completions"));
    const mainRequests = requests.filter(request => request.body.tools?.length);
    const auxiliaryRequests = requests.filter(request => !request.body.tools?.length);
    assert.equal(mainRequests.length, 2);
    assert.ok(mainRequests.every((request) => request.body.max_tokens === 32768), JSON.stringify(requests.map(request => ({
      max_tokens: request.body.max_tokens, max_completion_tokens: request.body.max_completion_tokens, tools: request.body.tools?.length,
    }))));
    // The native standard profile may concurrently request a short session
    // title. Its separate 64-token policy is deliberately not overridden.
    assert.ok(auxiliaryRequests.every(request => request.body.max_tokens === 64));
    const launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json")));
    assert.equal(launch.maxTokens, 32768);
    assert.equal(launch.requestedMaxOutputTokens, 32768);
    assert.equal(launch.contextWindow, 65536);
    assert.equal(fs.readFileSync(path.join(workspace, "smoke.txt"), "utf8"), "DEEPSEEK_SMOKE_OK\n");
    assert.equal(saved.native.usageAvailable, true);
    assert.ok(saved.native.cachedInputTokens >= 200);
    assert.equal(saved.native.toolCalls, 1);
    assert.ok(saved.native.artifacts.length >= 1);
    assert.equal(saved.native.errors.length, 0);
    assert.ok(saved.native.sessions.some((session) => session.turnEndReasons.includes("completed")));
    assert.equal(fs.existsSync(path.join(workspace, "native-home")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (process.env.BANTAM_KEEP_DEEPSEEK_SMOKE === "1") process.stderr.write(`DeepSeek smoke evidence retained at ${root}\n`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek deadline reports interruption and removes only its owned container", {
  skip: process.env.BANTAM_TEST_DEEPSEEK_DOCKER !== "1", timeout: 30000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-deadline-smoke-"));
  const workspace = path.join(root, "candidate");
  const output = path.join(root, "attempt");
  const taskFile = path.join(root, "task.txt");
  fs.mkdirSync(workspace);
  fs.writeFileSync(taskFile, "Wait for the supplied endpoint response.");
  const server = http.createServer(() => { /* Intentionally never finish this scripted response. */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runProcess(process.execPath, [path.join(REPO, "scripts/deepseek-fight-cli.mjs"),
      "--workspace", workspace, "--task-file", taskFile, "--output", output,
      "--endpoint", `http://127.0.0.1:${server.address().port}`, "--model", "deadline-smoke", "--timeout-seconds", "2"],
    { cwd: REPO, timeoutMs: 20000 });
    const saved = JSON.parse(fs.readFileSync(path.join(output, "result.json")));
    assert.equal(result.code, 124, result.stderr);
    assert.equal(saved.process.timedOut, true);
    const launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json")));
    const inspection = await runProcess("docker", ["container", "inspect", launch.name], { timeoutMs: 5000 });
    assert.notEqual(inspection.code, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (process.env.BANTAM_KEEP_DEEPSEEK_SMOKE === "1") process.stderr.write(`DeepSeek deadline evidence retained at ${root}\n`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
});
