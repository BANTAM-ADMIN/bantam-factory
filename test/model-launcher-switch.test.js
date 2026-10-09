import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { switchToModel } from "../src/model-launcher.js";

test("attaches to a healthy generic local endpoint without restarting it", async (t) => {
  let healthChecks = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      healthChecks += 1;
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === "/v1/models") {
      res.end('{"object":"list","data":[{"id":"operator-model.gguf"}]}');
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  let selected = null;
  const output = [];
  const switched = await switchToModel(
    { switchTo(value) { selected = value; } },
    { label: "Local model", endpoint, script: "/unused/start.sh", match: "" },
    { waitMs: 100, out: (text) => output.push(text) },
  );

  assert.equal(switched, true);
  assert.equal(selected, endpoint);
  assert.equal(healthChecks, 1);
  assert.match(
    output.join(""),
    new RegExp(`Now using Local model @ ${endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(already running\\)`),
  );
});

test("selecting an offline local model runs its script and verifies the resulting model", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-launch-choice-"));
  const pidFile = path.join(root, "pid");
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already exited */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const serverFile = path.join(root, "server.cjs");
  fs.writeFileSync(serverFile, `
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
http.createServer((req, res) => {
  const values = {
    '/health': { status: 'ok' },
    '/props': { is_sleeping: false, total_slots: 1 },
    '/slots': [{}],
    '/v1/models': { data: [{ id: 'chosen-model.gguf' }] },
  };
  res.writeHead(values[req.url] ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(values[req.url] || {}));
}).listen(${port}, '127.0.0.1');
`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const script = path.join(root, "start.sh");
  fs.writeFileSync(script, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(serverFile)}\n`);
  const endpoint = `http://127.0.0.1:${port}`;
  let selected = null;
  const messages = [];
  const ok = await switchToModel({ switchTo(value) { selected = value; } },
    { name: "chosen", label: "Chosen model", script, endpoint, match: "chosen-model", slots: 1 },
    { waitMs: 10_000, out: value => messages.push(value) });
  assert.equal(ok, true);
  assert.equal(selected, endpoint);
  assert.match(messages.join(""), /Starting Chosen model/);
  assert.equal(JSON.parse(await (await fetch(`${endpoint}/v1/models`)).text()).data[0].id, "chosen-model.gguf");
});
