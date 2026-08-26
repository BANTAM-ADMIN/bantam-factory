import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codeTool } from "../src/logic/tools.js";

// Measured 2026-08-15 (ticket A): the `symbols` answer for an entrypoint tells
// the model to "ask `flow <file>` for its ordered top-level startup and command
// dispatch" — and `flow` was never implemented, so the model asking got
// `unknown query "flow"`. It is the exact question a run wiring a new
// subcommand needs answered; the run that needed it read the 4,718-line CLI 54
// times instead.

function groundOf(dir, files) {
  const defines = [];
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return {
    workspace: dir,
    stats: { files: Object.keys(files).length },
    staleFiles: new Set(),
    db: {
      has: (rel, f) => rel === "entrypoint" && f === "cli.js",
      query: (rel, a, b) => {
        if (rel === "defines" && a === "cli.js") return [["cli.js", "main"]];
        if (rel === "entrypoint") return [["cli.js"]];
        return [];
      },
    },
  };
}

test("flow names an entrypoint's command dispatch with line numbers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    "const cmd = process.argv[2];",
    'if (cmd === "run") {',
    "  await runCommand();",
    "}",
    'if (cmd === "eval") {',
    "  await evalCommand();",
    "}",
    'if (cmd === "experiment") {',
    "  await experimentCommand();",
    "}",
  ].join("\n");
  const tool = codeTool(groundOf(dir, { "cli.js": cli }));

  const answer = String(tool.answer("flow cli.js"));
  assert.match(answer, /run/, "names the run command");
  assert.match(answer, /experiment/, "names the experiment command");
  assert.match(answer, /\bL?\d+\b/, "gives line numbers to jump to");
  assert.ok(!/unknown query/i.test(answer), "flow is a real verb");
});

test("flow is advertised in the tool description and verb list", () => {
  const tool = codeTool({ workspace: "/tmp", stats: { files: 1 }, staleFiles: new Set(), db: { has: () => false, query: () => [] } });
  assert.ok(tool.verbs.includes("flow"), "verbs include flow");
  assert.match(tool.description, /flow/, "description mentions flow");
});
