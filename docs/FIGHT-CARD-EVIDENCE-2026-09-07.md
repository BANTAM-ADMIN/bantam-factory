# Fight-card evidence and completion receipts — September 7, 2026

This is an engineering record, not a replacement for the historical scores.
The local date was September 6 (America/Denver) when this work began.

## What the fresh Tiel confirmation actually showed

The operator explicitly handed the GPU back. The recorded Tiel server was
restarted at `2026-09-07T00:17:57.094Z`, using the same model digest and
72,000-requested / 72,192-allocated context, one slot, MTP1 configuration.
The original 27B comparison was not rerun or relabeled.

Local evidence: `.bantam/acceptance/2026-09-06/tiel-qualification/factory-c72000-s1-mtp1-confirmation1/`.

| Card | Recorded outcome | Public tests | Independent groups | Contender seconds |
|---|---|---:|---:|---:|
| Receipt reducer | PASS | 31/31 | 5/5 | 125.523 |
| Snapshot drift | OUTPUT_ONLY | 25/25 | 5/5 | 328.896 |
| Job planner | OUTPUT_ONLY | 4/4 | 5/5 | 234.556 |

That is **3/3 accepted artifacts but 1/3 accepted completions**. All 194 model
calls were measured: 4,819,734 input, 3,420,510 cached input, 1,399,224 fresh
input and 67,845 output tokens. Contender time was 688.975 seconds; grading
added 3.942 seconds. Input includes repeated cached prefixes; it is not fresh
prefill compute. No task, independent judge or candidate was operator-repaired.

Snapshot's final direct focused test really executed and passed. Its turn also
carried project verification, but a single last-proof field could not retain
both executions. Separately, budget guidance told the worker to emit done
while the audit gate still required focused evidence. Planner's compound
assertion/status-echo/project-check/status-echo command did **not** provide a
valid focused receipt. Printed success was not grounds to accept it.

The repair preserves actual executions in a controller-owned, turn-bound
ordered envelope. A focused check followed by a fresh project check can now
qualify on one turn. An earlier cached project result is not relabeled as a
new execution. The envelope survives artifact serialization and crash
checkpoints. Existing aliases remain for older readers; contradictory aliases
fail closed. Changed generations, reversed order, zero-match Node tests,
wrong cwd, status masks and pre-audit checks cannot acquire credit.

The real Docker resume regression also exposed an older timestamp-only
authorship check: a resumed run could call its own previously written output
"untouched." The bounded repair uses the existing datalog's successful typed
edit outcome and the same turn's workspace fingerprint. Only an existing,
nonempty regular file whose bytes, size and mode still match receives credit
despite its old timestamp. A later read, model claim, failed edit, changed file
or missing fingerprint does not suffice. This establishes authorship, not
correctness; the verification gates still apply.

Budget guidance is selected after the current audit. When focused evidence
is missing, the next instruction names that direct execution, not done.
The executor's headline follows typed verification status. The existing
bounded correction for a direct test followed by a passive exit-code echo
also handles a trailing `2>&1`; it executes only the direct check and records
the correction. It does not reinterpret arbitrary compound shell programs.

These are generic controller/context repairs. Historical OUTPUT_ONLY results
stay OUTPUT_ONLY. Regression tests prove the specific machinery; a fresh
live series is needed to measure its effect on the worker.

## Repair9: another contradictory instruction found, not hidden

The first fresh card finished as OUTPUT_ONLY: Receipt Reducer passed all five
independent groups, but exhausted 60 actions without accepted completion in
389.558 seconds. All 78 calls were measured: 1,743,047 input, 1,262,852 cached,
480,195 fresh and 55,804 output tokens. Source and kit seals remained intact.
The series was stopped at the normal boundary after that finished card; the
other two planned cards are **not recorded**, not failures or passes.

Evidence: `factory-c72000-s1-mtp1-repair9/` under the same local provenance root.

The actual focused assertion was accepted. The remaining obligation was the
exact configured `npm test`, but the worker kept substituting `node --test`.
The public task still named `npm test`; it was not absent from context. The
local recovery instruction failed to name it, unnecessarily repeated the old
audit, and conflicted with repetition guidance that suggested done and masked
the shell action needed for recovery. The model also treated a previous
project pass as sufficient regardless of its order. Later unnecessary test
edits advanced the generation and invalidated earlier focused evidence.

