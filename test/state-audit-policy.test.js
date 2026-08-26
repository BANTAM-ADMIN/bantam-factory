import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import {
  stateAuditEngagement,
  stateAuditDeferral,
  stateAuditProbeDiagnostic,
  stateAuditProbePassed,
} from "../src/completion-audit.js";
import { decideStateAudit } from "../src/state-audit-policy.js";

const orderedMapTask = [
  "Implement orderedMap with concurrency.",
  "Preserve input order regardless of completion order and reject invalid concurrency.",
].join(" ");

const keyedPoolTask = [
  "Implement a concurrent keyed task pool.",
  "Coalesce duplicate same-key submissions to the exact same Promise.",
  "Keep each key pending until the Promise settles, then remove the key and allow it to be submitted again.",
].join(" ");

test("auto state audit excludes stateless completion-order mapping", () => {
  assert.deepEqual(
    decideStateAudit(orderedMapTask, "auto"),
    {
      mode: "auto",
      enabled: false,
      reason: "auto-no-high-confidence-lifecycle-risk",
    },
  );
});

test("auto state audit retains real keyed and supersession lifecycles", () => {
  assert.deepEqual(
    decideStateAudit(keyedPoolTask, "auto"),
    {
      mode: "auto",
      enabled: true,
      reason: "auto-keyed-promise-lifecycle",
    },
  );
  assert.equal(
    decideStateAudit(
      "An async loader must prevent an older stale completion from overwriting the latest result.",
      "auto",
    ).reason,
    "auto-async-supersession",
  );
  assert.equal(
    decideStateAudit(
      "Reset an in-flight async request without allowing its later rejection to mutate new state.",
      "auto",
    ).reason,
    "auto-async-lifecycle",
  );
  assert.equal(
    decideStateAudit(
      "Run an abortable batch. If the AbortSignal aborts during work, let already-started workers settle normally and remove the abort listener before resolving.",
      "auto",
    ).reason,
    "auto-async-abort-lifecycle",
  );
});

test("state audit deferrals stay reason-specific", () => {
  const abort = stateAuditDeferral("auto-async-abort-lifecycle");
  assert.match(abort, /abort before awaiting the batch/i);
  assert.match(abort, /exact listener function/i);
  assert.doesNotMatch(abort, /same-key|key-to-Promise/i);

  const keyed = stateAuditDeferral("auto-keyed-promise-lifecycle");
  assert.match(keyed, /same-key reuse/i);
  assert.doesNotMatch(keyed, /abort before awaiting the batch/i);
});

test("state audit diagnoses synchronous throw probes against async APIs", () => {
  const diagnostic = stateAuditProbeDiagnostic(
    {
      a: "shell",
      c: "node --input-type=module -e \"import assert from 'node:assert/strict'; assert.throws(() => orderedMap([], worker, { concurrency: 0 }), TypeError)\"",
    },
    "AssertionError [ERR_ASSERTION]: Missing expected exception (TypeError).\nexit 1",
  );
  assert.match(diagnostic, /assert\.throws.*synchronously/i);
  assert.match(diagnostic, /await assert\.rejects/);
  assert.match(diagnostic, /do not remove `async`/i);

  assert.equal(
    stateAuditProbeDiagnostic(
      {
        a: "shell",
        c: "node --input-type=module -e \"await assert.rejects(() => orderedMap([], worker, { concurrency: 0 }), TypeError)\"",
      },
      "AssertionError [ERR_ASSERTION]: Missing expected rejection (TypeError).\nexit 1",
    ),
    "",
  );
});

test("state audit credits successful inline stdin probes without crediting ordinary stdin", () => {
  const heredoc = {
    a: "shell",
    c: `node --input-type=module - <<'EOF'
import assert from "node:assert/strict";
assert.equal(1, 1);
EOF`,
  };
  assert.equal(
    stateAuditProbePassed(heredoc, {
      observation: "cwd: /tmp/example\nexit 0\n",
      configuredVerification: "npm test",
      triggerCommand: "npm test",
    }),
    true,
  );
  assert.equal(
    stateAuditProbePassed(heredoc, {
      observation: "AssertionError [ERR_ASSERTION]\nexit 1\n",
    }),
    false,
  );
  assert.equal(
    stateAuditProbePassed(
      { a: "shell", c: "node --input-type=module -" },
      { observation: "exit 0\n" },
    ),
    false,
  );
  assert.equal(
    stateAuditEngagement(
      { ...heredoc, c: `${heredoc.c}\nnpm test` },
      { observation: "exit 0\n# pass 2\n# fail 0\n" },
    ),
    true,
  );
});

