import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  planWorkspaceTransaction,
  recoverWorkspaceTransactions,
  WorkspaceTransaction,
} from "../src/workspace-transaction.js";

const temporary = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-workspace-transaction-"));
  temporary.push(root);
  return root;
}

function write(root, relative, contents, mode = 0o644) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function fixture() {
  const root = tempRoot();
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  const live = path.join(root, "live");
  const transactions = path.join(root, "state", "transactions");
  for (const directory of [baseline, candidate, live]) fs.mkdirSync(directory, { recursive: true });

  for (const directory of [baseline, live]) {
    write(directory, "src/changed.js", "export const revision = 1;\n");
    write(directory, "src/deleted.js", "remove me\n");
    write(directory, "bin/tool.sh", "#!/bin/sh\nexit 0\n", 0o755);
  }
  write(candidate, "src/changed.js", "export const revision = 2;\n");
  write(candidate, "src/added.js", "export const added = true;\n");
  write(candidate, "bin/tool.sh", "#!/bin/sh\nexit 1\n", 0o755);
  return { root, baseline, candidate, live, transactions };
}

function singleFileFixture() {
  const root = tempRoot();
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  const live = path.join(root, "live");
  const transactions = path.join(root, "state", "transactions");
  for (const directory of [baseline, candidate, live]) fs.mkdirSync(directory, { recursive: true });
  write(baseline, "src/a.js", "export const revision = 1;\n");
  write(live, "src/a.js", "export const revision = 1;\n");
  write(candidate, "src/a.js", "export const revision = 2;\n");
  return { root, baseline, candidate, live, transactions };
}