The next repair makes the mandatory project check a controller-owned follow-up
to a freshly accepted focused assertion, rather than another model choice.
It runs after audit/restore decisions with the exact configured command,
timeout, sandbox and read-only policy. A prior cached project pass cannot
stand in for this execution. Automatic attempts are bounded to one per audit
identity, generation and configured command, including across recorded resume;
manual recovery remains available. Failed or inconclusive verification stays
failed or inconclusive. There is no automatic done and no extra model call.

Phase-specific recovery now names the accepted focused turn and exact remaining
command without repeating the old review. Pending audit recovery also takes
precedence over a duplicate command's generic done suggestion/shell mask.
An actual-process regression demonstrates focused inline assertion, automatic
project verification and accepted done in four model actions; another retains
a failed project result and checks the bounded retry. These narrow regressions
are not a claim that the next live worker run will succeed.

## Repair10: project follow-up exercised; a missing tool interface exposed

The next complete series retained all three cards, unchanged tasks and judges:

| Card | Recorded outcome | Accepted artifact | Accepted completion | Independent groups | Contender seconds |
|---|---|---|---|---:|---:|
| Receipt reducer | PASS | Yes | Yes | 5/5 | 135.709 |
| Snapshot drift | FAIL | No | No | 5/5 | 208.507 |
| Job planner | OUTPUT_ONLY | Yes | No | 5/5 | 224.172 |

Evidence: `factory-c72000-s1-mtp1-repair10/` under the same local provenance
root. This is **2/3 accepted artifacts and 1/3 accepted completions**, not 3/3
passes. Snapshot's failing public suite prevents artifact acceptance even
though its implementation passed the independent groups. Contender time was
568.388 seconds; grading added 4.154 seconds. There was no protected-file
tampering. These adaptive runs do not establish a reliability rate.

All 185 generation calls have complete input/output/cache/fresh accounting;
read-only rederivation from the sealed response bodies independently agrees:

| Card | Calls | Input | Cached | Fresh | Output |
|---|---:|---:|---:|---:|---:|
| Receipt reducer | 55/55 | 1,047,731 | 887,732 | 159,999 | 16,594 |
| Snapshot drift | 56/56 | 1,311,656 | 847,033 | 464,623 | 19,872 |
| Job planner | 74/74 | 1,513,748 | 1,258,249 | 255,499 | 29,375 |
| Total | 185/185 | 3,873,135 | 2,993,014 | 880,121 | 65,841 |

Receipt exercised the repaired automatic project follow-up three times, with
real ordered focused/project executions. A later source cleanup invalidated
earlier proof; the gate correctly required fresh verification before accepting
done. This is evidence that the repaired branch operated in a live run, not a
controlled causal comparison or a general capability claim.

Snapshot authored two incorrect extra tests: an unchanged existing file was
expected to be missing, and its import check accidentally put literal double
quotes inside the module specifier. The failed repair then exposed a distinct
controller bug. The grammar enabled `edit_lines`, but **the actual subsequent
model prompts contained none of its syntax**. The raw saved observations did
contain the instructions. A long task reanchor preceded them in a guidance
block; observation clipping discarded the late action schema. Current source
and counterevidence were still present, so this was not wholesale loss of the
test file or evidence, nor proof that every worker mistake was harness-caused.

The closeout fix delivers the canonical, currently enabled `edit_lines` schema
through the existing bounded, recorded context-update channel, before source
snapshots consume its slots. The record names its turn, generation and actual
available actions, survives observation clipping, and cannot grant permission
to change protected files. It no longer asks for `read_file` when that action
is masked. A long-task regression checks the actual delivered prompt, performs
a real line edit, passes public verification and reaches accepted done without
changing protected tests. The previous benchmark remains FAIL. At commit
`b793cf7`, this schema-delivery fix had regression coverage but no fresh
live-model attempt. The subsequent Snapshot-only repair11 is recorded below.

