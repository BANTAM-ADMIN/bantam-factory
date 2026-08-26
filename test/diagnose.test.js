import assert from "node:assert";
import { describe, it } from "node:test";
import { witnessProblems, summarizeProblems, classifyAction, scoreRemedy, selectRemedies } from "../src/diagnose.js";

// ---------------------------------------------------------------------------
// selectRemedies — which candidate contexts a --turn replay will A/B.
//
// PRINCIPLES.md #3 is "test the counterfactual, don't argue it", and the
// capstone (parseArgs, 2026-07-14) worked by injecting ONE custom sentence.
// prepareReplay has always accepted an arbitrary inject string, but the CLI
// could only ever pass entries from the closed CONTEXT_REMEDIES table -- so the
// signature move had no surface. Every catalog entry describes a process failure
// (redundant read, phantom replace, paging); a narrowed lexical contract or any
// other spec-shaped defect matches none of them and exits "no candidate
// remedies".
// ---------------------------------------------------------------------------

describe("selectRemedies", () => {
  it("uses the catalog for a classified problem kind", () => {
    const remedies = selectRemedies("redundant-read");
    assert.ok(remedies.length > 0);
    assert.ok(remedies.every((r) => typeof r === "string" && r.length > 0));
  });

  it("returns the injected fact alone when one is supplied", () => {
    const remedies = selectRemedies("redundant-read", "--json is a boolean flag; it takes no value.");
    assert.deepStrictEqual(remedies, ["--json is a boolean flag; it takes no value."]);
  });

  it("makes an unclassifiable kind replayable via injection", () => {
    assert.deepStrictEqual(selectRemedies("no-such-kind"), []);
    assert.deepStrictEqual(selectRemedies("no-such-kind", "one true fact"), ["one true fact"]);
  });

  it("ignores a blank injection rather than testing an empty context", () => {
    assert.deepStrictEqual(selectRemedies("no-such-kind", "   "), []);
  });
});

// ---------------------------------------------------------------------------
// witnessProblems — detects distress signals in turn observations
// ---------------------------------------------------------------------------

describe("witnessProblems", () => {
  it("returns an empty array when there are no turns", () => {
    const problems = witnessProblems({ turns: [] });
    assert.deepStrictEqual(problems, []);
  });

  it("detects a redundant-read signal", () => {
    const artifact = {
      turns: [
        { i: 0, observation: "[open_files] Not re-read: src/foo.js" },
      ],
    };
    const problems = witnessProblems(artifact);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].kind, "redundant-read");
    assert.strictEqual(problems[0].turn, 0);
  });

  it("detects multiple distinct signals across turns", () => {
    const artifact = {
      turns: [
        { i: 0, observation: "[repetition] Deduplicated action" },
        { i: 1, observation: '"old" text not found in file' },
      ],
    };
    const problems = witnessProblems(artifact);
    assert.strictEqual(problems.length, 2);
    assert.strictEqual(problems[0].kind, "duplicate-action");
    assert.strictEqual(problems[1].kind, "phantom-replace");
  });

  it("skips turns with empty observations", () => {
    const artifact = {
      turns: [
        { i: 0, observation: "" },
        { i: 1, observation: "[open_files] Not re-read: src/foo.js" },
      ],
    };
    const problems = witnessProblems(artifact);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].turn, 1);
  });
});

// ---------------------------------------------------------------------------
// summarizeProblems — aggregates problem counts and action failure rates
// ---------------------------------------------------------------------------

describe("summarizeProblems", () => {
  it("returns correct shape with zero problems", () => {
    const summary = summarizeProblems({ turns: [] });
    assert.strictEqual(summary.turns, 0);
    assert.strictEqual(summary.problemTurns, 0);
    assert.strictEqual(summary.problemRate, 0);
    assert.ok(Array.isArray(summary.byKind));
    assert.ok(Array.isArray(summary.actionFailureRate));
  });

  it("counts problems by kind and computes failure rate", () => {
    const artifact = {
      turns: [
        { i: 0, observation: "[open_files] Not re-read: src/foo.js", parsedAction: { a: "read_file" } },
        { i: 1, observation: "[open_files] Not re-read: src/bar.js", parsedAction: { a: "read_file" } },
        { i: 2, observation: "OK", parsedAction: { a: "replace" } },
      ],
    };
    const summary = summarizeProblems(artifact);
    assert.strictEqual(summary.turns, 3);
    assert.strictEqual(summary.problemTurns, 2);
    assert.strictEqual(summary.problemRate, 2 / 3);
    const readRow = summary.actionFailureRate.find((r) => r.verb === "read_file");
    assert.strictEqual(readRow.bad, 2);
    assert.strictEqual(readRow.total, 2);
  });
});

// ---------------------------------------------------------------------------
// classifyAction — categorizes an action output string
// ---------------------------------------------------------------------------

describe("classifyAction", () => {
  it("classifies a JSON read_file action as recon", () => {
    assert.strictEqual(classifyAction('{"a":"read_file"}'), "recon");
  });

  it("classifies a JSON replace action as productive", () => {
    assert.strictEqual(classifyAction('{"a":"replace"}'), "productive");
  });

  it("classifies a bare string with no JSON as invalid", () => {
    assert.strictEqual(classifyAction("unknown_verb"), "invalid");
  });

  it("classifies a JSON shell action as productive", () => {
    assert.strictEqual(classifyAction('{"a":"shell"}'), "productive");
  });

  it("classifies a JSON inspect action as recon", () => {
    assert.strictEqual(classifyAction('{"a":"inspect","ops":[]}'), "recon");
  });

  it("classifies malformed JSON as invalid", () => {
    assert.strictEqual(classifyAction('{"a":"shell"'), "invalid");
  });

  it("classifies a JSON done action as productive", () => {
    assert.strictEqual(classifyAction('{"a":"done","summary":"ok"}'), "productive");
  });
});

// ---------------------------------------------------------------------------
// scoreRemedy — compares baseline vs remedy outcomes
// ---------------------------------------------------------------------------

describe("scoreRemedy", () => {
  it("promotes a remedy that increases productive rate above threshold", () => {
    const baseline = ['{"a":"read_file"}', '{"a":"read_file"}', '{"a":"read_file"}'];
    const remedy = ['{"a":"replace"}', '{"a":"replace"}', '{"a":"replace"}'];
    const result = scoreRemedy(baseline, remedy);
    assert.strictEqual(result.verdict, "promote");
    assert.ok(result.lift > 0);
  });

  it("marks a remedy as harmful when productive rate drops", () => {
    const baseline = ['{"a":"replace"}', '{"a":"replace"}', '{"a":"replace"}'];
    const remedy = ['{"a":"read_file"}', '{"a":"read_file"}', '{"a":"read_file"}'];
    const result = scoreRemedy(baseline, remedy);
    assert.strictEqual(result.verdict, "harmful");
    assert.ok(result.lift < 0);
  });

  it("returns inconclusive when lift is small", () => {
    // baseline: 2 productive / 4 = 0.5
    // remedy:   3 productive / 6 = 0.5
    // lift = 0.5 - 0.5 = 0 → inconclusive
    const baseline = ['{"a":"replace"}', '{"a":"replace"}', '{"a":"read_file"}', '{"a":"read_file"}'];
    const remedy = ['{"a":"replace"}', '{"a":"replace"}', '{"a":"replace"}', '{"a":"read_file"}', '{"a":"read_file"}', '{"a":"read_file"}'];
    const result = scoreRemedy(baseline, remedy);
    assert.strictEqual(result.verdict, "inconclusive");
  });
});
