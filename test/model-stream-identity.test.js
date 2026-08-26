// Streaming is delivery, not generation: the streamed and non-streamed paths
// must produce byte-identical completions from the same server output. This
// stub serves the SAME text both ways; the client must agree with itself.
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { ModelClient } from "../src/model.js";

const TEXT = 'thinking…\n{"a":"respond","text":"Line one\\nCafé ✓ done"}';

function stubServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body);
        if (b.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          // three uneven chunks, multibyte char split across none (llama.cpp
          // sends whole tokens per event); final carries stop + timings.
          const parts = [TEXT.slice(0, 15), TEXT.slice(15, 40), TEXT.slice(40)];
          for (const p of parts.slice(0, -1)) {
            res.write(`data: ${JSON.stringify({ content: p, stop: false })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ content: parts[parts.length - 1], stop: true, tokens_predicted: 42, timings: { predicted_per_second: 88.8 } })}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content: TEXT, tokens_predicted: 42, timings: { predicted_per_second: 88.8 } }));
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("streamed and plain completions are byte-identical; onProgress is cumulative", async (t) => {
  const srv = await stubServer();
  t.after(() => srv.close());
  const endpoint = `http://127.0.0.1:${srv.address().port}`;
  const model = new ModelClient({ endpoint, timeoutMs: 10000 });

  const plain = await model.complete("p", {});
  const seen = [];
  const streamed = await model.complete("p", { onProgress: (p) => seen.push(p.content) });

  assert.equal(plain.content, TEXT);
  assert.equal(streamed.content, TEXT, "streamed accumulation must equal the plain body");
  assert.ok(seen.length >= 1, "onProgress fired");
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].startsWith(seen[i - 1]), "content snapshots are cumulative");
  }
  assert.ok(TEXT.startsWith(seen[seen.length - 1]) || seen[seen.length - 1] === TEXT);
});