Planner's authored `test/edge.test.js` contained 15 cases and eventually passed
within the 19-case project suite. The worker never launched that file as a
direct focused check. Its repeated broad suite runs and printed probes did
not satisfy the focused-execution requirement. That completion limitation is
still open. Automatically selecting and executing newly authored tests is a
possible subsequent change, not implemented or claimed fixed in this batch.

## Repair11: fresh Snapshot replay finishes, but regresses existing ordering

After the operator released the GPU again, one fresh **Snapshot-only** attempt
ran against committed `b793cf74362e6e7f24ad0a773fc2122177165c78`. This is not a
new three-card cohort. Evidence: `factory-c72000-s1-mtp1-repair11/` under the
same local provenance root. No candidate repairs or extra actions were given.

**Result: FAIL.** The worker reached accepted done in 56 actions and passed
all 3 public tests, but passed only 4/5 independent groups. The failed group
was `builder-bytes-order-and-empty`: returned manifest entries were in input
order rather than JavaScript string order. Contender time was **347.877s**;
grading added **1.409s**. Accepted completion is not artifact correctness.

At zero-based turn 11, a successful replacement changed the existing
`[...paths].sort().map(...)` into `paths.map(...)`. The original task explicitly
required sorted builder entries and preservation of that existing behavior;
the ordering requirement remained in the delivered prompt. The worker's
preceding reasoning had even correctly recognized that copying and sorting
preserved the caller's input. This is not another missing-schema incident.
The supplied builder test has one path, which cannot distinguish sorted from
unsorted output; the independent multi-path fixture caught the regression.

The new dynamic action-interface branch **did not engage**: there were no
`edit_lines` actions or context-update records. This attempt therefore neither
demonstrates nor disproves the effectiveness of that particular recovery fix.
The earlier automatic focused-assertion/project-check mechanism did execute
once before accepted completion. Its real passing receipts establish execution
of those checks, not coverage of the missed ordering requirement.

All **85/85** generation calls have complete wire accounting, independently
rederived from hash-verified bodies and matched to the saved model calls:

| Input | Cached input | Fresh input | Output | Prefix reuse |
|---:|---:|---:|---:|---:|
| 2,182,781 | 1,680,779 | 502,002 | 39,288 | 77.0017% |

The model digest, context, limits, task, 23-file kit and runtime configuration
match repair10; the committed harness version differs. All 410 sealed runtime
files and 23 kit files remained unchanged during the replay. Protected files
were intact, and the endpoint was idle at both measured boundaries. The server
cache was not cleared and sampling was not seeded; this is not a controlled
causal ablation or a reliability estimate. The old failure stays on the card,
and this separate attempt is also shown as FAIL. No further harness change was
made as part of this test.

## Repair12: ordering passes, but the CLI and completion still fail

The next change extends the existing exact-transition edit-preservation review
to a narrowly matched removed intermediate call. A retained function changing
`values.order().map(fn)` to `values.map(fn)` can receive a review even when no
new function is added. The matcher is not specific to sorting or this card;
it requires the remaining statement and downstream arguments to match, bounds
its analysis, and records optional removal of a simple spread-copy wrapper.
Intentional changes remain confirmable; the witness is source evidence, not a
semantic-equivalence or correctness certificate. The saved repair11 deletion
now produces an explicit `sort()` removal witness without modifying its files.

Verification before the next live attempt: 21 module tests passed, 17 host
integration checks passed with one Docker-only skip, and the separately
enabled Docker selection passed 34/34. At the operator's request, the broader
`npm test` process was stopped to prioritize the live Snapshot attempt. **That
interrupted full-suite run is not recorded as a pass.** Runtime source was
then held fixed for the benchmark.

Fresh evidence: `factory-c72000-s1-mtp1-repair12/`, again **Snapshot only**, with
the same task, frozen kit, model and limits. **Result: FAIL, 4/5 independent
groups, 3/3 public tests, no accepted completion after 60 actions.** Contender
time was **434.659s**, plus **1.672s** grading. Protected files and source/kit
seals remained intact. There were no operator candidate repairs.

