// The Jev toolset: calibrated yes/no, choice and score judgments from Jev
// mode's DiffusionGemma System One engine, in the Jev wire format.
//
// The engine starts on the first question, not with the server. GPU sharing
// with the local llama.cpp worker is Jev mode's own swap policy; while a local
// job runs, each answer hands the GPU straight back to it.
import crypto from "node:crypto";

import { answerConfidence, JevBusy, JevUnavailable, normalizeAnswer, planQuestions, validateSystemOne } from "../../jev/api.js";
import { resolveProfile } from "../../jev/profiles.js";
import { ToolError } from "../protocol.js";

const MODELS = ["bantam-jev", "bantam-jev-fast", "openjev-latest"];
const MAX_QUESTIONS = 64;

export function describeAnswer(id, answer) {
  if (answer.type === "noul") return `${id}: ${answer.noul >= 0.5 ? "yes" : "no"} (P(yes) ${answer.noul.toFixed(3)})`;
  if (answer.type === "choice") return `${id}: ${answer.choice} (confidence ${answer.confidence.toFixed(3)})`;
  return `${id}: level ${answer.score} "${answer.legend[String(answer.score)] ?? ""}" (confidence ${answer.confidence.toFixed(3)})`;
}

async function defaultServiceFactory({ localEndpoint }) {
  const { loadJevConfig } = await import("../../jev/config.js");
  const { createJevService } = await import("../../jev/service.js");
  const { createJevEngine, JevNotConfigured } = await import("../../jev/engine.js");
  const config = loadJevConfig();
  if (config.engine.mode === "unconfigured") throw new JevNotConfigured();
  // Leave an engine someone else started running when this server stops.
  const wasAwake = (await createJevEngine(config).status()).state === "awake";
  const service = createJevService({ config, worker: { endpoint: localEndpoint } });
  await service.on({ serve: false });
  return { service, keepEngine: wasAwake };
}

export function createJevToolset({ localEndpoint = "http://127.0.0.1:8085", serviceFactory = defaultServiceFactory } = {}) {
  let ctx = null, pending = null, started = null;

  function ensure() {
    if (!pending) {
      pending = serviceFactory({ localEndpoint }).then((value) => (started = value), (error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  }

  async function decide({ state, questions, model = "bantam-jev" }) {
    const { fieldErrors, unknownType } = validateSystemOne({ model, state, questions });
    if (fieldErrors.length) throw new ToolError(`Invalid Jev request: ${fieldErrors.map((e) => `${e.loc.slice(1).join(".")}: ${e.msg}`).join("; ")}`);
    if (unknownType) throw new ToolError("Each question's type must be noul (yes/no), choice (criteria: {option: description|null}) or score (criteria: [level descriptions, lowest first])");
    const profile = resolveProfile(model);
    const plan = planQuestions(questions, { maxQuestions: MAX_QUESTIONS });
    if (plan.error) throw new ToolError(plan.error);
    const answers = { ...plan.forced };
    const t0 = Date.now();
    if (Object.keys(plan.toRead).length) {
      let service;
      try { ({ service } = await ensure()); }
      catch (error) { throw new ToolError(`Jev is not available: ${error.message}`); }
      const seed = crypto.createHash("sha256").update(JSON.stringify([state, questions])).digest().readUInt32BE(0);
      let decided;
      try {
        decided = await service.decide({ profile, state, questions: plan.toRead, seed, releaseAfter: ctx.localJobRunning?.() ?? false });
      } catch (error) {
        if (error instanceof JevBusy || error instanceof JevUnavailable) throw new ToolError(`Jev could not answer now: ${error.message}`);
        throw error;
      }
      for (const [id, q] of Object.entries(plan.toRead)) answers[id] = normalizeAnswer(q, decided.answers[id]);
    }
    const ordered = Object.fromEntries(Object.keys(questions).map((id) => [id, answers[id]]));
    return {
      model: profile.name,
      summary: Object.entries(ordered).map(([id, a]) => describeAnswer(id, a)).join("\n"),
      answers: ordered,
      confidence: Object.fromEntries(Object.entries(ordered).map(([id, a]) => [id, Number(answerConfidence(a).toFixed(3))])),
      ms: Date.now() - t0,
      note: "A fast calibrated judgment from a local model, not verification.",
    };
  }

  return {
    name: "jev",
    start(context) { ctx = context; },
    async stop() {
      const value = started ?? (pending ? await pending.catch(() => null) : null);
      if (value) await value.service.off({ keepEngine: value.keepEngine });
    },
    tools: [
      {
        name: "jev_decide",
        description: "Ask BANTAM's local Jev engine (DiffusionGemma System One) for calibrated judgments about some material: yes/no (noul), pick one option (choice) or rate on a scale (score), each with probabilities. Fast and cheap, good for triage, ranking candidates, or consistency checks over text; not a substitute for verification. The first call may take minutes while the engine loads. Example questions: {\"canon\": {\"type\": \"noul\", \"instructions\": \"Does the passage contradict the character notes?\"}, \"best\": {\"type\": \"choice\", \"instructions\": \"Which opening is strongest?\", \"criteria\": {\"A\": null, \"B\": null}}, \"tension\": {\"type\": \"score\", \"instructions\": \"How tense is the scene?\", \"criteria\": [\"flat\", \"some\", \"gripping\"]}}",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["state", "questions"],
          properties: {
            state: { type: ["string", "object", "array"], description: "The material to judge (text or JSON)." },
            questions: { type: "object", description: "Question id → {type: noul|choice|score, instructions, criteria?}." },
            model: { type: "string", enum: MODELS, description: "bantam-jev (default, thinks when unsure) or bantam-jev-fast." },
          },
        },
        handler: async (a) => decide(a),
      },
      {
        name: "jev_status",
        description: "Jev engine status: whether it has started, GPU policy, request counts and latency.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        handler: async () => started ? started.service.status() : { started: false, note: pending ? "starting" : "Jev starts on the first jev_decide." },
      },
    ],
  };
}
