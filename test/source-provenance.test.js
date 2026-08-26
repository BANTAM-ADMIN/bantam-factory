import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PROVENANCE_MARKER,
  deriveSourceProvenanceObligation,
  evaluateSourceProvenanceWrite,
} from "../src/logic/source-provenance.js";
import {
  formatProgressNudge,
  isProductiveShellCommand,
  progressGateRejection,
  shouldForceDraftEdit,
} from "../src/progress-awareness.js";

const CRACK_TASK = "You need to create a file called \"/app/solution.txt\" with the word found in \"secret_file.txt\" in the \"secrets.7z\" archive.";
const OUTPUTS = ["/app/solution.txt"];
const PARSER = {
  a: "shell",
  c: `python3 -c "data=open('secrets.7z','rb').read(); hdr=data[178:212]; print(hdr.hex())"`,
};

function obligation() {
  return deriveSourceProvenanceObligation(CRACK_TASK, { outputPaths: OUTPUTS });
}

test("Datalog derives the crack task's exact source-provenance contract", () => {
  const derived = obligation();
  assert.ok(derived);
  assert.equal(derived.marker, SOURCE_PROVENANCE_MARKER);
  assert.deepEqual(derived.outputs, OUTPUTS);
  assert.deepEqual(derived.sources, ["secret_file.txt", "secrets.7z"]);
  assert.match(derived.message, /filename.*not value evidence/i);
  assert.match(JSON.stringify(derived.proofs), /source_derivation/);
  assert.match(JSON.stringify(derived.proofs), /exact_payload/);
  assert.match(JSON.stringify(derived.proofs), /task_source/);
});

test("the station stays off for authored implementation and literal-value tasks", () => {
  assert.equal(deriveSourceProvenanceObligation(
    "Fix parser.js using the examples in spec.txt and write src/parser.js.",
    { outputPaths: ["src/parser.js"] },
  ), null);
  assert.equal(deriveSourceProvenanceObligation(
    "Create /app/solution.txt containing the literal word ready.",
    { outputPaths: OUTPUTS },
  ), null);
});

test("the recorded filename-derived guess is rejected without a source witness", () => {
  const decision = evaluateSourceProvenanceWrite(
    { a: "write_file", p: "/app/solution.txt", content: "secret" },
    {
      obligation: obligation(),
      turns: [{
        parsedAction: PARSER,
        observation: "$ python3 ...\ncwd: /app\nsandbox: host:/app\nexit 0\n215\nraw archive bytes\nTask: secret_file.txt is in secrets.7z",
      }],
    },
  );
  assert.equal(decision.applicable, true);
  assert.equal(decision.supported, false);
  assert.match(decision.rejection, /unsupported guess/);
  assert.match(decision.rejection, /was NOT written/);
});

test("a standalone value observed through the named source admits the exact write", () => {
  const decision = evaluateSourceProvenanceWrite(
    { a: "write_file", p: "/app/solution.txt", content: "honeybear\n" },
    {
      obligation: obligation(),
      turns: [{
        parsedAction: { a: "shell", c: "7z x secrets.7z && cat secret_file.txt" },
        observation: "$ 7z x secrets.7z && cat secret_file.txt\ncwd: /app\nsandbox: host:/app\nexit 0\nhoneybear\n",
      }],
    },
  );
  assert.equal(decision.applicable, true);
  assert.equal(decision.supported, true);
  assert.equal(decision.rejection, null);
  assert.equal(decision.proofs.length, 1);
  assert.match(JSON.stringify(decision.proofs[0]), /source_witness/);
});

test("a numbered read of the recovered inner file is valid source evidence", () => {
  const decision = evaluateSourceProvenanceWrite(
    { a: "replace", p: "solution.txt", old: "wrong", new: "honeybear" },
    {
      obligation: obligation(),
      turns: [{
        action: { a: "read_file", p: "/app/unpacked/secret_file.txt" },
        observation: "/app/unpacked/secret_file.txt (2 lines, showing 1-2):\n1\thoneybear\n2\t\n— end of file (2 lines); nothing beyond line 2, do not re-read this range.",
      }],
    },
  );
  assert.equal(decision.supported, true);
});

test("unrelated and multi-line authoring is outside the scalar evidence gate", () => {
  for (const action of [
    { a: "write_file", p: "/app/notes.txt", content: "secret" },
    { a: "write_file", p: "/app/solution.txt", content: "line one\nline two\n" },
    PARSER,
  ]) {
    const decision = evaluateSourceProvenanceWrite(action, { obligation: obligation(), turns: [] });
    assert.equal(decision.applicable, false, `should not gate ${action.a}:${action.p ?? action.c}`);
    assert.equal(decision.rejection, null);
  }
});

test("pre-write compute stays executable without being mistaken for a finished artifact", () => {
  assert.equal(isProductiveShellCommand(PARSER.c), true);
  assert.equal(progressGateRejection(PARSER, {
    progresslessTurns: 8,
    threshold: 8,
    knownArtifacts: [],
  }), null);
});

test("source-derived tasks suppress the force-draft mask and receive no-guess context", () => {
  const state = {
    interactive: false,
    useGrammar: true,
    progressAwareness: true,
    autoForceEditAfter: 8,
    progresslessTurns: 8,
  };
  assert.equal(shouldForceDraftEdit(state), true, "ordinary authored work still force-commits");
  assert.equal(shouldForceDraftEdit({ ...state, sourceProvenanceRequired: true }), false);

  const nudge = formatProgressNudge(8, { sourceProvenance: obligation() });
  assert.match(nudge, /exact transcription task/);
  assert.match(nudge, /do NOT write a rough draft/);
  assert.match(nudge, /secret_file\.txt/);
  assert.match(nudge, /change a real search axis/);
  assert.match(nudge, /Enumerate supported modes/);
  assert.doesNotMatch(nudge, /best current assumption/i);
});
