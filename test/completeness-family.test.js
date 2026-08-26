import assert from "node:assert/strict";
import test from "node:test";

import { familyFindings } from "../src/logic/completeness-critic.js";

function ground() {
  const definitions = [
    ["src/executor.js", "edit"],
    ["src/agent.js", "retained"],
    ["src/agent.js", "retainedTurn"],
  ];
  return {
    db: {
      query(relation) {
        return relation === "defines" ? definitions : [];
      },
    },
    factIndex: { records: new Map() },
  };
}

const action = {
  a: "write_file",
  content: "function editTurn() { return { editApplied: true }; }\n",
};

test("naming-family completeness ignores helper definitions added only to tests", () => {
  assert.deepEqual(familyFindings({
    ground: ground(),
    action,
    editedFile: "test/contract-test-oracle.test.js",
  }), []);
});

test("naming-family completeness still challenges an equivalent production definition", () => {
  const findings = familyFindings({
    ground: ground(),
    action,
    editedFile: "src/contract-test-oracle.js",
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, "editTurn");
  assert.equal(findings[0].editedFile, "src/contract-test-oracle.js");
});
