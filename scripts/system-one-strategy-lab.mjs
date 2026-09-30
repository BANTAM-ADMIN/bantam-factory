#!/usr/bin/env node

/**
 * System One strategy lab: compare decision strategies built from BANTAM's
 * DiffusionGemma reads on any JevBench-format item file.
 *
 *   node scripts/system-one-strategy-lab.mjs --items a.jsonl[,b.jsonl] \
 *     [--strategies fast1,fast3,think,geo,arbitrate,adaptive] [--limit N] \
 *     [--think-budget 512] [--gate 0.95] [--output report.json]
 *
 * Strategies:
 *   fast1      one rack
 *   fast3      three racks (different handles, order and wording), averaged
 *   think      a thought, then one read after it
 *   geo        fast3 and think combined by geometric mean
 *   arbitrate  fast3 and think; if they disagree, a focused duel between the
 *              two candidates (both orders, fresh handles, thought first)
 *   adaptive   fast3; only when its confidence is under --gate, arbitrate
 *   calc       the model writes a calculation setup, a calculator computes it
 *              exactly, and three racks read the material plus the results
 *   calcadapt  fast3; only when its confidence is under --gate, calc
 *   calc1      setup, calculator, one read (about two reads of input)
 *   calcadapt1 one fast read; only under --gate, calc1
 *   smart1     one fast read; only under --gate, calcthink (cost-aware)
 *   adaptive1  one fast read; only under --gate, a thought then a read (the
 *              server's `adaptive` profile)
 *   calcthink  a thought over the material plus calculator results, then a read
 *   focusthink the model names the passages that decide the question (checked
 *              against the real passage labels); a thought over only those
 *              passages plus calculator results, then a read
 *   focusarb   calc and focusthink; if they disagree, a duel over the focused
 *              material
 *   think1, calcthink1, focusthink1, calcarb1
 *              the same, but each thought and its answer come from ONE request
 *              (the model writes q1: [HANDLE] after its thought and the handle
 *              distribution is read at that position), so the prompt is billed
 *              once; a thought that runs out of budget falls back to a read
 *   elimthink1 one-request thought that tries to rule out each option in turn
 *              (over the calculator material), then answers
 *   tri        calc racks, calcthink1 and elimthink1: two agreeing voices
 *              release (geometric mean of all three); a three-way split duels
 *              the two strongest candidates
 *   calcarb    calc and calcthink; if they disagree, a duel over the material
 *              plus calculator results
 *
 * Scores accuracy, calibration (ECE, Brier), billed input tokens, thought
 * tokens and latency, plus JevBench-style Speed and Cost axes. Reads within
 * one item are cached across strategies, so each strategy is charged for the
 * reads it would have made, not re-run.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { compileHandlePool, createStructuredReader, formatCalcResults, rackOptions, runCalcSetup } from '../src/factory.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const base = option('base', 'http://127.0.0.1:8001');
const model = option('model', 'dgemma');
const itemsArg = option('items', null);
if (!itemsArg) throw new Error('--items is required');
const strategies = option('strategies', 'fast1,fast3,think,geo,arbitrate,adaptive').split(',');
const limit = Number(option('limit', '0'));
const thinkBudget = Number(option('think-budget', '512'));
const gate = Number(option('gate', '0.95'));
const output = resolve(option('output', '.bantam/factory-benchmarks/system-one-strategy-lab.json'));
const INPUT_PRICE_PER_M = 0.035; // djev's announced tariff; output tokens free

const ASKS = [
  'Which ONE bracketed handle answers the question?',
  'Pick the ONE bracketed option that is correct for the material above.',
  'Considering only the material above, which ONE bracketed handle is right?',
];
const SYSTEM_FAST = 'Answer one multiple-choice question about the material. Reply exactly as: q1: [HANDLE]';
const SYSTEM_THINK = 'Answer one multiple-choice question about the material. Work through the relevant facts and any arithmetic carefully, then reply exactly as: q1: [HANDLE]';
const SYSTEM_CALC = 'You set up calculations; a calculator will compute them exactly. Do NOT restate the material and do NOT answer the question. Write only the lines needed to decide it, one per line, as name = expression. Use numbers copied exactly from the material, + - * / ( ), earlier names, min(), max(), round(x, digits), days("YYYY-MM-DD", "YYYY-MM-DD") for whole days between two dates, and hours("YYYY-MM-DDTHH:MM+HH:MM", "YYYY-MM-DDTHH:MM+HH:MM") for elapsed hours using each time\'s UTC offset (account for daylight-saving changes). Give every quantity a clear name. If the decision needs no calculation, write NONE.';
const SYSTEM_FOCUS = 'The material is split into labelled passages. List the labels of every passage needed to decide the question: the rules that apply, their definitions, exceptions and effective dates, and the facts they apply to. Write only the labels, comma-separated, most important first (for example: P4, P9, P2). Write nothing else.';
const SYSTEM_ELIM = 'Answer one multiple-choice question about the material. Do not pick the option that merely looks best. For each option in turn, look for the specific fact, rule, exception, date or calculation in the material that rules it out, and note it. The answer is the option that cannot be ruled out. Then reply exactly as: q1: [HANDLE]';
const SYSTEM_DUEL = 'Exactly one of the two options is correct. Find the specific fact, rule or calculation in the material that decides between them, check it, then reply exactly as: q1: [HANDLE]';

const text = (value) => (value === null || value === undefined ? '' : typeof value === 'string' ? value.trim() : JSON.stringify(value));

function optionsOf(task) {
  const q = task.question;
  if (q.type === 'noul') {
    const c = q.criteria ?? {};
    return [
      { key: 'yes', text: text(c.true) ? `yes: ${text(c.true)}` : 'yes' },
      { key: 'no', text: text(c.false) ? `no: ${text(c.false)}` : 'no' },
    ];
  }
  if (q.type === 'choice') return Object.entries(q.criteria ?? {}).map(([key, d]) => ({ key, text: text(d) ? `${key}: ${text(d)}` : key }));
  return (q.criteria ?? []).map((level, i) => ({ key: String(i), text: `level ${i}: ${text(level)}` }));
}
const expectedKey = (task) => (task.question.type === 'score' ? String(task.expected) : task.expected);

async function loadItems() {
  const items = [];
  for (const file of itemsArg.split(',')) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) if (line.trim()) items.push(JSON.parse(line));
  }
  return limit ? items.slice(0, limit) : items;
}

const reader = createStructuredReader({ baseUrl: base, model });
const pool = await compileHandlePool(reader, { size: 256 });

function hashSeed(textValue) {
  let h = 2166136261;
  for (let i = 0; i < textValue.length; i += 1) h = Math.imul(h ^ textValue.charCodeAt(i), 16777619) >>> 0;
  return h % 1_000_000;
}

// Per-item lazily evaluated reads; strategies pull what they need.
function itemContext(task) {
  const options = optionsOf(task);
  const seed = hashSeed(task.id);
  const state = typeof task.state === 'string' ? task.state : JSON.stringify(task.state);
  const cache = new Map();
  const once = (key, work) => {
    if (!cache.has(key)) cache.set(key, work());
    return cache.get(key);
  };
  const racks = [0, 1, 2].map((r) => rackOptions(pool, options.map((o) => o.text), { seed: seed + r * 7919 + 1 }));
  const userFor = (rack, ask, instructions = task.question.instructions, material = state) => `${material}\n\n---\nQUESTION: ${text(instructions) || 'Answer about the state.'}\nOPTIONS:\n${rack.material}\n\nq1: ${ask}`;
  const toKeys = (rack, read) => {
    const p = Object.fromEntries(options.map((o) => [o.key, 0]));
    for (const row of rack.rows) p[options[row.optionIndex].key] = read.probabilities[row.handle];
    return p;
  };
  const cost = { input: 0, thought: 0, ms: 0, requests: 0 };
  const charge = (used, key) => used.add(key);
  const costs = new Map();
  const record = (key, c) => costs.set(key, c);

  const fastRead = (r) => once(`fast${r}`, async () => {
    const rack = racks[r];
    const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
    const read = await reader.read({ system: SYSTEM_FAST, user: userFor(rack, ASKS[r]), compiled, seed: seed + r });
    record(`fast${r}`, { input: read.promptTokens, thought: 0, ms: read.elapsedMs, requests: 1 });
    return toKeys(rack, read);
  });
  const thinkRead = (material = state, key = 'think') => once(key, async () => {
    const rack = racks[0];
    const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
    const t = await reader.think({ system: SYSTEM_THINK, user: userFor(rack, ASKS[0], task.question.instructions, material), budget: thinkBudget });
    const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
    record(key, { input: t.promptTokens + read.promptTokens, thought: t.thoughtTokens, ms: t.elapsedMs + read.elapsedMs, requests: 2 });
    return toKeys(rack, read);
  });
  const thinkOnce = (material = state, key = 'think1', system = SYSTEM_THINK, rackIndex = 0) => once(key, async () => {
    const rack = racks[rackIndex];
    const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
    const t = await reader.thinkAnswer({ system, user: userFor(rack, ASKS[rackIndex], task.question.instructions, material), compiled, budget: thinkBudget });
    if (t.answered) {
      record(key, { input: t.promptTokens, thought: t.thoughtTokens, ms: t.elapsedMs, requests: 1 });
      return toKeys(rack, t);
    }
    const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed });
    record(key, { input: t.promptTokens + read.promptTokens, thought: t.thoughtTokens, ms: t.elapsedMs + read.elapsedMs, requests: 2 });
    return toKeys(rack, read);
  });
  const duelOnce = (a, b, material = state, tag = '') => once(`duel1${tag}:${[a, b].sort().join('|')}`, async () => {
    const pair = options.filter((o) => o.key === a || o.key === b);
    const out = Object.fromEntries(options.map((o) => [o.key, 0]));
    let input = 0; let thought = 0; let ms = 0; let requests = 0;
    for (const [d, order] of [[0, pair], [1, [...pair].reverse()]]) {
      const rack = rackOptions(pool, order.map((o) => o.text), { seed: seed + 104729 * (d + 1), shuffle: false });
      const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
      const user = userFor(rack, 'Which ONE of these two bracketed options is correct?', task.question.instructions, material);
      const t = await reader.thinkAnswer({ system: SYSTEM_DUEL, user, compiled, budget: thinkBudget });
      let read = t;
      input += t.promptTokens; thought += t.thoughtTokens; ms += t.elapsedMs; requests += 1;
      if (!t.answered) { read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed: seed + d }); input += read.promptTokens; ms += read.elapsedMs; requests += 1; }
      rack.rows.forEach((row) => { out[order[row.optionIndex].key] += read.probabilities[row.handle] / 2; });
    }
    record(`duel1${tag}:${[a, b].sort().join('|')}`, { input, thought, ms, requests });
    return out;
  });
  const duel = (a, b, material = state, tag = '') => once(`duel${tag}:${[a, b].sort().join('|')}`, async () => {
    const pair = options.filter((o) => o.key === a || o.key === b);
    const out = Object.fromEntries(options.map((o) => [o.key, 0]));
    let input = 0; let thought = 0; let ms = 0;
    for (const [d, order] of [[0, pair], [1, [...pair].reverse()]]) {
      const rack = rackOptions(pool, order.map((o) => o.text), { seed: seed + 104729 * (d + 1), shuffle: false });
      const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
      const user = userFor(rack, 'Which ONE of these two bracketed options is correct?', task.question.instructions, material);
      const t = await reader.think({ system: SYSTEM_DUEL, user, budget: thinkBudget });
      const read = await reader.readAfter({ prefixIds: t.prefixIds, compiled, seed: seed + d });
      rack.rows.forEach((row) => { out[order[row.optionIndex].key] += read.probabilities[row.handle] / 2; });
      input += t.promptTokens + read.promptTokens; thought += t.thoughtTokens; ms += t.elapsedMs + read.elapsedMs;
    }
    record(`duel${tag}:${[a, b].sort().join('|')}`, { input, thought, ms, requests: 4 });
    return out;
  });
  const calcSetup = () => once('calc', async () => {
    const c = await reader.complete({ system: SYSTEM_CALC, user: `${state}\n\n---\nQUESTION: ${text(task.question.instructions) || 'Answer about the state.'}\nOPTIONS:\n${racks[0].material}`, maxTokens: 500 });
    record('calc', { input: c.promptTokens, thought: c.completionTokens, ms: c.elapsedMs, requests: 1 });
    return runCalcSetup(c.text);
  });
  // A read over the material plus exact results. With no usable results the
  // plain fast read stands in, so a strategy is never charged for a no-op.
  const calcMaterial = async () => {
    const run = await calcSetup();
    return run.results.length ? `${state}\n\nCALCULATOR RESULTS (exact arithmetic on a setup drawn from the material above; confirm each setup line matches the material before relying on it):\n${formatCalcResults(run.results)}` : null;
  };
  const calcRead = (r) => once(`calcread${r}`, async () => {
    const material = await calcMaterial();
    if (!material) return { probs: await fastRead(r), reused: true };
    const rack = racks[r];
    const compiled = await reader.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
    const read = await reader.read({ system: SYSTEM_FAST, user: userFor(rack, ASKS[r], task.question.instructions, material), compiled, seed: seed + r });
    record(`calc${r}`, { input: read.promptTokens, thought: 0, ms: read.elapsedMs, requests: 1 });
    return { probs: toKeys(rack, read), reused: false };
  });
  // Thinking over the calculator-augmented material; without results it is
  // the plain thought.
  const calcThink = async () => {
    const material = await calcMaterial();
    return material ? { probs: await thinkRead(material, 'calcthink'), key: 'calcthink' } : { probs: await thinkRead(), key: 'think' };
  };
  // Passages: blank-line blocks, with very short blocks (headings) joined to
  // the block that follows them.
  const passages = (() => {
    const blocks = state.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const out = [];
    let carry = '';
    for (const block of blocks) {
      const merged = carry ? `${carry}\n${block}` : block;
      if (merged.length < 160) { carry = merged; continue; }
      out.push(merged); carry = '';
    }
    if (carry) out.length ? (out[out.length - 1] += `\n${carry}`) : out.push(carry);
    return out;
  })();
  const focusMaterial = () => once('focus', async () => {
    if (passages.length < 4) return null;
    const labelled = passages.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n');
    const c = await reader.complete({ system: SYSTEM_FOCUS, user: `${labelled}\n\n---\nQUESTION: ${text(task.question.instructions) || 'Answer about the state.'}\nOPTIONS:\n${racks[0].material}`, maxTokens: 60 });
    record('focus', { input: c.promptTokens, thought: c.completionTokens, ms: c.elapsedMs, requests: 1 });
    const picked = [...new Set((c.text.match(/P(\d+)/g) ?? []).map((m) => Number(m.slice(1))).filter((n) => n >= 1 && n <= passages.length))].sort((a, b) => a - b);
    // Too few passages means the list failed; too many means nothing was focused.
    if (picked.length === 0 || picked.length > Math.ceil(passages.length * 0.8)) return null;
    return picked.map((n) => `[P${n}] ${passages[n - 1]}`).join('\n\n');
  });
  const focusedWithCalc = async () => {
    const focused = await focusMaterial();
    if (!focused) return null;
    const run = await calcSetup();
    return run.results.length ? `${focused}\n\nCALCULATOR RESULTS (exact arithmetic on a setup drawn from the full material; confirm each setup line matches the material before relying on it):\n${formatCalcResults(run.results)}` : focused;
  };
  const focusThink = async () => {
    const material = await focusedWithCalc();
    if (!material) { const v = await calcThink(); return { ...v, keys: [v.key, 'focus'] }; }
    return { probs: await thinkRead(`(Excerpt: only the passages that bear on this decision.)\n\n${material}`, 'focusthink'), keys: ['focus', 'focusthink'] };
  };
  const focusDuel = async (a, b) => {
    const material = await focusedWithCalc();
    if (!material) { const v = await calcDuel(a, b); return { ...v, keys: [v.key, 'focus'] }; }
    return { probs: await duel(a, b, `(Excerpt: only the passages that bear on this decision.)\n\n${material}`, 'focus'), keys: ['focus', `duelfocus:${[a, b].sort().join('|')}`] };
  };
  const calcDuel = async (a, b) => {
    const material = await calcMaterial();
    return material ? { probs: await duel(a, b, material, 'calc'), key: `duelcalc:${[a, b].sort().join('|')}` } : { probs: await duel(a, b), key: `duel:${[a, b].sort().join('|')}` };
  };
  const calcThink1 = async () => {
    const material = await calcMaterial();
    return material ? { probs: await thinkOnce(material, 'calcthink1'), keys: ['calcthink1'] } : { probs: await thinkOnce(), keys: ['think1'] };
  };
  const focusThink1 = async () => {
    const material = await focusedWithCalc();
    if (!material) { const v = await calcThink1(); return { ...v, keys: [...v.keys, 'focus'] }; }
    return { probs: await thinkOnce(`(Excerpt: only the passages that bear on this decision.)\n\n${material}`, 'focusthink1'), keys: ['focus', 'focusthink1'] };
  };
  const elimThink1 = async () => {
    const material = (await calcMaterial()) ?? state;
    return { probs: await thinkOnce(material, 'elimthink1', SYSTEM_ELIM, 1), keys: ['elimthink1'] };
  };
  const calcDuel1 = async (a, b) => {
    const material = await calcMaterial();
    return material ? { probs: await duelOnce(a, b, material, 'calc'), keys: [`duel1calc:${[a, b].sort().join('|')}`] } : { probs: await duelOnce(a, b), keys: [`duel1:${[a, b].sort().join('|')}`] };
  };
  return { options, fastRead, thinkRead, duel, calcRead, calcThink, calcDuel, focusThink, focusDuel, thinkOnce, calcThink1, focusThink1, calcDuel1, elimThink1, costs };
}

const argmax = (p) => Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
const normalize = (p) => {
  const total = Object.values(p).reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
};
const average = (...ps) => normalize(Object.fromEntries(Object.keys(ps[0]).map((k) => [k, ps.reduce((s, p) => s + p[k], 0) / ps.length])));
const geometric = (a, b) => normalize(Object.fromEntries(Object.keys(a).map((k) => [k, Math.sqrt(Math.max(a[k], 1e-9) * Math.max(b[k], 1e-9))])));

async function fast3(ctx) { return average(await ctx.fastRead(0), await ctx.fastRead(1), await ctx.fastRead(2)); }
async function arbitrate(ctx) {
  const f = await fast3(ctx);
  const t = await ctx.thinkRead();
  const a = argmax(f); const b = argmax(t);
  if (a === b) return geometric(f, t);
  const d = await ctx.duel(a, b);
  // Keep a little of the fast and thinking evidence so a confident duel decides
  // and a split duel does not throw the other reads away.
  return normalize(Object.fromEntries(Object.keys(f).map((k) => [k, 0.8 * d[k] + 0.1 * f[k] + 0.1 * t[k]])));
}
async function calc3(ctx) { return average(await ctx.calcRead(0), await ctx.calcRead(1), await ctx.calcRead(2)); }
const STRATEGIES = {
  fast1: async (ctx) => normalize(await ctx.fastRead(0)),
  fast3,
  think: async (ctx) => normalize(await ctx.thinkRead()),
  geo: async (ctx) => geometric(await fast3(ctx), await ctx.thinkRead()),
  arbitrate,
  calc: calc3,
  calc1: async (ctx) => normalize(await ctx.calcRead(0)),
  calcadapt1: async (ctx) => {
    const f = normalize(await ctx.fastRead(0));
    return Math.max(...Object.values(f)) >= gate ? f : normalize(await ctx.calcRead(0));
  },
  adaptive1: async (ctx) => {
    const f = normalize(await ctx.fastRead(0));
    return Math.max(...Object.values(f)) >= gate ? f : normalize(await ctx.thinkRead());
  },
  smart1: async (ctx) => {
    const f = normalize(await ctx.fastRead(0));
    return Math.max(...Object.values(f)) >= gate ? f : normalize(await ctx.calcThink());
  },
  calcthink: async (ctx) => normalize(await ctx.calcThink()),
  focusthink: async (ctx) => normalize(await ctx.focusThink()),
  think1: async (ctx) => normalize(await ctx.thinkOnce()),
  elimthink1: async (ctx) => normalize(await ctx.elimThink1()),
  tri: async (ctx) => {
    const f = await calc3(ctx);
    const t = normalize(await ctx.calcThink1());
    const e = normalize(await ctx.elimThink1());
    const votes = [argmax(f), argmax(t), argmax(e)];
    const geo3 = normalize(Object.fromEntries(Object.keys(f).map((k) => [k, Math.cbrt(Math.max(f[k], 1e-9) * Math.max(t[k], 1e-9) * Math.max(e[k], 1e-9))])));
    if (new Set(votes).size < 3) return geo3;
    const ranked = Object.keys(geo3).sort((x, y) => geo3[y] - geo3[x]);
    const d = await ctx.calcDuel1(ranked[0], ranked[1]);
    return normalize(Object.fromEntries(Object.keys(f).map((k) => [k, 0.8 * d[k] + 0.2 * geo3[k]])));
  },
  calcthink1: async (ctx) => normalize(await ctx.calcThink1()),
  focusthink1: async (ctx) => normalize(await ctx.focusThink1()),
  calcarb1: async (ctx) => {
    const f = await calc3(ctx);
    const t = await ctx.calcThink1();
    const a = argmax(f); const b = argmax(t);
    if (a === b) return geometric(f, t);
    const d = await ctx.calcDuel1(a, b);
    return normalize(Object.fromEntries(Object.keys(f).map((k) => [k, 0.8 * d[k] + 0.1 * f[k] + 0.1 * t[k]])));
  },
  focusarb: async (ctx) => {
    const f = await calc3(ctx);
    const t = await ctx.focusThink();
    const a = argmax(f); const b = argmax(t);
    if (a === b) return geometric(f, t);
    const d = await ctx.focusDuel(a, b);
    return normalize(Object.fromEntries(Object.keys(f).map((k) => [k, 0.8 * d[k] + 0.1 * f[k] + 0.1 * t[k]])));
  },
  calcarb: async (ctx) => {
    const f = await calc3(ctx);
    const t = await ctx.calcThink();
    const a = argmax(f); const b = argmax(t);
    if (a === b) return geometric(f, t);
    const d = await ctx.calcDuel(a, b);
    return normalize(Object.fromEntries(Object.keys(f).map((k) => [k, 0.8 * d[k] + 0.1 * f[k] + 0.1 * t[k]])));
  },
  calcadapt: async (ctx) => {
    const f = await fast3(ctx);
    return Math.max(...Object.values(f)) >= gate ? f : calc3(ctx);
  },
  adaptive: async (ctx) => {
    const f = await fast3(ctx);
    return Math.max(...Object.values(f)) >= gate ? f : arbitrate(ctx);
  },
};
for (const s of strategies) if (!STRATEGIES[s]) throw new Error(`unknown strategy ${s}`);

// Which cached reads a strategy consumed, for honest per-strategy cost.
async function runStrategy(name, ctx) {
  const before = new Set(ctx.costs.keys());
  const probs = await STRATEGIES[name](ctx);
  return { probs, used: [...ctx.costs.keys()] , before };
}

const items = await loadItems();
const rows = [];
const started = Date.now();
for (const [n, task] of items.entries()) {
  const ctx = itemContext(task);
  const expected = expectedKey(task);
  for (const name of strategies) {
    // Replay the strategy on a fresh usage tracker so shared reads are charged
    // to every strategy that needs them.
    const used = new Set();
    const tracked = {
      ...ctx,
      fastRead: async (r) => { const v = await ctx.fastRead(r); used.add(`fast${r}`); return v; },
      thinkRead: async () => { const v = await ctx.thinkRead(); used.add('think'); return v; },
      calcThink: async () => { const v = await ctx.calcThink(); used.add('calc'); used.add(v.key); return v.probs; },
      calcDuel: async (a, b) => { const v = await ctx.calcDuel(a, b); used.add('calc'); used.add(v.key); return v.probs; },
      thinkOnce: async () => { const v = await ctx.thinkOnce(); used.add('think1'); return v; },
      elimThink1: async () => { const v = await ctx.elimThink1(); used.add('calc'); for (const k of v.keys) used.add(k); return v.probs; },
      calcThink1: async () => { const v = await ctx.calcThink1(); used.add('calc'); for (const k of v.keys) used.add(k); return v.probs; },
      focusThink1: async () => { const v = await ctx.focusThink1(); used.add('calc'); for (const k of v.keys) used.add(k); return v.probs; },
      calcDuel1: async (a, b) => { const v = await ctx.calcDuel1(a, b); used.add('calc'); for (const k of v.keys) used.add(k); return v.probs; },
      focusThink: async () => { const v = await ctx.focusThink(); used.add('calc'); for (const k of v.keys ?? [v.key]) if (k) used.add(k); return v.probs; },
      focusDuel: async (a, b) => { const v = await ctx.focusDuel(a, b); used.add('calc'); for (const k of v.keys ?? [v.key]) if (k) used.add(k); return v.probs; },
      duel: async (a, b) => { const v = await ctx.duel(a, b); used.add(`duel:${[a, b].sort().join('|')}`); return v; },
      calcRead: async (r) => { const v = await ctx.calcRead(r); used.add('calc'); used.add(v.reused ? `fast${r}` : `calc${r}`); return v.probs; },
    };
    const probs = await STRATEGIES[name](tracked);
    const c = [...used].map((key) => ctx.costs.get(key)).filter(Boolean).reduce((s, x) => ({ input: s.input + x.input, thought: s.thought + x.thought, ms: s.ms + x.ms, requests: s.requests + x.requests }), { input: 0, thought: 0, ms: 0, requests: 0 });
    const predicted = argmax(probs);
    rows.push({ id: task.id, family: task.family, strategy: name, expected, predicted, correct: predicted === expected, confidence: probs[predicted], probs, surface: task.provenance?.surface_answer ?? null, labels: ctx.options.length, ...c });
  }
  if ((n + 1) % 10 === 0) process.stderr.write(`${n + 1}/${items.length} items, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
}

const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const speedScore = (seconds) => Math.max(0, Math.min(100, 100 - 20 * Math.log10((2 * seconds + 0.15) / 0.1)));
const summary = {};
for (const name of strategies) {
  const r = rows.filter((row) => row.strategy === name);
  const acc = r.filter((row) => row.correct).length / r.length;
  const chance = r.reduce((s, row) => s + 1 / row.labels, 0) / r.length;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const row of r) { const b = bins[Math.min(9, Math.floor(row.confidence * 10))]; b.n += 1; b.conf += row.confidence; b.acc += row.correct ? 1 : 0; }
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / r.length) * Math.abs(b.acc / b.n - b.conf / b.n) : 0), 0);
  const brier = r.reduce((s, row) => s + Object.entries(row.probs).reduce((t, [k, p]) => t + (p - (k === row.expected ? 1 : 0)) ** 2, 0), 0) / r.length;
  const meanInput = r.reduce((s, row) => s + row.input, 0) / r.length;
  const dollarsPer1k = (meanInput * 1000 * INPUT_PRICE_PER_M) / 1e6;
  const p50 = quantile(r.map((row) => row.ms / 1000), 0.5);
  const p95 = quantile(r.map((row) => row.ms / 1000), 0.95);
  const wrong = r.filter((row) => !row.correct);
  const byFamily = {};
  for (const row of r) { byFamily[row.family] ??= [0, 0]; byFamily[row.family][0] += row.correct ? 1 : 0; byFamily[row.family][1] += 1; }
  summary[name] = {
    n: r.length,
    correct: r.filter((row) => row.correct).length,
    accuracy: Number(acc.toFixed(4)),
    intelligenceProxy: Number((100 * Math.max(0, (acc - chance) / (1 - chance))).toFixed(1)),
    ece: Number(ece.toFixed(4)),
    brier: Number(brier.toFixed(4)),
    trapPicksAmongWrong: `${wrong.filter((row) => row.surface !== null && String(row.predicted) === String(row.surface)).length}/${wrong.length}`,
    meanInputTokens: Math.round(meanInput),
    meanThoughtTokens: Math.round(r.reduce((s, row) => s + row.thought, 0) / r.length),
    meanRequests: Number((r.reduce((s, row) => s + row.requests, 0) / r.length).toFixed(2)),
    p50s: Number(p50.toFixed(3)),
    p95s: Number(p95.toFixed(3)),
    speedAxis: Number(((speedScore(p50) + speedScore(p95)) / 2).toFixed(1)),
    costAxis: Number(Math.max(0, Math.min(100, 100 - 30 * Math.log10(dollarsPer1k / 0.001))).toFixed(1)),
    byFamily: Object.fromEntries(Object.entries(byFamily).map(([k, [c, n]]) => [k, `${c}/${n}`])),
  };
}

const report = { schema: 'bantam.factory.system-one-strategy-lab.v1', items: itemsArg, n: items.length, strategies, thinkBudget, gate, pricing: { inputPerMillion: INPUT_PRICE_PER_M, output: 'free' }, summary, rows };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
for (const [name, s] of Object.entries(summary)) {
  console.log(`${name.padEnd(10)} ${s.correct}/${s.n} acc ${s.accuracy} ECE ${s.ece} brier ${s.brier} trap ${s.trapPicksAmongWrong} in ${s.meanInputTokens} th ${s.meanThoughtTokens} req ${s.meanRequests} p50 ${s.p50s}s p95 ${s.p95s}s speed ${s.speedAxis} cost ${s.costAxis}`);
}
console.log(`evidence: ${output}`);
