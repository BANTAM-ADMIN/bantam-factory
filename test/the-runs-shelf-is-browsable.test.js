// Chat evidence artifacts accumulate one per request — useless if reading them
// takes a hand-written python one-liner. `bantam runs` lists the shelf;
// `bantam runlens <file>` digests one, including the chat shape (its header
// used to come out as "(no runId) / model: ? / outcome: incomplete" for a
// completed chat run, because it only knew headless meta).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listRunArtifacts, formatRunsListing } from "../src/run-listing.js";
import { analyze } from "../src/logic/runlens.js";

const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body));

function shelf() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-runs-shelf-"));
  const dir = path.join(ws, ".bantam", "runs");
  fs.mkdirSync(dir, { recursive: true });
  return { ws, dir };
}

test("the listing shows every artifact, newest first, with its story", () => {
  const { ws, dir } = shelf();
  write(dir, "2026-08-17T10-00-00-000Z-chat-r0.json", {
    kind: "bantam-chat-run", partial: false, disposition: "done",
    request: "add a shout function", summary: "Added shout()", turnCount: 4,
  });
  write(dir, "2026-08-17T11-00-00-000Z-chat-r1.json", {
    kind: "bantam-chat-run", partial: true, truncatedBy: "autosave",
    request: "make it full screen", turnCount: 6,
  });
  const rows = listRunArtifacts(ws);
  assert.equal(rows.length, 2);
  assert.match(rows[0].file, /r1/, "newest first");
  assert.equal(rows[0].partial, true);
  assert.equal(rows[1].disposition, "done");
  const text = formatRunsListing(rows);
  assert.match(text, /add a shout function/);
  assert.match(text, /done/);
  assert.match(text, /partial/, "an in-flight or killed run says so");
});

test("an empty or missing shelf is a calm message, not an error", () => {
  const { ws } = shelf();
  assert.equal(listRunArtifacts(ws).length, 0);
  assert.match(formatRunsListing([]), /no run artifacts/i);
  assert.equal(listRunArtifacts("/nonexistent-path-xyz").length, 0);
});

test("a corrupt artifact appears as unreadable instead of crashing the listing", () => {
  const { ws, dir } = shelf();
  fs.writeFileSync(path.join(dir, "2026-08-17T12-00-00-000Z-chat-r2.json"), "{not json");
  const rows = listRunArtifacts(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unreadable, true);
});

test("runlens understands the chat artifact shape", () => {
  const s = analyze({
    kind: "bantam-chat-run", partial: false, disposition: "responded",
    request: "what does greet.js export?", requestIndex: 3,
    startedAt: "2026-08-17T10-00-00.000Z", endpoint: "http://localhost:8085",
    turns: [{ parsedAction: { a: "respond", text: "greet" }, observation: "" }],
  });
  assert.equal(s.outcome, "responded");
  assert.equal(s.task, "what does greet.js export?");
  assert.equal(s.model, "http://localhost:8085");
  assert.match(String(s.runId), /chat r3/);
});

test("runlens reports cache reuse from the authoritative metric", () => {
  const chunk = (pn, te) => `data: {"content":"x","tokens_evaluated":${te}}\n\ndata: {"content":"","timings":{"prompt_n":${pn},"prompt_ms":100.0}}\n`;
  const s = analyze({
    kind: "bantam-chat-run", disposition: "done", request: "r", turns: [],
    modelCalls: [
      { response: { rawBody: chunk(2000, 2000) } },   // cold first call
      { response: { rawBody: chunk(50, 2100) } },
      { response: { rawBody: chunk(40, 2200) } },
    ],
  });
  assert.ok(s.cache, "three timed calls are enough to report");
  assert.equal(s.cache.processed, 2090);
  assert.equal(s.cache.total, 6300);
  assert.equal(s.cache.reusePct, 67);
});

test("the waste ledger classifies what the artifact already records", () => {
  const s = analyze({
    kind: "bantam-chat-run", disposition: "done", request: "r",
    turns: [
      { parsedAction: { a: "read_file", p: "a.js" }, observation: "1\tx" },
      { parsedAction: { a: "replace", p: "a.js" }, observation: "replaced" },
      { parsedAction: { a: "shell", c: "npm test" }, observation: "# pass 1" },
      { parsedAction: { a: "done", summary: "done" }, observation: "" },
    ],
    rejectedOutputs: [{ turn: 1 }],
    events: [
      { type: "model_lock_wait" }, { type: "model_lock_wait" },
      { type: "paging_steer" }, { type: "done_rejected" },
    ],
  });
  assert.deepEqual(s.waste, { turns: 4, value: 2, recon: 1, motion: 1, waiting: 2, defects: 2 });
});
