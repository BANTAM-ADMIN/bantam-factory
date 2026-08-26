import http from "node:http";

import { collectFactoryReportEvidence, renderFactoryReport } from "./html-report.js";
import { projectRecordedFactoryBlueprint, renderFactoryBlueprint } from "./blueprint.js";
import { FactoryStore } from "./store.js";
import { WorkforceRegistry } from "./workforce.js";
import { projectFactoryYard } from "./yard.js";
import { renderFactoryYard } from "./yard-report.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

export async function startFactoryYardServer({
  root,
  host = "127.0.0.1",
  port = 4_318,
  pollIntervalMs = 1_000,
  idleAfterMs = 30_000,
  semanticControls = [],
  signal = null,
} = {}) {
  validateOptions({ host, port, pollIntervalMs, idleAfterMs });
  const store = new FactoryStore(root);
  const yardSnapshot = () => projectFactoryYard({ root, idleAfterMs, semanticControls });
  yardSnapshot();
  const jobSnapshot = (jobId) => buildJobSnapshot({ store, root, jobId });
  const blueprintSnapshot = (jobId) => {
    const events = store.load(jobId);
    return projectRecordedFactoryBlueprint(store, events);
  };

  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "method not allowed\n", request.method === "HEAD");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const jobPage = matchJobPath(url.pathname, "/jobs/");
      const jobApi = matchJobPath(url.pathname, "/api/jobs/");
      const blueprintPage = matchJobPath(url.pathname, "/blueprints/");
      const blueprintApi = matchJobPath(url.pathname, "/api/blueprints/");
      if (url.pathname === "/health") {
        const yard = yardSnapshot();
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, lines: yard.summary.total }), request.method === "HEAD");
      } else if (url.pathname === "/api/yard") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(yardSnapshot()), request.method === "HEAD");
      } else if (blueprintApi !== null) {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(blueprintSnapshot(blueprintApi)), request.method === "HEAD");
      } else if (blueprintPage !== null) {
        send(response, 200, "text/html; charset=utf-8", renderFactoryBlueprint(blueprintSnapshot(blueprintPage)), request.method === "HEAD");
      } else if (jobApi !== null) {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(jobSnapshot(jobApi)), request.method === "HEAD");
      } else if (jobPage !== null) {
        const state = jobSnapshot(jobPage);
        send(response, 200, "text/html; charset=utf-8", renderFactoryReport(state.events, {
          evidence: state.evidence,
          workforce: state.workforce,
          liveEndpoint: `/api/jobs/${encodeURIComponent(jobPage)}`,
          blueprintEndpoint: state.blueprintRef ? `/blueprints/${encodeURIComponent(jobPage)}` : null,
          pollIntervalMs,
        }), request.method === "HEAD");
      } else if (url.pathname === "/") {
        send(response, 200, "text/html; charset=utf-8", renderFactoryYard(yardSnapshot(), { pollIntervalMs }), request.method === "HEAD");
      } else {
        send(response, 404, "text/plain; charset=utf-8", "not found\n", request.method === "HEAD");
      }
    } catch (error) {
      send(response, 503, "application/json; charset=utf-8", JSON.stringify({ schema: 1, kind: "bantam.factory-yard-error", error: error.message }), request.method === "HEAD");
    }
  });
  return listen(server, { host, port, signal });
}

function buildJobSnapshot({ store, root, jobId }) {
  const events = store.load(jobId);
  const evidence = collectFactoryReportEvidence(store, events);
  let workforce = null;
  try { workforce = new WorkforceRegistry(root).project(); } catch { /* optional workforce state must not hide a job */ }
  const blueprintRef = events.find((event) => event.type === "blueprint.loaded")?.payload.blueprintRef ?? null;
  return { schema: 1, kind: "bantam.factory-floor-snapshot", jobId, generatedAt: new Date().toISOString(), events, evidence, workforce, blueprintRef };
}

function matchJobPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  const jobId = decodeURIComponent(encoded);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId)) throw new Error(`invalid factory job id: ${jobId}`);
  return jobId;
}

function validateOptions({ host, port, pollIntervalMs, idleAfterMs }) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("factory yard host must be a loopback address (127.0.0.1 or ::1)");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("factory yard port must be an integer from 0 to 65535");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) throw new Error("factory yard poll interval must be from 100 to 60000ms");
  if (!Number.isInteger(idleAfterMs) || idleAfterMs < 1 || idleAfterMs > 86_400_000) throw new Error("factory yard idle threshold must be from 1 to 86400000ms");
}

async function listen(server, { host, port, signal }) {
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

function send(response, status, contentType, body, headOnly = false) {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType });
  response.end(headOnly ? undefined : body);
}
