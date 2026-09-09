import assert from "node:assert/strict";
import test from "node:test";

import { ChatSessionPlanner } from "../src/chat-sessions.js";
import { ModelClient } from "../src/model.js";

// codexapi sessions (2026-08-24): a reused session sends ONLY the newest message
// and the thread keeps its own replies, so a warm turn costs ~1.7 s instead of
// ~3.3 s and stops resending a growing transcript. The planner decides, per
// prompt, whether it is a byte-extension of the run's last prompt (send the
// delta), a rebuilt main line (rebase: new session, full transcript), or an
// auxiliary call with a different head (ephemeral: no session at all).

const SYS = "<|im_start|>system\nYou are Bantam.<|im_end|>\n";
const TASK = "<|im_start|>user\nTask: look around\n\nWorkspace:\nsrc/<|im_end|>\n";
const OPEN = "<|im_start|>assistant\n";
const P0 = SYS + TASK + OPEN;
const REPLY = '{"a":"list_dir","p":"src"}';
const OBS1 = "<|im_start|>user\n<observation>\nsrc:\na.js\n</observation>\n<|im_end|>\n";
const GUIDE = "<|im_start|>user\nReminder — your objective\n<|im_end|>\n";
const P1 = SYS + TASK + OPEN + REPLY + "<|im_end|>\n" + OBS1 + GUIDE + OPEN;

test("the first call opens a run session with the full transcript", () => {
  const planner = new ChatSessionPlanner({ prefix: "t" });
  const plan = planner.plan(P0);
  assert.ok(plan.sessionId?.startsWith("t-"));
  assert.equal(plan.delta, false);
  assert.deepEqual(plan.messages.map((m) => m.role), ["system", "user"]);
  planner.commit(plan, P0, REPLY);
  assert.equal(planner.stats.full, 1);
});

test('an altered or unacknowledged assistant reply is never silently dropped', () => {
  for (const reply of [null, '{"a":"read_file","p":"other.js"}']) {
    const planner = new ChatSessionPlanner(); const first = planner.plan(P0);
    planner.commit(first, P0, reply);
    const next = planner.plan(P1);
    assert.equal(next.kind, 'rebase'); assert.notEqual(next.sessionId, first.sessionId);
    assert.ok(next.messages.some(m => m.role === 'assistant' && m.content === REPLY));
  }
});

test('explicit auxiliary calls never capture or replace a bridge run session', () => {
  const client = new ModelClient({apiUrl: 'http://bridge/v1', apiDialect: 'chat', model: 'gpt-6-astra:medium'});
  const planner = client.enableChatSessions();
  assert.deepEqual(client.codexToolIdentity, {model: 'gpt-6-astra', effort: 'medium'});
  let request = client.buildRequest(P0, {isolated: true});
  assert.equal(planner.pending.kind, 'ephemeral');
  assert.equal(JSON.parse(request.body).session_id ?? null, null);
  planner.commit(planner.pending, P0, REPLY);
  assert.equal(planner.run, null);
  const first = planner.plan(P0); planner.commit(first, P0, REPLY);
  request = client.buildRequest(P1, {isolated: true});
  assert.equal(planner.pending.kind, 'ephemeral');
  planner.commit(planner.pending, P1, 'auxiliary reply');
  assert.equal(planner.plan(P1).sessionId, first.sessionId);
  assert.equal(planner.pending.kind, 'delta');
});

test('a startup grammar probe cannot capture the main run session', async () => {
  const client = new ModelClient({apiUrl:'http://bridge/v1', apiDialect:'chat'});
  client.enableChatSessions(); const planner=client.chatSessions;
  const deleted=[]; planner.deleteSession=async id=>{deleted.push(id);};
  const probe='\u003c|im_start|>user\nReply with ok.\u003c|im_end|>\n'+OPEN;
  const preliminary=planner.plan(probe); planner.commit(preliminary,probe,'ok');
  client.beginAgentRun();
  const first=planner.plan(P0);assert.equal(first.kind,'full');planner.commit(first,P0,REPLY);
  assert.equal(planner.plan(P1).kind,'delta');
  await client.endAgentRun(null);
  assert.deepEqual(deleted,[preliminary.sessionId,first.sessionId]);
});

test('health enables bridge sessions for headless runs without calling a model or changing transport', async t => {
  const requests = []; const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (url, options) => {
    requests.push({url, method:options.method ?? 'GET'});
    return new Response(JSON.stringify({object:'list', data:[]}));
  };
  const client = new ModelClient({apiUrl:'http://bridge:8787/v1', apiDialect:'chat', model:'gpt-6-astra:medium'});
  assert.equal(await client.health(), true); assert.equal(client.codex, false); assert.equal(client.codexBacked, true);
  const planner = client.chatSessions; client.enableChatSessions(); assert.equal(client.chatSessions, planner);
  assert.deepEqual(requests.map(r => r.method), ['GET','GET']);
  const request = client.buildRequest(P0, {});
  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(JSON.parse(request.body).chat_preamble, false);
  await client.endAgentRun(null);
});

test('unsupported endpoints and explicit session opt-out keep ordinary chat transport', async t => {
  const original = globalThis.fetch, old = process.env.BANTAM_CHAT_SESSIONS;
  t.after(() => {globalThis.fetch=original; if(old===undefined)delete process.env.BANTAM_CHAT_SESSIONS;else process.env.BANTAM_CHAT_SESSIONS=old;});
  globalThis.fetch = async url => new Response('{}', {status:String(url).endsWith('/sessions') ? 404 : 200});
  const client = new ModelClient({apiUrl:'http://chat/v1',apiDialect:'chat'});
  assert.equal(await client.health(), true); assert.equal(client.codexBacked, false);
  process.env.BANTAM_CHAT_SESSIONS='0';
  let calls=0; globalThis.fetch=async()=>{calls++;return new Response('{"object":"list","data":[]}');};
  assert.equal(await client.health(),true);assert.equal(calls,1);assert.equal(client.chatSessions,null);
});

