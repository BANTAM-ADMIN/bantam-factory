# Context handoff follow-up

This follow-up addresses defects found by reading all prompts and execution
receipts from the 152.362-second, 5/5 Qwen 27B patch-transaction run. It does not
weaken the existing focused-assertion or read-only project completion gates.

## Changes

### Audit containment

Collection reviews now archive the exact raw response, its hash, proposed
findings and free-text note separately from actionable context. The worker view
is regenerated from structurally admitted findings. A rejected finding cannot
survive via its note or an old rendered report. Empty/deferred reviews still
require actual focused and project checks; admission remains a bounded
hypothesis filter, not a semantic correctness oracle.

### Shared execution recognition and cadence

`verification-command.js` owns the existing bounded direct-command identity and
status analysis. Producers, audit recognition, failure reminders and regression
comparison use it. A terminal literal unquoted `2>&1` is recognized without
rewriting raw requested/executed commands. Chains, masks, other redirections,
different test selections and contradictory receipt aliases retain their
existing stricter handling.

Each newly recorded verification execution updates cadence through one helper,
including late CLI-station project checks. Current completed configured checks
reset full-suite freshness; scoped checks do not. A timeout, stale receipt or
cached result cannot masquerade as a new completed configured check. With no
configured verifier, an actual completed runner attempt can reset the narrower
“nothing has run” warning without becoming passing evidence. Trigger messages
retain their pre-execution counts.

This centralizes command identity and cadence updates, not every verification
policy in the factory. Execution ordering, environment, generation, read-only
qualification and completion acceptance remain separately checked.

### Explicit repair handoff

Edit actions accept an optional one-to-four-record `repair` array, using the shared
action definition for parsing, local grammar and strict JSON-schema transports.
It contains an earlier failed execution's output hash, fixture, old worker
expectation, proposed correction, public-contract rationale and next direct
check. Fields are bounded at admission. No extra model call or worker action is
required just to store it.

Only an applied edit linked to an actual earlier failed process in the same
workspace creates the controller-linked handoff. The next worker prompt retains
that explicit proposal without extracting or restoring private reasoning.
Generation changes are marked; a different green command cannot retire it.
A matching current successful process retires the advisory reminder, not the
factory's independent completion obligations.

The fixture and expectation remain worker hypotheses: linking a process receipt
does not establish that the proposed expected value is correct. Raw actions,
typed handoffs, checkpoint state and an EAVT `repair-proposal` attribute preserve
the audit trail. No proposal is recorded as a verdict or passing proof.

## Verification approach

Regressions cover rejected/mixed/empty audit-note containment in actual rendered
prompts; command identity and raw aliases; late CLI project cadence in Docker;
scoped and no-configured-verifier behavior; proposal admission and staleness;
and an actual worker edit/check sequence whose next prompt, artifact and crash
checkpoint all retain the correction. The live comparison uses the same frozen
patch-transaction kit, extension context, 72K Qwen 27B server and independent
five-group acceptance checks. Saved historical attempts are never overwritten.

This is an adaptive development regression, not a held-out evaluation or a
statistical performance claim. Live results are recorded below after execution.

## First follow-up: correct, but slower

`factory-patch-20260907-27b-contextfix2` passed all five independent groups and
produced an accepted completion in **236.273 seconds**, compared with
**152.362 seconds** for `contextfix1`. This was not a speed improvement.

Reading the complete wire prompts and ordered executions showed:

- Production code stopped changing after turn 10 (one-based). The worker then
  spent 125.645 seconds writing and repairing additional tests. Four failures
  were mistaken authored expectations/fixtures, not production defects.
- One reasoning step identified three corrections but applied only one. The
  action interface did not expose atomic patch during that repair sequence.
- The first handoff implementation offered worker-shell receipts, but these
  failures came from controller-run CLI project checks. No live handoff was
  created. The synthetic shell-only regression had not covered that path.
- Six CLI design requests had identical prompts and input digests. Their
  subprocess checks still needed fresh execution; five proposal-generation
  calls did not.
- The audit checkpoint ran before the late CLI project check. Its first review
  therefore waited for a redundant worker-requested project test.
- Prefix cache use improved from 83.03% to 88.84%; the slowdown was not a cache
  collapse. Additional reasoning, actions and station calls increased work.

The initial reasoning prompts were byte-identical across those two runs, but
the model produced different trajectories. With an unfixed sampling seed, the
entire difference cannot be attributed causally to harness changes.

## Second refinement

Repair handoffs now consume the shared validated ordered execution ledger,
including automatic/scoped/landing/completion checks. Up to four bounded
corrections can travel together, with atomic admission and explicit proposal
authority. Matching checks after an edit in the same turn can retire its
advisory reminder. New scripted-agent coverage exercises real automatic
failures and a two-edit atomic repair, not just fabricated shell receipts.

In automatic patch mode, a measured multi-failure configured suite following
an authored test-only edit can expose the existing atomic patch action. A typed
current-turn action description supplies its syntax. Explicit caller exclusions,
transaction atomicity, protected paths and completion gates remain intact.