function killAfterStagedWrite(state, id, {
  phase = "ready-to-rename",
  partial = null,
} = {}) {
  const moduleUrl = new URL("../src/workspace-transaction.js", import.meta.url).href;
  const script = [
    `const { WorkspaceTransaction } = await import(${JSON.stringify(moduleUrl)});`,
    "const config = JSON.parse(process.env.BANTAM_KILLED_TRANSACTION_FIXTURE);",
    "const { killPhase, partialBytes, ...transactionConfig } = config;",
    "const transaction = new WorkspaceTransaction({",
    "  ...transactionConfig,",
    "  onStagedWrite(event) {",
    "    if (event.phase !== killPhase) return;",
    "    if (partialBytes !== null) {",
    "      const partialTarget = event.phase === 'owned'",
    "        ? path.join(config.transactionRoot, config.id, event.stagingPath)",
    "        : path.join(config.workspace, event.tempPath);",
    "      fs.writeFileSync(partialTarget, partialBytes);",
    "    }",
    "    process.kill(process.pid, 'SIGKILL');",
    "  },",
    "});",
    "transaction.prepare();",
    "transaction.apply();",
    "process.exitCode = 99;",
  ].join("\n");
  const childScript = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    script,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: {
      ...process.env,
      BANTAM_KILLED_TRANSACTION_FIXTURE: JSON.stringify({
        workspace: state.live,
        baselineRoot: state.baseline,
        candidateRoot: state.candidate,
        transactionRoot: state.transactions,
        id,
        killPhase: phase,
        partialBytes: partial,
      }),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function stagedSiblings(state) {
  const source = path.join(state.live, "src");
  return fs.readdirSync(source)
    .filter((entry) => /^\.a\.js\.bantam-promote-[0-9]+-[a-f0-9]{24}$/.test(entry))
    .map((entry) => path.join(source, entry));
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("workspace promotion transaction", () => {
  it("plans, applies, and restores added, modified, deleted, and executable files", () => {
    const state = fixture();
    const plan = planWorkspaceTransaction(state.baseline, state.candidate);
    assert.deepEqual(
      plan.changes.map(({ path: file, kind }) => [file, kind]),
      [
        ["bin/tool.sh", "modified"],
        ["src/added.js", "added"],
        ["src/changed.js", "modified"],
        ["src/deleted.js", "deleted"],
      ],
    );

    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "attempt-1",
      metadata: { candidateTree: "candidate-tree" },
    });
    transaction.prepare();
    transaction.apply();

    assert.equal(fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"), "export const revision = 2;\n");
    assert.equal(fs.readFileSync(path.join(state.live, "src/added.js"), "utf8"), "export const added = true;\n");
    assert.equal(fs.existsSync(path.join(state.live, "src/deleted.js")), false);
    assert.equal(fs.statSync(path.join(state.live, "bin/tool.sh")).mode & 0o111, 0o111);

    transaction.rollback({ reason: "smoke failed" });
    assert.equal(fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"), "export const revision = 1;\n");
    assert.equal(fs.existsSync(path.join(state.live, "src/added.js")), false);
    assert.equal(fs.readFileSync(path.join(state.live, "src/deleted.js"), "utf8"), "remove me\n");
    assert.equal(transaction.view().state, "rolled_back");
  });

  it("recovers an interrupted apply unless the channel already promoted it", () => {
    const rollbackState = fixture();
    const interrupted = new WorkspaceTransaction({
      workspace: rollbackState.live,
      baselineRoot: rollbackState.baseline,
      candidateRoot: rollbackState.candidate,
      transactionRoot: rollbackState.transactions,
      id: "interrupted",
    });
    interrupted.prepare();
    interrupted.apply();

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: rollbackState.live,
      transactionRoot: rollbackState.transactions,
    }), [{ id: "interrupted", action: "rolled_back" }]);
    assert.equal(
      fs.readFileSync(path.join(rollbackState.live, "src/changed.js"), "utf8"),
      "export const revision = 1;\n",
    );

    const promotedState = fixture();
    const promoted = new WorkspaceTransaction({
      workspace: promotedState.live,
      baselineRoot: promotedState.baseline,
      candidateRoot: promotedState.candidate,
      transactionRoot: promotedState.transactions,
      id: "promoted",
      metadata: { candidateVersionRef: "candidate-ref" },
    });
    promoted.prepare();
    promoted.apply();
    promoted.markVerified({ status: "pass" });

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: promotedState.live,
      transactionRoot: promotedState.transactions,
      wasPromoted: (manifest) => manifest.metadata.candidateVersionRef === "candidate-ref",
    }), [{ id: "promoted", action: "committed" }]);
    assert.equal(
      fs.readFileSync(path.join(promotedState.live, "src/changed.js"), "utf8"),
      "export const revision = 2;\n",
    );
  });

  it("prunes a manifest-owned staged sibling after SIGKILL between write and rename", () => {
    const state = singleFileFixture();
    const killed = killAfterStagedWrite(state, "killed-before-rename");

    assert.equal(killed.status, null);
    assert.equal(killed.signal, "SIGKILL");
    const staged = stagedSiblings(state);
    assert.equal(staged.length, 1);
    assert.equal(fs.readFileSync(staged[0], "utf8"), "export const revision = 2;\n");
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "a.js"), "utf8"),
      "export const revision = 1;\n",
    );
    const manifest = JSON.parse(fs.readFileSync(
      path.join(state.transactions, "killed-before-rename", "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.state, "applying");
    assert.equal(manifest.pendingWrite.tempPath, `src/${path.basename(staged[0])}`);
    assert.equal(manifest.pendingWrite.destinationPath, "src/a.js");

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), [{ id: "killed-before-rename", action: "rolled_back" }]);
    assert.deepEqual(stagedSiblings(state), []);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "a.js"), "utf8"),
      "export const revision = 1;\n",
    );
  });

  it("preserves a staged sibling whose bytes no longer match its ownership record", () => {
    const state = singleFileFixture();
    const killed = killAfterStagedWrite(state, "tampered-staged-write");
    assert.equal(killed.signal, "SIGKILL");
    const [staged] = stagedSiblings(state);
    assert.ok(staged);
    fs.unlinkSync(staged);
    fs.writeFileSync(staged, "human-owned replacement\n");

    assert.throws(
      () => recoverWorkspaceTransactions({
        workspace: state.live,
        transactionRoot: state.transactions,
      }),
      /not the transaction-owned regular-file inode|rollback conflict/,
    );
    assert.equal(fs.readFileSync(staged, "utf8"), "human-owned replacement\n");
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "a.js"), "utf8"),
      "export const revision = 1;\n",
    );
    const recovered = new WorkspaceTransaction({
      workspace: state.live,
      transactionRoot: state.transactions,
      id: "tampered-staged-write",
    }).load();
    assert.equal(recovered.view().state, "conflict");
  });

  it("prunes the same owned inode after SIGKILL leaves a partial staged write", () => {
    const state = singleFileFixture();
    const killed = killAfterStagedWrite(state, "killed-during-write", {
      phase: "owned",
      partial: "partial candidate",
    });

    assert.equal(killed.signal, "SIGKILL");
    assert.deepEqual(stagedSiblings(state), []);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(state.transactions, "killed-during-write", "manifest.json"),
      "utf8",
    ));
    assert.match(manifest.pendingWrite.device, /^[0-9]+$/);
    assert.match(manifest.pendingWrite.inode, /^[0-9]+$/);
    const privateStage = path.join(
      state.transactions,
      "killed-during-write",
      manifest.pendingWrite.stagingPath,
    );
    assert.equal(fs.readFileSync(privateStage, "utf8"), "partial candidate");

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), [{ id: "killed-during-write", action: "rolled_back" }]);
    assert.deepEqual(stagedSiblings(state), []);
    assert.equal(fs.existsSync(privateStage), false);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "a.js"), "utf8"),
      "export const revision = 1;\n",
    );
  });

  it("discards private staging after SIGKILL before inode ownership is persisted", () => {
    const state = singleFileFixture();
    const killed = killAfterStagedWrite(state, "killed-before-ownership", {
      phase: "created-unowned",
    });

    assert.equal(killed.signal, "SIGKILL");
    assert.deepEqual(stagedSiblings(state), []);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(state.transactions, "killed-before-ownership", "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.pendingWrite.device, null);
    assert.equal(manifest.pendingWrite.inode, null);
    const privateStage = path.join(
      state.transactions,
      "killed-before-ownership",
      manifest.pendingWrite.stagingPath,
    );
    assert.equal(fs.statSync(privateStage).isFile(), true);

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), [{ id: "killed-before-ownership", action: "rolled_back" }]);
    assert.equal(fs.existsSync(privateStage), false);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "a.js"), "utf8"),
      "export const revision = 1;\n",
    );
  });

  it("discards crash-left partial preparation directories without touching live files", () => {
    const state = fixture();
    const partial = path.join(state.transactions, ".preparing-killed-controller");
    fs.mkdirSync(path.join(partial, "backups", "src"), { recursive: true });
    fs.writeFileSync(path.join(partial, "backups", "src", "changed.js"), "partial backup\n");

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), [{
      id: ".preparing-killed-controller",
      action: "discarded-preparation",
    }]);
    assert.equal(fs.existsSync(partial), false);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src", "changed.js"), "utf8"),
      "export const revision = 1;\n",
    );
  });

  it("abandons a prepared-only crash without conflicting with later human edits", () => {
    const state = fixture();
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "prepared-only",
    });
    transaction.prepare();
    write(state.live, "src/changed.js", "human edit after prepare\n");

    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), [{ id: "prepared-only", action: "rolled_back" }]);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"),
      "human edit after prepare\n",
    );
    const recovered = new WorkspaceTransaction({
      workspace: state.live,
      transactionRoot: state.transactions,
      id: "prepared-only",
    }).load();
    assert.equal(recovered.view().state, "rolled_back");
    assert.equal(recovered.view().rollback.liveWorkspaceUntouched, true);
  });

  it("refuses a stale live file before making any workspace change", () => {
    const state = fixture();
    write(state.live, "src/changed.js", "concurrent edit\n");
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "stale",
    });

    assert.throws(() => transaction.prepare(), /changed since baseline/);
    assert.equal(fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"), "concurrent edit\n");
    assert.equal(fs.existsSync(path.join(state.live, "src/added.js")), false);
    assert.equal(fs.existsSync(path.join(state.transactions, "stale")), false);
    assert.deepEqual(recoverWorkspaceTransactions({
      workspace: state.live,
      transactionRoot: state.transactions,
    }), []);
  });

  it("refuses candidate symlinks rather than deploying an escaping target", () => {
    const state = fixture();
    fs.symlinkSync("/etc/passwd", path.join(state.candidate, "src", "escape.js"));

    assert.throws(
      () => planWorkspaceTransaction(state.baseline, state.candidate),
      /refuses symbolic links/,
    );
  });

  it("preserves a concurrent edit made after prepare and retains a conflict", () => {
    const state = fixture();
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "concurrent-before-apply",
    });
    transaction.prepare();
    write(state.live, "bin/tool.sh", "#!/bin/sh\nhuman edit\n", 0o755);

    assert.throws(
      () => transaction.apply(),
      /rollback failed.*rollback conflict|rollback conflict/s,
    );
    assert.equal(
      fs.readFileSync(path.join(state.live, "bin/tool.sh"), "utf8"),
      "#!/bin/sh\nhuman edit\n",
    );
    assert.equal(transaction.view().state, "conflict");
    assert.throws(
      () => recoverWorkspaceTransactions({
        workspace: state.live,
        transactionRoot: state.transactions,
      }),
      /unresolved rollback conflict/,
    );
  });

  it("does not erase a concurrent edit discovered during rollback", () => {
    const state = fixture();
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "concurrent-before-rollback",
    });
    transaction.prepare();
    transaction.apply();
    write(state.live, "src/changed.js", "human post-deploy edit\n");

    assert.throws(
      () => transaction.rollback({ reason: "verification failed" }),
      /unknown live bytes were preserved/,
    );
    assert.equal(
      fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"),
      "human post-deploy edit\n",
    );
    assert.equal(transaction.view().state, "conflict");
    assert.equal(
      fs.readFileSync(path.join(state.live, "src/added.js"), "utf8"),
      "export const added = true;\n",
    );
  });

  it("rejects a candidate materialization changed after prepare and restores prior writes", () => {
    const state = fixture();
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "tampered-candidate",
    });
    transaction.prepare();
    write(state.candidate, "src/changed.js", "tampered candidate\n");

    assert.throws(() => transaction.apply(), /candidate src\/changed\.js does not match/);
    assert.equal(
      fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"),
      "export const revision = 1;\n",
    );
    assert.equal(fs.existsSync(path.join(state.live, "src/added.js")), false);
    assert.equal(transaction.view().state, "rolled_back");
  });

  it("rejects candidate type and executable-mode changes made after prepare", () => {
    for (const mutate of [
      (file) => fs.chmodSync(file, 0o755),
      (file) => {
        fs.unlinkSync(file);
        fs.symlinkSync("elsewhere.js", file);
      },
    ]) {
      const state = fixture();
      const transaction = new WorkspaceTransaction({
        workspace: state.live,
        baselineRoot: state.baseline,
        candidateRoot: state.candidate,
        transactionRoot: state.transactions,
        id: "tampered-candidate-shape",
      });
      transaction.prepare();
      mutate(path.join(state.candidate, "src/changed.js"));

      assert.throws(() => transaction.apply(), /candidate src\/changed\.js/);
      assert.equal(
        fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"),
        "export const revision = 1;\n",
      );
      assert.equal(transaction.view().state, "rolled_back");
    }
  });

  it("rejects a tampered backup without writing any rollback bytes", () => {
    const state = fixture();
    const transaction = new WorkspaceTransaction({
      workspace: state.live,
      baselineRoot: state.baseline,
      candidateRoot: state.candidate,
      transactionRoot: state.transactions,
      id: "tampered-backup",
    });
    transaction.prepare();
    transaction.apply();
    write(
      path.join(state.transactions, "tampered-backup", "backups"),
      "src/changed.js",
      "tampered backup\n",
    );

    assert.throws(
      () => transaction.rollback({ reason: "verification failed" }),
      /transaction backup src\/changed\.js does not match/,
    );
    assert.equal(
      fs.readFileSync(path.join(state.live, "src/changed.js"), "utf8"),
      "export const revision = 2;\n",
    );
    assert.equal(fs.existsSync(path.join(state.live, "src/added.js")), true);
    assert.equal(transaction.view().state, "conflict");
  });

  it("rejects unknown states and malformed change records during recovery", () => {
    for (const corruption of [
      (manifest) => { manifest.state = "mystery"; },
      (manifest) => { manifest.changes[0].kind = "added"; },
    ]) {
      const state = fixture();
      const transaction = new WorkspaceTransaction({
        workspace: state.live,
        baselineRoot: state.baseline,
        candidateRoot: state.candidate,
        transactionRoot: state.transactions,
        id: "invalid-manifest",
      });
      transaction.prepare();
      const manifestPath = path.join(
        state.transactions,
        "invalid-manifest",
        "manifest.json",
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      corruption(manifest);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      assert.throws(
        () => recoverWorkspaceTransactions({
          workspace: state.live,
          transactionRoot: state.transactions,
        }),
        /invalid workspace transaction manifest/,
      );
    }
  });
});
