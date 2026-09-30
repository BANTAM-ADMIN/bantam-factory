import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkPrerequisites, installPlan, MODELS, probeEndpoint, runInstall, setupWizard } from "../src/jev/setup.js";

// The chat template closes an empty thought; the reader checks for it.
const SCAFFOLD = [5, 6, 7, 8];
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

// A fake HTTP server: which routes exist decides what kind of server it is.
function fakeServer({ version = "0.29.1+g1b3b88ec2", models = ["dgemma"], structured = true } = {}) {
  const seen = [];
  const ids = new Map([["q1:", 10], ["[", 11], ["]", 12]]);
  const idOf = (piece) => { if (!ids.has(piece)) ids.set(piece, 100 + ids.size); return ids.get(piece); };
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    seen.push(route);
    if (route === "/version") return version ? json(200, { version }) : json(404, { detail: "Not Found" });
    if (route === "/v1/models") return json(200, { data: models.map((id) => ({ id })) });
    if (route === "/is_sleeping") return json(200, { is_sleeping: false });
    if (route === "/tokenize") {
      const body = JSON.parse(init.body);
      // lead/tail/handles tokenize to one id each (a new id per distinct piece); a chat prompt to a few ids.
      if (body.messages) return json(200, { tokens: [1, 2, 3, ...SCAFFOLD] });
      if (body.prompt === "<|channel>thought\n<channel|>") return json(200, { tokens: SCAFFOLD });
      return json(200, { tokens: (String(body.prompt).match(/q1:|\[|\]|[A-Z]+/g) ?? []).map(idOf) });
    }
    if (route === "/v1/chat/completions") {
      if (!structured) return json(400, { error: "unknown field vllm_xargs" });
      const canvas = JSON.parse(init.body).vllm_xargs.diffusion_seed_canvas;
      const slot = canvas.findIndex((id, i) => i > 0 && canvas[i - 1] === 11);
      const rows = canvas.map(() => ({ top_logprobs: [{ token: "token_id:1", logprob: -0.01 }] }));
      rows[slot] = { top_logprobs: [{ token: `token_id:${idOf("AA")}`, logprob: -0.05 }, { token: `token_id:${idOf("AB")}`, logprob: -3 }] };
      return json(200, { choices: [{ logprobs: { content: rows } }], usage: { prompt_tokens: 20 } });
    }
    return json(404, {});
  };
  return { fetchImpl, seen };
}

