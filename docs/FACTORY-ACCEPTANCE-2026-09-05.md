# Factory acceptance — 2026-09-05

Status: the bounded launch repair pass passed its repository and confinement
checks, an isolated factory build/apply task, and a final provenance-restored
CSV diagnostic. Failed earlier trials remain recorded below. These observations
are not a stock-model benchmark or evidence of a general factory advantage.

## Interval repair

The scratch Git project contained a deliberately incomplete interval-set
intersection function, a complete written contract, and six provided tests.
The contract required arbitrary input order, union/intersection semantics,
coalesced touching output, finite-number validation, and preservation of inputs.

An independently authored checker remained outside the model workspace. It used
unit-segment membership as an oracle for 2048 seeded integer-set pairs, checked
both argument orders, and included five additional groups for empty ranges,
fractional endpoints, invalid inputs, frozen inputs/fresh output, and large
finite magnitudes. Its source was embedded only in the operator's final
verification command. It was not part of the implementation model's task or
focused-test input.

| Observation | Result |
| --- | --- |
| Untouched starter | Provided checks and independent checker both failed |
| Runtime | Local llama.cpp at `http://127.0.0.1:8085`; `qwen` profile; `rebuild` context |
| Server-reported weights | `Qwen3.8-27B-BANTAM-Q4_K_P.gguf`; reported quantization `Q4_K - Medium` |
| Agent work | 6 turns, 6 model requests, 739 generated tokens; 0 invalid actions |
| Factory build | Released in 16.575 seconds of CLI wall time |
| Inspection and review | `show`, `audit`, HTML report, and actual Git tree diff succeeded |
| Source before apply | All four original source/input files retained their hashes |
| Explicit apply | Succeeded; transaction committed |
| Source after apply | Implementation changed; original tests and package configuration remained byte-identical |
| Verification after apply | 6 provided tests and all 6 independent checker groups passed |
| Final verifier isolation | Recorded `docker:alpine:3`; candidate read-only, network disabled |

The endpoint's model filename and metadata were read immediately after the
run; the weights file itself was not independently hashed. The filename is not
the stock model installed by `bantam setup`. API transport environment variables
were explicitly cleared in this acceptance invocation so that only the
authorized local endpoint could be selected. A separate regression now checks
that explicit factory `--endpoint` selection overrides an inherited hosted API
URL and dialect.

The observed workflow was:

```text
red starter → private build → independent passing inspection → released
            → show/audit/report/diff → explicit apply → passing independent recheck
```

The successful result establishes that this task traveled through those
implemented boundaries. The independent checker exercises a finite domain;
its 2048 cases are not 2048 independent agent runs or a reliability estimate.

## Local evidence locations

These paths identify the review machine's artifacts. They are not installation
requirements, and the scratch artifacts are not bundled with this document.

- Checkout: `/tmp/bantam-finish.5it7sj/bantam`
- Driver: `/tmp/bantam-finish.5it7sj/acceptance/factory-interval-acceptance.mjs`
- Structured record: `/tmp/bantam-finish.5it7sj/acceptance/interval-acceptance-result.json`
- HTML report: `/tmp/bantam-finish.5it7sj/acceptance/interval-factory-report.html`
- Job manifest: `/tmp/bantam-finish.5it7sj/acceptance/interval-factory/jobs/interval-acceptance/manifest.json`
- Independent checker: `/tmp/bantam-finish.5it7sj/acceptance/interval-holdout.mjs`
- Checker SHA-256: `b6c8998f1312300c00b752aaebecdcaafb7d54808528c3e9c9a692a502766a4c`
- Baseline tree: `9d8bd359ba05f90370e1c67e6c35bb18105efeea`
- Candidate tree: `5c45d528dc78945461e3ffac286a85261437a886`

The structured record includes baseline and after-apply hashes, command output,
verifier output, model metrics, the candidate diff, and the unchanged checker
hash. The untouched CSV starter was separately reconstructed from the first
recorded source/test observations; its provenance is at
`/tmp/bantam-finish.5it7sj/acceptance/csv-starter-provenance.json`.

## CSV acceptance

The first repair rerun used the exact reconstructed starter, the same local
endpoint, `rebuild`, autonomous mode, a 40-turn limit, and `npm test` as the
visible verifier. Its final visible suite passed 24/24, but the unchanged
independent checker passed only 20/22. It exhausted the action budget without
an accepted `done`. This is not completed independent acceptance.

Both hidden failures involved trailing empty fields at EOF. All 55 recorded
request hashes verified; every nonempty requirement line remained present
from model call 2 onward. Specification eviction did not explain the miss.
The run also introduced a test contradicting valid quoted-field EOF, and
diagnostic feedback gave that self-authored assertion undue authority.

Two read-only generic audits (full history and current artifacts only) missed
the defect and alleged other violations that executable checks disproved.
A focused state-invariant audit then proposed a condition that passed 22/22
independent checks **in memory** inside read-only Docker. The 20/22 candidate
remained byte-identical. This is a diagnostic result, not a fresh autonomous
repair or proof that shortening context alone solves the problem.

- Original film: `/tmp/bantam-finish.5it7sj/acceptance/csv-run.json`
- Original verdict: `/tmp/bantam-finish.5it7sj/acceptance/csv-acceptance.json`
- Original hidden checks: `/tmp/bantam-finish.5it7sj/acceptance/csv-holdout.tap`
- Generic audits: `/tmp/bantam-finish.5it7sj/acceptance/context-audit-probe.json`
- Focused proposal: `/tmp/bantam-finish.5it7sj/acceptance/state-audit-focused-role.json`
- In-memory confirmation: `/tmp/bantam-finish.5it7sj/acceptance/state-audit-confirmation.json`

