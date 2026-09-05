import assert from "node:assert/strict";
import test from "node:test";

import { wrapWords, layoutHelpRows, renderHelpRows, renderBullet } from "../src/logic/help-table.js";

// 2026-09-05. `:help` padded commands to a fixed 20 columns; the seven commands
// longer than that pushed their descriptions to a different column each, and
// descriptions wider than the terminal folded back to column 0. These pin the
// layout: one description column, wrapped under itself, at any width.

const rows = [
  { cmd: ":model [name|n]", desc: "switch local / DeepSeek / Codex (:model codex-sol)" },
  { cmd: ":deepresearch [on|off]", desc: "pre-answer self-assessed gaps -> one governed source errand (A/B winner)" },
  { cmd: ":context [rebuild|immutable|extension]", desc: "the context dial: clean reprefill ↔ fastest KV-cache reuse" },
  { cmd: ":eyes [auto|local|codex]", desc: "which model reads an image: local mmproj or Codex" },
  { cmd: ":help  ?", desc: "show this help" },
];
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("every description starts at the same column", () => {
  // Commands like `:help  ?` and `exit  quit  :q` carry a double space inside
  // them, so measure from the layout rather than by splitting on whitespace.
  const { column, lines } = layoutHelpRows(rows, { cols: 120 });
  const out = renderHelpRows(rows, { cols: 120 });
  assert.equal(out.length, lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].desc) continue;
    assert.equal(out[i].indexOf(lines[i].desc), 4 + column, `line ${i}: ${JSON.stringify(out[i])}`);
  }
});

test("a command over the cap sits on its own line and does not widen the column for everyone", () => {
  const { column, lines } = layoutHelpRows(rows, { cols: 120, cap: 24 });
  assert.equal(column, ":eyes [auto|local|codex]".length + 2, "column is set by the longest FITTING command");
  const ctx = lines.findIndex((l) => l.cmd.startsWith(":context"));
  assert.equal(lines[ctx].desc, "", "the long command carries no description on its own line");
  assert.match(lines[ctx + 1].desc, /^the context dial/, "its description follows underneath, at the column");
  assert.equal(lines[ctx + 1].cmd, "");
});

test("no rendered line exceeds the terminal, at 80 or 120 columns", () => {
  for (const cols of [80, 120]) {
    for (const line of renderHelpRows(rows, { cols })) {
      assert.ok(strip(line).length <= cols, `${cols}: ${strip(line).length} > ${cols}: ${line}`);
    }
  }
});

test("a wrapped description continues under itself, not at column 0", () => {
  const out = renderHelpRows(rows, { cols: 80 });
  const i = out.findIndex((l) => l.includes(":deepresearch"));
  assert.ok(out[i + 1].startsWith(" ".repeat(20)), "continuation is indented to the description column");
  assert.match(out[i + 1].trim(), /^\S/, "and carries text");
  assert.doesNotMatch(out[i + 1], /^\s*:/, "a continuation is never mistaken for a command");
});

test("padding is computed from plain lengths, so painting cannot skew the column", () => {
  const painted = renderHelpRows(rows, { cols: 120, paintCmd: (s) => `\x1b[36m${s}\x1b[0m`, paintDesc: (s) => `\x1b[2m${s}\x1b[0m` });
  const plain = renderHelpRows(rows, { cols: 120 });
  assert.deepEqual(painted.map(strip), plain);
});

test("wrapWords is greedy and never splits a word", () => {
  assert.deepEqual(wrapWords("aaa bbb ccc ddd", 8), ["aaa bbb", "ccc ddd"]);   // 8 is the floor
  assert.deepEqual(wrapWords("averyveryverylongword x", 8), ["averyveryverylongword", "x"]);
  assert.deepEqual(wrapWords("", 40), []);
});

test("a bullet wraps with a hanging indent under its text", () => {
  const out = renderBullet("drop an image path (shot.png) in a request — I'll view it if a vision model is loaded", { cols: 60 });
  assert.ok(out.length >= 2);
  assert.match(out[0], /^ {4}· drop/);
  assert.match(out[1], /^ {6}\S/, "continuation aligns under the text, past the bullet");
  for (const l of out) assert.ok(l.length <= 60, l);
});
