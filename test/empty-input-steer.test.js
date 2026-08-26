import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Executor } from "../src/executor.js";
import { emptyInputNote } from "../src/logic/kill-signal.js";

test("a 0-byte file piped into a program is named as such in the observation (real executor)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "emptyin-"));
  fs.writeFileSync(path.join(ws, "data.comp"), "");
  fs.writeFileSync(path.join(ws, "full.comp"), "abc");
  const ex = new Executor(ws, { shellSandbox: "host" });
  const r1 = await ex.shell({ c: "cat data.comp | wc -c" });
  const t1 = typeof r1 === "string" ? r1 : (r1?.observation ?? "");
  assert.match(t1, /\[empty-input\] data\.comp is 0 bytes/);
  const r2 = await ex.shell({ c: "cat full.comp | wc -c" });
  const t2 = typeof r2 === "string" ? r2 : (r2?.observation ?? "");
  assert.doesNotMatch(t2, /\[empty-input\]/);
});

test("pure: heredocs and /dev files never trigger; a redirect of an empty file does", () => {
  const st = (f) => ({ "x.bin": 0 })[f] ?? null;
  assert.equal(emptyInputNote("python3 - <<'EOF'\nprint(1)\nEOF", { statSize: st }), "");
  assert.equal(emptyInputNote("cat /dev/urandom | head -c 8", { statSize: () => 0 }), "");
  assert.match(emptyInputNote("./prog < x.bin", { statSize: st }), /x\.bin is 0 bytes/);
});
