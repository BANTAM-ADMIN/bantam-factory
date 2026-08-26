import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { makeScratchDir, keepScratchDir, pendingScratchDirs } from "../src/logic/scratch-dir.js";

// BANTAM leaked 1,306 directories into /tmp over one day -- 1,198 from preview
// screenshots alone -- because every mkdtemp call was permanent. 49MB, growing
// with every run forever.
//
// Deleting inside the creating function is not an option: callers read the
// screenshot path AFTER runPreviewSync returns. The directory must outlive the
// call and die with the process.

describe("self-cleaning scratch directories", () => {
  it("creates a real directory and tracks it", () => {
    const dir = makeScratchDir("bantam-test-");
    assert.ok(fs.existsSync(dir));
    assert.ok(pendingScratchDirs().includes(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets a caller take ownership and opt out of cleanup", () => {
    const dir = makeScratchDir("bantam-test-");
    keepScratchDir(dir);
    assert.ok(!pendingScratchDirs().includes(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The property that matters, verified in a real child process: the directory
  // must survive the creating call and be gone once the process ends.
  it("removes the directory when the process exits", () => {
    const script = `
      import { makeScratchDir } from "${new URL("../src/logic/scratch-dir.js", import.meta.url).href}";
      import fs from "node:fs";
      const dir = makeScratchDir("bantam-exittest-");
      fs.writeFileSync(dir + "/artifact.txt", "still readable after the call");
      if (!fs.existsSync(dir + "/artifact.txt")) throw new Error("vanished too early");
      process.stdout.write(dir);
    `;
    const dir = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
    assert.ok(dir.includes("bantam-exittest-"), `unexpected output: ${dir}`);
    assert.equal(fs.existsSync(dir), false, "the scratch directory outlived its process");
  });
});

// Debugging a failed run means reading the workspace it left behind. Fixing the
// leak must not remove the evidence trail that found most of today's bugs.
describe("keeping scratch for debugging", () => {
  it("leaves the directory in place when BANTAM_KEEP_SCRATCH is set", () => {
    const script = `
      import { makeScratchDir } from "${new URL("../src/logic/scratch-dir.js", import.meta.url).href}";
      const dir = makeScratchDir("bantam-keeptest-");
      process.stdout.write(dir);
    `;
    const dir = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, BANTAM_KEEP_SCRATCH: "1" },
    }).trim();
    assert.equal(fs.existsSync(dir), true, "an explicitly kept directory must survive");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// run-checkpoint.arm() registers SIGINT/SIGTERM handlers that flush a crash
// checkpoint and then call process.exit(). A second handler here that also exited
// would race it, and whichever ran first would terminate the process before the
// other -- silently losing the checkpoint on Ctrl-C. Exiting from any handler still
// fires `exit`, so the sweep runs AFTER the flush rather than instead of it.
describe("not racing crash recovery", () => {
  it("registers no signal handlers of its own", async () => {
    const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const dir = makeScratchDir("bantam-sigtest-");
    const after = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    assert.equal(after, before, "scratch cleanup must not add signal handlers");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still sweeps when another handler calls process.exit", () => {
    const script = `
      import { makeScratchDir } from "${new URL("../src/logic/scratch-dir.js", import.meta.url).href}";
      import fs from "node:fs";
      const dir = makeScratchDir("bantam-flushtest-");
      process.stdout.write(dir);
      // stand-in for run-checkpoint's flush-then-exit handler
      process.exit(0);
    `;
    const dir = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
    assert.equal(fs.existsSync(dir), false,
      "an explicit process.exit elsewhere must still trigger the sweep");
  });
});
