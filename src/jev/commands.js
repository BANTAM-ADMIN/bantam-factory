// `:jev` in a BANTAM Factory session and `bantamfactory jev …` on the command line.
// See docs/JEV-MODE.md for the full guide.
import { loadJevConfig, saveJevConfig } from "./config.js";
import { createJevService, effectivePolicy } from "./service.js";

const POLICIES = ["auto", "alongside", "swap", "off"];

export const JEV_USAGE = [
  "  :jev setup              choose your own DiffusionGemma server, or install one (asks first)",
  "  :jev on [port]          start DiffusionGemma and serve the Jev API (default port 8090)",
  "  :jev off                stop serving and stop DiffusionGemma (:jev off keep = keep it loaded)",
  "  :jev status             engine, GPU policy, API address, requests served",
  "  :jev sleep | wake       move DiffusionGemma out of / back into VRAM",
  "  :jev policy <p>         auto | alongside | swap | off (saved to .bantam/jev.json)",
  "  :jev ask <question>     a quick yes/no question; add  | option | option  for a choice",
  "  :jev tool on | off      let the working agent ask Jev mid-task (the decide action)",
].join("\n");

let session = null; // { service, config, active, tool } for this BANTAM process

function current(worker) {
  if (!session) {
    const config = loadJevConfig();
    session = { config, service: createJevService({ config, worker }) };
  } else if (worker) session.service.setWorker(worker);
  return session;
}

function describeStatus(s) {
  const lines = [
    `  Jev engine: ${s.engine} (${s.endpoint}${s.mode ? `, ${s.mode}` : ""})`,
    `  GPU policy: ${s.policy}${s.configuredPolicy === "auto" ? " (auto)" : ""}${s.gpuLease.held ? ` · holding the GPU (${s.gpuLease.state})` : ""}`,
    `  API: ${s.api ? `${s.api.url}/v1/systemone${s.api.auth ? " (token required)" : ""}` : "not serving (:jev on)"}`,
  ];
  if (s.requests) lines.push(`  Served: ${s.requests} requests, ${s.questions} questions, p50 ${s.p50Ms} ms${s.errors ? `, ${s.errors} errors` : ""}${s.swaps.in ? `, ${s.swaps.in} GPU swaps` : ""}`);
  return lines.join("\n");
}

/** Parse `:jev ask` text into a Jev request: yes/no, or a choice with `| a | b`. */
export function askRequest(text, model = "bantam-jev") {
  const [question, ...options] = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (!question) return null;
  const q = options.length >= 2
    ? { type: "choice", instructions: question, criteria: Object.fromEntries(options.map((o) => [o, null])) }
    : { type: "noul", instructions: question };
  return { model, state: "(no material; answer from general knowledge)", questions: { answer: q } };
}

