import fs from "node:fs";
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let nextThread = 1;
let nextTurn = 1;
const usageTotals = new Map();

// Die with the parent. This fixture inherits the test file's stdio, so a
// survivor holds that pipe open and `node --test` never sees EOF: on 2026-08-16
// the full suite stalled at 496 tests, deterministically and at the same point
// under --test-concurrency=1, while every file passed in isolation. The stray
// was one of these, still alive minutes later. CodexAppServer.close() does
// SIGTERM the child, so this only covers the paths that never reach a close.
lines.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

// Orphan watchdog. The leak only reproduces under a PARALLEL `node --test`:
// run alone, every codex test closes its server and leaves nothing behind;
// run with 16 workers, the transport's millisecond deadlines (controlTimeoutMs
// 30, timeoutMs 1000) fire on paths that never reach close(). stdin stays open
// because the RUNNER holds the other end, so the close/SIGTERM handlers above
// cannot save us. Losing our parent is directly observable — watch for it.
// The ppid check alone is not enough: `node --test` is the DIRECT parent of
// these fixtures and outlives the file that spawned them, so an abandoned
// fixture keeps a live parent and a stdin that never ends. Idleness is the
// signal that actually distinguishes abandoned from busy — every real exchange
// here answers in milliseconds and the transport's own deadlines are <= 10s.
const IDLE_EXIT_MS = 60_000;
let idleTimer = null;
function resetIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  idleTimer.unref();   // never keep this fixture alive on its own account
}
resetIdleExit();
lines.on("line", resetIdleExit);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    send({ id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "model/list") {
    send({ id, result: { data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol" }] } });
    return;
  }
  if (method === "thread/start") {
    if (params.model === "hold-thread-start") return;
    send({ id, result: { thread: { id: `thread-${process.pid}-${nextThread++}` } } });
    return;
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    return;
  }
  if (method !== "turn/start") return;

  const prompt = params.input?.[0]?.text ?? "";
  if (prompt === "hold turn/start") return;

  const turnId = `turn-${nextTurn++}`;
  send({ id, result: { turn: { id: turnId } } });
  if (prompt === 'native usage sequence' || prompt === 'native missing usage') {
    const total = usageTotals.get(params.threadId) ?? {inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
    if (prompt === 'native usage sequence') for (const last of [
      {inputTokens:120,cachedInputTokens:20,outputTokens:12,reasoningOutputTokens:4,totalTokens:132},
      {inputTokens:180,cachedInputTokens:160,outputTokens:8,reasoningOutputTokens:2,totalTokens:188},
    ]) {
      for (const k of Object.keys(total)) total[k] += last[k];
      const update = {method:'thread/tokenUsage/updated',params:{threadId:params.threadId,turnId,tokenUsage:{last,total}}};
      send(update);send(update); // Retransmitted notification, not another model response.
    }
    usageTotals.set(params.threadId,total);
    const item = {type:'agentMessage',phase:'final_answer',text:'native work complete'};
    send({method:'turn/completed',params:{threadId:params.threadId,turnId,turn:{id:turnId,status:'completed',items:[item]}}});
    return;
  }
  if (prompt === "report env") {
    const text = JSON.stringify({
      bantamKeys: Object.keys(process.env).filter((k) => k.startsWith("BANTAM_")),
      nodeTestContext: process.env.NODE_TEST_CONTEXT ?? null,
      openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    });
    const item = { id: `env-${nextTurn}`, type: "agentMessage", text };
    send({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turnId, turn: { id: turnId, status: "completed", items: [item] } } });
    return;
  }
  if (prompt === "synthetic image") {
    const imagePath = `/tmp/fake-codex-image-${process.pid}.png`;
    fs.writeFileSync(imagePath, "fake image");
    const image = { id: `image-${nextTurn}`, type: "imageGeneration", status: "completed", savedPath: imagePath, revisedPrompt: "synthetic revised image prompt", result: "raw image bytes" };
    send({ method: "item/completed", params: { threadId: params.threadId, turnId, item: image } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turnId, turn: { id: turnId, status: "completed", items: [image] } } });
    return;
  }
  const exitOnce = prompt.match(/BANTAM_FAKE_EXIT_ONCE=([^\s"\\]+)/);
  if (exitOnce && !fs.existsSync(exitOnce[1])) {
    fs.writeFileSync(exitOnce[1], `${process.pid}\n`, { flag: "wx" });
    process.exit(86);
  }
  if (prompt === "failed turn") {
    send({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turnId,
        turn: {
          id: turnId,
          status: "failed",
          error: { message: "synthetic turn failure" },
          items: [],
        },
      },
    });
    return;
  }
  if (prompt === "silent turn") return;
  if (prompt === "active slow turn") {
    let count = 0;
    const activity = setInterval(() => {
      count++;
      send({
        method: "item/started",
        params: {
          threadId: params.threadId,
          turnId,
          item: { type: "reasoning", id: `reasoning-${count}` },
        },
      });
      if (count < 3) return;
      clearInterval(activity);
      const item = { type: "agentMessage", phase: "final_answer", text: "still alive" };
      send({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId,
          turn: { id: turnId, status: "completed", items: [item] },
        },
      });
    }, 20);
    return;
  }
  const promptText = params.input?.find(item => item.type === 'text')?.text ?? '';
  if (promptText === 'stalled JSON whitespace') {
    for (const delta of ['{"a":"read_file","p":"test.js","limit":250', ' '.repeat(3000), '\n\t'.repeat(700)]) {
      send({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, delta } });
    }
    return;
  }
  const text = promptText === 'quoted whitespace'
    ? JSON.stringify({ a: 'write_file', p: 'large.txt', content: ' '.repeat(6000) + '"\\end' })
    : promptText.startsWith('decorated action fixture\n')
    ? JSON.stringify({ a: 'write_file', p: 'result.js', content: 'export const answer = 42;\n' }) + '\nExtra prose, not a second action.'
    : params.outputSchema
    ? JSON.stringify({
      a: "respond",
      text: "schema received",
      p: null,
      q: null,
      start: null,
    })
    : "plain response";
  send({
    method: "item/agentMessage/delta",
    params: { threadId: params.threadId, turnId, delta: promptText === 'quoted whitespace' ? text : text.slice(0, 8) },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: params.threadId,
      turnId,
      tokenUsage: {
        ...(prompt.startsWith('context window ') ? {modelContextWindow:Number(prompt.slice('context window '.length))} : {}),
        last: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 12,
          reasoningOutputTokens: 4,
          totalTokens: 132,
        },
      },
    },
  });
  const item = { type: "agentMessage", phase: "final_answer", text };
  send({
    method: "item/completed",
    params: { threadId: params.threadId, turnId, item },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: params.threadId,
      turnId,
      turn: { id: turnId, status: "completed", items: [item] },
    },
  });
});
