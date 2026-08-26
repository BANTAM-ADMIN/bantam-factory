// A piped chat session's log opened with `[1G[0Jbantam ❯ [10G` — raw cursor
// escapes from the interactive repaint machinery (cellui replay, 2026-08-17).
// In a terminal those codes ARE the interface; in a pipe they are noise at the
// top of every captured transcript. The repaint helpers must go quiet when
// there is no terminal, and stay untouched when there is one.

import { test } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { emitAboveInput, redrawInput } from "../src/interactive-display.js";

function session({ terminal }) {
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (c) => chunks.push(c.toString()));
  const rl = readline.createInterface({ input: new PassThrough(), output, terminal });
  return { rl, output, bytes: () => chunks.join("") };
}

test("a piped session gets plain lines, no escape codes", () => {
  const { rl, output, bytes } = session({ terminal: false });
  emitAboveInput(rl, output, "✓ done in 3 turns");
  redrawInput(rl, "bantam ❯ ");
  rl.close();
  assert.match(bytes(), /✓ done in 3 turns\n/, "the content still arrives");
  assert.doesNotMatch(bytes(), /\x1b/, "no ANSI escapes in a pipe");
});

test("a real terminal still gets its repaint", () => {
  const { rl, output, bytes } = session({ terminal: true });
  emitAboveInput(rl, output, "✓ done");
  rl.close();
  assert.match(bytes(), /✓ done/);
  assert.match(bytes(), /\x1b\[/, "cursor control is how a live prompt repaints");
});
