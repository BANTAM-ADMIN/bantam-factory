import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asksForProbability, buildReadCanvas, compileHandlePool, createStructuredReader, decideJev, decideJevAdaptive, decideJevDeep, decideJevThink, isQuantitative, rackOptions, readSlotDistribution, seededNoise, selectAllGroup, systemOneDecide, temperProbs } from "../src/factory.js";

const SCAFFOLD = [100, 45518, 107, 101];

// A tokenizer where each word is one token id, with "[HANDLE]" split as
// "[", HANDLE, "]" and a few multi-token handles.
function fakeServer({ promptTail = SCAFFOLD, slotLogprobs = {}, onChat = () => {} } = {}) {
  const vocab = new Map([["q1:", 10], [" ", 11], ["[", 12], ["]", 13], ["TNF", 50], ["VRDR", 51], ["TMP", 52], ["TWO", 53]]);
  const tokenize = (text) => {
    if (text === "<|channel>thought\n<channel|>") return SCAFFOLD;
    const out = [];
    for (const part of text.match(/q1:|\s|\[|\]|[A-Z]+/g) ?? []) {
      if (part === "SPLIT") out.push(60, 61);
      else out.push(vocab.get(part) ?? 99);
    }
    return out;
  };
  return async (url, init) => {
    const body = JSON.parse(init.body);
    let payload;
    if (url.endsWith("/tokenize")) payload = { tokens: body.messages ? [1, 2, 3, ...promptTail] : tokenize(body.prompt) };
    else {
      onChat(body);
      const slot = body.vllm_xargs.diffusion_seed_canvas.findIndex((id, i) => i > 0 && body.vllm_xargs.diffusion_seed_canvas[i - 1] === 12);
      const rows = body.vllm_xargs.diffusion_seed_canvas.slice(0, body.max_tokens).map(() => ({ top_logprobs: [{ token: "token_id:1", logprob: -0.01 }] }));
      rows[slot] = { top_logprobs: Object.entries(slotLogprobs).map(([id, logprob]) => ({ token: `token_id:${id}`, logprob })) };
      payload = { choices: [{ logprobs: { content: rows } }], usage: { prompt_tokens: 42 } };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

describe("factory System One structured reads", () => {
  it("replays the same noise draw for the same seed", () => {
    const a = buildReadCanvas({ templateIds: [10, 11, 12, 50, 13], slot: 3, seed: 7, vocabularySize: 1000 });
    const b = buildReadCanvas({ templateIds: [10, 11, 12, 50, 13], slot: 3, seed: 7, vocabularySize: 1000 });
    assert.deepEqual(a.canvas, b.canvas);
    assert.equal(a.width, 16);
    assert.equal(a.canvas[5], 106);
    assert.equal(a.canvas.at(-1), 0);
    assert.equal(seededNoise(7)(1000), a.canvas[3]);
  });

  it("reports absolute label mass beside the renormalized choice", () => {
    const labels = [{ label: "TNF", tokenId: 50 }, { label: "VRDR", tokenId: 51 }];
    const clean = readSlotDistribution({ labels, logprobs: { 51: Math.log(0.97), 50: Math.log(0.01) } });
    assert.equal(clean.choice, "VRDR");
    assert.ok(Math.abs(clean.labelMass - 0.98) < 1e-9);
    assert.equal(clean.slotLeaderIsLabel, true);

    // Same renormalized answer, but most of the slot sits on a token nobody issued.
    const leaking = readSlotDistribution({ labels, logprobs: { 1: Math.log(0.85), 51: Math.log(0.14), 50: Math.log(0.001) } });
    assert.equal(leaking.choice, "VRDR");
    assert.ok(leaking.probability > 0.99);
    assert.ok(leaking.offLabelMass > 0.8);
    assert.equal(leaking.slotLeaderIsLabel, false);
  });

  it("bounds a label vLLM did not return by the smallest returned logprob", () => {
    const labels = [{ label: "TNF", tokenId: 50 }, { label: "VRDR", tokenId: 51 }];
    const read = readSlotDistribution({ labels, logprobs: { 51: -0.1, 1: -3 } });
    assert.deepEqual(read.missingLabels, ["TNF"]);
    assert.ok(read.probabilities.TNF > 0);
  });

  it("omits the thought scaffold when the prompt already closes it", async () => {
    const reader = createStructuredReader({ baseUrl: "http://fixture", model: "m", fetchImpl: fakeServer() });
    const head = await reader.canvasHead();
    assert.equal(head.promptClosesThought, true);
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: ["TNF", "VRDR"] });
    assert.deepEqual(compiled.templateIds, [10, 11, 12, 50, 13]);
    assert.equal(compiled.slot, 3);
  });

  it("puts the scaffold on the canvas when the prompt leaves the thought open", async () => {
    const reader = createStructuredReader({ baseUrl: "http://fixture", model: "m", fetchImpl: fakeServer({ promptTail: [7, 8, 9, 5] }) });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: ["TNF", "VRDR"] });
    assert.deepEqual(compiled.templateIds.slice(0, 4), SCAFFOLD);
    assert.equal(compiled.slot, 7);
  });

  it("refuses labels that do not occupy one shared slot or that collide", async () => {
    const reader = createStructuredReader({ baseUrl: "http://fixture", model: "m", fetchImpl: fakeServer() });
    await assert.rejects(reader.compileLabels({ lead: "q1: [", tail: "]", labels: ["TNF", "SPLIT"] }), /one shared template slot/);
    await assert.rejects(reader.compileLabels({ lead: "q1: [", tail: "]", labels: ["TNF", "QQ", "ZZ"] }), /collide/);
    await assert.rejects(reader.compileLabels({ lead: "q1: [", labels: ["TNF"] }), /at least two labels/);
  });

  it("sends a read-only one-step request and reads the slot", async () => {
    let sent;
    const reader = createStructuredReader({ baseUrl: "http://fixture/", model: "m", fetchImpl: fakeServer({ slotLogprobs: { 51: -0.02, 50: -6 }, onChat: (body) => { sent = body; } }) });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: ["TNF", "VRDR"] });
    const read = await reader.read({ system: "s", user: "u", compiled, seed: 3 });
    assert.equal(read.choice, "VRDR");
    assert.equal(read.promptTokens, 42);
    assert.deepEqual(sent.logprob_token_ids, [50, 51]);
    assert.equal(sent.vllm_xargs.diffusion_read_only, true);
    assert.equal(sent.vllm_xargs.diffusion_max_steps, 1);
    assert.equal(sent.temperature, undefined);
    assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  });

  it("finds the slot where labels differ when the lead's trailing space folds into the label", async () => {
    // "q1: " alone ends in a space token; "q1: yes" folds the space into " yes".
    const vocab = { "q1: ": [10, 11, 12, 20], "q1: yes": [10, 11, 12, 30], "q1: no": [10, 11, 12, 31] };
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      const tokens = body.messages ? [1, ...SCAFFOLD] : vocab[body.prompt] ?? SCAFFOLD;
      return { ok: true, status: 200, text: async () => JSON.stringify({ tokens }) };
    };
    const reader = createStructuredReader({ baseUrl: "http://fixture", model: "m", fetchImpl });
    const compiled = await reader.compileLabels({ lead: "q1: ", labels: ["yes", "no"] });
    assert.equal(compiled.slot, 3);
    assert.deepEqual(compiled.labels.map((row) => row.tokenId), [30, 31]);
  });

  it("compiles only handles that are one unique token in the bracket template", async () => {
    // Two-letter handles are one token; three-letter ones split in two, and
    // "AB" and "BA" collide on a token.
    const tokenize = async (text) => {
      const out = [10, 11, 12];
      const handle = text.slice(5, -1);
      if (handle.length === 3) out.push(900, 901);
      else if (handle === "BA") out.push(1000 + 1);
      else out.push(1000 + (handle.charCodeAt(0) - 65) * 26 + (handle.charCodeAt(1) - 65));
      out.push(13);
      return text === "q1: [" ? [10, 11, 12] : text === "]" ? [13] : out;
    };
    const pool = await compileHandlePool({ tokenize }, { size: 5 });
    assert.deepEqual(pool.map((row) => row.handle), ["AA", "AB", "AC", "AD", "AE"]);
    assert.equal(new Set(pool.map((row) => row.tokenId)).size, 5);
    const scarce = async (text) => (text === "q1: [" ? [10, 11, 12] : text === "]" ? [13] : ["q1: [AA]", "q1: [AB]"].includes(text) ? [10, 11, 12, text.charCodeAt(6), 13] : [10, 11, 12, 900, 901, 13]);
    await assert.rejects(compileHandlePool({ tokenize: scarce }, { size: 3 }), /only 2 single-token handles/);
  });

  it("racks arbitrary options under handles and maps the answer back", () => {
    const pool = ["AA", "AB", "AC", "AD", "AE"].map((handle, i) => ({ handle, tokenId: 1000 + i }));
    const options = ["spec gap", "harness bug", { kind: "model limit" }];
    const rack = rackOptions(pool, options, { seed: 4 });
    assert.equal(rack.labels.length, 3);
    for (const row of rack.rows) {
      assert.equal(rack.optionOf(row.handle), options[row.optionIndex]);
      assert.match(rack.material, new RegExp(`\\[${row.handle}\\] `));
    }
    assert.match(rack.material, /\{"kind":"model limit"\}/);
    assert.deepEqual(rackOptions(pool, options, { seed: 4 }).labels, rack.labels);
    assert.notDeepEqual(rackOptions(pool, options, { seed: 5 }).labels, rack.labels);
    assert.throws(() => rackOptions(pool.slice(0, 2), options), /exceed/);
  });

  it("answers Jev questions by averaging differently ordered and worded racks", async () => {
    // A reader that always favours whichever handle sits next to "billing" or
    // "yes", wherever the rack put it.
    const asked = [];
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => {
        asked.push(user);
        const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] (billing|yes|level 2)`).test(user)).label;
        const probabilities = Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? 0.9 : 0.1 / (compiled.labels.length - 1)]));
        return { choice: favoured, probability: 0.9, probabilities, labelMass: 1, elapsedMs: 1 };
      },
    };
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const { answers, evidence } = await decideJev({
      reader,
      pool,
      state: "Customer was charged twice.",
      questions: {
        topic: { type: "choice", criteria: { shipping: null, billing: "money questions", legal: null } },
        refund: { type: "noul", instructions: "A refund is owed.", criteria: { true: "charged twice", false: "charged once" } },
        urgency: { type: "score", criteria: ["low", "medium", "high"] },
        only: { type: "choice", criteria: { single: null } },
      },
      racks: 3,
      seed: 11,
    });
    assert.equal(answers.topic.choice, "billing");
    assert.ok(Math.abs(answers.topic.probabilities.billing - 0.9) < 1e-9);
    assert.ok(Math.abs(answers.refund.noul - 0.9) < 1e-9);
    assert.ok(Math.abs(answers.urgency.score - (0.05 * 0 + 0.05 * 1 + 0.9 * 2)) < 1e-9);
    assert.equal(answers.only.choice, "single");
    assert.equal(evidence.topic.length, 3);
    assert.ok(asked.every((user) => user.startsWith("Customer was charged twice.")), "the state leads every rack so racks share a cached prefix");
    const topicAsks = asked.slice(0, 3).map((user) => user.split("\n").at(-1));
    assert.equal(new Set(topicAsks).size, 3, "each rack words the question differently");
    await assert.rejects(decideJev({ reader, pool, state: "s", questions: {}, racks: 9 }), /racks must be/);
  });

  it("deep profile: calculator results reach every read, agreement releases, disagreement duels", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    // `fastFavours` / `thinkFavours` name the option each kind of read leans to;
    // duels favour "billing" whatever order it appears in.
    function reader({ fastFavours, thinkFavours }) {
      const users = [];
      const favour = (compiled, user, key) => {
        const label = compiled.labels.find(({ label: handle }) => new RegExp(`\\[${handle}\\] ${key}`).test(user))?.label ?? compiled.labels[0].label;
        return Object.fromEntries(compiled.labels.map(({ label: handle }) => [handle, handle === label ? 0.9 : 0.1 / (compiled.labels.length - 1)]));
      };
      return {
        users,
        complete: async () => ({ text: "total = 2 * 21\nNONE", promptTokens: 100 }),
        compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
        read: async ({ user, compiled }) => { users.push(user); return { probabilities: favour(compiled, user, fastFavours), promptTokens: 10 }; },
        thinkAnswer: async ({ user, compiled }) => {
          users.push(user);
          const duel = /Which ONE of these two/.test(user);
          return { answered: true, probabilities: favour(compiled, user, duel ? "billing" : thinkFavours), promptTokens: 20, thoughtTokens: 50 };
        },
      };
    }
    const questions = { topic: { type: "choice", criteria: { shipping: null, billing: null, legal: null } } };

    const agree = reader({ fastFavours: "billing", thinkFavours: "billing" });
    const one = await decideJevDeep({ reader: agree, pool, state: "Charged twice.", questions, seed: 3 });
    assert.equal(one.answers.topic.choice, "billing");
    assert.equal(one.evidence.topic.some((step) => step.step === "duel"), false);
    assert.ok(agree.users.every((user) => user.includes("total = 2 * 21  →  42")), "calculator results reach every read");
    assert.equal(one.usage.inputTokens, 100 + 3 * 10 + 20);

    const split = reader({ fastFavours: "shipping", thinkFavours: "billing" });
    const two = await decideJevDeep({ reader: split, pool, state: "Charged twice.", questions, seed: 3 });
    const duel = two.evidence.topic.find((step) => step.step === "duel");
    assert.deepEqual([...duel.between].sort(), ["billing", "shipping"]);
    assert.equal(duel.choice, "billing");
    assert.equal(two.answers.topic.choice, "billing");
    assert.equal(two.usage.inputTokens, 100 + 3 * 10 + 20 + 2 * 20);
  });

  it("think profile thinks, then reads after the thought", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    let lastUser = "";
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      think: async ({ user }) => { lastUser = user; return { prefixIds: [1, 2, 3], promptTokens: 40, thoughtTokens: 300, truncated: false }; },
      readAfter: async ({ compiled }) => {
        const handle = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] no`).test(lastUser)).label;
        return { probabilities: Object.fromEntries(compiled.labels.map(({ label }) => [label, label === handle ? 0.95 : 0.05])), promptTokens: 400, labelMass: 0.97 };
      },
    };
    const questions = { owed: { type: "noul", instructions: "A refund is owed.", criteria: { true: "charged twice", false: "charged once" } } };
    const out = await decideJevThink({ reader, pool, state: "Charged once.", questions });
    assert.ok(out.answers.owed.noul < 0.1);
    assert.equal(out.usage.inputTokens, 440);
    assert.equal(out.evidence.owed[0].thoughtTokens, 300);
  });

  it("detects select-all groups by question shape, not by name", () => {
    const yn = { yes: "Yes", no: "No" };
    const stem = "Question: Which concepts does the document include?\nDoes this candidate correctly answer the question?\nCandidate: ";
    const group = selectAllGroup({
      a: { type: "choice", instructions: `${stem}doctor`, criteria: yn },
      b: { type: "choice", instructions: `${stem}appointment of staff`, criteria: yn },
      c: { type: "choice", instructions: `${stem}technology assessment`, criteria: yn },
    });
    assert.deepEqual(group.ids, ["a", "b", "c"]);
    assert.deepEqual(group.candidates, ["doctor", "appointment of staff", "technology assessment"]);
    assert.equal(selectAllGroup({ a: { type: "choice", instructions: `${stem}x`, criteria: yn }, b: { type: "choice", instructions: `${stem}y`, criteria: yn } }), null, "two questions are not a group");
    assert.equal(selectAllGroup({
      a: { type: "choice", instructions: "Is the sky blue?", criteria: yn },
      b: { type: "choice", instructions: "Is grass red?", criteria: yn },
      c: { type: "choice", instructions: "Is snow cold?", criteria: yn },
    }), null, "unrelated questions are not a group");
    assert.equal(selectAllGroup({
      a: { type: "choice", instructions: `${stem}x`, criteria: { A: "a", B: "b", C: "c" } },
      b: { type: "choice", instructions: `${stem}y`, criteria: yn },
      c: { type: "choice", instructions: `${stem}z`, criteria: yn },
    }), null, "every question must be yes/no");
  });

  it("flags quantitative material and tempers distributions", () => {
    assert.equal(isQuantitative("the probability is 20% when unset and 68% when set"), true);
    assert.equal(isQuantitative("Budget $12,000, alert at 80%"), true);
    assert.equal(isQuantitative("Is this tweet sarcastic?"), false);
    assert.deepEqual(temperProbs([0.7, 0.3], 1), [0.7, 0.3]);
    const soft = temperProbs([0.98, 0.02], 3);
    assert.ok(soft[0] < 0.9 && soft[0] > 0.5 && Math.abs(soft[0] + soft[1] - 1) < 1e-9);
  });

  it("speaks the Jev contract and refuses a response that drops a question", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      assert.match(url, /\/v1\/systemone$/);
      seen.push(init.headers.authorization);
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: "openjev-0.1", answers: { a: { type: "noul", noul: 0.9 } } }) };
    };
    const decided = await systemOneDecide({ baseUrl: "http://fixture", apiKey: "k", state: "s", questions: { a: { type: "noul" } }, fetchImpl });
    assert.equal(decided.answers.a.noul, 0.9);
    await assert.rejects(systemOneDecide({ baseUrl: "http://fixture", state: "s", questions: { a: {}, b: {} }, fetchImpl }), /omitted question b/);
    assert.deepEqual(seen, ["Bearer k", undefined]);
  });

  it("adaptive: a thought cut off by its budget keeps the fast answer under keep-fast", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    // Fast reads lean to "billing" (unsure, so the gate thinks); reads after a
    // thought lean to "legal".
    const lean = (compiled, user, key, p) => {
      const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] ${key}`).test(user)).label;
      return Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? p : (1 - p) / (compiled.labels.length - 1)]));
    };
    function reader(truncated) {
      const calls = { readAfter: 0 };
      return {
        calls,
        compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
        read: async ({ user, compiled }) => ({ probabilities: lean(compiled, user, "billing", 0.6), promptTokens: 1 }),
        think: async ({ user }) => ({ prefixIds: [user], thoughtTokens: truncated ? 1024 : 300, truncated, promptTokens: 1 }),
        readAfter: async ({ prefixIds, compiled }) => { calls.readAfter += 1; return { probabilities: lean(compiled, prefixIds[0], "legal", 0.8), promptTokens: 1 }; },
      };
    }
    const questions = { topic: { type: "choice", criteria: { shipping: null, billing: null, legal: null } } };
    const run = (r, truncatedThought) => decideJevAdaptive({ reader: r, pool, state: "s", questions, truncatedThought });
    const cut = reader(true);
    const kept = await run(cut, "keep-fast");
    assert.equal(kept.answers.topic.choice, "billing");
    assert.equal(cut.calls.readAfter, 0, "no read after a thought that is dropped");
    assert.equal(kept.evidence.topic[1].truncated, true);
    assert.equal((await run(reader(true), "read")).answers.topic.choice, "legal", "the default still reads after the thought");
    assert.equal((await run(reader(false), "keep-fast")).answers.topic.choice, "legal", "a finished thought is used");
    assert.equal((await run(reader(true), "keep-fast-multi")).answers.topic.choice, "billing", "keep-fast-multi drops a cut-off thought on three options");
  });

  it("adaptive: keep-fast-multi keeps a cut-off thought on yes/no; rowThinkLimit thinks on the least confident first", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    // Each question's fast confidence in "yes" is named in its instructions; a
    // read after any thought is sure of "no".
    const thoughtAbout = [];
    const lean = (compiled, user, key, p) => {
      const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] ${key}`).test(user)).label;
      return Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? p : 1 - p]));
    };
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => ({ probabilities: lean(compiled, user, "yes", Number(/sure (0\.\d+)/.exec(user)[1])), promptTokens: 1 }),
      think: async ({ user }) => { thoughtAbout.push(/sure (0\.\d+)/.exec(user)[1]); return { prefixIds: [user], thoughtTokens: 1024, truncated: true, promptTokens: 1 }; },
      readAfter: async ({ prefixIds, compiled }) => ({ probabilities: lean(compiled, prefixIds[0], "no", 0.9), promptTokens: 1 }),
    };
    const yn = (sure) => ({ type: "noul", instructions: `sure ${sure}`, criteria: { true: "yes", false: "no" } });
    const questions = { a: yn("0.8"), b: yn("0.6"), c: yn("0.7"), d: yn("0.99") };
    const { answers } = await decideJevAdaptive({ reader, pool, state: "s", questions, truncatedThought: "keep-fast-multi", rowThinkLimit: 2 });
    assert.deepEqual(thoughtAbout, ["0.6", "0.7"], "the two least confident questions think, in that order");
    assert.ok(answers.b.noul < 0.5 && answers.c.noul < 0.5, "a cut-off thought is still read on yes/no");
    assert.ok(answers.a.noul > 0.5, "over the row's limit, the fast answer stands");
    assert.deepEqual(Object.keys(answers).sort(), ["a", "b", "c", "d"]);
  });

  it("adaptive: a row thought reads every question after one shared thought, with distinct handles per question", async () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const thinks = [];
    // Fast reads are unsure between yes and no; reads after the row thought
    // favour "yes" for the question named in the slot lead.
    const reader = {
      compileLabels: async ({ lead, labels }) => ({ lead, labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map(({ label }) => [label, 1 / compiled.labels.length])), promptTokens: 1 }),
      think: async ({ system, user }) => { thinks.push({ system, user }); return { prefixIds: [user], thoughtTokens: 300, truncated: false, promptTokens: 1 }; },
      readAfter: async ({ prefixIds, compiled }) => {
        const block = prefixIds[0].split(`${compiled.lead.replace(" [", "")} `)[1];
        const yes = compiled.labels.find(({ label }) => block.includes(`[${label}] yes`)).label;
        return { probabilities: Object.fromEntries(compiled.labels.map(({ label }) => [label, label === yes ? 0.9 : 0.1])), promptTokens: 1 };
      },
    };
    const questions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i}`, { type: "noul", instructions: `Is device ${i} targeted?` }]));
    const { answers, evidence } = await decideJevAdaptive({ reader, pool, state: "one home", questions, rowThought: true, truncatedThought: "keep-fast" });
    assert.equal(thinks.length, 1, "one thought for the whole row");
    const listed = thinks[0].user;
    for (let i = 0; i < 5; i += 1) assert.match(listed, new RegExp(`q${i + 1}: Is device ${i} targeted\\?`), "questions are listed in their original order");
    const handles = [...listed.matchAll(/\[(H[A-L])\]/g)].map((m) => m[1]);
    assert.equal(new Set(handles).size, handles.length, "no handle is shared between questions");
    for (const id of Object.keys(questions)) {
      assert.ok(answers[id].noul > 0.5, `${id} is read after the row thought`);
      assert.equal(evidence[id].at(-1).step, "rowthink");
    }
  });

  it("adaptive: a cut-off row thought keeps the fast answers and no per-question thought follows", async () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    let thinks = 0;
    let readsAfter = 0;
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.6 : 0.4])), promptTokens: 1 }),
      think: async ({ user }) => { thinks += 1; return { prefixIds: [user], thoughtTokens: 1024, truncated: true, promptTokens: 1 }; },
      readAfter: async () => { readsAfter += 1; throw new Error("no read after a dropped thought"); },
    };
    const questions = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`d${i}`, { type: "noul", instructions: `q ${i}` }]));
    const { answers } = await decideJevAdaptive({ reader, pool, state: "s", questions, rowThought: true, truncatedThought: "keep-fast" });
    assert.equal(thinks, 1);
    assert.equal(readsAfter, 0);
    assert.equal(Object.keys(answers).length, 6);
  });

  it("clamps a thought budget to the context left after the prompt", async () => {
    const asked = [];
    const promptLength = 15000;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      let payload;
      if (url.endsWith("/tokenize")) payload = { tokens: body.messages ? Array.from({ length: promptLength }, () => 7) : [9] };
      else {
        asked.push(body.max_tokens);
        payload = { choices: [{ text: "", finish_reason: "length", logprobs: { tokens: [] } }], usage: { prompt_tokens: promptLength } };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    const reader = createStructuredReader({ baseUrl: "http://fixture", model: "m", maxModelLen: 16384, fetchImpl });
    await reader.think({ system: "s", user: "u", budget: 4096 });
    assert.equal(asked[0], 16384 - (promptLength + 1) - 256, "prompt plus opener plus thought plus the read reserve fits the context");
    await reader.think({ system: "s", user: "u", budget: 512 });
    assert.equal(asked[1], 512, "a budget that fits is kept");
  });

  it("recognizes questions that ask for a probability estimate, not decisions that mention probabilities", () => {
    assert.ok(asksForProbability("Estimate the probability that the event in state resolves Yes, using only information available as of the forecast date."));
    assert.ok(asksForProbability("How likely is it that the bill passes by June?"));
    assert.ok(!asksForProbability("For individuals who are male, the probability of admission acceptance is 82%. Would it be more likely to see admission acceptance if the individual was not male?"), "a decision over given probabilities");
    assert.ok(!asksForProbability(`${"a retrieved passage ".repeat(30)} how likely is it that the pump fails`), "a long passage that mentions likelihood");
  });

  it("adaptive: estimateBlend 0 answers probability estimates from the fast read without thinking", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.6 : 0.4])), promptTokens: 1 }),
      think: async () => { throw new Error("a forecast must not think"); },
    };
    const questions = { answer: { type: "choice", instructions: "Estimate the probability that the event resolves Yes.", criteria: { yes: "occurs", no: "does not occur" } } };
    const { evidence } = await decideJevAdaptive({ reader, pool, state: "s", questions, estimateBlend: 0 });
    assert.deepEqual(evidence.answer.map((step) => step.step), ["fast", "estimate"]);
    await assert.rejects(decideJevAdaptive({ reader, pool, state: "s", questions }), /must not think/, "off by default");
  });

  it("adaptive: thinkBlend mixes a finished thought's read with the fast read; a dropped thought is not blended", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const lean = (compiled, user, key, p) => {
      const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] ${key}`).test(user)).label;
      return Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? p : 1 - p]));
    };
    const reader = (truncated) => ({
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => ({ probabilities: lean(compiled, user, "billing", 0.6), promptTokens: 1 }),
      think: async ({ user }) => ({ prefixIds: [user], thoughtTokens: truncated ? 8192 : 900, truncated, promptTokens: 1 }),
      readAfter: async ({ prefixIds, compiled }) => ({ probabilities: lean(compiled, prefixIds[0], "legal", 0.99), promptTokens: 1 }),
    });
    const questions = { topic: { type: "choice", criteria: { billing: null, legal: null } } };
    const blended = await decideJevAdaptive({ reader: reader(false), pool, state: "s", questions, thinkBlend: 0.75, truncatedThought: "keep-fast" });
    assert.equal(blended.answers.topic.choice, "legal", "a confident thought still decides");
    assert.ok(Math.abs(blended.answers.topic.probabilities.legal - (0.75 * 0.99 + 0.25 * 0.4)) < 1e-9);
    const cut = await decideJevAdaptive({ reader: reader(true), pool, state: "s", questions, thinkBlend: 0.75, truncatedThought: "keep-fast" });
    assert.ok(Math.abs(cut.answers.topic.probabilities.billing - 0.6) < 1e-9, "a dropped thought leaves the fast read as it was");
    const unblended = await decideJevAdaptive({ reader: reader(false), pool, state: "s", questions });
    assert.ok(Math.abs(unblended.answers.topic.probabilities.legal - 0.99) < 1e-9, "weight 1 (the default) is the read after the thought");
  });

  it("adaptive: estimateBlend sets the think weight for probability estimates; other questions keep thinkBlend", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const lean = (compiled, user, key, p) => {
      const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] ${key}`).test(user)).label;
      return Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? p : 1 - p]));
    };
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => ({ probabilities: lean(compiled, user, "yes", 0.6), promptTokens: 1 }),
      think: async ({ user }) => ({ prefixIds: [user], thoughtTokens: 500, truncated: false, promptTokens: 1 }),
      readAfter: async ({ prefixIds, compiled }) => ({ probabilities: lean(compiled, prefixIds[0], "no", 0.99), promptTokens: 1 }),
    };
    const questions = {
      forecast: { type: "choice", instructions: "Estimate the probability that the event resolves Yes.", criteria: { yes: "occurs", no: "does not occur" } },
      decision: { type: "choice", instructions: "Is the claim supported?", criteria: { yes: "supported", no: "not supported" } },
    };
    const { answers } = await decideJevAdaptive({ reader, pool, state: "s", questions, thinkBlend: 0.75, estimateBlend: 0.5 });
    assert.ok(Math.abs(answers.forecast.probabilities.no - (0.5 * 0.99 + 0.5 * 0.4)) < 1e-9);
    assert.ok(Math.abs(answers.decision.probabilities.no - (0.75 * 0.99 + 0.25 * 0.4)) < 1e-9);
  });

  it("adaptive: hideKeys drops meaningless option keys from what the reads see, unless the question refers to them", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => { seen.push(user); return { probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.97 : 0.03 / (compiled.labels.length - 1)])), promptTokens: 1 }; },
    };
    const ask = (questions) => decideJevAdaptive({ reader, pool, state: "s", questions, hideKeys: true });
    const { answers } = await ask({ q: { type: "choice", instructions: "Which stance?", criteria: { A: "against", B: "favor", C: "none" } } });
    assert.ok(["A", "B", "C"].includes(answers.q.choice), "answers still come back under the original keys");
    assert.doesNotMatch(seen.at(-1), /\] [ABC]: /, "letter keys are not shown");
    assert.match(seen.at(-1), /\] against/);
    await ask({ q: { type: "choice", instructions: "Pick one.", criteria: { option_0: "BookHotel", option_1: "ModifyAlarm" } } });
    assert.doesNotMatch(seen.at(-1), /option_0/, "option_N keys are not shown");
    await ask({ q: { type: "choice", instructions: "Which is right, (A) or (B)?", criteria: { A: "the student's", B: "the architect's" } } });
    assert.match(seen.at(-1), /\] A: the student's/, "keys the question refers to stay");
    await ask({ q: { type: "choice", instructions: "Classify.", criteria: { Entailment: "entails", Contradiction: "contradicts" } } });
    assert.match(seen.at(-1), /\] Entailment: entails/, "meaningful keys stay");
  });

  it("adaptive: binary debias always reads the second order as the reverse of the first", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    // A purely position-biased reader: whatever option is listed first gets 0.8.
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.8 : 0.2])), promptTokens: 1 }),
    };
    const questions = { q: { type: "choice", instructions: "Supported?", criteria: { SUPPORTED: "supported", NOT_SUPPORTED: "not supported" } } };
    for (let seed = 0; seed < 12; seed += 1) {
      const { evidence } = await decideJevAdaptive({ reader, pool, state: "s", questions, seed, binaryDebias: true, gate: 0 });
      const fast = evidence.q[0];
      assert.equal(fast.ordersAgree, false, `seed ${seed}: the two orders expose the position bias`);
      assert.ok(Math.abs(fast.probabilities.SUPPORTED - 0.5) < 1e-9, `seed ${seed}: position bias averages out`);
    }
  });

  it("adaptive: evidenceFirst answers a row's yes/no checks first and gives the judgments the checklist", async () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    // Checks read "yes"; the judgment reads phishing only when it can see the checklist.
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => {
        seen.push(user);
        const want = user.includes("QUESTION: Is it phishing?") ? (user.includes("CHECKLIST") ? "phishing" : "legitimate") : "yes";
        const hit = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] ${want}`).test(user));
        return { probabilities: Object.fromEntries(compiled.labels.map(({ label }) => [label, hit && label === hit.label ? 0.97 : 0.03 / (compiled.labels.length - 1)])), promptTokens: 1 };
      },
    };
    const check = (text) => ({ type: "noul", instructions: text });
    const questions = {
      mismatch: check("The sender domain differs from the link domain."),
      hosting: check("The link points to free hosting."),
      generic: check("The sender uses a webmail address."),
      verdict: { type: "choice", instructions: "Is it phishing?", criteria: { phishing: "malicious", legitimate: "safe" } },
    };
    const { answers } = await decideJevAdaptive({ reader, pool, state: { from: "a@gmail.com" }, questions, evidenceFirst: true });
    assert.equal(answers.verdict.choice, "phishing");
    const verdictRead = seen.find((user) => user.includes("QUESTION: Is it phishing?"));
    assert.match(verdictRead, /CHECKLIST[^]*The sender domain differs from the link domain\.: yes/);
    assert.ok(answers.mismatch.noul > 0.5 && answers.hosting.noul > 0.5 && answers.generic.noul > 0.5);
    const plain = await decideJevAdaptive({ reader, pool, state: {}, questions: { verdict: questions.verdict }, evidenceFirst: true });
    assert.equal(plain.answers.verdict.choice, "legitimate", "no checks in the row, no checklist");
  });

  it("adaptive: a forced question thinks despite a confident fast read (claim check, many options); select-all candidates see the list", async () => {
    const pool = Array.from({ length: 24 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    let thoughts = 0;
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => { seen.push(user); return { probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.97 : 0.03 / (compiled.labels.length - 1)])), promptTokens: 1 }; },
      think: async ({ user }) => { thoughts += 1; return { prefixIds: [user], thoughtTokens: 300, truncated: false, promptTokens: 1 }; },
      readAfter: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.9 : 0.1 / (compiled.labels.length - 1)])), promptTokens: 1 }),
    };
    const claimState = { claim: "It was released in 1999.", evidence: [{ title: "Film", text: "It was released in 1987." }] };
    const verdict = { v: { type: "choice", instructions: "Is the claim supported by the evidence?", criteria: { SUPPORTED: "supported", NOT_SUPPORTED: "not supported" } } };
    await decideJevAdaptive({ reader, pool, state: claimState, questions: verdict, claimGauge: true });
    assert.equal(thoughts, 1, "a confident read of a claim with an unsourced detail still thinks");
    assert.match(seen.at(-1), /CLAIM CHECK[^]*1999/);
    thoughts = 0;
    await decideJevAdaptive({ reader, pool, state: claimState, questions: verdict });
    assert.equal(thoughts, 0, "off by default: the confident read stands");
    const many = { m: { type: "choice", instructions: "Which?", criteria: { A: "one", B: "two", C: "three", D: "four" } } };
    await decideJevAdaptive({ reader, pool, state: "s", questions: many, thinkMinOptions: 4 });
    assert.equal(thoughts, 1, "four options think whatever the fast confidence");
    const stem = "Question: What concepts does the document include?\nDoes this candidate correctly answer the question?\nCandidate: ";
    const candidates = Object.fromEntries(["doctor", "appointment of staff", "technology assessment"].map((c, i) => [`c${i}`, { type: "choice", instructions: stem + c, criteria: { yes: "Yes", no: "No" } }]));
    seen.length = 0;
    await decideJevAdaptive({ reader, pool, state: "a document", questions: candidates, selectAllFraming: true });
    assert.ok(seen.every((user) => /CANDIDATES \(3 candidates[^]*more than one of them may be correct[^]*2\. appointment of staff/.test(user)));
  });

  it("adaptive: stanceFraming defines bare stance options relative to the topic; other bare labels are left alone", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => { seen.push(user); return { probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.99 : 0.01 / (compiled.labels.length - 1)])), promptTokens: 1 }; },
    };
    const ask = (criteria) => decideJevAdaptive({ reader, pool, state: {}, questions: { q: { type: "choice", instructions: "Topic: x\nPost: y", criteria } }, stanceFraming: true });
    const { answers } = await ask({ A: "against", B: "favor", C: "neutral" });
    assert.ok(["A", "B", "C"].includes(answers.q.choice));
    assert.match(seen.at(-1), /neutral: the text takes no position on the topic itself, including when it does not discuss the topic at all/);
    await ask({ N: "Negative", U: "Neutral", P: "Positive" });
    assert.doesNotMatch(seen.at(-1), /takes no position/, "sentiment labels are not stances");
    await ask({ phishing: null, legitimate: null });
    assert.doesNotMatch(seen.at(-1), /takes no position/, "empty descriptions are not stance words");
  });
});
