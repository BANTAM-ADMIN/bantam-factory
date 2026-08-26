import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";

// The first thing a newcomer hits is a model server that isn't running, and the
// message was `model request failed: fetch failed (endpoint http://…)`. True,
// and useless to someone who does not already know bantam needs llama.cpp on
// 8085 — the exit code is correct and the run stops cleanly, but nothing says
// what to DO.
//
// `bantam doctor` already answers exactly this: it checks node, probes the
// endpoint, and prints a "Next:" instruction. It just isn't discoverable at the
// moment it is needed.
//
// Only for connection-shaped failures. An HTTP 500 from a server that IS running
// is a different problem and pointing at doctor there would be noise.

test("a connection failure names the command that diagnoses it", async () => {
  const model = new ModelClient({ endpoint: "http://127.0.0.1:9", model: "x" });
  await assert.rejects(
    () => model.complete("hello", { maxTokens: 1 }),
    (e) => {
      assert.match(String(e.message), /endpoint http:\/\/127\.0\.0\.1:9/, "still names the endpoint");
      assert.match(String(e.message), /bantam doctor/, `should point at the diagnostic: ${e.message}`);
      return true;
    },
  );
});
