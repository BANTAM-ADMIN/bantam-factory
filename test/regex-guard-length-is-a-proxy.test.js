import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Executor } from "../src/executor.js";

// Length is a PROXY for catastrophic backtracking and a poor one. `(a+)+$` is
// twenty characters and can hang the harness; a flat alternation of literals is
// linear however long it gets. At 120 the proxy rejected only SAFE patterns.
//
// TB2 mailman (2026-08-21) was refused three searches, each a flat literal
// alternation with no quantifier in it — enumerate the config sections, find
// which of a dozen settings exist. "Use a simpler literal" asks for one turn per
// alternative instead of one for all of them.
const MAILMAN = [
  "\\[mta\\]|\\[routes\\]|\\[database\\]|\\[logging\\]|\\[rest_api\\]|\\[archiver\\]|\\[bounce\\]|\\[debugger\\]|\\[default\\]|\\[shell\\]|\\[smtp\\]|\\[vars\\]",
  "nodedomain|mailman_host|subscription_policy|subscription_authenticator|bounce_handler|advertise_second|preference|confirm|smtp_host|smtp_port|smtp_user|smtp_password",
];

// await the body before the finally runs — see the note in
// shell-inspection-outside-workspace.test.js. Returning the promise deletes the
// fixture mid-test, and a search against a missing directory is "not refused"
// for the wrong reason, which is how this file first reported a working guard
// as broken.
async function withWorkspace(fn) {
  const ws = fs.mkdtempSync("/tmp/rx-guard-");
  fs.writeFileSync(`${ws}/a.txt`, "mta routes database\n");
  try { return await fn(ws); } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}
const refused = (obs) => /unsafe search regex/.test(String(obs ?? ""));

test("a long FLAT alternation is safe and is allowed", async () => {
  await withWorkspace(async (ws) => {
    const ex = new Executor(ws, { shellSandbox: "host" });
    for (const q of MAILMAN) {
      assert.ok(q.length > 120, "these are the patterns the old cap rejected");
      const out = await ex.execute({ a: "search", q, path: "." });
      assert.equal(refused(out?.observation), false, `flat alternation must run: ${q.slice(0, 40)}…`);
    }
  });
});

test("the shapes that actually backtrack are still refused", async () => {
  await withWorkspace(async (ws) => {
    const ex = new Executor(ws, { shellSandbox: "host" });
    for (const q of ["(a+)+$", "(a|a)*b", "(?=foo)bar", "\\1foo", "x".repeat(600)]) {
      const out = await ex.execute({ a: "search", q, path: "." });
      assert.equal(refused(out?.observation), true, `must stay blocked: ${q.slice(0, 30)}`);
    }
  });
});
