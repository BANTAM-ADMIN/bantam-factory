# Stream task: timeout diagnosis and context work order

Original candidate evidence:
`.bantam/benchmarks/factory-davidau-20260907-candidate/repeat-1/stream-framer/bantam-local-27b`.

The run timed out at 600.017 seconds. The final candidate's `push` loop finds
LF, decrements its index to exclude a preceding CR from line content, then
uses that adjusted index plus one as the next cursor. On a subsequent iteration
the same LF is found and the cursor does not advance. A read-only reproduction
against the actual saved module, using a valid CRLF stream and synchronous
before/after markers, was externally killed at 1.5 seconds. Only the before-push
marker appeared. The finalizer never ran.

The saved trajectory shows a mistaken guess that finalization was hanging,
followed by an edit to `finish` and another long configured test. A later masked
timeout command was correctly denied passing-proof status. Direct `node --test`
eventually returned a per-file timeout, but pointing at line 1 of a timed-out
test file did not identify the hanging API call. Process cleanup completed;
no candidate public-test process remained after the original lane finished.

## Bounded changes

- A public-task-routed stream work order reaches the initial cached worker
  context and source auditor. It separates decoding, framing, and protocol
  state; requires reasoning about loop progress; describes all-two-part-split
  assertions against independently expected output and rejection-path state
  checks. This is guidance, not automatic coverage enforcement.
- Verification timeout observations now ask for a separate bounded diagnostic
  against the actual API, using synchronous before/after call markers and an
  external deadline. They explicitly reject guessing that a later finalizer ran
  or relying on an in-process timer to interrupt synchronous code.
- Audit instructions describe JSON-encoded throw/return observations so an
  exception prediction is not discarded merely because it used bare `throws`
  where JSON was required. Existing admission validation remains unchanged.

No task, protected public test, hidden grader, or acceptance gate was changed.
No corrected implementation was supplied to the contender. These changes do
not yet implement automatic per-requirement coverage receipts, automatic timeout
localization, or a new hard gate. Their effect must be measured, not assumed.

## Verification

Targeted tests: 36 passed, zero failed. Includes worker/auditor delivery,
unrelated-task nonactivation, timeout receipt remaining unverified, and a real
externally killed nonadvancing-cursor child proving the marker technique.
First guidance-only full suite: 4054 passed, zero failed, 75 skipped.
The fresh DavidAU run finished in 143.233 seconds but scored only 1/5, despite
accepted completion. Usage: 412271 input, 9040 output, 378720 cached input,
33551 fresh input; all 28 requests measured. This is not an improvement in
accepted quality and does not replace the original timeout.

## Context reread and obligation station

Evidence: `.bantam/benchmarks/factory-davidau-20260907-stream-context1`.
The requirements and stream guidance were present throughout all 19 turns.
At turn 5 the worker placed `stream:true` on the TextDecoder constructor, not
decode. At turn 7 it abandoned strict decoding and replayed a mistaken diagnosis.
At turn 8 a source audit invented a CLI file-argument defect; turns 9–18 dealt
with CLI checks and their own execSync misuse. No partition or poisoned-state
regression was authored. A lexical reminder also generalized “not canonical
serializers” from a task that said data was **not** trimmed and explicitly
required canonical base64. The final check suite did not substantiate the
worker's claims of strict decoding and terminal-state validation.

The follow-up implements a narrowly routed synchronous byte-stream obligation
station, not a universal semantic coverage system. It recognizes an explicit
public push(Uint8Array)/finish contract with strict UTF-8 and poisoning rules.
It separately measures chunk partitions (including leading BOM when specified),
strict decoding, terminal state, rejection state, and—when the declared CLI
shape is supported—canonical base64 pad bits. Unsupported tasks do not acquire
these obligations. Additional protocol requirements remain outside this jig.

The model proposes one short valid stream, expected frames and a forbidden
post-terminal suffix from the public task and source path list, without seeing
candidate implementation or hidden tests. Fixed controller code supplies the
partitions, negative byte/type cases and subprocess checks. Each case first
requires a positive control. The existing offline probe system copies pinned
inputs and emits command/output/source-bound receipts; its Datalog projection
determines pass/fail/unavailable. A child timeout or missing completion packet
is unavailable, not PASS. Stale generations and unrelated CLI/project success
cannot clear the station. The fixture data can be reused, never its execution.

