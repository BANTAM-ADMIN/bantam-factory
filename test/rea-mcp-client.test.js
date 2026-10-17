import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startReaMcpClient, acquireReaMcpClient } from "../src/rea-mcp-client.js";

const server = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
const state=process.env.REA_TEST_STATE;
function record(value) {const rows=JSON.parse(fs.readFileSync(state)); rows.push(value); fs.writeFileSync(state,JSON.stringify(rows));}
record({pid:process.pid});
if(process.env.REA_TEST_STUBBORN==='1') {
 process.on('SIGTERM',()=>{});
 process.stdin.on('end',()=>setInterval(()=>{},1000));
}
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); record(m);
 if(m.method==='initialize')send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list')send(m.id,{tools:['echo','other',...(process.env.REA_TEST_SESSION?['binary_session']:[])].map(name=>({name,description:name==='echo'?'Echo from a fixture':name==='other'?'ROM inventory':'Session state',inputSchema:{type:'object'},outputSchema:{description:'z'.repeat(170000)}}))});
 if(m.method==='tools/call'&&m.params.name==='binary_session') {
  // The first call is the startup snapshot; later calls see an opened target.
  const opened=JSON.parse(fs.readFileSync(state)).filter(r=>r.params?.name==='binary_session').length>1;
  return send(m.id,{content:[{type:'text',text:JSON.stringify({result:{tool_availability:{groups:[
  {names:['other'],available:false,reason:'provider_missing',remediation:'Set REA_ROM_TOOL.'},
  {names:['echo'],available:opened,reason:opened?'available':'target_required',remediation:'Call open_binary.'}]}}})}]});
 }
 if(m.method==='tools/call'&&m.params.arguments.providerless) return send(m.id,{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'provider_unavailable',message:'no ghidra'}})}]});
 if(m.method==='tools/call') {
  if(m.params.arguments.exit)process.exit(7);
  if(m.params.arguments.hang)return;
  if(m.params.arguments.invalid)send(m.id,{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'invalid_request',message:'fixture invalid argument'}})}]});
  else send(m.id,{content:[{type:'text',text:JSON.stringify(m.params.arguments)}]});
 }
});
`;

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-rea-client-"));
  const state = path.join(dir, "messages.json");
  fs.writeFileSync(state, "[]");
  t.after(() => {
    for (const row of JSON.parse(fs.readFileSync(state))) {
      if (row.pid) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { command: process.execPath, args: ["--input-type=module", "-e", server], cwd: dir,
    env: { ...process.env, REA_TEST_STATE: state, ...extra }, toolNames: "echo",
    startupTimeoutMs: 1000, shutdownTimeoutMs: 30,
    rows: () => JSON.parse(fs.readFileSync(state)) };
}
const call = (client, args, opts) => client.call({ tool: "echo", args: JSON.stringify(args) }, opts);

test("complete evidence survives transport; invalid args and disabled names never dispatch", async t => {
  const f = fixture(t), c = await startReaMcpClient(f);
  try {
    const payload = { head: "x".repeat(30000), channel: "notes:export", tail: "y".repeat(30000) };
    assert.deepEqual(JSON.parse(await call(c, payload)), payload);
    await assert.rejects(c.call({ tool: "other", args: "{}" }), /not enabled/);
    await assert.rejects(c.call({ tool: "echo", args: "[]" }), /JSON object/);
    await assert.rejects(c.call({ tool: "echo", args: "{" }), /valid JSON/);
    assert.equal(f.rows().filter(m => m.method === "tools/call").length, 1);
    assert.match(await call(c, { invalid: true }), /REA MCP tool error:.*invalid_request/);
  } finally { await c.close(); }
});

test("cancellation targets the outstanding request and leaves the session usable", async t => {
  const f = fixture(t), c = await startReaMcpClient(f), controller = new AbortController();
  try {
    const pending = call(c, { hang: true }, { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await delay(30); controller.abort(); await rejected;
    assert.deepEqual(JSON.parse(await call(c, { value: "still alive" })), { value: "still alive" });
    const rows = f.rows(), request = rows.find(m => m.method === "tools/call");
    assert.equal(rows.find(m => m.method === "notifications/cancelled").params.requestId, request.id);
  } finally { await c.close(); }
});

test("server exit fails the pending call and cleanup can be awaited twice", async t => {
  const c = await startReaMcpClient(fixture(t));
  await assert.rejects(call(c, { exit: true }), /exited/);
  await Promise.all([c.close(), c.close()]);
});

test("timeouts cancel the remote request without poisoning subsequent calls", async t => {
  const f = fixture(t), c = await startReaMcpClient({ ...f, toolTimeoutMs: 40 });
  try {
    await assert.rejects(call(c, { hang: true }), /timed out/);
    assert.deepEqual(JSON.parse(await call(c, { value: "after timeout" })), { value: "after timeout" });
    assert.ok(f.rows().some(m => m.method === "notifications/cancelled"));
  } finally { await c.close(); }
});

test("failed startup and invalid allowlists clean up the owned child", async t => {
  const f = fixture(t);
  await assert.rejects(startReaMcpClient({ ...f, toolNames: "missing" }), /unknown tool/);
  const pid = f.rows().find(row => row.pid).pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(startReaMcpClient({ ...f, command: path.join(f.cwd, "missing-command") }), /Could not start|stdin failed/);
});

test("CommonJS interpretation context accompanies the complete original evidence", async t => {
  const c = await startReaMcpClient(fixture(t));
  try {
    const evidence = { normalized_result: { rows: [{ properties: {
      relationship_kind: "commonjs-export", exported_name: "default",
    } }] } };
    const response = await call(c, evidence);
    assert.ok(response.startsWith(JSON.stringify(evidence)));
    assert.match(response, /does not establish an ESM default export/);
    assert.match(response, /Verify module\.exports\/exports/);
  } finally { await c.close(); }
});

test("shutdown remains bounded when the child ignores stdin EOF and SIGTERM", async t => {
  const c = await startReaMcpClient(fixture(t, { REA_TEST_STUBBORN: "1" }));
  assert.equal(await Promise.race([c.close().then(() => true), delay(1400).then(() => false)]), true);
});

test("shared leases preserve caller-selected tool sets and close only after the last user", async t => {
  const f = fixture(t);
  const a = await acquireReaMcpClient(f), b = await acquireReaMcpClient(f);
  const separate = await acquireReaMcpClient({ ...f, toolNames: "other" });
  try {
    assert.deepEqual(separate.tools.map(x => x.name), ["other"]);
    await a.close();
    assert.deepEqual(JSON.parse(await call(b, { value: "leased" })), { value: "leased" });
    assert.equal(f.rows().filter(m => m.pid).length, 2);
  } finally { await Promise.all([a.close(), b.close(), separate.close()]); }
});

 test("wildcard discovery exposes exact schemas and gates dispatch", async t => {
  const f=fixture(t), c=await startReaMcpClient({...f,toolNames:"*"});
  try {
    assert.equal(c.tools.length,2);
    assert.deepEqual(JSON.parse(c.discover({q:"ROM"})).tools.map(t=>t.name),["other"]);
    await assert.rejects(call(c,{}),error=>{
      assert.match(error.message,/Schema first/);
      assert.match(error.message,/"inputSchema"/);
      assert.doesNotMatch(error.message,/"outputSchema"/);
      return true;
    });
    assert.deepEqual(JSON.parse(await call(c,{recovered:true})),{recovered:true});
    const definition=JSON.parse(c.discover({name:"echo"}));
    assert.deepEqual(definition.inputSchema,{type:"object"});
    assert.equal(definition.schema_scope,"complete-input");
    assert.equal(definition.output_schema_included,false);
    assert.ok(JSON.stringify(definition).length<1000);
    assert.deepEqual(JSON.parse(await call(c,{ok:true})),{ok:true});
    assert.throws(()=>c.discover({name:"missing"}),/not available/);
    assert.equal(JSON.parse(c.discover({q:"other"})).name,"other");
    assert.deepEqual(JSON.parse(await c.call({tool:"other",args:'{"ok":2}'})),{ok:2});
  } finally {await c.close();}
});

test("REA starts in the run's workspace and the prompt names its host path", async t => {
  const f = fixture(t);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-rea-workspace-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { cwd, ...rest } = f;
  const c = await startReaMcpClient({ ...rest, workspace });
  try {
    assert.match(c.prompt, new RegExp(`the workspace is ${JSON.stringify(workspace).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    assert.match(c.prompt, /Do not guess other mount points such as \/workspace/);
  } finally { await c.close(); }
});