function describeAnswer(answer) {
  if (answer.type === "noul") return `${answer.noul >= 0.5 ? "yes" : "no"} (P(yes) = ${answer.noul.toFixed(3)})`;
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(3)}`).join(", ");
  return `${answer.choice} (confidence ${answer.confidence.toFixed(3)}; ${ranked})`;
}

/**
 * Handle `:jev …` inside a session. `model` is the session's worker (for the
 * GPU policy); `ask(question)` reads the user's answer for the setup wizard.
 */
export async function handleJevCommand(arg, { model = null, out = console.log, ask = null } = {}) {
  const [sub = "status", ...rest] = String(arg).trim().split(/\s+/).filter(Boolean);
  let { service, config } = current(model);
  const runSetup = async () => {
    if (!ask) { out("  Run `bantamfactory jev setup` in a terminal to set up Jev mode."); return false; }
    const { setupWizard } = await import("./setup.js");
    const configured = await setupWizard({ ask, out });
    if (!configured) return false;
    session = null;
    ({ service, config } = current(model));
    return true;
  };
  try {
    switch (sub.toLowerCase()) {
      case "setup":
        await runSetup();
        return;
      case "status":
        out(describeStatus(await service.status()));
        return;
      case "tool": {
        const want = rest[0];
        if (want !== "on" && want !== "off") { out(`  Usage: :jev tool on|off (now: ${session.tool ? "on" : "off"})`); return; }
        session.tool = want === "on";
        out(session.tool
          ? `  The working agent can now ask Jev mid-task (the decide action)${session.active ? "" : "; Jev mode is off, so turn it on with :jev on"}.`
          : "  The decide action is off.");
        return;
      }
      case "on": {
        if (config.engine.mode === "unconfigured") {
          out("  Jev mode is not set up on this machine yet.");
          if (!(await runSetup())) return;
        }
        const port = rest[0] ? Number(rest[0]) : config.api.port;
        out(`  Starting Jev mode (GPU policy: ${effectivePolicy(config, model)})…`);
        const s = await service.on({ port, onProgress: (line) => out(`    ${line}`) });
        session.active = true;
        out(describeStatus(s));
        out(`  Try:  curl -s ${s.api?.url}/v1/systemone -H 'content-type: application/json' \\\n          -d '{"model":"bantam-jev","state":"The build failed","questions":{"broken":{"type":"noul"}}}'`);
        return;
      }
      case "off": {
        const keepEngine = rest[0] === "keep";
        session.active = false;
        out(describeStatus(await service.off({ keepEngine })));
        return;
      }
      case "sleep": await service.sleep(); out("  DiffusionGemma is asleep (weights in host memory)."); return;
      case "wake": await service.wake(); out("  DiffusionGemma is awake."); return;
      case "policy": {
        const policy = rest[0];
        if (!POLICIES.includes(policy)) { out(`  Usage: :jev policy ${POLICIES.join("|")} (now: ${config.gpu.policy})`); return; }
        config.gpu.policy = policy;
        saveJevConfig({ gpu: { policy } });
        out(`  GPU policy: ${policy} (applies now: ${effectivePolicy(config, model)}); saved to .bantam/jev.json`);
        return;
      }
      case "ask": {
        const request = askRequest(rest.join(" "));
        if (!request) { out("  Usage: :jev ask <question>   or   :jev ask <question> | option | option"); return; }
        const started = Date.now();
        const decided = await service.decide({ profile: (await import("./profiles.js")).resolveProfile("bantam-jev"), state: request.state, questions: request.questions, seed: 7 });
        const answer = decided.answers.answer;
        out(`  ${describeAnswer(answer)}  · ${Date.now() - started} ms`);
        return;
      }
      case "help":
        out(JEV_USAGE);
        return;
      default:
        out(JEV_USAGE);
    }
  } catch (error) {
    out(`  Jev: ${error.message}`);
  }
}

/**
 * The working agent's decide tool: a function for runAgent's `jevDecide`, or
 * null (the verb stays out of the grammar) unless Jev mode is on and the
 * operator enabled the tool with `:jev tool on`.
 */
export function jevDecideTool() {
  if (!session?.active || !session.tool) return null;
  const { service } = session;
  return async (action) => {
    const options = String(action.options ?? "").trim();
    const request = askRequest(options ? `${action.q} | ${options}` : action.q);
    if (!request) return "ERROR: decide needs a question in q.";
    const state = String(action.state ?? "").trim() || request.state;
    const started = Date.now();
    try {
      const { resolveProfile } = await import("./profiles.js");
      const decided = await service.decide({ profile: resolveProfile("bantam-jev"), state, questions: request.questions, seed: 7, releaseAfter: true });
      return `JEV (bantam-jev, ${Date.now() - started} ms): ${describeAnswer(decided.answers.answer)}. A fast calibrated judgment, not verification.`;
    } catch (error) {
      return `ERROR: Jev could not answer: ${error.message}`;
    }
  };
}

/** `bantamfactory jev <sub>` on the command line. Returns an exit code. */
export async function runJevCli(argv, { out = console.log, ask = null } = {}) {
  try { return await runJevCliUnsafe(argv, { out, ask }); }
  catch (error) { out(`  Jev: ${error.message}`); return 1; }
}

async function readLineAsk(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } catch { return null; } finally { rl.close(); }
}

async function runJevCliUnsafe(argv, { out, ask }) {
  const [sub = "status", ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(`--${name}`); return i < 0 ? undefined : rest[i + 1]; };
  const has = (name) => rest.includes(`--${name}`);
  const overrides = {};
  if (flag("policy")) overrides.gpu = { policy: flag("policy") };
  if (flag("token") || flag("host") || flag("port")) {
    overrides.api = { ...(flag("token") ? { token: flag("token") } : {}), ...(flag("host") ? { host: flag("host") } : {}), ...(flag("port") ? { port: Number(flag("port")) } : {}) };
  }
  const config = loadJevConfig(overrides);
  // `--worker <endpoint>` names a local llama.cpp worker to share the GPU with (swap policy).
  const worker = flag("worker") ? { endpoint: flag("worker") } : null;
  const service = createJevService({ config, worker, log: has("verbose") ? (e) => out(JSON.stringify(e)) : () => {} });
  switch (sub) {
    case "setup": {
      const { setupWizard } = await import("./setup.js");
      const done = await setupWizard({ ask: ask ?? readLineAsk, out, endpoint: flag("endpoint") ?? null, install: has("install"), yes: has("yes"),
        ...(flag("image") ? { image: flag("image") } : {}), ...(flag("model-dir") ? { modelDir: flag("model-dir") } : {}) });
      return done ? 0 : 1;
    }
    case "status": out(describeStatus(await service.status())); return 0;
    case "start": await (await import("./engine.js")).createJevEngine(config).start({ onProgress: (l) => out(`  ${l}`) }); out("  DiffusionGemma is awake."); return 0;
    case "stop": await service.off(); out("  DiffusionGemma stopped."); return 0;
    case "sleep": await service.sleep(); out("  DiffusionGemma is asleep."); return 0;
    case "wake": await service.wake(); out("  DiffusionGemma is awake."); return 0;
    case "policy": {
      const policy = rest[0];
      if (!POLICIES.includes(policy)) { out(`  Usage: bantamfactory jev policy ${POLICIES.join("|")}`); return 2; }
      saveJevConfig({ gpu: { policy } });
      out(`  GPU policy saved: ${policy}`);
      return 0;
    }
    case "ask": {
      const request = askRequest(rest.filter((r) => !r.startsWith("--")).join(" "));
      if (!request) { out("  Usage: bantamfactory jev ask <question> [| option | option]"); return 2; }
      await service.on({ serve: false });
      const decided = await service.decide({ profile: (await import("./profiles.js")).resolveProfile("bantam-jev"), state: request.state, questions: request.questions, seed: 7 });
      out(`  ${describeAnswer(decided.answers.answer)}`);
      await service.off({ keepEngine: true });
      return 0;
    }
    case "serve": {
      const s = await service.on({ onProgress: (l) => out(`  ${l}`) });
      out(describeStatus(s));
      out("  Serving until Ctrl-C.");
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      out("\n  Stopping…");
      await service.off({ keepEngine: !has("stop-engine") });
      return 0;
    }
    default:
      out([
        "  bantamfactory jev setup [--endpoint URL | --install [--image I] [--model-dir D]] [--yes]",
        "  bantamfactory jev serve [--port 8090] [--host 127.0.0.1] [--token T] [--policy P] [--worker URL] [--stop-engine]",
        "  bantamfactory jev start | stop | sleep | wake | status",
        "  bantamfactory jev policy auto|alongside|swap|off",
        "  bantamfactory jev ask <question> [| option | option]",
      ].join("\n"));
      return sub === "help" ? 0 : 2;
  }
}
