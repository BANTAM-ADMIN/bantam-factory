import test from "node:test";
import assert from "node:assert";
import { makeStreamRenderer, decodeJsonStringChunk } from "../src/logic/stream-render.js";

test("thinking phase: line-buffered, verbatim, stops at the action JSON", () => {
  const r = makeStreamRenderer();
  assert.equal(r.feed({ phase: "thinking", content: "The user asks" }), "");
  assert.equal(r.feed({ phase: "thinking", content: "The user asks about X.\nLet me ch" }), "The user asks about X.\n");
  assert.equal(r.feed({ phase: "thinking", content: 'The user asks about X.\nLet me check.\n{"a":"respond"' }), "Let me check.\n");
  assert.equal(r.feed({ phase: "thinking", content: 'The user asks about X.\nLet me check.\n{"a":"respond","text":"hi"}' }), "");
});

test("action phase: only the respond text streams, decoded from partial JSON", () => {
  const r = makeStreamRenderer();
  assert.equal(r.feed({ phase: "action", content: '{"a":"respond","te' }), "");
  assert.equal(r.feed({ phase: "action", content: '{"a":"respond","text":"Line one\\nLine tw' }), "Line one\n");
  assert.equal(r.feed({ phase: "action", content: '{"a":"respond","text":"Line one\\nLine two\\nEnd"}' }), "Line two\n");
  assert.equal(r.finish(), "End\n");
});

test("non-respond actions stream nothing", () => {
  const r = makeStreamRenderer();
  const content = '{"a":"write_file","p":"big.txt","content":"thousands\\nof\\nlines"}';
  assert.equal(r.feed({ phase: "action", content }), "");
  assert.equal(r.finish(), "");
});

test("partial escapes are held across feeds, never mangled", () => {
  const r = makeStreamRenderer();
  const p1 = '{"a":"respond","text":"tab:\\';
  const p2 = '{"a":"respond","text":"tab:\\tdone\\nnext"}';
  assert.equal(r.feed({ phase: "action", content: p1 }), "");
  assert.equal(r.feed({ phase: "action", content: p2 }), "tab:\tdone\n");
  const u = makeStreamRenderer();
  u.feed({ phase: "action", content: '{"a":"respond","text":"x\\u00e' });
  assert.equal(u.feed({ phase: "action", content: '{"a":"respond","text":"x\\u00e9!\\n"}' }), "xé!\n");
});

test("a shrinking content resets state (new model call)", () => {
  const r = makeStreamRenderer();
  r.feed({ phase: "thinking", content: "first call reasoning text here\n" });
  const out = r.feed({ phase: "thinking", content: "second\n" });
  assert.equal(out, "second\n");
});

test("decodeJsonStringChunk: stops at the closing quote", () => {
  const d = decodeJsonStringChunk('hello world"},"x":1');
  assert.equal(d.text, "hello world");
  assert.equal(d.done, true);
});

test("soft-wrap: a single-paragraph answer streams progressively, not in one lump", () => {
  const r = makeStreamRenderer({ wrap: 40 });
  const long = "word ".repeat(30).trim(); // 149 chars, no newline
  const out = r.feed({ phase: "action", content: `{"a":"respond","text":"${long}` });
  assert.ok(out.length > 0, "wrapped lines flush before any newline arrives");
  assert.ok(out.split("\n").every((l) => l.length <= 40));
  const rest = r.feed({ phase: "action", content: `{"a":"respond","text":"${long} end"}` }) + r.finish();
  assert.equal((out + rest).replace(/\n/g, " ").trim(), `${long} end`);
});
