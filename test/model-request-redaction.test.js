import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ModelClient } from "../src/model.js";

const SECRET = "sk-super-secret-key-1234567890";

test("stored request records never contain the API key", async () => {
  // Port 1 refuses connections immediately; the record still settles with an error.
  const client = new ModelClient({
    apiUrl: "http://127.0.0.1:1",
    apiKey: SECRET,
    model: "any-model",
    retries: 0,
    timeoutMs: 2000,
  });

  await assert.rejects(client.complete("hello"));

  const log = client.requestLog();
  assert.equal(log.length, 1);
  const serialized = JSON.stringify(log);
  assert.ok(!serialized.includes(SECRET), "request evidence must not embed the bearer token");
  assert.equal(log[0].request.headers.Authorization, "Bearer [redacted]");
});

test("live requests and redacted-record replays both send the real key", async () => {
  const seenAuthorization = [];
  const server = http.createServer((request, response) => {
    seenAuthorization.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ text: "ok" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const client = new ModelClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: SECRET,
      model: "any-model",
      retries: 0,
      timeoutMs: 5000,
    });

    const first = await client.complete("hello");
    assert.equal(first.content, "ok");

    const recorded = client.requestLog()[0].request;
    assert.equal(recorded.headers.Authorization, "Bearer [redacted]");

    const replay = await client.completeRequest(recorded);
    assert.equal(replay.content, "ok");

    assert.deepEqual(seenAuthorization, [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