The builder-ordering group passed, but `cli-create-verify-drift-and-errors`
failed on a valid create command. The candidate passes the entire
`process.argv` to `runCli`, reads `argv[1]` as the command even though it is the
script filename, and puts the command handlers behind `argv.length === 2`.
Thus valid invocations return usage/exit 2 instead of the required JSON/exit 0.
The worker's own probes exposed the valid-invocation failure, but it did not
repair it. Broad public tests do not exercise this CLI, and repeated printed
probes did not establish the focused assertion required for completion.

No chain-removal review fired in this run. The ordering pass therefore cannot
be credited causally to the new review guard. This is another retained failed
attempt, not a 5/5 result or evidence of a reliable complete workflow.

Wire accounting is complete for **79/79** generation calls: **1,728,722 input,
1,028,913 cached input, 699,809 fresh input and 48,964 output tokens**, with
59.5187% prefix reuse. Full wire totals are distinct from supplementary global
endpoint counters. The public Arena and separate private repair12 page retain
this outcome alongside all earlier editions.

## Repair13: prioritize observed behavior over repeated review hypotheses

Repair12's concrete observations were still in the actual delivered context.
The audit-refuting probe and valid CLI failure were roughly 75K and 68K
characters back in the late prompt, while the unverified hypothesis was
repeated much nearer the end. This was evidence prioritization, not wholesale
loss of source or a license to treat printed booleans as passing assertions.

The next generic context repair changes the independent review's order: trace
an ordinary valid call through each required public entrypoint first, then the
existing boundary checks. A required CLI must be traced separately from an
exported API. For Node, the reviewer receives the actual file-launch argument
layout and must follow caller slicing and dispatch guards. Validation helpers
and statement order must be traced before alleging missing or late checks.

Recovery now leads with a compact instruction to turn the current diagnostic
into an assertion. An observed task-valid failure takes priority over a model
review hypothesis. For a Node CLI, use a real child-process entry-file launch
and assert the contract-derived status/output; importing the API or simulating
arguments in `node -e` does not test that route. The old hypothesis comes last
as a shorter, explicitly falsifiable excerpt. Working code must not be changed
merely to satisfy an unsupported review.

The recorded run's essential instruction was 421 characters with `npm test`
configured. A
regression with the actual repetition-prefix clipping path and a 16K trailing
working note proves that priority, real-child assertions, missing phases and
the exact project command survive. This does not enlarge observation budgets
or alter frozen cache prefixes. Receipt recognition, source-generation binding,
completion gates, the disabled assertion-station default, task, judges and
60-action limit are unchanged.

Before the fresh attempt, the targeted selection passed **123/123**, including
enabled real-Docker checks. After the final compact-prefix change, the affected
recovery/delivery/agent selection passed **56/56**, again with Docker enabled.
These overlap and are not summed. The integration regression demonstrates
API-green with a genuinely broken CLI, failed actual child assertion, repaired
argument forwarding, fresh focused/project receipts, and accepted completion.
It does not use the benchmark candidate or independent judge as its fixture.

Fresh evidence: `factory-c72000-s1-mtp1-repair13/`, **Snapshot only**. The result
is **PASS: 5/5 independent groups, 3/3 public tests, accepted completion in 51
actions**. Contender time was **223.576s**, with **1.369s** of independent
grading (224.945s combined). The CLI group passed. All 410 runtime and 23 kit
seals remained unchanged, protected files were intact, and there were zero
operator candidate interventions. The task, model and runtime recipe remained
the same as repair12, apart from the recorded harness source revision.

All **69/69** generation calls have complete accounting:

| Input | Cached input | Fresh input | Output | Prefix reuse |
|---:|---:|---:|---:|---:|
| 1,642,238 | 1,194,946 | 447,292 | 21,567 | 72.7633% |

The compact recovery instruction reached actual worker prompts. The worker
authored executable API/CLI assertions, but still spent extra turns wrapping
them in compound setup/launch commands and mistaking their printed success
for the required focused receipt. Those attempts did not acquire credit.
Eventually it requested the focused script directly with a passive status
echo. The existing status guard removed only that suffix, executed the real
direct check, and the controller followed it with fresh configured project
verification. The subsequent done was accepted. This is a real successful
recovery, not retroactive acceptance of earlier unverified probes.