test("a byte-extension sends only the new user content, without the assistant's own reply", () => {
  const planner = new ChatSessionPlanner({ prefix: "t" });
  const first = planner.plan(P0); planner.commit(first, P0, REPLY);
  const plan = planner.plan(P1);
  assert.equal(plan.sessionId, first.sessionId);
  assert.equal(plan.delta, true);
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].role, "user");
  assert.match(plan.messages[0].content, /<observation>\nsrc:\na\.js/);
  assert.match(plan.messages[0].content, /Reminder — your objective/, "several new user turns are joined into the one message the server reads");
  assert.doesNotMatch(plan.messages[0].content, /list_dir/, "the thread already holds its reply");
  planner.commit(plan, P1, REPLY);
  assert.equal(planner.stats.delta, 1);
});

test("a rebuilt main line (same head, not an extension) rebases onto a new session", () => {
  const planner = new ChatSessionPlanner({ prefix: "t" });
  const first = planner.plan(P0); planner.commit(first, P0, REPLY);
  const second = planner.plan(P1); planner.commit(second, P1, REPLY);
  // The harness rewrote observation 1 in place (a stub) — same head, not an extension of P1.
  const rebuilt = SYS + TASK + OPEN + REPLY + "<|im_end|>\n<|im_start|>user\n<observation>\n[turn 1: src — earlier snapshot omitted]\n</observation>\n<|im_end|>\n" + GUIDE + OPEN;
  const plan = planner.plan(rebuilt);
  assert.notEqual(plan.sessionId, first.sessionId);
  assert.equal(plan.delta, false);
  assert.equal(plan.messages.length, 5, "the whole transcript again");
  planner.commit(plan, rebuilt);
  assert.equal(planner.stats.rebases, 1);
  assert.deepEqual(planner.retired, [first.sessionId], "the old session is queued for deletion");
});

test("an auxiliary prompt with a different head is ephemeral and leaves the run session intact", () => {
  const planner = new ChatSessionPlanner({ prefix: "t" });
  const first = planner.plan(P0); planner.commit(first, P0, REPLY);
  const aux = "<|im_start|>system\nSummarize.<|im_end|>\n<|im_start|>user\nSummarize this.<|im_end|>\n" + OPEN;
  const plan = planner.plan(aux);
  assert.equal(plan.sessionId, null);
  assert.equal(plan.delta, false);
  planner.commit(plan, aux);
  const next = planner.plan(P1);
  assert.equal(next.sessionId, first.sessionId, "the run session survives the aside");
  assert.equal(next.delta, true);
  assert.equal(planner.stats.ephemeral, 1);
});

test("after the server reports the session gone, the next call is a full transcript on a new id", () => {
  const planner = new ChatSessionPlanner({ prefix: "t" });
  const first = planner.plan(P0); planner.commit(first, P0, REPLY);
  planner.lost();
  const plan = planner.plan(P1);
  assert.notEqual(plan.sessionId, first.sessionId);
  assert.equal(plan.delta, false);
  assert.equal(planner.stats.lost, 1);
});

test("the chat dialect carries session_id and the delta messages in the body", () => {
  const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", model: "spark", apiDialect: "chat" });
  client.enableChatSessions({ prefix: "run" });
  const r0 = JSON.parse(client.buildRequest(P0, {}).body);
  assert.match(r0.session_id, /^run-/);
  assert.equal(r0.messages.length, 2);
  client.chatSessions.commit(client.chatSessions.pending, P0, REPLY);
  const r1 = JSON.parse(client.buildRequest(P1, {}).body);
  assert.equal(r1.session_id, r0.session_id);
  assert.equal(r1.messages.length, 1);
  assert.equal(r1.messages[0].role, "user");
});

test("through complete(): the second call is a delta on the same session, and the run's end deletes it", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":"list_dir","p":"src"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", apiKey: "k", model: "spark", apiDialect: "chat", retries: 0 });
    client.enableChatSessions({ prefix: "run" });
    const token = client.beginAgentRun?.() ?? null;
    await client.complete(P0, {});
    await client.complete(P1, {});
    const posts = seen.filter((s) => s.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.session_id, posts[0].body.session_id, "same session");
    assert.equal(posts[1].body.messages.length, 1, "only the new user content");
    assert.deepEqual({ full: client.chatSessions.stats.full, delta: client.chatSessions.stats.delta }, { full: 1, delta: 1 });
    client.endAgentRun(token);
    await new Promise((r) => setTimeout(r, 10));
    const deletes = seen.filter((s) => s.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].url, new RegExp(`/v1/sessions/${posts[0].body.session_id}$`));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("run end awaits the session deletion, so a process that exits right after cannot lose it", async () => {
  const realFetch = globalThis.fetch;
  let deleteResolved = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "DELETE") {
      await new Promise((r) => setTimeout(r, 30));
      deleteResolved = true;
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":"done"}' }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new ModelClient({ apiUrl: "http://bridge:8787/v1", apiKey: "k", model: "spark", apiDialect: "chat", retries: 0 });
    client.enableChatSessions({ prefix: "run" });
    await client.complete(P0, {});
    await client.endAgentRun(null);
    assert.equal(deleteResolved, true, "endAgentRun resolved before the DELETE finished");
  } finally {
    globalThis.fetch = realFetch;
  }
});
