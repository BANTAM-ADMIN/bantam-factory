import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFactoryVerifier } from "../src/factory/coding-cell.js";
import { runWorkspaceProbe } from "../src/workspace-probe.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-verifier-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  return { root, workspace, marker: path.join(root, "outside-canary.txt") };
}

test("factory verifier uses the shared Docker runner with readonly workspace and pipefail", async (t) => {
  const { workspace } = fixture(t);
  let calls = 0;
  const result = await runFactoryVerifier(workspace, "npm test", 12000, {
    shellSandbox: "docker",
    processRunner: async (file, args, options) => {
      calls++;
      assert.equal(file, "docker");
      assert.ok(args.includes(`${workspace}:${workspace}:ro`));
      assert.ok(args.includes("none"));
      assert.deepEqual(args.slice(-5), ["/bin/bash", "-o", "pipefail", "-c", "npm test"]);
      assert.equal(options.timeoutMs, 12000);
      return { code: 0, stdout: "verified", stderr: "" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.pass, true);
  assert.match(result.sandbox, /^docker:/);
});

test("factory verifier records unavailable, canceled, limited and red checks as nonpasses", async (t) => {
  const { workspace } = fixture(t);
  for (const [outcome, status] of [
    [{ code: 125, stderr: "missing image" }, "infrastructure"],
    [{ code: 0, timedOut: true }, "timeout"],
    [{ code: 0, aborted: true }, "interrupted"],
    [{ code: 0, bufferExceeded: true }, "output-limit"],
    [{ code: 1 }, "fail"],
  ]) {
    const result = await runFactoryVerifier(workspace, "true", 1000, { shellSandbox: "docker", processRunner: async () => outcome });
    assert.equal(result.pass, false);
    assert.equal(result.status, status);
  }
  const invalid = await runFactoryVerifier(workspace, "true", 1000, { shellSandbox: "dokcer" });
  assert.equal(invalid.status, "infrastructure");
  assert.equal(invalid.pass, false);
});

test("explicit host opt-in keeps pipefail and removes secret environment keys", async (t) => {
  const { workspace } = fixture(t);
  const key = "BANTAM_REVIEW_CANARY_TOKEN", previous = process.env[key];
  process.env[key] = "harmless-parent-canary";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  fs.writeFileSync(path.join(workspace, "verify.cjs"), `if (process.env.${key}) process.exit(1);`);
  const clean = await runFactoryVerifier(workspace, "node verify.cjs", 1000, { shellSandbox: "host" });
  assert.equal(clean.pass, true);
  assert.match(clean.sandbox, /^host:/);
  const piped = await runFactoryVerifier(workspace, "false | true", 1000, { shellSandbox: "host" });
  assert.equal(piped.pass, false);
});

const liveDocker = process.env.BANTAM_LIVE_SANDBOX_TEST === "1";
test("live Docker confines candidate imports and the factory verifier", {
  skip: liveDocker ? false : "set BANTAM_LIVE_SANDBOX_TEST=1 to exercise the installed Docker sandbox",
}, async (t) => {
  const { root, workspace, marker } = fixture(t);
  const key = "BANTAM_REVIEW_CANARY_TOKEN", previous = process.env[key];
  process.env[key] = "harmless-parent-canary";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}');
  const inspect = [
    "import fs from 'node:fs';",
    "let outsideWrite = false, workspaceWrite = false;",
    `try { fs.writeFileSync(${JSON.stringify(marker)}, 'harmless'); outsideWrite = true; } catch {}`,
    "try { fs.writeFileSync('candidate-mutation.txt', 'harmless'); workspaceWrite = true; } catch {}",
    `const inheritedSecret = Boolean(process.env.${key});`,
  ];
  fs.writeFileSync(path.join(workspace, "collections.js"), [...inspect,
    "export function normalizeTags() { return { outsideWrite, workspaceWrite, inheritedSecret }; }",
  ].join("\n"));
  const probe = await runWorkspaceProbe({ workspace, kind: "type_contract", task: "normalizeTags accepts an array of strings.", shellSandbox: "docker" });
  assert.equal(probe.status, "ok", probe.detail);
  assert.ok(probe.findings.length > 0);
  for (const finding of probe.findings) {
    assert.deepEqual(JSON.parse(finding.returned), { outsideWrite: false, workspaceWrite: false, inheritedSecret: false });
  }
  fs.writeFileSync(path.join(workspace, "verify.mjs"), [...inspect,
    "if (outsideWrite || workspaceWrite || inheritedSecret) process.exit(1);",
    "console.log('candidate stayed within the declared sandbox');",
  ].join("\n"));
  const verification = await runFactoryVerifier(workspace, "node verify.mjs", 10000, { shellSandbox: "docker" });
  assert.equal(verification.pass, true, verification.detail);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(workspace, "candidate-mutation.txt")), false);
  const grader = path.join(root, "external-grader.cjs"), neighbor = path.join(root, "ungranted-neighbor.txt");
  fs.writeFileSync(neighbor, "harmless neighboring host file");
  fs.writeFileSync(grader, [
    "const fs = require('node:fs');",
    `if (fs.existsSync(${JSON.stringify(neighbor)})) throw new Error('neighbor was exposed');`,
    "let writable = false; try { fs.appendFileSync(__filename, '// forbidden'); writable = true; } catch {}",
    "if (writable) throw new Error('grader was writable');",
    "if (process.env.CANDIDATE_ROOT !== process.cwd()) throw new Error('wrong candidate');",
  ].join("\n"));
  const external = await runFactoryVerifier(workspace, `CANDIDATE_ROOT="$PWD" node '${grader}'`, 10000, { shellSandbox: "docker" });
  assert.equal(external.pass, true, external.detail);
});
