// secret_cleanup done-gate: a secret-removal task where a previously observed
// secret-bearing path is not cleared by post-edit verification. The gate names
// the missed path and bounces once; it is bounded and can never trap.

import assert from "node:assert/strict";
import test from "node:test";

import { secretCleanupObjection } from "../src/done-guard.js";

const TASK = "Remove all secrets and API keys from the repository before shipping.";

// A search observation whose line matches the secret pattern (a ghp_ token) and
// whose path survives normalizeHitPath.
const SECRET_OBS = "src/config.js:12:  const token = \"ghp_abcdefghijklmnopqrstuv\";";

// A turn that counts as an applied edit (turnEditApplied: replace + success prose).
const editTurn = (p) => ({
  action: { a: "replace", p, old: "x", new: "y" },
  observation: "replaced 1 occurrence",
});

// A post-edit search that covers the whole workspace with a secret query.
const coveringSearchTurn = () => ({
  action: { a: "search", q: "ghp_[A-Za-z0-9]{20}", p: "." },
  observation: "no matches",
});

// A post-edit shell search that covers the whole workspace with a secret query.
const coveringShellTurn = () => ({
  action: { a: "shell", c: "grep -rn ghp_ ." },
  observation: "",
});

// The measured failure: a post-edit grep that FILTERS OUT the hit path.
const filteredShellTurn = () => ({
  action: { a: "shell", c: "grep -rn ghp_ . | grep -v src/config.js" },
  observation: "",
});

test("secret_cleanup fires when an observed secret path is not covered by post-edit verification", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: SECRET_OBS },
    editTurn("src/other.js"),
    filteredShellTurn(),
  ];
  const obj = secretCleanupObjection(turns, 0, { task: TASK });
  assert.equal(typeof obj, "string");
  assert.ok(obj.length > 0, "expected a non-null objection message");
  assert.match(obj, /src\/config\.js/);
});

test("secret_cleanup stays silent when the post-edit search covers the hit path", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: SECRET_OBS },
    editTurn("src/config.js"),
    coveringSearchTurn(),
  ];
  assert.equal(secretCleanupObjection(turns, 0, { task: TASK }), null);
});

test("secret_cleanup stays silent when a shell search covers the hit path", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: SECRET_OBS },
    editTurn("src/config.js"),
    coveringShellTurn(),
  ];
  assert.equal(secretCleanupObjection(turns, 0, { task: TASK }), null);
});

test("secret_cleanup stays silent when the task is not a secret-cleanup task", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: SECRET_OBS },
    editTurn("src/other.js"),
    filteredShellTurn(),
  ];
  assert.equal(secretCleanupObjection(turns, 0, { task: "Refactor the parser" }), null);
});

test("secret_cleanup stays silent when there are no secret hits at all", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: "no matches" },
    editTurn("src/other.js"),
  ];
  assert.equal(secretCleanupObjection(turns, 0, { task: TASK }), null);
});

test("secret_cleanup stays silent once the rejection bound is reached", () => {
  const turns = [
    { action: { a: "search", q: "ghp_", p: "." }, observation: SECRET_OBS },
    editTurn("src/other.js"),
    filteredShellTurn(),
  ];
  assert.equal(secretCleanupObjection(turns, 1, { task: TASK }), null);
});