The CLI station now precedes the due audit checkpoint: a fresh CLI/project pass
can immediately trigger the independent review and expose the remaining focused
obligation. An invocation-owned proposal cache binds literal proposal bytes to
model identity, policy, exact prompt, contract, schema and current input hashes.
It never caches a verdict. Every station still executes fresh isolated checks,
and a fresh failure remains a failure even when the design came from a prior
successful station. Receipts disclose design reuse and its original generation.

The rewrite-thrashing warning is emitted after same-turn controller checks so
a late green result cannot be preceded by a newly issued stale red-suite steer.

### Regression results

- Full suite: 4,118 tests; 4,043 passed, zero failed, 75 skipped
  (`/tmp/bantam-refinement-full-20260907.log`).
- Explicit Docker integration: five passed, zero skipped or failed, including
  immediate CLI/project-to-audit scheduling and fresh completion evidence
  (`/tmp/bantam-refinement-docker-20260907.log`).
- Final focused suite: 27 passed, zero failed, one live-Docker test skipped
  (`/tmp/bantam-refinement-final-targeted-20260907.log`). This includes the
  same-turn automatic-check repair-retirement regression.

These regressions establish the intended mechanics. They do not establish a
27B speed improvement; that requires the separately measured live rerun.

## Second live run and final delivery/recovery refinement

`factory-patch-20260907-27b-contextfix3` passed **5/5 with accepted completion
in 224.309 seconds**. It used 22 actions and 41 fully measured model requests:
595,095 input tokens, 535,987 cached, 59,108 fresh and 13,647 output (90.07%
prefix reuse). Source and kit seals matched, with no operator candidate edits.
This modest improvement over 236.273 seconds still did not beat 152.362 seconds.

The run demonstrated immediate auditing and repeated fresh CLI execution with
reused design bytes. However, inspecting the actual wire prompts exposed two
remaining gaps:

1. The long task restatement clipped the automatic-failure repair offer out of
   ordinary guidance. The patch interface survived its typed context channel,
   but the receipt-linked offer did not. Zero explicit live handoffs resulted.
2. The run reached valid focused/project proof, then made a compound diagnostic
   whose uncertain status revoked that proof. The audit gate requested fresh
   checks, but duplicate-command protection counted the old execution from
   before revocation and blocked the required retry. The model eventually
   escaped by adding a new check file, invalidating the workspace generation,
   and rerunning. That is avoidable controller work, not an inability to code.

The final refinement carries bounded repair advice alongside the typed current
verification decision, outside ordinary output clipping. History accounting
charges its rendered length; templates still scrub role-control tokens. The
current measured failure/obligation follows the advisory proposal, not vice versa.

Audit recovery now records the turn that revoked previously credited checks.
The existing one-execution retry allowance starts after that boundary. It does
not accept uncertain receipts, restore invalid proof, disable repetition
protection generally, or grant extra turns. A real fresh focused/project
execution is still required. Scripted-agent regressions cover a long task and
the sequence ready -> opaque diagnostic -> revoked -> exact fresh retry -> ready.

Final regression verification: 4,119 tests, 4,044 passed, zero failed, 75 skipped
(`/tmp/bantam-delivery-recovery-full-20260907.log`). The explicit integration
run passed all six tests with zero failures/skips
(`/tmp/bantam-delivery-recovery-docker-20260907.log`); the new revocation case
uses actual host processes, while the CLI and existing merged-proof cases use
Docker. These are scripted models exercising real executions, not live 27B
quality measurements.

## Final live result

`factory-patch-20260907-27b-contextfix4` finished **5/5 with accepted completion
in 220.792 seconds**. All 13 project tests passed. All 32 wire requests have
complete measurements: 402,637 input tokens, 343,139 cached, 59,498 fresh,
14,056 output; prefix reuse 85.22%. Source and kit seals matched; no operator
candidate edits occurred. The run used 17 actions, four CLI design model calls
for five fresh station executions, and two independent audits.

| Run | Strict groups / accepted completion | Seconds | Actions | Model calls |
|---|---|---:|---:|---:|
| contextfix1 (earlier baseline) | 5/5 / yes | 152.362 | 15 | 28 |
| contextfix2 | 5/5 / yes | 236.273 | 19 | 42 |
| contextfix3 | 5/5 / yes | 224.309 | 22 | 41 |
| contextfix4 (final refinement) | 5/5 / yes | 220.792 | 17 | 32 |

This is 6.6% faster than contextfix2, but 44.9% slower than the earlier baseline.
It is not a statistically established speed improvement. Different sampled
drafts and repair trajectories remain important confounders.

Actual wire prompts now contain the automatic-receipt repair offer, including
request 00012; it is no longer lost behind the long task restatement. The model
did not emit optional repair records on this trajectory: the later failing
tests exposed a production reconstruction defect, which it repaired. Thus
explicit multi-correction retention remains demonstrated by the scripted
agent regressions, not by a live handoff in this particular run.

The final run did not encounter the prior ready -> revocation deadlock; the
targeted actual-execution regression establishes recovery for that sequence.
One duplicate broad-project command was correctly refused while focused proof
was still absent. The eventual direct edge-test execution was accepted, the
controller ran the fresh read-only project check, and DONE was accepted without
extra workspace changes or completion rejection.

