# Patch-transaction: context and receipt repair

This is a harness repair and a fresh system regression on an already-seen
development task, not a held-out evaluation or a statistical ranking.

## Observed failure mechanism

The original Qwen 27B BANTAM attempt passed all five acceptance groups and
produced an accepted completion, but took 590.546 seconds and 40 worker actions.
Its last production edit was action 4 (zero-based), about 22 seconds after
starting. Reconstructing that edit yields exactly the final production-file
hash. That does **not** make this a 22-second verified completion: the later
checks and completion protocol were still required.

The retained context and execution receipts show several distinct problems:

1. `node check-contract.mjs 2>&1` actually passed but was not recognized as
   focused proof. The plain launcher later received credit on the same workspace
   generation with identical output. Configured-check repeat handling also
   compared raw command spelling instead of the same bounded execution identity.
2. Independent source audits lacked already-measured CLI and project facts.
   One predicted an incorrect result from `4 !== 3`; another described correct
   error handling as a finding. Text-field limits could sever the finding while
   leaving its surrounding JSON syntactically complete.
3. Adding an assertion-only `check-contract.mjs` changed the audit's product
   source set and triggered a second review despite unchanged production code.
4. A heuristic called a conditional-throw probe “print-only.” A separate green
   test notice recommended scratch cleanup and DONE before all current proof
   obligations were settled.
5. The prolonged loop repeatedly exceeded the 120,000-character history budget.
   Sliding the oldest retained boundary broke prefix reuse near the head, even
   though the physical model context was not exhausted.

The worker also made real mistakes: its first array-validation condition was
wrong, and several handwritten check expectations were wrong. Context repair
must distinguish these from production defects; it cannot make model output an
oracle or remove independent verification.

## Implemented changes

- Recognize one literal, trailing, unquoted `2>&1` plus ordinary outer whitespace
  for direct proof-command identity. Preserve the exact executed command and
  raw receipts. Pipelines, masks, ambiguous wrappers, contradictory receipts,
  stale generations and incorrectly ordered verification remain rejected.
- Use this identity for the audit-repeat exception and check-file retention.
  Current guidance names concrete supported launchers and minimal witnesses.
- Give the auditor bounded, source/generation-bound projections of validated
  CLI cases and project verification, not worker reasoning or arbitrary logs.
  CLI/API agreement remains wiring evidence, **not business correctness**.
- Require fresh collection findings to declare a differing observable in
  bounded JSON data. Missing, equal or field-capped contrasts are deferred,
  explicitly not a clean review. Differing predictions remain hypotheses and
  still require execution. Historical audit receipts remain readable.
- Exclude conventional standalone builtin-assertion scripts with no exports
  from the production audit source set. They remain subject to real focused
  and project verification. Production API exports are not excluded by name.
- Make the print-probe advisory conservative; conditional throws and explicit
  failure paths are no longer labeled print-only. Green notices preserve
  intended regression checks and defer to current completion requirements.
- Add extension-only history-window hysteresis: keep the retained boundary
  until the existing hard budget is exceeded, then compact to two thirds of
  that budget. Preserve initial grounding, latest causal evidence and safe
  source pointers. Temporary unnumbered recovery notes do not reset the
  boundary or resurrect evicted evidence. Emit explicit rebase diagnostics.
  Rebuild keeps its existing stateless budgeting behavior.

## Verification

The integrated focused suite passed **181/181**, with no skips or failures.
A separate actual-Docker regression passed: a merged-output focused check and
fresh read-only project verification reopened DONE and produced accepted
completion without gratuitous edits. These deterministic checks do not by
themselves establish live-model quality or a wall-clock improvement.

The final server-off full suite passed **4,030 tests, zero failures, 75
environment/opt-in skips** (4,105 total). The preceding full run exposed two
outdated copy assertions, now corrected, and its live-vision request was
interrupted by the operator-requested server shutdown. No vision success is
claimed from the offline rerun; the model was not restarted.

The live BANTAM-only rerun passed **5/5 with accepted completion in 152.362
seconds**, using 15 worker actions. It is recorded under
`.bantam/benchmarks/factory-patch-20260907-27b-contextfix1`.
The original four-corner evidence is untouched under
`.bantam/benchmarks/factory-patch-20260907-27b-fourcorners2`.

The repaired path engaged directly: action 13 ran
`node check-contract.mjs 2>&1`, received focused credit, and was followed by
the controller's read-only `npm test`. Action 14 produced accepted DONE.
All 424 runtime-source and 23 kit hashes remained sealed; 28/28 request
accounting records, 64 wire bodies, 58 factory blobs and final/protected
workspace files reconciled. The factory ended in `job.released`.

This does not mean the auditor became infallible: it still misread conflict
logic. The worker rejected unsupported claims and fixed a genuine insertion
ordering bug. Both source reviews covered only production code; the second
followed that real production correction. The new quality filter deferred
malformed findings without waiving executed verification.

No extension-prefix breaks or history rebases were recorded in the rerun.
Its largest prompt was 71,775 characters / 17,969 input tokens: this shorter
trajectory did not reach the history threshold. Hysteresis is covered by
deterministic overflow/rewind tests, not stressed by this live attempt.

Both attempts use the same frozen `factory-2026-09-07/patch-transaction`
starter, public task and independent judges; Qwen 27B; extension/immutable;
teacher off; read-only configured verification; and a 600-second limit.
Both used the warm server, with 72,192 actual context tokens and microbatch 1024.
The original run overlapped frontier work and the operator-requested shutdown
of ComfyUI; the rerun runs alone. This is not a clean timing ablation isolating
only the code changes. All outcomes must remain on record. After the completed
rerun, the operator requested server shutdown to reclaim VRAM; it was stopped
and was not restarted for offline verification.

## Before and after

| Measurement | Original attempt | Repaired rerun |
| --- | ---: | ---: |
| Strict acceptance groups | 5/5 | 5/5 |
| Accepted completion | Yes | Yes |
| Wall clock | 590.546 s | 152.362 s |
| Model calls | 77 | 28 |
| Input tokens, including cached | 1,724,714 | 271,157 |
| Cached prefix tokens | 1,334,515 | 225,141 |
| Fresh input tokens | 390,199 | 46,016 |
| Output tokens | 26,599 | 9,419 |
| Model prefill time | 197.945 s | 25.833 s |
| Model decode time | 326.433 s | 104.910 s |
| Worker actions | 40 | 15 |
| Recorded extension-prefix breaks | 9 | 0 |
| Collection audits / CLI stations | 2 / 8 | 2 / 3 |

The objective is to preserve the safety checks while reducing unnecessary
model decisions and repeated prefill—not to award completion earlier, weaken
the judges, or promise a faster ranking before measuring it.
