// A stand-in for `bantam run` in the MCP jobs tests: edits the workspace,
// reads steering through the real worker-control mailbox, writes run.json.
import fs from "node:fs";
import path from "node:path";
import { openWorkerControl } from "../../src/foreman-worker-control.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ws = arg("ws"), control = arg("control"), runFile = arg("run"), mode = arg("mode", "ok");
const steerWaitMs = Number(arg("steer-wait", "0"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worker = control ? openWorkerControl(control, ws) : null;
fs.appendFileSync(path.join(ws, "story.txt"), "edited by worker\n");
fs.writeFileSync(path.join(ws, "new-note.md"), "a new file\n");
worker?.note({ type: "action", action: { a: "write_file", p: "story.txt" } });
worker?.note({ type: "observation", observation: "wrote story.txt" });

if (mode === "hang") { for (;;) await sleep(1000); }

const until = Date.now() + steerWaitMs;
let steered = 0;
while (Date.now() < until) {
  for (const message of worker?.drain() ?? []) {
    fs.appendFileSync(path.join(ws, "steered.txt"), `${message.kind}: ${message.text}\n---\n`);
    worker.note({ type: "action", action: { a: "respond", p: `steer ${++steered}` } });
  }
  if (steered && arg("stop-after-steer")) break;
  await sleep(40);
}

// The shape `bantam run --save-run` writes (the parts the jobs toolset reads).
fs.writeFileSync(runFile, JSON.stringify({ kind: "bantam-run", metrics: { turns: 2 },
  result: { reachedDone: mode !== "undone", summary: "fake worker summary", status: mode === "fail" ? "fail" : "pass",
    blocked: mode === "undone" ? "needs the operator's canon notes" : null } }));
process.exit(mode === "fail" ? 1 : 0);
