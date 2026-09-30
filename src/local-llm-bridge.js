import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForImageGpu } from './image-gpu.js';

// An HTTP socket capability, not a general network proxy. Never accept a
// destination from the sandbox or follow upstream redirects.
export function localLlmEndpoint(model) {
  if (!model || model.codex || model.codexBacked || process.env.BANTAM_SHELL_LLM === '0') return null;
  const value = model.apiMode ? model.apiUrl : model.endpoint;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) return null;
    if (['localhost', '0.0.0.0'].includes(url.hostname)) url.hostname = '127.0.0.1';
    url.search = ''; url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

const routes = new Map([
  ['/health', 'GET'], ['/v1/models', 'GET'],
  ['/completion', 'POST'], ['/v1/completions', 'POST'],
  ['/v1/chat/completions', 'POST'], ['/v1/embeddings', 'POST'],
  ['/tokenize', 'POST'], ['/detokenize', 'POST'],
]);

export async function startLocalLlmBridge(endpoint, { apiKey = null } = {}) {
  const normalized = localLlmEndpoint({ endpoint });
  if (!normalized) throw new Error('LLM bridge requires a loopback HTTP endpoint');
  const target = new URL(normalized);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-llm-'));
  const socketPath = path.join(directory, 'api.sock');
  const upstreams = new Set();
  const server = http.createServer(async (req, res) => {
    if (routes.get(req.url) !== req.method) {
      res.writeHead(403).end('LLM bridge: route or method is not allowed');
      req.resume(); return;
    }
    const waiting = new AbortController();
    res.on('close', () => waiting.abort());
    try { await waitForImageGpu(normalized, waiting.signal); }
    catch {
      if (!res.destroyed) res.writeHead(503).end('Local LLM is unavailable during image GPU recovery');
      req.resume(); return;
    }
    const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    // apiUrl often ends in /v1; the socket always exposes canonical /v1 paths.
    const prefix = target.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
    const upstream = (target.protocol === 'https:' ? https : http).request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port, path: prefix + req.url, method: req.method, headers,
    }, reply => {
      // Do not forward Location, cookies, or hop-by-hop headers.
      res.writeHead(reply.statusCode, { 'content-type': reply.headers['content-type'] || 'application/json' });
      reply.on('error', () => res.destroy());
      reply.pipe(res);
    });
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('Local LLM request failed');
      else res.destroy();
    });
    upstream.setTimeout(600000, () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory, socketPath,
    async close() {
      for (const request of upstreams) request.destroy();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