The expectation remains model-designed, not an oracle. Fixtures and outcomes
are retained for inspection. This initial adapter does not establish complete
coverage, independent oracle certification, or support arbitrary API shapes.
A disputed fixture must not be silently treated as a requirement to change the
implementation. More general reviewed-fixture correction remains future work.

Before model rerunning, the fixed jigs were executed against the preserved
143-second candidate with a small independently authored public-contract fixture.
All five obligations failed while source remained unchanged. The same machinery
passes an independent correct toy protocol and rejects deliberate mutations for
each dimension. This was operator diagnostic qualification, not a scored model
attempt and not a hidden-grader-derived fixture.

The lexical reminder now honors negated trimming and preserves canonical rules
on other fields. Source auditing has a stateful-stream focus, and the work order
gives the concrete streaming decode call signature.

### Fixture admission correction

The first station-backed model attempt (`stream-obligations1`) generated an
incomplete positive fixture: no required termination marker. Its negative suffix
also lacked a terminating newline. The operator interrupted the contender with
SIGINT after identifying this. Archival grading returned 4/5 at 138.602 seconds,
without accepted completion. This interrupted attempt is **not eligible for
performance comparison**; `operator-annotation.json` records the intervention
that the runner's automatic operatorInterventions=0 field cannot observe.

The station now requires newline-complete fixture fields, rejects omission of
an explicitly quoted public termination marker, and obtains a separate clean
contract-only fixture review before executing candidate code. Rejected fixtures
can be revised once, with the rejection in the user-role proposal context.
Both proposal and review are retained. This second model judgment is a fallible
check, not oracle certification. Disagreement on a positive control produces
unavailable evidence, not five attributed implementation failures.

A separate serialization omission was found and corrected: stream receipts now
survive final artifacts as well as checkpoints and observation events. A saved
checkpoint retains the initial interrupted run's complete station receipts.
The live integration test checks both archive paths.

### Mechanical fixture adapter

The reviewed-fixture attempt (`stream-obligations2`) correctly rejected its
incomplete fixtures but repeatedly failed to construct an admitted one. It was
also operator-interrupted and excluded from comparisons; its annotation is
stored alongside the unchanged runner result. No success claim comes from it.

For the explicitly recognized line protocol, fixture framing is now mechanical.
The adapter matches public clauses for LF/CRLF, data joining, default event name,
colon splitting, leading-space handling, comments and terminal-state rules. It
extracts the literal termination marker and exported factory from the public
task, and requires one unambiguous task-named source module. It constructs a
short multibyte data frame followed by that marker, the expected emitted frame,
and a complete forbidden comment line. The adapter reads no candidate source
contents and no hidden tests. Its matched clauses and task digest are archived.

This is a protocol-specific fixture builder, not a universal contract compiler
or an implementation supplied to the worker. Unmatched protocols do not use
this adapter. Tests change the marker and remove individual protocol clauses
to check that the fixture follows the task and that unsupported contracts are
not silently assigned this protocol. The recognized adapter needs no model
calls for fixture construction or review; its execution receipts still require
the existing isolated probe checks on current source.

The adapter reproduced the original control's two gaps: chunk partitions and
rejection poisoning failed; strict decoding, terminal state and canonical CLI
checks passed. Against the later 143-second candidate, all five dimensions
failed. These were read-only diagnostic replays, not new model scores.

`stream-obligations3` demonstrated an additional delivery defect: the jigs
caught a BOM-prefixed partition failure but sent only the output mismatch,
omitting the BOM transformation and split position from the compact work order.
The worker repeatedly probed the unprefixed fixture and obtained green results.
This attempt was interrupted and annotated, not counted as a completed model
comparison. Failure outcomes now carry the exact partition label, BOM state,
and chunk hex strings; rejection and CLI cases also identify the triggering
operation/input. A regression verifies that a BOM-only defect names the BOM,
split zero, and `efbbbf` bytes in the actual emitted outcome.

### CLI reproduction evidence and prompt admission

