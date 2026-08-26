import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_STRATEGY_MARKER,
  classifySearchStrategyAction,
  evaluateSearchStrategyProposal,
  searchStrategyGateRejection,
} from "../src/logic/search-strategy.js";

const alpha = (command, observation) => ({
  parsedAction: { a: "shell", c: command },
  observation,
});

const ALPHA_FAILURES = [
  alpha(
    "timeout 30s /app/john/run/john --incremental=alpha --fork=2 hashes.txt",
    "$ timeout 30s ...\ncwd: /app\nexit 124\n",
  ),
  alpha(
    "/app/john/run/john --fork=8 --incremental=alpha:1-8 --min-length=1 --max-length=8 hashes.txt",
    "$ /app/john/run/john ...\ncwd: /app\nexit 0\n0g 0:00:05:00 DONE 0g/s\nSession completed\n",
  ),
];

test("normalizes John timeout, fork, and length variations to one incremental domain", () => {
  const plain = classifySearchStrategyAction({ a: "shell", c: "john --incremental=Alpha hashes.txt" });
  const varied = classifySearchStrategyAction({
    a: "shell",
    c: "timeout -k 2s 45s /app/john/run/john --fork=6 --incremental=alpha:1-8 --max-length=8 hashes.txt",
  });
  assert.deepEqual(plain, {
    family: "john-incremental",
    domain: "alpha",
    operation: "search",
    normalized: "john:incremental:alpha",
  });
  assert.deepEqual(varied, plain);
});

test("Datalog rejects the next same-domain proposal after two failed attempts", () => {
  const action = {
    a: "shell",
    c: "/app/john/run/john --incremental=alpha:3-6 --fork=12 hashes.txt",
  };
  const result = evaluateSearchStrategyProposal(action, { turns: ALPHA_FAILURES });

  assert.equal(result.marker, SEARCH_STRATEGY_MARKER);
  assert.equal(result.applicable, true);
  assert.equal(result.rejected, true);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures.map((failure) => failure.reason), ["timeout", "no-candidate"]);
  assert.match(result.rejection, /rejected this action before execution/i);
  assert.match(result.rejection, /timeout.*--fork.*length bounds/i);
  assert.match(result.rejection, /--list=inc-modes/);
  assert.match(result.rejection, /change a real search axis/i);
  assert.match(JSON.stringify(result.proof), /proposed_strategy/);
  assert.match(JSON.stringify(result.proof), /failed_outcome/);
  assert.match(JSON.stringify(result.proof), /turn:1/);
  assert.match(JSON.stringify(result.proof), /turn:2/);
  assert.equal(searchStrategyGateRejection(action, { turns: ALPHA_FAILURES }), result.rejection);
});

test("nonzero failures and explicit no-candidate outcomes both count", () => {
  const turns = [
    alpha("john --incremental=alpha hashes.txt", "$ john ...\nexit 1\nError: invalid recovery state\n"),
    alpha("john --incremental=alpha:1-4 hashes.txt", "$ john ...\nexit 0\n0 password hashes cracked, 1 left\n"),
  ];
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "john --incremental=alpha --fork=4 hashes.txt" },
    { turns },
  );
  assert.equal(result.rejected, true);
  assert.deepEqual(result.failures.map((failure) => failure.reason), ["nonzero-exit:1", "no-candidate"]);
});

test("the recorded timeout plus exit-zero unknown-mode replay blocks the next alpha proposal", () => {
  const turns = [
    alpha(
      "timeout 300s /app/john/run/john --incremental=alpha hashes.txt",
      "$ timeout 300s /app/john/run/john --incremental=alpha hashes.txt\nexit 1\n(timed out)\n",
    ),
    alpha(
      "timeout 300s /app/john/run/john --incremental=alpha:1-8 --fork=4 hashes.txt 2>&1 | tail -20",
      "$ timeout 300s /app/john/run/john --incremental=alpha:1-8 --fork=4 hashes.txt 2>&1 | tail -20\nexit 0\nUnknown incremental mode: alpha:1-8\n",
    ),
  ];
  const repeated = evaluateSearchStrategyProposal(
    { a: "shell", c: "timeout 600s john --incremental=alpha --fork=8 hashes.txt" },
    { turns },
  );
  assert.equal(repeated.rejected, true);
  assert.deepEqual(repeated.failures.map((failure) => failure.reason), ["timeout", "invalid-configuration"]);

  const newDomain = evaluateSearchStrategyProposal(
    { a: "shell", c: "timeout 600s john --incremental=digits hashes.txt" },
    { turns },
  );
  assert.equal(newDomain.rejected, false);
  assert.equal(newDomain.strategy.domain, "digits");
});

