#!/usr/bin/env node
// Live demonstration of BANTAM Jev mode: starts the service on the real
// DiffusionGemma engine, sends a set of requests through the Jev API, and
// records every request/response with timings to docs/jev-demos/transcript.json.
// Used to produce the examples in JEV_MODE.md.
//
//   node scripts/jev-live-demo.mjs [--port 8095] [--rows .bantam/decision-index/dev-1500.jsonl.gz]
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";
import { loadJevConfig } from "../src/jev/config.js";
import { createJevService } from "../src/jev/service.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const port = Number(arg("port", "8095"));
const rowsFile = arg("rows", ".bantam/decision-index/dev-1500.jsonl.gz");
const out = "docs/jev-demos/transcript.json";

// Real Decision Index dev rows for the gauge demonstrations.
async function firstRow(prefix) {
  const rl = readline.createInterface({ input: fs.createReadStream(rowsFile).pipe(zlib.createGunzip()) });
  for await (const line of rl) { const r = JSON.parse(line); if (r._evaluation.dataset.startsWith(prefix)) { rl.close(); return r; } }
  return null;
}

const service = createJevService({ config: loadJevConfig(), log: () => {} });
console.log("turning Jev mode on…");
const t0 = Date.now();
const status = await service.on({ port, onProgress: (l) => console.log("  ", l) });
console.log(`on in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, status.engine, status.policy, status.api?.url);
const base = `http://127.0.0.1:${port}`;
const transcript = [];

async function call(title, method, path, body, headers = {}) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const ms = performance.now() - started;
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return l; } }); }
  transcript.push({ title, request: { method, path, headers, body }, response: { status: res.status, headers: { "x-request-id": res.headers.get("x-request-id"), "server-timing": res.headers.get("server-timing"), "content-type": res.headers.get("content-type") }, body: parsed }, ms: Math.round(ms) });
  console.log(`${String(res.status).padEnd(4)} ${String(Math.round(ms)).padStart(6)} ms  ${title}`);
  return parsed;
}

// 1. Plain Jev.
await call("health", "GET", "/health");
await call("model list", "GET", "/v1/models");
await call("yes/no question", "POST", "/v1/systemone", { model: "bantam-jev", state: { ticket: "I was charged twice for my March subscription and nobody has answered my emails for a week." }, questions: { refund_owed: { type: "noul", instructions: "Is the customer owed a refund?" }, angry: { type: "noul", instructions: "Is the customer frustrated?" } } });
await call("choice + score in one request", "POST", "/v1/systemone", { model: "bantam-jev", state: "The build failed: `TypeError: Cannot read properties of undefined (reading 'map')` at src/list.js:14 after the API started returning null for empty lists.", questions: { cause: { type: "choice", instructions: "What is the most likely cause?", criteria: { null_data: "the code does not handle a null response", flaky_test: "a flaky test", syntax: "a syntax error", dependency: "a broken dependency" } }, severity: { type: "score", instructions: "How severe is this for users?", criteria: ["cosmetic", "minor", "major", "outage"] } } });
await call("single-option choice (answered without a read)", "POST", "/v1/systemone", { model: "bantam-jev", state: "anything", questions: { only: { type: "choice", criteria: { the_one: "the only option" } } } });

// 2. Fast vs full profile on the same question.
const routing = { state: "Customer message: 'my card got eaten by the ATM on 5th street, can you block it?'", questions: { intent: { type: "choice", instructions: "Which intent is this?", criteria: { card_swallowed: "card swallowed by an ATM", lost_or_stolen_card: "card lost or stolen", card_arrival: "waiting for a new card", balance: "check balance" } } } };
await call("fast profile (no thinking)", "POST", "/v1/systemone", { model: "bantam-jev-fast", ...routing, bantam: { explain: true } });
await call("full profile (same question)", "POST", "/v1/systemone", { model: "bantam-jev", ...routing, bantam: { explain: true } });

// 3. Exact gauges on real Decision Index dev rows.
for (const [title, prefix] of [["execution gauge (CRUXEval dev row)", "CRUXEval"], ["tool-call gauge (When2Call dev row)", "When2Call"], ["state gauge (Home appliance dev row)", "Home appliance"]]) {
  const row = await firstRow(prefix);
  const res = await call(title, "POST", "/v1/systemone", { model: "bantam-jev", state: row.state, questions: row.questions, bantam: { explain: true } });
  const right = Object.entries(row.expected).filter(([k, g]) => g != null && res.answers?.[k]?.choice === g).length;
  transcript.at(-1).gold = row.expected;
  transcript.at(-1).scored = `${right}/${Object.values(row.expected).filter((g) => g != null).length} right`;
  console.log(`         ${transcript.at(-1).scored}`);
}

// 4. Extensions.
await call("abstain below a confidence (andon for gates)", "POST", "/v1/systemone", { model: "bantam-jev-fast", state: "The meeting is sometime next week, probably.", questions: { day: { type: "choice", instructions: "Which day is the meeting?", criteria: { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday" } } }, bantam: { abstainBelow: 0.8, explain: true } });
await call("borrowed thought (experimental)", "POST", "/v1/systemone", { model: "bantam-jev", state: "When was the Old Babylonian version of Gilgamesh modified into the standard version?", questions: { when: { type: "choice", criteria: { A: "Toward the end of the first millennium BCE", C: "Toward the end of the second millennium BCE", E: "At the start of the second millennium BCE" } } }, bantam: { explain: true, thought: "The Standard Babylonian version is attributed to the scribe Sîn-lēqi-unninni, dated about 1300–1000 BCE: toward the end of the second millennium BCE." } });
await call("batch, streamed as NDJSON", "POST", "/v1/systemone/batch", { model: "bantam-jev-fast", rows: [ { state: "The package arrived crushed.", questions: { damaged: { type: "noul", instructions: "Was the item damaged?" } } }, { state: "Thanks, everything was perfect!", questions: { damaged: { type: "noul", instructions: "Was the item damaged?" } } }, { state: "x", questions: { bad: { type: "ranking" } } } ] }, { accept: "application/x-ndjson" });
await call("gauges", "GET", "/v1/gauges");
await call("status", "GET", "/v1/bantam/status");

// 5. Errors, in Jev's shapes.
await call("error: unknown model", "POST", "/v1/systemone", { model: "gpt-9", state: "s", questions: { q: { type: "noul" } } });
await call("error: missing field", "POST", "/v1/systemone", { model: "bantam-jev", questions: { q: { type: "noul" } } });
await call("error: unknown question type", "POST", "/v1/systemone", { model: "bantam-jev", state: "s", questions: { q: { type: "ranking" } } });

fs.writeFileSync(out, JSON.stringify(transcript, null, 1));
console.log(`wrote ${transcript.length} exchanges to ${out}`);
await service.off({ keepEngine: true });