The bounded integration trial did not pass acceptance. The `csv-final` trial began with
only the four exact starter files, not a completed solution or hidden checks.
Initial runner: `/tmp/bantam-finish.5it7sj/acceptance/run-csv-final.mjs`.
It retained the original task and endpoint, used `rebuild`, autonomous mode,
a 60-turn budget and `npm test`. The user interrupted it after 24 recorded
turns; its outcome must not be described as an uninterrupted blind trial.

The continuation reconstructed the recorded checkpoint in a separate workspace.
One live edit after that checkpoint was not replayed into the continuation;
the interrupted action still consumed one budget slot. The remaining allowance
was 35 new turns: 24 recorded turns plus one interrupted slot plus 35 new turns
retained the original 60-turn limit. A factual recovery note explained the
interruption and identifies `test/boundary.test.js` as model-authored during
this run, because the older saved film did not preserve that provenance.
The note supplies no hidden-check answers or implementation solution.
The unchanged external checker ran after the agent exited. Final results were
**15/19 visible checks and 21/22 independent checks**, CLI exit 1, with no
accepted `done` before the overall 60-turn budget ended. The continuation used
35 new actions and 54 new model requests, generating 62669 tokens, including
50881 thinking tokens; CLI wall time was 1133.124 seconds. These are continuation
costs, not totals for the original interrupted portion plus continuation.
This failed acceptance is preserved, not replaced by the later diagnosis.

- Continuation record: `/tmp/bantam-finish.5it7sj/acceptance/csv-final-resumed-acceptance.json`
- Continuation film: `/tmp/bantam-finish.5it7sj/acceptance/csv-final-resumed-run.json`
- Visible results: `/tmp/bantam-finish.5it7sj/acceptance/csv-final-resumed-visible.tap`
- Independent results: `/tmp/bantam-finish.5it7sj/acceptance/csv-final-resumed-holdout.tap`

This continuation loaded its implementation before the latest saved-context-
basis fix. Its result therefore cannot serve as end-to-end acceptance of that
fix. New saved runs now preserve original supplied test authorship and original
requirement document bytes through artifact serialization and resumed execution,
including relocation to a different workspace. Legacy films missing this basis
remain explicitly unknown: the current model-edited tests and documents are not
recaptured as original authority. Stubbed integration tests establish these
context-isolation properties; they do not establish an improved live task
success rate.

The trial also enables the integrated bounded state-contract audit where
the task supplies an explicit stateful contract. Automatic eligibility requires
both a stateful/parser/streaming task and documented lifecycle or chunk
boundaries. At most two audit calls are allowed per run, each bounded by
45 seconds and 2400 generated tokens. Its reports are unverified hypotheses,
not executable actions, passing tests, or completion evidence. Source-generation
receipts identify what the audit actually inspected. Raw model requests confirm
that both audit calls ran before interruption; further calls are disabled for
the continuation rather than resetting the cap. This is intentionally a narrow
safeguard, not a general correctness guarantee.

The trial's 60-turn budget and factual recovery context differ from the earlier
40-turn run. This is an interrupted integration acceptance check, not a
controlled A/B comparison isolating the audit's effect or proving a general
improvement in autonomous task success.

### Final-source diagnostic continuation

One further diagnostic continuation under the corrected harness passed:
**19/19 visible checks and 22/22 independent checks**, with accepted `done`,
`pass: true`, and CLI exit 0. It used 7 of its 12 additional action slots,
9 new model calls, and 4182 generated tokens. CLI wall time was 103.807 seconds;
recorded agent time was 102.491 seconds.

Its missing original context basis was reconstructed from validated starter
facts; a factual recovery note addressed stale test-authorship labels without
giving hidden-check content, expected outputs, or an implementation solution.
Original requirements, package configuration, and the supplied test file retained
their hashes. The visible suite comprised four unchanged supplied tests and
fifteen model-authored tests; the model corrected three of its own tests during
this continuation. A model-written summary calling sixteen tests pre-existing
is not used as provenance evidence.

Final implementation SHA-256:
`6cacb0806857942260c7ac978510461e740663757dafe9ca724eb6f85b26d8bf`.

- Diagnostic acceptance: `/tmp/bantam-finish.5it7sj/acceptance/csv-context-basis-acceptance.json`
- Diagnostic film: `/tmp/bantam-finish.5it7sj/acceptance/csv-context-basis-run.json`
- Invocation: `/tmp/bantam-finish.5it7sj/acceptance/csv-context-basis-invocation.json`
- Visible results: `/tmp/bantam-finish.5it7sj/acceptance/csv-context-basis-visible.tap`
- Independent results: `/tmp/bantam-finish.5it7sj/acceptance/csv-context-basis-holdout.tap`

This allowance was beyond the original 60-turn budget. The success is a
reviewer-assisted diagnostic continuation, not a fresh benchmark, replacement
for the failed bounded trial, or causal proof of improved autonomous reliability.
It establishes a passing final candidate under the documented recovery context.

Raw evidence is retained locally in the installation's
`.bantam/acceptance/2026-09-05` archive. That directory is ignored by Git and
excluded from the commit/upload; this document records the findings without
publishing the raw model transcripts.

## Final suite

The final-source integration checkout ran the repository suite, including
the audit-resume cap, artifact-persistence, and saved-context-basis regressions:
**3268 passed, 0 failed, 4 skipped; 3272 total**, in 99.545 seconds.
The skipped checks remain skipped, not certified passes. Saved checkpoints
were also checked for preservation of the typed records. The root integration
record supplies the final commit/source basis; the local CSV outcomes are
tracked separately above.

The separate live Docker confinement/lifecycle acceptance passed 41/41 with
zero skips in 31.295 seconds.
It remains distinct from the general unit suite.
