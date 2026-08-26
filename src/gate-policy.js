// Delivery policy: what the loop does when a gate objects.
//
// The check always runs. Only delivery varies:
//   "block" - refuse the action and feed the objection back to the model
//   "warn"  - let the action through and surface the objection to the human
//   "off"   - do not evaluate the gate at all
//
// Rule of thumb: block on the user's word, warn on the harness's hunch.
//
// immutable_file encodes an instruction the user actually gave, so it blocks even with a human
// present. premature_done encodes the harness's suspicion that the model is claiming an unearned
// victory; with a human present, say so and let them judge.

export const BLOCK = "block";
export const WARN = "warn";
export const OFF = "off";

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));

export function defaultPolicy(env = process.env) {
  return {
    // "I implemented it" with a pristine working tree. Blocks in both modes: this
    // is not a judgement call about verification depth, it is a factual claim the
    // filesystem contradicts.
    empty_done: { autonomous: BLOCK, interactive: BLOCK },
    placeholder_done: { autonomous: BLOCK, interactive: WARN },
    missing_outputs: { autonomous: BLOCK, interactive: WARN },
    premature_done: { autonomous: BLOCK, interactive: WARN },
    // Interactive warning ships immediately because it cannot block a human-driven run. Blocking
    // unattended runs changes eval trajectories, so keep it opt-in until an A/B says it helps.
    unverified_edit: { autonomous: truthy(env.BANTAM_UNVERIFIED_GATE) ? BLOCK : OFF, interactive: WARN },
    // Tightly scoped (refactor-shaped task + no configured verifier + one
    // bounce): workday pass 3 request 6 preserved stdout byte-for-byte while
    // flipping exit codes both directions off a single-invocation baseline.
    refactor_surface: { autonomous: BLOCK, interactive: WARN },
    secret_cleanup: { autonomous: BLOCK, interactive: WARN },
    immutable_file: { autonomous: BLOCK, interactive: BLOCK },
    evidence: { autonomous: BLOCK, interactive: WARN },
    // An answer extracted from a machine-rendered image by the vision model with
    // the pixels never opened. Autonomous BLOCK: unlike most hunches this one is
    // a measured error rate (~1-in-6 exact on the graded chess board), the fix is
    // spelled out in the objection, and it costs exactly one bounce. Interactive
    // WARN — a human looking at the same image is their own gauge.
    // BANTAM_VISION_GROUND=0 disables.
    // An answer to a decidable search, produced without running one. Autonomous
    // BLOCK: the objection names the exact procedure, it costs one bounce, and the
    // advisory form measured inert. BANTAM_UNSEARCHED_CHOICE=0 disables.
    // Satisfied every stated rule without reproducing the stated result.
    // BANTAM_SIMULATE_TARGET=0 disables.
    // An enumerated contract with listed items no test exercises. Autonomous
    // BLOCK: measured miss family (rowquery/slugline), the objection names the
    // exact untested tokens, one bounce. BANTAM_CONTRACT_GATE=0 disables.
    contract_coverage: /^(0|false|no|off)$/i.test(String(env.BANTAM_CONTRACT_GATE ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: WARN },
    unsimulated_target: /^(0|false|no|off)$/i.test(String(env.BANTAM_SIMULATE_TARGET ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: WARN },
    unsearched_choice: /^(0|false|no|off)$/i.test(String(env.BANTAM_UNSEARCHED_CHOICE ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: WARN },
    vision_unverified: /^(0|false|no|off)$/i.test(String(env.BANTAM_VISION_GROUND ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: WARN },
    // A red preview is real execution evidence, but a hard done-gate on rendering
    // errors is precisely what 2026-07-13-preview-loop.md:58 defers until an
    // experiment measures it — and none has: preview-vision and preview-vision-hard
    // varied BANTAM_NO_PREVIEW/BANTAM_NO_VISION (the tool) and never the gate. Do
    // not read their pass-rate deltas as a verdict on this gate either way; the
    // vision arm's -16.7 pp is one contract-fail in six runs. The gate also carries
    // requireInteraction, a regex over the task text, which is a hunch by the rule
    // of thumb above. Ship it the way unverified_edit ships until an A/B says
    // otherwise. BANTAM_PREVIEW_GATE=1 is the candidate arm.
    preview: { autonomous: truthy(env.BANTAM_PREVIEW_GATE) ? BLOCK : OFF, interactive: WARN },
    // A done that arrives while the task's configured verify still fails. The
    // 2026-07-16 swb-sympy-prefix run recorded the failure class exactly: done
    // accepted at turn 21/30 on a red tree, and the unshown terminal verify held
    // the one missing fact ("expected watt/1000, got watt*Prefix(...)").
    // Replaying that done turn with the verify output injected flipped the model
    // to the gold fix (comparison/runs/2026-07-16-swebench-lite-v1). Autonomous
    // only: an interactive done is the human's call, and running a suite before
    // accepting their word costs real time. BANTAM_VERIFY_DONE_GATE=0 disables.
    verify_red: /^(0|false|no|off)$/i.test(String(env.BANTAM_VERIFY_DONE_GATE ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: OFF },
    // Done while a symbol the model edited has same-named definitions in files
    // it never opened (swb2-django-serializer 2026-07-17: queryset_iterator
    // fixed in python.py, identical twin in xml_serializer.py never visited).
    // Replays showed the fact as advisory text was ignored; as a gate it was
    // acted on. One bounce max; carries repo facts only. Candidate pending the
    // full-deck A/B; BANTAM_SIBLING_GATE=0 disables.
    sibling_symbol: /^(0|false|no|off)$/i.test(String(env.BANTAM_SIBLING_GATE ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: OFF },
    // Done while the task's own "every module in <dir>" quantifier still has
    // modules the run never read or edited. Both prompt trajectories lost
    // adapter-migration runs to this early-done in the 2026-08-12 A/B, and the
    // 2026-07-30 poka-yoke table measured the advisory form of the same fact
    // ignored 3/3 on that fixture — so it ships as a gate only. One bounce,
    // repo facts only. Candidate pending its preregistered A/B;
    // BANTAM_TASK_COVERAGE=1 enables the autonomous block.
    task_coverage: { autonomous: truthy(env.BANTAM_TASK_COVERAGE) ? BLOCK : OFF, interactive: WARN },
    // Done after ADDING a name that joins an existing affix family whose
    // implementations were never examined (escapeseq v5, 2026-07-17: the
    // [family] footer quoted the docstring naming conditional_escape and the
    // model never mentioned it again; the same fact as a done-turn gate
    // rejection flipped it to open the family file). BANTAM_FAMILY_GATE=0.
    family_convention: /^(0|false|no|off)$/i.test(String(env.BANTAM_FAMILY_GATE ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: OFF },
    // Costs an extra turn by design; already opt-in via BANTAM_LEDGER_GATE.
    requirement_ledger: { autonomous: BLOCK, interactive: OFF },
    // Prose continuity conflict still in the final narrative. Candidate: the
    // read-time advisory (BANTAM_CONTINUITY_ANCHORS) showed no pass lift because it
    // under-caught the half-fixed conflict; this gate re-checks the final text.
    // Opt-in until the A/B says it helps. BANTAM_CONTINUITY_GATE=1 is the candidate.
    continuity_reconcile: truthy(env.BANTAM_CONTINUITY_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // A notes/changelog deliverable that omits a repair the model made. Candidate,
    // opt-in until an A/B says it helps. BANTAM_NOTES_GATE=1 is the candidate arm.
    notes_documentation: truthy(env.BANTAM_NOTES_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // Code that passes its visible tests but THROWS on a valid-shaped edge input
    // the examples never showed (empty string, [], 0). Candidate: replay proved the
    // vague "consider edge cases" nudge moved this 27B ~1/3 of the time, but the
    // concrete "titleCase('') throws" fact from this smoke check fixed it. Opt-in
    // until an A/B says it helps. BANTAM_EDGE_SMOKE_GATE=1 is the candidate arm.
    edge_smoke: truthy(env.BANTAM_EDGE_SMOKE_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // Code that disagrees with a concrete example STATED IN THE SPEC. The
    // template-engine run reasoned itself into a false JS belief ("if([]) is
    // falsy") and its thin self-tests missed the regression; the spec's own
    // example is an un-arguable oracle the model can't reason around. Unlike a
    // self-authored test, the oracle is the task author. Opt-in until an A/B
    // says it helps. BANTAM_SPEC_EXAMPLE_GATE=1 is the candidate arm.
    spec_example: truthy(env.BANTAM_SPEC_EXAMPLE_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // Code that narrows an accepted-string language the task NAMED -- a
    // case-sensitive compare where the spec said case-insensitive. The advisory
    // [lexical-contract-audit] reminder already states this fact and is default-on;
    // the 2026-07-30 local-27B multi-sample recorded it firing in 3/3
    // adapter-migration runs and being ignored in 3/3, each ending in a confident
    // done with 26-32 turns of budget left and the byte-identical
    // `trimmed === "true"` narrowing. Same fact, advisory voice -- the delivery
    // asymmetry this project has now measured four times. This gate re-checks the
    // named language mechanically at done and bounces with the exact failing call.
    // Opt-in until an A/B says it helps. BANTAM_LEXICAL_SMOKE_GATE=1 is the
    // candidate arm.
    lexical_smoke: truthy(env.BANTAM_LEXICAL_SMOKE_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // The mirror of lexical_smoke: code that ACCEPTS a value the task's stated
    // type excludes, coercing where the contract requires a throw. All six
    // lexical-smoke-gate-ab runs wrote a correct parseEnabled and still failed the
    // hidden contract 6/6 on normalizeTags("a") -> ["a"], normalizeTags(["ok",2])
    // -> ["ok","2"], normalizeHeaders([]) -> {}. The visible suite only ever passes
    // well-formed input, so nothing contradicts the lenient reading. Validated 6/6
    // against the recorded trees with no false positive. Opt-in until an A/B says
    // it helps. BANTAM_TYPE_CONTRACT_GATE=1 is the candidate arm.
    type_contract: truthy(env.BANTAM_TYPE_CONTRACT_GATE)
      ? { autonomous: BLOCK, interactive: WARN }
      : { autonomous: OFF, interactive: OFF },
    // From the Fable reporting rules. Default-on since 2026-07-13 (bounded to one
    // rejection, zero false fires in 40 measured runs); BANTAM_REPORT_GUARD=0 disables
    // (baseline experiment arms use this).
    report_shape: /^(0|false|no|off)$/i.test(String(env.BANTAM_REPORT_GUARD ?? ""))
      ? { autonomous: OFF, interactive: OFF }
      : { autonomous: BLOCK, interactive: WARN },
  };
}

/** An unknown gate fails closed: a check nobody classified is treated as load-bearing. */
export function deliveryFor(gate, {
  interactive = false,
  visualTask = false,
  specGap = false,
  policy = defaultPolicy(),
} = {}) {
  // Rendered visual work has no meaningful unit-test substitute. Make a fresh
  // red screenshot load-bearing for unattended visual tasks while ordinary web
  // work retains the measured opt-in preview-gate policy.
  if (gate === "preview" && visualTask && !interactive) return BLOCK;
  // The type_contract gate earns its cost only on a task that under-specifies its
  // own type contract. Measured 2026-08-01, n=3 per arm on gpt-5.6-terra: on
  // channel-filter, whose task declares accepted input types and never says what
  // falls outside them, the gate took the hidden contract from 0/3 to 3/3 (exact
  // permutation p = 0.05, firing once in every passing run and zero times in every
  // failing one). On the seven fixtures whose tasks already state their contracts
  // it changes no score and costs roughly 2x turns.
  //
  // So the gate follows the detector rather than a standing flag. spec-gap-detector
  // reads that condition from the task text and the workspace's exports alone --
  // no grader, which is what makes it usable at runtime. It fired on 2 of 14
  // fixtures with zero false positives, and correctly stayed silent on both
  // `-explicit` variants, which share a repo with their bare twin and differ only
  // in whether the task states the contract.
  //
  // BANTAM_TYPE_CONTRACT_GATE=1 still forces it on regardless, for A/B arms.
  if (gate === "type_contract" && specGap && policy[gate]?.autonomous !== BLOCK) {
    return interactive ? WARN : BLOCK;
  }
  const row = policy[gate];
  if (!row) return BLOCK;
  return interactive ? row.interactive : row.autonomous;
}
