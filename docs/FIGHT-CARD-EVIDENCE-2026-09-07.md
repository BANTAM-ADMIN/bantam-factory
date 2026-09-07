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
changing protected tests. The previous benchmark remains FAIL; **this final
schema-delivery fix has regression coverage, not a fresh live-model cohort**.

Planner's authored `test/edge.test.js` contained 15 cases and eventually passed
within the 19-case project suite. The worker never launched that file as a
direct focused check. Its repeated broad suite runs and printed probes did
not satisfy the focused-execution requirement. That completion limitation is
still open. Automatically selecting and executing newly authored tests is a
possible subsequent change, not implemented or claimed fixed in this batch.

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

## Closeout verification

The final source tree passed `npm test`: **3,794 passed, zero failed, 41
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
score. The final context-delivery fix was not followed by another live cohort;
the Planner completion limitation above remains open.
