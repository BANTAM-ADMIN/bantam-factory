import assert from "node:assert/strict";
import http from "node:http";
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
