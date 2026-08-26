const readline = require("node:readline");

let nextThread = 1;
const lines = readline.createInterface({ input: process.stdin });

// Die with the parent — see the note in fake-codex-app-server.js. An orphaned
// fixture holds the stdio it inherited from its test file, and `node --test`
// waits on that pipe forever: the full suite stalls around 490 tests while
// every file passes in isolation. Observed at HEAD, so this is not new.
lines.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
// `node --test` is the direct parent and outlives the file that spawned this,
// so a ppid check never fires and stdin never ends. Idleness is the signal that
// separates abandoned from busy — see fake-codex-app-server.js.
const IDLE_EXIT_MS = 60_000;
let idleTimer = null;
function resetIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  idleTimer.unref();
}
resetIdleExit();
lines.on("line", resetIdleExit);

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: `thread-${nextThread++}` } } });
    return;
  }
  if (message.method === "turn/start") {
    const localImage = message.params.input.find((item) => item.type === "localImage");
    const text = message.params.input.find((item) => item.type === "text");
    const threadId = message.params.threadId;
    const turnId = `turn-${Date.now()}`;
    const answer = localImage
      ? `saw ${localImage.detail} image ${localImage.path}; question=${text.text}`
      : "no image";
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: {
            inputTokens: 20,
            outputTokens: 8,
            totalTokens: 28,
            cachedInputTokens: 0,
            reasoningOutputTokens: 2,
          },
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turnId,
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", phase: "final_answer", text: answer }],
        },
      },
    });
  }
});

