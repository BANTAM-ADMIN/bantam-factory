// Compose the two halves of the test-impact primitive (roadmap 2.1) into a single decision: given the
// files a turn just edited, return a runnable SCOPED test command that exercises only the tests those
// edits could affect — or null, meaning "don't scope, run the full --verify".
//
// This is the pure decision function the harness-run scoped verifier (roadmap 1.1/1.2) will call each
// edit turn. It is deliberately conservative: it returns null (→ full verify) whenever scoping would be
// unsound or unhelpful, so a scoped green is always a genuine subset of a full green, never a claim
// beyond it. The loop-wiring (running it async, overlapped with generation, and labeling
// green(scoped) vs green(full)) is the remaining body of 1.1/1.2.

import { affectedTests } from "./codefacts.js";
import { detectFramework } from "./test-frameworks.js";

/**
 * @param {string} workspace     absolute workspace path
 * @param {string[]} changedRels workspace-relative files edited this turn
 * @param {object} db            the datalog KB (with test/reaches facts materialized)
 * @returns {{ framework: string, tests: string[], command: string } | null}
 */
export function scopedVerifyPlan(workspace, changedRels, db) {
  if (!db || !Array.isArray(changedRels) || changedRels.length === 0) return null;
  const framework = detectFramework(workspace);
  if (!framework) return null;                 // unknown framework → the caller runs the full --verify
  const tests = affectedTests(db, changedRels);
  if (!tests.length) return null;              // nothing statically reachable → don't claim a scoped pass
  return { framework: framework.name, tests, command: framework.scopedCommand(tests) };
}