test("pipeline-masked aborted sessions remain failed attempts", () => {
  const wrapped = [
    alpha(
      "timeout 30s john --incremental=alpha hashes.txt 2>&1 | tail -5",
      "$ timeout 30s john --incremental=alpha hashes.txt 2>&1 | tail -5\nexit 0\nSession aborted\n",
    ),
    alpha(
      "john --incremental=alpha:1-8 hashes.txt",
      "$ john --incremental=alpha:1-8 hashes.txt\nexit 0\nSession aborted\n",
    ),
  ];
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "john --incremental=alpha hashes.txt" },
    { turns: wrapped },
  );
  assert.equal(result.rejected, true);
  assert.deepEqual(result.failures.map((failure) => failure.reason), ["timeout", "aborted"]);
});

test("pipeline-masked invalid options and fork ranges are failed configurations", () => {
  const invalid = [
    alpha(
      "john --incremental=alpha hashes.txt 2>&1 | tail -5",
      "$ john --incremental=alpha hashes.txt 2>&1 | tail -5\nexit 0\nInvalid option: --external\n",
    ),
    alpha(
      "john --incremental=alpha:1-8 --fork=99 hashes.txt 2>&1 | tail -5",
      "$ john --incremental=alpha:1-8 --fork=99 hashes.txt 2>&1 | tail -5\nexit 0\n--fork value out of range\n",
    ),
  ];
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "john --incremental=alpha hashes.txt" },
    { turns: invalid },
  );
  assert.equal(result.rejected, true);
  assert.deepEqual(result.failures.map((failure) => failure.reason), [
    "invalid-configuration",
    "invalid-configuration",
  ]);
});

test("john --show remains allowed after the search domain is exhausted", () => {
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "/app/john/run/john --show hashes.txt" },
    { turns: ALPHA_FAILURES },
  );
  assert.equal(result.applicable, true);
  assert.equal(result.rejected, false);
  assert.equal(result.rejection, null);
  assert.equal(result.strategy.operation, "inspect");
  assert.match(JSON.stringify(result.proof), /allowed_strategy/);
});

test("a genuinely new incremental domain is allowed", () => {
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "/app/john/run/john --incremental=digits:1-12 --fork=4 hashes.txt" },
    { turns: ALPHA_FAILURES },
  );
  assert.equal(result.applicable, true);
  assert.equal(result.rejected, false);
  assert.equal(result.strategy.domain, "digits");
  assert.deepEqual(result.failures, []);
});

test("successful, refused, and unrelated actions do not manufacture failures", () => {
  const turns = [
    alpha("john --incremental=alpha hashes.txt", "$ john ...\nexit 0\n1g 0:00:00:02 DONE 1g/s\n"),
    alpha("john --incremental=alpha:1-8 hashes.txt", "[progress-awareness] action was not executed"),
    alpha("/app/john/run/7z2john.pl archive.7z", "$ 7z2john.pl ...\nexit 1\n"),
  ];
  const result = evaluateSearchStrategyProposal(
    { a: "shell", c: "john --incremental=alpha hashes.txt" },
    { turns },
  );
  assert.equal(result.rejected, false);
  assert.deepEqual(result.failures, []);
  assert.equal(classifySearchStrategyAction({ a: "shell", c: "echo john --incremental=alpha" }), null);
  assert.equal(classifySearchStrategyAction({ a: "shell", c: "john --list=inc-modes" }), null);
  assert.equal(classifySearchStrategyAction({ a: "shell", c: "john --wordlist=words.txt hashes.txt" }), null);
});

test("an ambiguous multi-domain shell proposal fails open", () => {
  assert.equal(classifySearchStrategyAction({
    a: "shell",
    c: "john --incremental=alpha hashes.txt; john --incremental=digits hashes.txt",
  }), null);
});
