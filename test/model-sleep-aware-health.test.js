// /health is not proof a model is loaded. Measured 2026-08-22 with
// --sleep-idle-seconds 15: VRAM fell from 20062 MiB to 696 MiB while /health
// kept answering 200, because /health bypasses the sleep gate by design. The
// server does expose the truth — /props carries is_sleeping and also answers
// without waking the model — so that is the gauge liveness must read.
import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";

import { listModels, modelStatus, startRegisteredModel } from "../src/model-launcher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanups = [];
after(() => { for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } } });

/** A server that answers /health 200 always, and /props with the given state. */
async function server({ sleeping, propsStatus = 200 }) {
  const hits = { health: 0, props: 0 };
  const s = http.createServer((req, res) => {
    if (req.url === "/health") { hits.health++; res.writeHead(200); res.end('{"status":"ok"}'); return; }
    if (req.url === "/props") {
      hits.props++;
      if (propsStatus !== 200) { res.writeHead(propsStatus); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ is_sleeping: sleeping }));
      return;
    }
    if (req.url === "/slots") { res.writeHead(200, {"content-type":"application/json"}); res.end("[{}]"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  cleanups.push(() => s.close());
  return { endpoint: `http://127.0.0.1:${s.address().port}`, hits };
}

function registry(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-reg-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prior = process.env.BANTAM_MODELS;
  cleanups.push(() => { if (prior === undefined) delete process.env.BANTAM_MODELS; else process.env.BANTAM_MODELS = prior; });
  for (const e of entries) {
    e.script = path.join(dir, `${e.name}.sh`);
    fs.writeFileSync(e.script, "#!/usr/bin/env bash\nexit 0\n");
  }
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify(entries));
  process.env.BANTAM_MODELS = file;
  return dir;
}

test("a sleeping server is not 'running', however cheerful /health is", async () => {
  const { endpoint } = await server({ sleeping: true });
  registry([{ name: "asleep", endpoint }]);
  const [m] = await modelStatus();
  assert.equal(m.running, false, "the model is unloaded; VRAM is free; it is not running");
  assert.equal(m.sleeping, true, "and the reason must be visible, not just a false");
});

test("an awake server is running, and says it is not sleeping", async () => {
  const { endpoint } = await server({ sleeping: false });
  registry([{ name: "awake", endpoint }]);
  const [m] = await modelStatus();
  assert.equal(m.running, true);
  assert.equal(m.sleeping, false);
});

test("a server with no /props at all is treated as awake, not as broken", async () => {
  // vLLM and older llama.cpp builds have no /props; absence of evidence for
  // sleeping is not evidence of sleeping.
  const { endpoint } = await server({ sleeping: undefined, propsStatus: 404 });
  registry([{ name: "noprops", endpoint }]);
  const [m] = await modelStatus();
  assert.equal(m.running, true);
  assert.equal(m.sleeping, false);
});

test("starting a model does not report success when the server is asleep", async () => {
  const { endpoint } = await server({ sleeping: true });
  const dir = registry([{ name: "asleep", endpoint }]);
  const target = listModels().find((m) => m.name === "asleep");
  let said = "";
  const got = await startRegisteredModel(target, { waitMs: 4000, out: (s) => { said += s; } });
  assert.equal(got, null, "a sleeping server holds no model — that is not 'up'");
  assert.doesNotMatch(said, /Model is up/);
  assert.ok(dir);
});
