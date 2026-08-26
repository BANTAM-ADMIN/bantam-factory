// Live probe, 2026-08-17: bantam added shout() to a one-file workspace, proved
// it with `node -e "import('./greet.js')..."` printing HI BOB — and the done
// gate still scolded "you never ran anything that exercises it. Run the
// project's tests". There ARE no project tests; the advice was impossible.
//
// The probe exclusion is right when a real oracle exists (swb2-sympy-rational
// ran thirteen probes while the visible suite sat red). It is wrong when NO
// verifier is configured: there, a post-edit probe that touches the edited
// file is the best evidence the workspace can produce. The oracle's presence
// decides which physics apply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unverifiedEditObjection } from "../src/done-guard.js";

const edit = { parsedAction: { a: "replace", p: "greet.js", old: "x", new: "y" }, observation: "ok" };
const probe = {
  parsedAction: { a: "shell", c: `node -e "import('./greet.js').then(m=>console.log(m.shout('bob')))"` },
  observation: "HI BOB",
};

test("with no verifier anywhere, a post-edit probe of the edited file satisfies the gate", () => {
  assert.equal(unverifiedEditObjection([edit, probe], 0, { verifierConfigured: false }), null);
});

test("with a verifier configured, a probe alone still draws the objection", () => {
  const o = unverifiedEditObjection([edit, probe], 0, { verifierConfigured: true });
  assert.match(o, /never ran anything that exercises it/);
});

test("no verifier and no probe still draws the objection — with achievable advice", () => {
  const o = unverifiedEditObjection([edit], 0, { verifierConfigured: false });
  assert.match(o, /never ran anything that exercises it/);
  assert.doesNotMatch(o, /project's tests/, "never demand tests that do not exist");
  assert.match(o, /probe|script|run the code/i, "the advice must be something this workspace can do");
});

test("a probe BEFORE the edit proves nothing about it", () => {
  assert.match(
    unverifiedEditObjection([probe, edit], 0, { verifierConfigured: false }),
    /never ran anything/,
  );
});

test("a probe that errored is not evidence", () => {
  const failed = { ...probe, observation: "ERROR: Cannot find module './greet.js'" };
  assert.match(
    unverifiedEditObjection([edit, failed], 0, { verifierConfigured: false }),
    /never ran anything/,
  );
});

test("a probe of some OTHER file does not clear an edit to this one", () => {
  const other = { parsedAction: { a: "shell", c: "node -e \"console.log(1+1)\"" }, observation: "2" };
  assert.match(
    unverifiedEditObjection([edit, other], 0, { verifierConfigured: false }),
    /never ran anything/,
  );
});

test("default physics are unchanged: verifier presumed configured", () => {
  assert.match(
    unverifiedEditObjection([edit, probe], 0, {}),
    /never ran anything/,
  );
});

test("documentation edits never anchor the objection", () => {
  const docEdit = { parsedAction: { a: "write_file", p: "CODEXTHOUGHTS.md", content: "notes" }, observation: "wrote 2000 bytes" };
  assert.equal(unverifiedEditObjection([docEdit], 0, {}), null,
    "there is no such thing as exercising markdown");
});

test("a code edit is still anchored even when a docs edit follows it", () => {
  const codeEdit = { parsedAction: { a: "replace", p: "greet.js", old: "x", new: "y" }, observation: "ok" };
  const docEdit = { parsedAction: { a: "write_file", p: "README.md", content: "docs" }, observation: "wrote 500 bytes" };
  const o = unverifiedEditObjection([codeEdit, docEdit], 0, {});
  assert.match(o, /`greet\.js`/, "the objection names the code file, not the README");
});
