import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createJevApi } from "../src/jev/api.js";
import { followSavedToken, jevWelcome, runJevCli } from "../src/jev/commands.js";
import { loadJevConfig } from "../src/jev/config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-commands-"));

async function cli(argv, file) {
  process.env.BANTAM_JEV_CONFIG = file;
  const lines = [];
  try {
    const code = await runJevCli(argv, { out: (line) => lines.push(line) });
    return { code, text: lines.join("\n") };
  } finally { delete process.env.BANTAM_JEV_CONFIG; }
}
const saved = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("jev token", () => {
  it("creates a key once, shows the same key again, and saves it readable only by you", async () => {
    const file = path.join(tmp, "create.json");
    const first = await cli(["token"], file);
    const key = saved(file).api.token;
    assert.equal(first.code, 0);
    assert.match(key, /^[0-9a-f]{48}$/);
    assert.match(first.text, new RegExp(`API key \\(new\\): ${key}`));
    assert.match(first.text, /Authorization: Bearer <key>/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const again = await cli(["token"], file);
    assert.equal(saved(file).api.token, key, "showing the key does not replace it");
    assert.doesNotMatch(again.text, /\(new\)/);
  });

  it("new replaces the key; clear removes it; other settings survive", async () => {
    const file = path.join(tmp, "rotate.json");
    fs.writeFileSync(file, JSON.stringify({ engine: { mode: "external" }, api: { port: 9000 } }));
    await cli(["token"], file);
    const old = saved(file).api.token;
    const rotated = await cli(["token", "new"], file);
    assert.notEqual(saved(file).api.token, old);
    assert.match(rotated.text, /the old one stops working now/);
    await cli(["token", "clear"], file);
    assert.equal(saved(file).api.token, null);
    assert.equal(saved(file).api.port, 9000);
    assert.equal(saved(file).engine.mode, "external");
    assert.equal((await cli(["token", "bogus"], file)).code, 2);
  });
});

describe("jev welcome panel", () => {
  const status = { api: { url: "http://127.0.0.1:8090" }, engine: "awake", policy: "alongside", configuredPolicy: "auto" };
  const config = (token) => loadJevConfig({ api: { token } }, { readFile: () => "{}" });

  it("explains Jev, the API, the key and a request to paste", () => {
    const open = jevWelcome(status, config(null));
    assert.match(open, /Jev mode is on/);
    assert.match(open, /http:\/\/127\.0\.0\.1:8090\/v1\/systemone/);
    assert.match(open, /none needed: only this machine can connect; :jev token creates one/);
    assert.doesNotMatch(open, /authorization: Bearer/);
    assert.match(open, /:jev ask/);
    const keyed = jevWelcome(status, config("k123"), { surface: "cli" });
    assert.match(keyed, /Key {5}k123/);
    assert.match(keyed, /-H 'authorization: Bearer k123'/);
    assert.match(keyed, /bantamfactory jev token new/);
    assert.match(keyed, /Ctrl-C stops serving/);
  });

  it("warns about swap delays only under the swap policy", () => {
    assert.doesNotMatch(jevWelcome(status, config(null)), /swaps in/);
    assert.match(jevWelcome({ ...status, policy: "swap" }, config(null)), /swaps in \(about 6 s\)/);
  });
});

describe("jev API token changes", () => {
  it("applies a new or removed token without a restart", async () => {
    let token = null;
    const api = createJevApi({ decide: async () => ({ answers: {} }), token: () => token });
    const call = async (auth) => {
      const res = { status: 0, setHeader() {}, writeHead(code) { this.status = code; }, end() {} };
      const req = Object.assign((async function* () {})(), { method: "GET", url: "/v1/models", headers: auth ? { authorization: `Bearer ${auth}` } : {} });
      await api(req, res);
      return res.status;
    };
    assert.equal(await call(null), 200);
    token = "fresh";
    assert.equal(await call(null), 403);
    assert.equal(await call("fresh"), 200);
    assert.equal(await call("stale"), 401);
    token = null;
    assert.equal(await call(null), 200);
  });
});

describe("following the saved key while serving", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("picks up a key saved by another process, and a removal on localhost", async () => {
    const file = path.join(tmp, "follow.json");
    fs.writeFileSync(file, JSON.stringify({ api: { token: "one" } }));
    const config = loadJevConfig({}, { file });
    const stop = followSavedToken(config, { file, intervalMs: 20 });
    try {
      fs.writeFileSync(file, JSON.stringify({ api: { token: "two" } }));
      await settle();
      assert.equal(config.api.token, "two");
      fs.writeFileSync(file, JSON.stringify({ api: { token: null } }));
      await settle();
      assert.equal(config.api.token, null);
    } finally { stop(); }
  });

  it("never drops the key of an API open to the network, and ignores a half-written file", async () => {
    const file = path.join(tmp, "follow-lan.json");
    fs.writeFileSync(file, JSON.stringify({ api: { host: "0.0.0.0", token: "keep" } }));
    const config = loadJevConfig({}, { file });
    const stop = followSavedToken(config, { file, intervalMs: 20 });
    try {
      fs.writeFileSync(file, "{\"api\": {");
      await settle();
      assert.equal(config.api.token, "keep");
      fs.writeFileSync(file, JSON.stringify({ api: { host: "0.0.0.0", token: null } }));
      await settle();
      assert.equal(config.api.token, "keep");
    } finally { stop(); }
  });
});
