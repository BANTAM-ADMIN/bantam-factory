#!/usr/bin/env node
// Live demonstration of Jev mode's swap policy: a local llama.cpp worker and
// DiffusionGemma share one GPU. Plays both sides (the agent's local calls and a
// burst of Jev questions) and records timings and GPU memory at each step to
// docs/jev-demos/swap.json. Used for JEV_MODE.md.
//
//   node scripts/jev-swap-demo.mjs [--worker http://127.0.0.1:8085] [--burst-ms 8000]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadJevConfig } from "../src/jev/config.js";
import { createJevService } from "../src/jev/service.js";
import { resolveProfile } from "../src/jev/profiles.js";
import { waitForImageGpu } from "../src/image-gpu.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const worker = { endpoint: arg("worker", "http://127.0.0.1:8085") };
const config = loadJevConfig({ gpu: { policy: "auto", burstMs: Number(arg("burst-ms", "8000")) } });
const service = createJevService({ config, worker, log: (e) => { if (e.event?.startsWith("jev_swap")) note(`service: ${e.event}`); } });
const profile = resolveProfile("bantam-jev-fast");
const t0 = performance.now();
const events = [];
const gpu = () => Number(execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).trim());
const props = async () => (await (await fetch(`${worker.endpoint}/props`)).json()).is_sleeping;
const dgSleeping = async () => (await (await fetch(`${config.endpoint}/is_sleeping`)).json()).is_sleeping;
function note(what, extra = {}) {
  const entry = { t: +((performance.now() - t0) / 1000).toFixed(2), what, gpuMiB: gpu(), ...extra };
  events.push(entry);
  console.log(`${String(entry.t).padStart(7)} s  ${String(entry.gpuMiB).padStart(6)} MiB  ${what}${Object.keys(extra).length ? `  ${JSON.stringify(extra)}` : ""}`);
}
async function agentCall(label) {
  await waitForImageGpu(worker.endpoint);          // what src/model.js does before every local call
  const s = performance.now();
  const r = await fetch(`${worker.endpoint}/completion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Say OK.", n_predict: 4, temperature: 0 }) });
  await r.json();
  note(label, { ms: Math.round(performance.now() - s), qwenSleeping: await props(), jevSleeping: await dgSleeping() });
}
async function ask(label, question) {
  const s = performance.now();
  const out = await service.decide({ profile, state: question.state, questions: { q: question.q }, seed: 1 });
  const a = out.answers.q;
  note(label, { ms: Math.round(performance.now() - s), answer: a.type === "noul" ? +a.noul.toFixed(3) : a.choice });
}

console.log(`worker ${worker.endpoint}, GPU policy ${service ? "auto" : ""} -> swap, burst window ${config.gpu.burstMs} ms`);
note("start", { qwenSleeping: await props(), jevSleeping: await dgSleeping() });
await agentCall("agent: local Qwen call (worker busy)");
// A Jev burst arrives while the agent is working.
const agentWaiting = (async () => { await delay(300); note("agent: next local call requested (waits on the GPU lease)"); await agentCall("agent: local Qwen call completes (after Jev hands the GPU back)"); })();
await ask("jev #1 (swap in: Qwen idle-sleeps, DiffusionGemma wakes)", { state: "The deploy failed with exit code 137 after memory climbed to the container limit.", q: { type: "noul", instructions: "Was the process killed for running out of memory?" } });
await ask("jev #2 (burst, GPU already held)", { state: "Customer: 'please cancel my subscription, I'm moving abroad'", q: { type: "choice", instructions: "Intent?", criteria: { cancel: "cancel the subscription", upgrade: "upgrade", billing_question: "question about a charge" } } });
await ask("jev #3 (burst)", { state: "Test output: 12 passed, 0 failed.", q: { type: "noul", instructions: "Did the test suite pass?" } });
await ask("jev #4 (burst)", { state: "Test output: 11 passed, 1 failed (test_login_timeout).", q: { type: "noul", instructions: "Did the test suite pass?" } });
note("jev burst over; waiting for the burst window to close");
await agentWaiting;
note("end", { qwenSleeping: await props(), jevSleeping: await dgSleeping(), status: await service.status().then((s) => ({ swaps: s.swaps, requests: s.requests, p50Ms: s.p50Ms })) });
fs.writeFileSync("docs/jev-demos/swap.json", JSON.stringify({ worker: worker.endpoint, burstMs: config.gpu.burstMs, events }, null, 1));
await service.off({ keepEngine: true });
