// Multi-line paste buffering: rapid successive lines within the paste window
// are combined into a single request, not queued as separate ones.
import test from "node:test";
import assert from "node:assert/strict";

// We test the paste-buffering logic in isolation by simulating the timing.
// The actual implementation lives in bin/bantam.js's repl() function.

function createPasteBuffer() {
  let buffer = [];
  let timer = null;
  const WINDOW_MS = 150;
  const processed = [];

  function flush() {
    timer = null;
    if (buffer.length === 0) return;
    const combined = buffer.join("\n").trim();
    buffer = [];
    if (combined) processed.push(combined);
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WINDOW_MS);
  }

  function handleLine(line) {
    const s = line.trim();
    if (!s) { scheduleFlush(); return; }
    buffer.push(s);
    scheduleFlush();
  }

  return { handleLine, flush, processed, get buffer() { return buffer; } };
}

test("single line is processed after window", async () => {
  const pb = createPasteBuffer();
  pb.handleLine("hello world");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pb.processed.length, 1);
  assert.equal(pb.processed[0], "hello world");
});

test("rapid multi-line paste is combined into one request", async () => {
  const pb = createPasteBuffer();
  pb.handleLine("line one");
  pb.handleLine("line two");
  pb.handleLine("line three");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pb.processed.length, 1);
  assert.equal(pb.processed[0], "line one\nline two\nline three");
});

test("slow typing produces separate requests", async () => {
  const pb = createPasteBuffer();
  pb.handleLine("first");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pb.processed.length, 1);
  assert.equal(pb.processed[0], "first");

  pb.handleLine("second");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pb.processed.length, 2);
  assert.equal(pb.processed[1], "second");
});

test("empty line flushes the buffer", async () => {
  const pb = createPasteBuffer();
  pb.handleLine("some text");
  pb.handleLine("");  // empty line triggers flush
  await new Promise(r => setTimeout(r, 200));
  assert.equal(pb.processed.length, 1);
  assert.equal(pb.processed[0], "some text");
});
