import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCodexapiConfig, findCodexapiCheckout, codexapiChoices, bridgeStatus, launchBridge } from "../src/codexapi-bridge.js";
import { startupModelChoices } from "../src/startup-model-choice.js";

// codexapi (an OpenAI-compatible bridge over the codex CLI) as a startup option
// beside the local models and the Codex app-server: selecting it brings the
// bridge up if it is down and leaves BANTAM configured on the chat dialect with
// sessions. Nothing here hardcodes one developer's paths: the checkout is found
// by env, by the saved setting, or by walking up from the repo for a sibling.

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("config precedence: env, then saved settings, then defaults", () => {
  assert.deepEqual(resolveCodexapiConfig({ env: {}, settings: {} }), { url: "http://127.0.0.1:8787/v1", key: null, dir: null, source: "default" });
  assert.equal(resolveCodexapiConfig({ env: {}, settings: { codexapi: { url: "http://10.0.0.5:8787/v1", key: "k", dir: "/x" } } }).url, "http://10.0.0.5:8787/v1");
  const fromEnv = resolveCodexapiConfig({ env: { BANTAM_CODEXAPI_URL: "http://h:1/v1/", BANTAM_CODEXAPI_KEY: "e", BANTAM_CODEXAPI_DIR: "/d" }, settings: { codexapi: { url: "http://10.0.0.5:8787/v1" } } });
  assert.deepEqual(fromEnv, { url: "http://h:1/v1", key: "e", dir: "/d", source: "env" });
});

test("the checkout is discovered as a sibling of the repo or its parents", (t) => {
  const root = tmp(t, "bantam-codexapi-find-");
  const repo = path.join(root, "projects", "bantam");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(findCodexapiCheckout({ repoRoot: repo, home: root }), null);
  fs.mkdirSync(path.join(root, "codexapi", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "codexapi", "bin", "codexapi.js"), "");
  assert.equal(findCodexapiCheckout({ repoRoot: repo, home: "/nonexistent" }), path.join(root, "codexapi"));
});

test("picker entries: one per recommended bridge model, marked launchable when the bridge is down", () => {
  const models = [
    { id: "gpt-5.3-codex-spark", display_name: "GPT-5.3-Codex-Spark", description: "Ultra-fast coding model.", supported_reasoning_efforts: ["low", "medium", "high"], default_reasoning_effort: "high" },
    { id: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", description: "Fast and affordable.", supported_reasoning_efforts: ["low", "medium"], default_reasoning_effort: "medium" },
  ];
  const up = codexapiChoices({ status: { reachable: true, models }, config: { url: "http://h:8787/v1", key: "k", dir: "/d" }, preference: { kind: "codexapi", model: "gpt-5.6-luna", effort: "low" } });
  assert.equal(up.length, 2);
  assert.equal(up[0].kind, "codexapi");
  assert.match(up[0].label, /codexapi · GPT-5\.3-Codex-Spark · low reasoning/, "spark defaults to low: dumb-fast is the point");
  assert.equal(up[1].effort, "low", "a remembered effort wins for that model");
  assert.equal(up[1].lastUsed, true);
  assert.equal(up[0].launch, false);
  const down = codexapiChoices({ status: { reachable: false, models: [] }, config: { url: "http://h:8787/v1", key: null, dir: "/d" }, preference: null });
  assert.ok(down.length >= 1);
  assert.equal(down[0].launch, true);
  assert.match(down[0].detail, /start it from \/d/);
  assert.deepEqual(codexapiChoices({ status: { reachable: false, models: [] }, config: { url: "http://h:8787/v1", key: null, dir: null }, preference: null }), [], "down and no checkout: nothing to offer");
});

test("startupModelChoices lists bridge entries after the Codex app-server entries and before DeepSeek", () => {
  const bridge = [{ kind: "codexapi", name: "codexapi-spark", label: "codexapi · spark", model: "gpt-5.3-codex-spark", effort: "low", recommended: false, lastUsed: false }];
  const c = startupModelChoices({ locals: [], catalog: [], preference: null, codexapi: bridge });
  const kinds = c.map((x) => x.kind);
  assert.equal(kinds.at(-1), "deepseek");
  assert.equal(kinds.at(-2), "codexapi");
});

test("launchBridge starts the checkout detached and waits for /v1/models", async (t) => {
  const dir = tmp(t, "bantam-codexapi-launch-");
  fs.mkdirSync(path.join(dir, "bin"));
  // A stand-in bridge: honors CODEXAPI_PORT/HOST/KEY, answers /v1/models.
  fs.writeFileSync(path.join(dir, "bin", "codexapi.js"), `
    const http = require("node:http");
    const key = process.env.CODEXAPI_KEY;
    http.createServer((req, res) => {
      if (key && req.headers.authorization !== "Bearer " + key) { res.writeHead(401); return res.end("{}"); }
      if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "gpt-5.3-codex-spark" }] })); }
      res.writeHead(404); res.end();
    }).listen(Number(process.env.CODEXAPI_PORT), process.env.CODEXAPI_HOST || "127.0.0.1");
  `);
  const port = 18000 + Math.floor(Math.random() * 2000);
  const url = `http://127.0.0.1:${port}/v1`;
  assert.equal((await bridgeStatus(url, "k")).reachable, false);
  const started = await launchBridge({ dir, url, key: "k", waitMs: 10000, out: () => {} });
  t.after(() => { try { process.kill(started.pid); } catch { /* already gone */ } });
  assert.equal(started.url, url);
  const status = await bridgeStatus(url, "k");
  assert.equal(status.reachable, true);
  assert.equal(status.models[0].id, "gpt-5.3-codex-spark");
});

test("a bridge that is up but rejects the key asks for the key rather than launching a second instance", () => {
  const cfg = { url: "http://h:8787/v1", key: null, dir: "/d" };
  const c = codexapiChoices({ status: { reachable: false, models: [], status: 401 }, config: cfg, preference: null });
  assert.ok(c.length >= 1);
  assert.equal(c[0].launch, false);
  assert.equal(c[0].needsKey, true);
  assert.match(c[0].detail, /needs its API key/);
});
