# Why the older 27B stream-framer control failed

Status: read-only diagnosis during the DavidAU comparison, 2026-09-07.
No candidate source, grading fixture or harness was changed for this diagnosis.

Evidence: `.bantam/benchmarks/factory-davidau-20260907-control/repeat-1/stream-framer/bantam-local-27b/`.
The complete prompts, responses and execution receipts are in `run.json` and
`wire/`; the final candidate and authored checks are in `ws/`.

## Result and the meaning of completion

The control took 467.030 seconds and 41 action turns. It passed the supplied
suite and its authored checks, and obtained an accepted completion receipt.
Independent acceptance was only 3/5: arbitrary UTF-8 boundaries and poisoned
decoder behavior remained incorrect. The receipt demonstrates that the
configured completion gates were satisfied, not that all contract requirements
were independently established. The final result is FAIL.

Accounting: 1,195,135 input tokens, of which 1,049,208 were cached and 145,927
fresh; 28,040 output tokens. These include the recovery and verification route,
not merely the final code generation.

## Defect 1: partial UTF-8 detection depends on chunk shape

The final `decodeUtf8` scans forward through the last four bytes, looking for
an incomplete character. An ASCII byte makes it break before it reaches a
later incomplete multibyte lead byte. It then decodes that incomplete suffix
with Buffer's replacement behavior and throws when the result contains U+FFFD.

Independent diagnostic against the saved module, using a new input rather
than altering the grader: split `data: café😀\n\ndata: [DONE]\n\n` at byte 10.
The first chunk ends with hexadecimal `64 61 74 61 3a 20 63 61 66 c3`.
This is a valid partial UTF-8 stream, but `push` throws `decoder error`.

The supplied one-byte transport case can pass while this mixed ASCII/partial
character chunk fails. Thus one-byte plus whole-string checks did not establish
the task's explicit arbitrary-boundary invariant. Separately, using decoded
U+FFFD as an invalid-byte detector conflates a legitimate replacement character
with decoder substitution; the implementation should not use that heuristic.

## Defect 2: only some errors poison the instance

The final `fail()` merely throws. `push` catches errors from `feedBytes` and
sets `poisoned=true`, but its input-type checks occur outside that catch.
`finish` likewise throws without setting poisoned on its failure paths.

Two measured reproductions on separate fresh decoders:

1. `push('bad')` throws; subsequent `push(Buffer.from('data: [DONE]\n\n'))`
   and `finish()` both succeed. They must reject after the first failure.
2. Calling `finish()` before termination throws; the same subsequent valid
   push and finish both succeed. They must reject too.

The authored test called “poison: after failed push, all subsequent throw” used
invalid UTF-8, which enters the catch and does poison. The invalid-type tests
checked only their immediate exceptions. Early-finish tests likewise did not
check subsequent calls. A check name that says “all” was not evidence that all
rejection paths were exercised.

## What the context actually contained

The public task explicitly states arbitrary chunk boundaries and that **any**
rejected push/finish poisons the decoder. Both were still present in the final
action prompt. This is not a missing-requirement or insufficient-window case.

There was also a stuck-test diagnostic after turn 16 recommending replacing
the UTF-8 heuristic with streaming TextDecoder behavior. It reached turn 17's
actual prompt. However, its specific trace was mistaken for the one-byte case:
the worker traced that case, found a separate line-buffer concatenation bug,
fixed it, and reached 4/4 public green. We should not describe this as simply
ignoring a proven correct diagnosis. The broad UTF-8 risk was real, but the
diagnostic had not produced a valid distinguishing execution for it.

Later prompts no longer contained the TextDecoder diagnostic (checked at turns
38 and 41). Persisting its flawed prose would not be a sound fix. What was
missing was a bounded, unresolved invariant with an executable witness: the
same byte stream must yield the same frames under every tested split.

The final review treated strict UTF-8 and poisoning as completed requirements,
without showing the missing split/error-transition evidence. This is a failure
to turn broad requirements into small verified obligations, not evidence that
another 20K of context would solve the problem.

## Audit and gate limitations that contributed