describe("jev setup: probing an external server", () => {
  it("refuses a non-vLLM server before sending any structured read", async () => {
    const llamaCpp = fakeServer({ version: null, models: ["/models/qwen.gguf"] });
    const probe = await probeEndpoint("http://box:8085", { fetchImpl: llamaCpp.fetchImpl });
    assert.equal(probe.structuredReads, false);
    assert.match(probe.problem, /not a vLLM server/);
    assert.ok(!llamaCpp.seen.includes("/v1/chat/completions") && !llamaCpp.seen.includes("/tokenize"), "no read reaches a server that could crash on it");
  });

  it("refuses a vLLM that cannot do structured reads, naming the build it needs", async () => {
    const plain = fakeServer({ structured: false });
    const probe = await probeEndpoint("http://box:8001", { fetchImpl: plain.fetchImpl });
    assert.equal(probe.structuredReads, false);
    assert.match(probe.problem, /PR #57250/);
  });

  it("accepts DiffusionGemma, and a single model served under another name", async () => {
    const good = await probeEndpoint("http://box:8001/", { fetchImpl: fakeServer().fetchImpl });
    assert.equal(good.structuredReads, true);
    assert.equal(good.endpoint, "http://box:8001");
    assert.equal(good.sleepMode, true);
    const renamed = await probeEndpoint("http://box:8001", { fetchImpl: fakeServer({ models: ["diffusiongemma-26b"] }).fetchImpl });
    assert.equal(renamed.servedModel, "diffusiongemma-26b");
    assert.equal(renamed.structuredReads, true);
  });
});

describe("jev setup: installing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-setup-"));
  const runs = [];
  const fakeRun = (answers) => async (cmd, args) => {
    runs.push([cmd, ...args]);
    const key = `${cmd} ${args[0]}`;
    return answers[key] ?? { ok: true, stdout: "", stderr: "" };
  };

  it("picks the model for the GPU and lists what blocks an install", async () => {
    const ada = await checkPrerequisites({ modelDir: tmp, runImpl: fakeRun({ "docker info": { ok: true, stdout: '{"nvidia":{},"runc":{}}' }, "nvidia-smi --query-gpu=name,memory.total,compute_cap": { ok: true, stdout: "NVIDIA GeForce RTX 4090, 24564, 8.9" } }) });
    assert.equal(ada.model.repo, MODELS.awq.repo);
    assert.deepEqual(ada.problems.filter((p) => !/disk/.test(p)), []);
    const blackwell = await checkPrerequisites({ modelDir: tmp, runImpl: fakeRun({ "docker info": { ok: true, stdout: '{"nvidia":{}}' }, "nvidia-smi --query-gpu=name,memory.total,compute_cap": { ok: true, stdout: "NVIDIA RTX PRO 6000, 97887, 12.0" } }) });
    assert.equal(blackwell.model.repo, MODELS.nvfp4.repo);
    const small = await checkPrerequisites({ modelDir: tmp, runImpl: fakeRun({ "docker version": { ok: false }, "nvidia-smi --query-gpu=name,memory.total,compute_cap": { ok: true, stdout: "NVIDIA GeForce RTX 4070, 12282, 8.9" } }) });
    assert.ok(small.problems.some((p) => /Docker is not available/.test(p)));
    assert.ok(small.problems.some((p) => /needs about 21 GB/.test(p)));
  });

  it("plans the pull and download, runs them as the user, and saves a managed config", async () => {
    process.env.BANTAM_JEV_CONFIG = path.join(tmp, "jev.json");
    try {
      const prerequisites = { model: MODELS.awq, gpu: { name: "RTX 4090", memoryMiB: 24564, computeCap: 8.9 } };
      const plan = await installPlan({ prerequisites, modelDir: tmp, runImpl: fakeRun({ "docker image": { ok: false } }) });
      assert.equal(plan.imagePresent, false);
      assert.equal(plan.modelPresent, false);
      assert.ok(plan.steps.some((s) => /pull the Docker image/.test(s)) && plan.steps.some((s) => /download cyankiwi/.test(s)));
      assert.ok(plan.args.includes("--enable-sleep-mode"));
      runs.length = 0;
      const config = await runInstall(plan, { runImpl: fakeRun({}) });
      assert.deepEqual(runs[0].slice(0, 3), ["docker", "pull", plan.image]);
      const download = runs[1];
      assert.ok(download.includes("--user") && download.includes("download") && download.includes(MODELS.awq.repo));
      assert.equal(config.engine.mode, "managed");
      assert.equal(config.create.modelPath, plan.modelPath);
    } finally { delete process.env.BANTAM_JEV_CONFIG; }
  });

  it("changes nothing when the user declines", async () => {
    process.env.BANTAM_JEV_CONFIG = path.join(tmp, "declined.json");
    try {
      runs.length = 0;
      const lines = [];
      const result = await setupWizard({ install: true, ask: async () => "n", out: (l) => lines.push(l), modelDir: tmp,
        runImpl: fakeRun({ "docker info": { ok: true, stdout: '{"nvidia":{}}' }, "nvidia-smi --query-gpu=name,memory.total,compute_cap": { ok: true, stdout: "RTX 4090, 24564, 8.9" }, "docker image": { ok: false } }) });
      assert.equal(result, null);
      assert.ok(!runs.some((r) => r[1] === "pull" || r.includes("download")), "no pull, no download");
      assert.ok(!fs.existsSync(path.join(tmp, "declined.json")), "no config written");
      assert.ok(lines.some((l) => /Nothing was downloaded or changed/.test(l)));
    } finally { delete process.env.BANTAM_JEV_CONFIG; }
  });
});