The independent auditor still produced unsupported hypotheses in this run;
the worker's probes refuted them. Review calibration and wasted recovery turns
remain improvement opportunities. One adaptive successful rerun does not prove
a causal speedup, a reliability rate, or qualification of the other two cards.
Earlier failures remain visible alongside this separately identified PASS.

Post-run wording clarification: the recovery example explicitly labels
`process.execPath` as a **Node** CLI launch, not a launcher for every language;
other CLIs must use their actual runtime. The live result retains its original
sealed prompt bytes. This small subsequent wording change is regression-tested,
not represented as another model run.

Final targeted closeout passed **128/128**, with no skips, including real Docker
execution, edit-preservation, audit delivery/recovery, verification environment
and the optional assertion-station regressions. This is not a rerun of the full
repository suite; the earlier full-suite result belongs to `b793cf7` below.

## Hermes: show measured values without inventing a missing total

The original Hermes records requested streaming usage already. In each of
the three cards, a downstream disconnect canceled one response before its
terminal usage was recorded. The missing receipt card request was post-task
skill-library work, not another task-solving turn. Native task accounting,
whole-harness wire accounting and endpoint windows cover different scopes.

Read-only rederivation from hashed response bodies gives these exact subsets:

| Hermes card | Measured / sent calls | Input | Cached | Fresh | Output |
|---|---:|---:|---:|---:|---:|
| Receipt reducer | 16/17 | 305,497 | 264,561 | 40,936 | 27,443 |
| Snapshot drift | 14/15 | 272,440 | 246,351 | 26,089 | 38,653 |
| Job planner | 13/14 | 247,592 | 222,608 | 24,984 | 36,537 |

These are **measured subsets, not whole-run totals**. They must never become
zero-filled totals, fabricated token estimates from stream chunk counts, or
values inferred from llama.cpp slot state. The original receipt card's main
task session has complete 15-call native accounting, but substituting it for
all 17 harness calls would omit auxiliary cost.

The proxy now settles every admitted request before final aggregation and
records why an exchange ended. Cancellation still cancels generation; it
does not silently continue inference beyond the contender cutoff to obtain
a nicer accounting row. Per-field measured totals and request coverage are
available independently, including terminal usage received before a transport
disconnect. Full transport-complete totals remain distinct.

`scripts/fight-usage-report.mjs` rederives historical wire usage read-only,
verifies body hashes and request/response bindings, and reports missing fields
and request indices. It never overwrites original evidence. Hash consistency
detects changed bytes; it is not independent authentication of a foreign log.

## Presentation and sharing boundary

The new showcase is a derivative of recorded runs, not a new judge. Original
comparisons and Tiel editions have separate identities and scoreboards.
Artifact acceptance, accepted completion, wall clock, all token fields and
accounting coverage must remain separately visible. Failures stay visible.

A private full-evidence page can include source, prompts, paths and execution
logs. A public summary must use an explicit numeric/public-task allowlist,
omit those private bytes and label the omission. A redacted summary is not
the full auditable chain. Generating a page does not publish it or change the
repository's private visibility.

## Earlier committed closeout verification (`b793cf7`)

That committed source tree passed `npm test`: **3,794 passed, zero failed, 41
explicitly skipped** (3,835 tests across 298 suites). The separately enabled
real-Docker collection-audit, verification-environment and assertion-station
checks passed **16/16**. Showcase tests, including explicit Chromium desktop
and true 390px mobile emulation, passed **12/12**. These overlapping test
selections are reported separately, not added into a fabricated unique total.

The final generated public/private pages were also opened at desktop and
mobile widths. Their four packaged HTML/JSON hashes matched; all 474 embedded
private evidence artifacts matched their recorded size and digest. The public
summary has no raw prompt/source payloads or links to private evidence pages.
These checks establish implementation and packaging behavior, not a new model
score. At that commit the final context-delivery fix had not been followed by
a live attempt. Repair11 above subsequently tested Snapshot, without engaging
the dynamic-schema branch; the Planner completion limitation remains open.
