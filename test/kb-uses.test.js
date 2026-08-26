import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Datalog } from "../src/logic/datalog.js";
import { extractCodeFacts } from "../src/logic/codefacts.js";
import { codeTool } from "../src/logic/tools.js";

// The KB knew where a symbol was DEFINED and never where it was USED. That is
// the shape of the expensive failures: the sibling-site sweep (a text heuristic
// today), ticket A's env-flip test, and every SWE-bench miss where the gold
// patch guarded two call sites and ours guarded the one the issue named.

function ws(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-uses-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const db = new Datalog();
  const { index, ...stats } = extractCodeFacts(db, dir);
  return { db, workspace: dir, stats, factIndex: index, staleFiles: new Set() };
}

const FILES = {
  "src/policy.js": "export function deliveryFor(gate) {\n  return gate;\n}\n",
  "src/gates.js": "import { deliveryFor } from './policy.js';\n\nexport function run(g) {\n  return deliveryFor(g);\n}\n",
  "src/report.js": "import { deliveryFor } from './policy.js';\nconst a = deliveryFor('x');\nconst b = deliveryFor('y');\n",
  "src/unrelated.js": "export const nothing = 1;\n",
};

test("uses names every call site with file:line", (t) => {
  const answer = String(codeTool(ws(t, FILES)).answer("uses deliveryFor"));
  assert.match(answer, /src\/gates\.js:4/, "the call inside run()");
  assert.match(answer, /src\/report\.js:2/);
  assert.match(answer, /src\/report\.js:3/, "both sites in one file, not just the first");
  assert.ok(!/unrelated/.test(answer), "files that never mention it are absent");
});

test("uses excludes the definition itself but says where it is", (t) => {
  const answer = String(codeTool(ws(t, FILES)).answer("uses deliveryFor"));
  assert.match(answer, /defined at src\/policy\.js:1/);
});

test("uses reports honestly when a symbol has no call sites", (t) => {
  const answer = String(codeTool(ws(t, FILES)).answer("uses nothing"));
  assert.match(answer, /no use sites/i);
});

test("uses is advertised in the verb list and description", (t) => {
  const tool = codeTool(ws(t, FILES));
  assert.ok(tool.verbs.includes("uses"));
  assert.match(tool.description, /uses/);
});