test("successful heredoc lifecycle proof resolves the audit without a done deferral", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-state-heredoc-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(
    path.join(workspace, "src", "pool.js"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(
    path.join(workspace, "test", "public.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { value } from "../src/pool.js";
test("visible", () => assert.equal(typeof value, "number"));
`,
  );

  let call = 0;
  const actions = [
    { a: "replace", p: "src/pool.js", old: "export const value = 1;\n", new: "export const value = 2;\n" },
    { a: "shell", c: "npm test" },
    { a: "replace", p: "src/pool.js", old: "export const value = 2;\n", new: "export const value = 1;\n" },
    {
      a: "shell",
      c: `node --input-type=module - <<'EOF'
import assert from "node:assert/strict";
import { value } from "./src/pool.js";
assert.equal(value, 1);
EOF
npm test`,
    },
    { a: "done", summary: "Implemented and verified." },
  ];
  const model = {
    codex: false,
    endpoint: null,
    metadata: () => ({ runtime: "test", model: "state-heredoc-script" }),
    async complete() {
      return {
        content: JSON.stringify(actions[Math.min(call++, actions.length - 1)]),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };

  const result = await runAgent({
    task: keyedPoolTask,
    workspace,
    model,
    maxTurns: 8,
    preGate: false,
    grounding: false,
    shellSandbox: "host",
    completionAudit: true,
    stateAudit: "auto",
    stateAuditMaxDeferrals: 2,
  });

  assert.equal(result.metrics.stateAuditHints, 1);
  assert.equal(result.metrics.stateAuditDoneDeferrals, 0);
  assert.equal(result.metrics.turns, 5);
  assert.equal(result.done, true);
});

test("completion-order exclusion prevents the observed async-to-sync regression", async (t) => {
  const roots = [];
  t.after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const correctAsync = `export async function orderedMap(values, worker, { concurrency = 1 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("invalid concurrency");
  }
  return Promise.all(values.map((value) => worker(value)));
}
`;
  const regressedSync = correctAsync
    .replace("export async function", "export function");
  const initial = `export async function orderedMap(values, worker, { concurrency = 1 } = {}) {
  return Promise.all(values.map((value) => worker(value)));
}
`;

  async function run(stateAudit) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-state-policy-"));
    roots.push(workspace);
    fs.mkdirSync(path.join(workspace, "src"));
    fs.mkdirSync(path.join(workspace, "test"));
    fs.writeFileSync(path.join(workspace, "src", "ordered-map.js"), initial);
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
    );
    fs.writeFileSync(
      path.join(workspace, "test", "visible.test.js"),
      `import test from "node:test";
import assert from "node:assert/strict";
import { orderedMap } from "../src/ordered-map.js";
test("maps values", async () => {
  assert.deepEqual(await orderedMap([1, 2], async (value) => value * 2), [2, 4]);
});
`,
    );

    let call = 0;
    const model = {
      codex: false,
      endpoint: null,
      metadata: () => ({ runtime: "test", model: "state-policy-script" }),
      async complete() {
        const actions = [
          { a: "read_file", p: "src/ordered-map.js", start: 1, limit: 80 },
          {
            a: "replace",
            p: "src/ordered-map.js",
            old: initial,
            new: correctAsync,
          },
          { a: "shell", c: "npm test" },
          { a: "done", summary: "Implemented and verified." },
          {
            a: "shell",
            c: "node --input-type=module -e \"import assert from 'node:assert/strict'; import { orderedMap } from './src/ordered-map.js'; assert.throws(() => orderedMap([], async value => value, { concurrency: 0 }), TypeError);\"",
          },
          {
            a: "replace",
            p: "src/ordered-map.js",
            old: correctAsync,
            new: regressedSync,
          },
          { a: "shell", c: "npm test" },
          { a: "done", summary: "Implemented and verified." },
          { a: "done", summary: "Implemented and verified." },
        ];
        return {
          content: JSON.stringify(actions[Math.min(call++, actions.length - 1)]),
          tokens: 1,
          stoppedEos: true,
          stoppedLimit: false,
          timings: {},
        };
      },
    };

    const result = await runAgent({
      task: orderedMapTask,
      workspace,
      model,
      maxTurns: 10,
      preGate: false,
      grounding: false,
      shellSandbox: "host",
      completionAudit: true,
      stateAudit,
      stateAuditMaxDeferrals: 2,
    });
    return {
      result,
      source: fs.readFileSync(path.join(workspace, "src", "ordered-map.js"), "utf8"),
    };
  }

  const legacy = await run(true);
  const corrected = await run("auto");

  assert.equal(legacy.result.metrics.stateAuditHints, 1);
  assert.equal(legacy.result.metrics.stateAuditDoneDeferrals, 2);
  assert.equal(legacy.source, regressedSync);
  assert.equal(corrected.result.metrics.stateAuditHints, 0);
  assert.equal(corrected.result.metrics.stateAuditDoneDeferrals, 0);
  assert.equal(corrected.source, correctAsync);
  assert.ok(corrected.result.metrics.turns < legacy.result.metrics.turns);
});