`stream-obligations4` timed out at 600 seconds and independently scored 3/5;
it is not a successful completion. During repair, four station dimensions
passed, while the CLI rejected canonical input. The CLI positive check still
reported the preceding API fixture label and an exit-code mismatch, without
the actual two-chunk JSON or process stderr. Worker diagnostics instead used
a different, single-chunk representation and repeatedly examined pad bits.

The CLI jig now records its command, exact JSON input, expected result, actual
exit status, signal/error, stdout, and stderr for both positive and negative
cases. Process output is bounded with explicit truncation flags. Repair context
prioritizes that evidence; redundant fixture details are omitted when needed.
The entire work order remains within the prompt validator's 2,400-character
limit, avoiding silent rejection of oversized workflow messages. Full outcomes
remain in the raw probe receipts.

Regression tests execute both a valid-input-rejecting CLI and a CLI accepting
noncanonical pad bits, then check that reproduction evidence survives the real
workflow prompt formatter, including when all other obligations also fail.
Validation: 12 focused tests passed; the Docker completion-gating integration
test passed. The full repository suite passed 4,063 tests, with zero failures
and 76 skipped.

### Latest independent result: not launch-qualified

`stream-obligations5` completed in 202.206 seconds with an accepted completion
receipt, but independently scored **4/5**, not a pass. UTF-8/chunk boundaries,
termination/finalization, invalid-input poisoning, and canonical CLI checks
passed. Field parsing failed: an embedded carriage return was treated as a
delimiter, losing the remainder of that data value. All five station checks
passed, demonstrating that their current fixture coverage does not certify
all field-parsing rules. The accepted receipt is not independent correctness.

All 30 model requests have complete accounting: 436,442 input tokens, 8,966
output tokens, 397,299 cached input tokens, and 39,143 fresh input tokens
(91.03% prefix reuse). No operator intervention occurred in the candidate.
The repository test suite ran concurrently on the host during part of this
attempt; do not use its wall time as a controlled performance comparison.
Source and kit seal mismatch lists are empty.

These fixes are regression-tested development progress, not qualification of
the DavidAU stack or a clean launch showcase. The outstanding requirement is
to preserve non-delimiter carriage returns as public-contract data and verify
that behavior independently; the existing public-contract jigs miss it.

### CR framing coverage repair

The archived worker prompts retained "Other CR characters remain data" in
all 18 turns. The first rewrite nevertheless scanned for either CR or LF.
Neither its added tests nor the original single-data-line jig distinguished
that implementation from LF-only framing. This was a missed contract witness,
not evidence of context-window truncation.

The public-clause adapter now enables additional witnesses only when the task
explicitly states embedded-CR preservation, stripping one CR before LF,
blank-line dispatch, and per-push frame delivery. The witnesses check embedded
CR within a value, embedded CR at a chunk edge, and CRLF split across pushes
between multiple data fields and at dispatch. Each push is checked against its
own expected frames, rather than comparing only the final aggregate. Failures
include the actual chunk schedule, failing push index, and expected outputs.
The initial task guidance explains LF-only scanning for this explicit rule.

Regression mutations cover CR truncation, bare-CR splitting, and premature
completion of a pending CR. A separate correct implementation passes. A real
sandboxed replay of the unchanged `stream-obligations5` source now fails the
chunk/framing station with the embedded-CR witness while the other four
dimensions pass. No benchmark answer, public test, or grader was edited.

### Verified follow-up: 5/5

`stream-obligations6` independently **passed all five grading groups** in
169.707 seconds, with an accepted completion receipt and zero operator
interventions. Source and kit seals remained unchanged throughout the run.
This includes the previously failing field-parsing/embedded-CR group.

Usage is complete for all 21 requests: 243,478 input tokens, 9,838 output
tokens, 221,269 cached input tokens, and 22,209 fresh input tokens (90.88%
prefix reuse). The full test suite finished before this model run started.
Validation of the harness: 4,064 repository tests passed, zero failed, 76
skipped; 13 focused tests and the live Docker integration test passed.

This is one successful adaptive rerun, not a reliability estimate or proof
that every task/model is launch-qualified. Earlier failed attempts remain
recorded. No additional qualification run was started after this result.