test("tools the host cannot run are marked and ranked last; target_required is not a host limit", async t => {
  const f = fixture(t, { REA_TEST_SESSION: "1" });
  const c = await startReaMcpClient({ ...f, toolNames: "*" });
  try {
    const found = JSON.parse(c.discover({ q: "ROM inventory echo fixture" })).tools;
    assert.deepEqual(found.map(tool => tool.name), ["echo", "other"]);
    assert.equal(found[1].unavailable_here, "Set REA_ROM_TOOL.");
    assert.equal(found[0].unavailable_here, undefined);
    assert.equal(JSON.parse(c.discover({ name: "other" })).unavailable_here, "Set REA_ROM_TOOL.");
    assert.match(c.prompt, /1 REA tools cannot run on this machine/);
  } finally { await c.close(); }
});

test("the prompt carries REA's routing guide section from the installed skill", async t => {
  const f = fixture(t);
  const guideFile = path.join(path.dirname(f.env.REA_TEST_STATE), "SKILL.md");
  fs.writeFileSync(guideFile, "# REA\n\n## Route the target first\n\n- Native executable: `open_binary`.\n\n## Work summary-first\n\nlater");
  const c = await startReaMcpClient({ ...f, guideFile });
  try {
    assert.match(c.prompt, /routing guide.*if no route fits the input/);
    assert.match(c.prompt, /Native executable: `open_binary`/);
    assert.doesNotMatch(c.prompt, /Work summary-first/);
  } finally { await c.close(); }
});

test("a provider failure names the tools the open target made usable", async t => {
  const f = fixture(t, { REA_TEST_SESSION: "1" });
  const c = await startReaMcpClient({ ...f, toolNames: "*" });
  try {
    c.discover({ name: "echo" });
    const failed = await c.call({ tool: "echo", args: JSON.stringify({ providerless: true }) });
    assert.match(failed, /REA MCP tool error:.*provider_unavailable/);
    assert.doesNotMatch(failed, /usable now: .*echo/, "the failed tool itself is not offered back");
    const ordinary = await c.call({ tool: "echo", args: JSON.stringify({ invalid: true }) });
    assert.doesNotMatch(ordinary, /REA availability/, "only provider failures trigger the lookup");
  } finally { await c.close(); }
});