1. The source review was a `collection-preconditions` audit, with at most two
   findings. That lens is not a systematic examination of decoder state
   transitions or byte-partition invariance.
2. At turn 18, the audit proposed an incorrect Buffer/Uint8Array complaint and
   an incorrect empty-data complaint. The first was deferred for invalid
   contrast encoding; the second was admitted as a hypothesis and exercised
   by the worker's tests. Structured admission did not establish factual truth.
3. At turn 26, two UTF-8/error findings used bare `throws Error` in fields
   requiring JSON data. Both were deferred by `jsonObservation` /
   `admittedCollectionReport` in `src/contract-state-audit.js`. Deferring malformed
   findings was appropriate; their predicted behaviors were also unreliable.
   But the protocol lacks an explicit typed return/throw outcome and does not
   convert such gaps into resolved, executable coverage obligations.
4. `src/contract-audit-recovery.js` recognizes a fresh focused check followed
   by the configured project check. It does not prove that the focused check
   covers every public requirement or every branch of a stateful contract.
5. The final prompt's current workflow said the focused/project checks passed
   and allowed DONE if requested work was complete. That statement was true as
   execution accounting, but the worker supplied its own unsupported coverage
   judgment. There was no per-obligation evidence record to contradict it.

The response should not be “remove audits” or “trust the smarter worker.” Keep
the gates, improve their work orders and explicitly distinguish passed tests
from demonstrated coverage.

## Where the time went

Summed recorded action-turn durations (some include controller/model work):

| Turns | Seconds | Route |
| --- | ---: | --- |
| 1–5 | 56.884 | Inspect; two refused rewrite proposals; applied replacement |
| 6–17 | 151.014 | Failing tests, repeated probes/reads, typed-array decoding fix, line-buffer repair |
| 18–30 | 127.236 | Audit, authored contract checks, implementation and test repairs |
| 31–41 | 129.113 | CLI probes, rereads, BOM repair, fresh checks and completion |

Total turn time is 464.247 seconds; the remaining approximately 2.783 seconds
is outside those recorded turns. No grader work should be relabeled model time.
The rewrite preservation guard demanded an identical confirmation, but the
worker regenerated changed proposals instead. That added work, although these
UTF-8/poisoning defects already existed in the first proposal; the refusals did
not create them.

## Specific proposed harness improvements, not implemented here

1. **Chunk-invariance jig:** for contracts explicitly requiring streaming or
   chunk-independence, generate a bounded replay check over each split of a
   short valid stream, plus whole-stream, one-byte and selected multi-split
   partitions. Bind every replay to the real public API and the task-specified
   expected result. This is a reusable metamorphic check, not a hidden fixture.
2. **Error-transition jig:** enumerate task-required rejection classes. For
   each, use a fresh instance, trigger the rejection, then try both a valid
   push and finish. Keep positive controls and instance-independence checks.
   Do not infer poison semantics for APIs that do not require them.
3. **Typed observations:** give audit counterexamples explicit `return` and
   `throw` outcomes. Still require actual execution before treating a finding
   as true; repairing JSON encoding alone does not make a bad diagnosis good.
4. **Coverage receipts:** retain obligation IDs, current-source identity,
   executable witness and measured result. Distinguish unresolved obligations,
   false hypotheses and satisfied checks. A single green file must not silently
   stand in for all obligations of a stateful protocol.
5. **Bounded risk retention:** when a diagnostic trace is refuted by one case,
   do not promote the broader invariant to satisfied. Preserve only the
   remaining testable question and its next discriminating check, not raw
   speculative reasoning. Retire it when matching evidence settles it.
6. **Use vetted primitives where appropriate:** offer a tested strict streaming
   UTF-8 recipe when Node builtins are allowed, including fatal decoding, BOM
   handling and finish behavior. Prefer deriving a correct primitive over
   repeated hand-written byte heuristics; still test the composed decoder.

Implement and regression-test these only after freezing the current comparison
results. Then requalify both models on the same revised harness. Do not patch
one contender midway and call the resulting figures a model comparison.