Remaining latency is visible, not hidden: the model regenerated a large test
file after a parser-caught typo and spent several turns on inline custom checks
that did not meet the focused-proof admission shape, before using the existing
direct test launcher. Measured model-call wall time: reasoning 102.033 seconds,
actions 79.282 seconds, CLI design 6.374 seconds, audits 12.249 seconds. These
remaining efficiency opportunities do not justify accepting unmeasured or
unrecognized checks as proof, or claiming this run beat the 152-second baseline.

## Implementation-decision and verification-work-order follow-up

The 220.792-second context exposed a gap between a correct proposed cursor
repair and the next edit: the worker reasoned out the insertion-position update,
read the file, then omitted that update. The existing handoff required an edit
and described test-expectation corrections, so it did not cover that boundary.

The optional `repair` array is now also available on `read_file`, and its offer
explicitly covers concrete implementation decisions as well as test corrections.
An executed read can retain a v3 handoff tied to the earlier failed execution,
current source path/hash and generation. It is stored using the existing
artifact/checkpoint/datalog field and delivered through bounded current context.
No raw reasoning is replayed or promoted into evidence. Changed/unavailable
source is disclosed, failed/refused reads cannot create the handoff, and only
an actual matching current check retires its advisory reminder.

Focused verification now distinguishes execution from admission. A successful
custom inline check can produce an explicit, receipt-linked non-admission reason
instead of another generic demand for focus. Such checks now count toward
recovery guidance even when their process exits zero and produces no verifier
proof. This changes scheduling/context, not acceptance.

The controller can identify one existing authored Node check from bounded current
source: a recognized assertion binding/call plus a literal local import, with
a direct launcher, source hash and generation. This is a launcher hint, not a
claim of coverage or a cached result. Current configured failures take priority.
When no suitable check is found, the instruction asks for one discriminating
fixture/assertion and execution before expanding coverage. Exact fresh focused
and configured project evidence are still required.

Regression coverage includes the long-context failed-check -> read-with-decision
-> edit -> actual check sequence, retained artifacts/checkpoints/datalog,
source changes, refusal/forgery/size limits, source-bound launcher selection,
and a successful custom inline check followed by precise non-admission guidance,
the existing direct test launcher, fresh project execution and accepted DONE.
The initial focused run passed all 74 tests (`/tmp/bantam-handoff5-focused.log`).

### Exact failing assertion follow-up

The handoff5 full suite passed 4,048 tests (75 skipped), and its explicit
integration run passed 10/10. Its live contextfix5 run nevertheless took
339.514 seconds: 5/5 independent groups, accepted completion, 49 measured
requests, 741,173 input tokens, 621,838 cached input tokens and 17,961 output
tokens. This is a correctness result, not evidence of a speed improvement.

The saved prompts contained both public assertions and the failing stack frame.
The worker repeatedly probed the first, passing input instead of the second
assertion's reversed input. Turns 7–13 consumed 97.197 seconds before the
44.081-second repair turn. After that, turns 15–24 consumed 163.108 seconds
authoring/repairing tests and completing verification. The route therefore
cannot be explained simply as slow inference or missing source.

The concrete localization gap: Node's `location` identifies the test declaration;
the parser ignored the separate stack location, and persistent failure context
retained only case names. The parser now preserves the first same-test-file
stack frame separately, without crossing test blocks or lossy clipping seams.
Bounded locations survive execution-receipt serialization. Current-generation
failure context resolves workspace-confined source and highlights the reported
line, with preceding setup, before optional structural hypotheses. It asks for
that exact input rather than a neighboring passing call. This is advisory
execution-linked context, not an assertion that the test is a correct oracle.
No acceptance gates or grading fixtures were relaxed.

Regression coverage uses actual Node output with a passing first assertion and
a failing second assertion, receipt round-trip, stale generations, clipping,
foreign stack files, path boundaries and source-size limits.

Validation: the targeted suite passed 21/21. The full suite passed 4,051 tests,
zero failed, 75 skipped (`/tmp/bantam-assert-site-full.log`).

Live rerun: `.bantam/benchmarks/factory-patch-20260907-27b-contextfix6` passed
all 5 independent groups with an accepted completion receipt in 75.559 seconds.
Same frozen kit, card, model/server and verification settings; zero operator
interventions, no runtime-source or kit mismatches. Nine action turns and 18
measured requests; 133,303 input tokens, 97,975 cached input tokens, 35,328 fresh
input tokens and 3,854 output tokens. All token measurements were available.

The worker corrected a CLI startup defect, reached public green, ran a
print-only probe, received the explicit focused-proof non-admission reason,
wrote an assertion-based check and ran it successfully before accepted DONE.
It did not repeat the reversed-input failure, so this is not a controlled
demonstration that the newest localization patch caused the speedup. That
failure path is established by the real-runner regression, not exercised by
this successful live trajectory. The result demonstrates a short successful
route with the current combined harness; more repetitions would be needed to
claim a stable latency improvement. Do not replace earlier slow evidence with
only this favorable run.
