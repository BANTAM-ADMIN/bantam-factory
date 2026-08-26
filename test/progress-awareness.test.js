import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyProgress, progressGateRejection } from "../src/progress-awareness.js";

// Recorded specimen: keyed-task-pool, local 27B, 2026-07-30, round-03.
// The public suite went green at turn 7. The model tried done at turn 13, was
// bounced by the state audit, then spent turns 14-39 -- 26 of a 40-turn budget --
// alternating a deduplicated read of the same file with a rerun of the unchanged,
// already-passing suite. It never attempted done again and hit the turn cap.
//
// The anti-spiral gate needs progresslessTurns >= 8. The run peaked at 6, because
// every rerun of the green suite scored as "verification" progress and reset the
// counter to 0. In a read -> test loop the counter oscillates 0<->1 and the gate
// is structurally unreachable.
//
// agent.js already carries this exact insight for duplicate memory: "A passing
// verifier or useful query does not make an unchanged read fresh; clearing on
// those signals let the model alternate read -> test forever." It was never
// applied to progress accounting.

const VERIFY = { a: "shell", c: "node --test test/public.test.js" };
const GREEN = "VERDICT: all 2 tests passed.";

describe("classifyProgress: verification credit", () => {
  it("credits a verification run after the workspace changed", () => {
    const p = classifyProgress(VERIFY, GREEN, { workspaceChangedSinceVerification: true });
    assert.equal(p.progress, true);
    assert.equal(p.reason, "verification");
  });

  it("does not credit a rerun of an unchanged suite", () => {
    const p = classifyProgress(VERIFY, GREEN, { workspaceChangedSinceVerification: false });
    assert.equal(p.progress, false, "an unchanged rerun is not new evidence and must not reset the anti-spiral counter");
    assert.equal(p.reason, "verification_unchanged");
  });

  it("defaults to crediting, so existing callers are unaffected", () => {
    const p = classifyProgress(VERIFY, GREEN);
    assert.equal(p.progress, true);
    assert.equal(p.reason, "verification");
  });

  it("still credits an edit regardless of verification state", () => {
    const edit = { a: "write_file", p: "src/x.js", content: "x" };
    const p = classifyProgress(edit, "wrote 1 bytes to src/x.js", { workspaceChangedSinceVerification: false });
    assert.equal(p.progress, true);
    assert.equal(p.reason, "edit");
  });
});

// The counter must actually be able to reach the gate threshold in the recorded
// read -> test loop. This is the regression the specimen demands: replay that
// alternation and assert the gate becomes reachable.
describe("anti-spiral reachability in a read/test loop", () => {
  const READ = { a: "read_file", p: "src/keyed-task-pool.js" };

  function simulate({ creditUnchangedVerification }) {
    let progressless = 0;
    let changedSinceVerification = false; // nothing edited during the spin
    let gateFiredAt = null;
    for (let turn = 0; turn < 26; turn++) {
      const action = turn % 2 === 0 ? READ : VERIFY;
      const p = classifyProgress(action, turn % 2 === 0 ? "[repetition] Deduplicated" : GREEN, {
        workspaceChangedSinceVerification: creditUnchangedVerification ? true : changedSinceVerification,
      });
      if (p.progress) progressless = 0;
      else progressless++;
      if (gateFiredAt === null && progressGateRejection(action, { progresslessTurns: progressless, threshold: 8 })) {
        gateFiredAt = turn;
      }
    }
    return { progressless, gateFiredAt };
  }

  it("never reaches the gate while unchanged reruns score as progress", () => {
    const { progressless, gateFiredAt } = simulate({ creditUnchangedVerification: true });
    assert.equal(gateFiredAt, null, "this is the recorded bug: the gate is unreachable");
    assert.ok(progressless <= 1, `counter oscillates near zero, got ${progressless}`);
  });

  it("reaches the gate once unchanged reruns stop scoring as progress", () => {
    const { gateFiredAt } = simulate({ creditUnchangedVerification: false });
    assert.ok(gateFiredAt !== null, "the gate must become reachable");
    assert.ok(gateFiredAt < 12, `should fire early in the spin, fired at turn ${gateFiredAt}`);
  });
});
