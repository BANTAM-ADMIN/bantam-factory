import test from "node:test";
import assert from "node:assert/strict";

import { killSignalNote, cgroupMemoryLimit } from "../src/logic/kill-signal.js";

test("an ordinary exit code gets no note — this must not fire on normal failures", () => {
  for (const code of [0, 1, 2, 127]) assert.equal(killSignalNote(code), "");
});

test("137 names the OOM killer and the container's actual limit", () => {
  const note = killSignalNote(137, { memoryLimitBytes: 2 * 1024 ** 3 });
  assert.match(note, /SIGKILL/);
  assert.match(note, /out-of-memory/);
  assert.match(note, /2\.0GiB/);
  // the specific behaviour it exists to stop: re-issuing the same command
  assert.match(note, /Re-running the same command will fail the same way/);
});

test("137 still says something useful when the limit is unknown", () => {
  const note = killSignalNote(137);
  assert.match(note, /SIGKILL/);
  assert.doesNotMatch(note, /undefined|null|NaN/);
});

test("a signal death that arrives as code 1 + a signal NAME is still caught", () => {
  // process-runner flattens Node's (code=null, signal="SIGKILL") to code 1, so
  // on that path the signal name is the only surviving evidence. Without this
  // the kill is indistinguishable from an ordinary failure.
  const note = killSignalNote(1, { signal: "SIGKILL", memoryLimitBytes: 2 * 1024 ** 3 });
  assert.match(note, /SIGKILL/);
  assert.match(note, /2\.0GiB/);
  assert.equal(killSignalNote(1, { signal: null }), "");
});

test("other signals are named without the memory advice", () => {
  assert.match(killSignalNote(139), /SIGSEGV/);
  assert.doesNotMatch(killSignalNote(139), /Reduce PEAK memory/);
  assert.match(killSignalNote(134), /SIGABRT/);
});

test("cgroup limit reads either layout and rejects unusable values", () => {
  assert.equal(cgroupMemoryLimit(() => "2147483648"), 2147483648);
  assert.equal(cgroupMemoryLimit(() => "max"), null);
  assert.equal(cgroupMemoryLimit(() => { throw new Error("no cgroup"); }), null);
  // an unlimited cgroup reports a sentinel near 2^63; it must not become a "limit"
  assert.equal(cgroupMemoryLimit(() => "9223372036854771712"), null);
});
