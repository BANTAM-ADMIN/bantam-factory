// A/B probe, dialect-aware. Measures GENERATION speed only: first token ->
// last token, grammar-constrained (what BANTAM actually sends), plus an
// unconstrained control.
//
//   node ab_bench.mjs <label> <vllm|llamacpp> [baseUrl] [model]
import fs from "node:fs";

const BASE = process.argv[4] ?? process.env.AB_BASE ?? "http://127.0.0.1:18020";
const DIALECT = process.argv[3] ?? "vllm";
const LABEL = process.argv[2] ?? "?";
const MODEL = process.argv[5] ?? "qwen3.8-27b";
const GBNF = fs.readFileSync("/tmp/ag.gbnf", "utf8");

const P = (t) => `<|im_start|>system\nYou are a coding agent. Reply with exactly one action object and nothing else.<|im_end|>\n<|im_start|>user\n${t}<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n`;
const TASKS = [
  "List the files in the current directory.",
  "Show the contents of package.json.",
  "Search the repository for TODO.",
  "Read the README file.",
  "Say you are finished.",
  "Write a file called notes.txt containing hello.",
];
const PROSE = "<|im_start|>user\nWrite a long detailed essay about the history of computing.<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The dialect decides where the grammar rides: vLLM nests it under
// structured_outputs, llama.cpp takes a top-level `grammar`.
function withGrammar(body, gbnf) {
  if (!gbnf) return body;
  if (DIALECT === "vllm") body.structured_outputs = { grammar: gbnf };
  else body.grammar = gbnf;
  return body;
}

async function call({ prompt, maxTokens, grammar = null, forceLength = false, temperature = 0.4 }) {
  const body = {
    model: MODEL, prompt, max_tokens: maxTokens, temperature, top_p: 0.95, top_k: 20,
    stop: ["<|im_end|>"], stream: true, stream_options: { include_usage: true },
  };
  if (forceLength) { body.ignore_eos = true; body.min_tokens = maxTokens; delete body.stop; }
  withGrammar(body, grammar);

  let first = null, last = null, usage = null, text = "";
  const res = await fetch(`${BASE}/v1/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) return { failed: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
  const dec = new TextDecoder(); let buf = "";
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let e; try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (e.usage) usage = e.usage;
      const t = e.choices?.[0]?.text;
      if (t) { const at = performance.now(); if (first === null) first = at; last = at; text += t; }
    }
  }
  const n = usage?.completion_tokens ?? null;
  const genMs = first !== null && last !== null ? last - first : null;
  let valid = false;
  try { valid = typeof JSON.parse(text).a === "string"; } catch { valid = false; }
  return { n, genMs, tps: genMs > 0 ? n / (genMs / 1000) : null, valid, failed: null };
}

let ready = false;
for (let i = 0; i < 200; i++) {
  try { const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(3000) }); if (r.ok) { ready = true; break; } }
  catch { /* booting */ }
  await wait(3000);
}
if (!ready) { console.log(`[${LABEL}] SERVER NEVER CAME UP at ${BASE}`); process.exit(2); }
await wait(3000);

const g = [];
for (const t of TASKS) g.push(await call({ prompt: P(t), maxTokens: 8192, grammar: GBNF }));
const good = g.filter((r) => !r.failed && r.genMs > 0);
const fails = g.filter((r) => r.failed);
const gTok = good.reduce((s, r) => s + r.n, 0);
const gMs = good.reduce((s, r) => s + r.genMs, 0);
const valid = good.filter((r) => r.valid === true).length;

// Unconstrained control: prose, forced length, so speculation's payoff shows.
const c1 = await call({ prompt: PROSE, maxTokens: 300, forceLength: true, temperature: 0.6 });
const c2 = await call({ prompt: PROSE, maxTokens: 300, forceLength: true, temperature: 0.6 });
const ctrl = [c1, c2].filter((r) => r.tps);
const ctrlTps = ctrl.length ? ctrl.reduce((s, r) => s + r.tps, 0) / ctrl.length : null;

console.log(
  `[${LABEL}] GRAMMAR: ${gTok} tok / ${gMs.toFixed(0)}ms = ${(gTok / (gMs / 1000)).toFixed(1)} tok/s generation` +
  ` | valid ${valid}/${good.length}${fails.length ? ` | failed ${fails.length} (${fails[0].failed})` : ""}` +
  ` || UNCONSTRAINED: ${ctrlTps ? ctrlTps.toFixed(1) : "n/a"} tok/s`,
);
