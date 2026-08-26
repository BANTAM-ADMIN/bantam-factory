import http from "node:http";

import { collectFactoryReportEvidence, renderFactoryReport } from "./html-report.js";
import { projectRecordedFactoryBlueprint, renderFactoryBlueprint } from "./blueprint.js";
import { FactoryStore } from "./store.js";
import { WorkforceRegistry } from "./workforce.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

export async function startFactoryFloorServer({
  root,
  jobId,
  host = "127.0.0.1",
  port = 4317,
  pollIntervalMs = 1_000,
  signal = null,
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("factory floor host must be a loopback address (127.0.0.1 or ::1)");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("factory floor port must be an integer from 0 to 65535");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new Error("factory floor poll interval must be an integer from 100 to 60000ms");
  }
  const store = new FactoryStore(root);
  const snapshot = () => buildSnapshot({ store, root, jobId });
  const blueprintSnapshot = () => projectRecordedFactoryBlueprint(store, store.load(jobId));
  snapshot(); // Fail before binding if the requested traveler is absent or invalid.

  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "method not allowed\n", request.method === "HEAD");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/health") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, jobId }), request.method === "HEAD");
      } else if (url.pathname === "/api/snapshot") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(snapshot()), request.method === "HEAD");
      } else if (url.pathname === "/api/blueprint") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(blueprintSnapshot()), request.method === "HEAD");
      } else if (url.pathname === "/blueprint") {
        send(response, 200, "text/html; charset=utf-8", renderFactoryBlueprint(blueprintSnapshot()), request.method === "HEAD");
      } else if (url.pathname === "/") {
        const state = snapshot();
        const body = renderFactoryReport(state.events, {
          evidence: state.evidence,
          workforce: state.workforce,
          liveEndpoint: "/api/snapshot",
          blueprintEndpoint: state.blueprintRef ? "/blueprint" : null,
          pollIntervalMs,
        });
        send(response, 200, "text/html; charset=utf-8", body, request.method === "HEAD");
      } else {
        send(response, 404, "text/plain; charset=utf-8", "not found\n", request.method === "HEAD");
      }
    } catch (error) {
      send(response, 503, "application/json; charset=utf-8", JSON.stringify({
        schema: 1,
        kind: "bantam.factory-floor-error",
        error: error.message,
      }), request.method === "HEAD");
    }
  });

  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  server.once("close", resolveClosed);
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const displayHost = host === "::1" ? "[::1]" : host;
  const url = `http://${displayHost}:${address.port}/`;
  const close = () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
  if (signal) {
    if (signal.aborted) await close();
    else signal.addEventListener("abort", () => { void close(); }, { once: true });
  }
  return Object.freeze({ server, address, url, closed, close });
}

function buildSnapshot({ store, root, jobId }) {
  const events = store.load(jobId);
  const evidence = collectFactoryReportEvidence(store, events);
  let workforce = null;
  try { workforce = new WorkforceRegistry(root).project(); } catch { /* job visibility outranks an optional workforce projection */ }
  const blueprintRef = events.find((event) => event.type === "blueprint.loaded")?.payload.blueprintRef ?? null;
  return {
    schema: 1,
    kind: "bantam.factory-floor-snapshot",
    jobId,
    generatedAt: new Date().toISOString(),
    events,
    evidence,
    workforce,
    blueprintRef,
  };
}

function send(response, status, contentType, body, headOnly = false) {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType });
  response.end(headOnly ? undefined : body);
}
