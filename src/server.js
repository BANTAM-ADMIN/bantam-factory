// BANTAM web UI server — a small, dependency-free HTTP host so you can drive the agent
// from a phone or another machine on the LAN and watch it work turn by turn.
//
// Decoupled from the agent internals on purpose: the caller supplies `getStatus()` and
// `runTask(opts, onEvent)`; this module only speaks HTTP, streams the run as newline-delimited
// JSON, and gates the API behind a token. It executes real tasks (which run shell in BANTAM's
// sandbox), so it must never be reachable without the token.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";

const HTML_PATH = new URL("./webui.html", import.meta.url);
// Read fresh per request — a local single-user tool, so the cost is nil and UI edits go live on reload.
function readHtml() {
  try { return fs.readFileSync(HTML_PATH, "utf8"); }
  catch { return "<!doctype html><meta charset=utf-8><title>BANTAM</title><p>webui.html not found</p>"; }
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}\n… (+${s.length - n} more chars)` : s;
}
function pickAction(a) {
  if (!a || typeof a !== "object") return null;
  const o = { a: a.a };
  if (typeof a.p === "string") o.p = a.p;
  if (a.c != null) o.c = String(a.c).slice(0, 240);
  if (typeof a.q === "string") o.q = a.q.slice(0, 200);
  return o;
}

/** Non-internal IPv4 addresses, so the launcher can print a URL a phone can reach. */
export function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  }
  return out;
}

export function createBantamServer({ token, getStatus, runTask, listDir, setWorkspace, maxBody = 200_000 }) {
  let busy = false;
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); return res.end("bad request"); }
    const p = url.pathname;

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readHtml());
    }

    // Everything under /api requires the token (query ?t= or x-bantam-token header).
    if (p.startsWith("/api/")) {
      const t = url.searchParams.get("t") || req.headers["x-bantam-token"];
      if (!token || t !== token) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("unauthorized"); }
    }

    if (req.method === "GET" && p === "/api/status") {
      Promise.resolve().then(getStatus).then((s) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(s ?? {}));
      }).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e?.message || e) })); });
      return;
    }

    if (req.method === "GET" && p === "/api/ls" && listDir) {
      Promise.resolve(listDir(url.searchParams.get("dir"))).then((r) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(r ?? {}));
      }).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e?.message || e) })); });
      return;
    }

    if (req.method === "POST" && p === "/api/workspace" && setWorkspace) {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on("end", async () => {
        let dir; try { dir = JSON.parse(body || "{}").dir; } catch { res.writeHead(400); return res.end("bad json"); }
        const r = await Promise.resolve(setWorkspace(dir)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
        res.writeHead(r?.ok ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(r ?? { ok: false, error: "unknown" }));
      });
      return;
    }

    if (req.method === "POST" && p === "/api/run") {
      if (busy) { res.writeHead(409, { "content-type": "text/plain" }); return res.end("a run is already in progress — one at a time"); }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > maxBody) req.destroy(); });
      req.on("end", async () => {
        let opts;
        try { opts = JSON.parse(body || "{}"); } catch { res.writeHead(400, { "content-type": "text/plain" }); return res.end("bad json"); }
        const task = String(opts.task || "").trim();
        if (!task) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("task is required"); }

        busy = true;
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
        const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* client gone */ } };
        const ac = new AbortController();
        // Abort the run only when the RESPONSE connection drops (client navigated away / hit Stop).
        // Listening on the request stream would fire as soon as the body is consumed and kill the run.
        res.on("close", () => { if (!res.writableEnded) ac.abort(); });

        const onEvent = (e) => {
          switch (e.type) {
            case "turn_start": send({ t: "turn_start", turn: e.turn }); break;
            case "action":
              if (e.reasoning) send({ t: "reasoning", text: clip(e.reasoning, 600) });
              if (e.action?.a === "respond") {
                // BANTAM answering a question/greeting — the reply text IS the point; show it as prose.
                send({ t: "answer", text: clip(e.action.text || "", 5000) });
              } else {
                send({ t: "action", action: pickAction(e.action) });
                if (e.action?.a === "done" && e.action.summary) send({ t: "summary", text: clip(e.action.summary, 800) });
              }
              break;
            case "observation": if (e.observation) send({ t: "observation", obs: clip(e.observation, 4000) }); break;
            case "activity": if (e.label) send({ t: "activity", label: e.label }); break;
            case "auto_verify": send({ t: "auto_verify", verdict: e.verdict }); break;
            case "test_diagnosis": case "teacher_diagnosis": send({ t: e.type, test: e.test }); break;
            case "done_rejected": send({ t: "done_rejected", gate: e.gate }); break;
            default: break; // the rest of BANTAM's rich event stream is not surfaced in the phone UI
          }
        };

        try {
          const result = await runTask({ task, verify: opts.verify || null, maxTurns: Number(opts.maxTurns) || 30, signal: ac.signal }, onEvent);
          send({ t: "result", pass: !!result.pass, status: result.status, turns: result.turns ?? 0, durationMs: result.durationMs ?? 0 });
        } catch (err) {
          send({ t: "result", pass: false, status: "error", turns: 0, error: String(err?.message || err) });
        } finally {
          busy = false;
          try { res.end(); } catch { /* already closed */ }
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

export function startBantamServer(opts) {
  const server = createBantamServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
