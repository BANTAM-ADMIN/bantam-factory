# Fresh factory fights: context and overhead audit

September 6, 2026. Post-hoc inspection of completed runs, not a new experiment.
No candidate was repaired, no inference was requested, and no frozen runtime
was changed for this audit. See [the protocol](FRESH-FACTORY-FIGHTS-2026-09-06.md).

## What the evidence says

Native Astra and BANTAM-wrapped Astra both passed all three cards, five
independent acceptance groups apiece. Wrapped Astra used more input and more
round trips, despite working extension delivery and substantial prefix reuse.
The receipts identify several contributors: different first-call cache state,
action text echoed into later context, narrower action batching, and additional
completion evidence. They do not establish how much latency each contributor
caused, or that removing a guard would preserve reliability on unfamiliar work.

The useful distinction is **context that enables a decision versus context or
interaction that repeats an already resolved decision**. More checking is not
automatically more correctness; fewer tokens are not automatically better work.

## Exact Astra comparison

All indices below are zero-based model-call/turn indices, not display turn
numbers. Input includes reused input; fresh input is input minus cached input.
Wall time is contender startup through exit, excluding independent grading.
Native counts come from distinct response-usage records in session rollouts;
wrapped counts come from saved per-call Codex usage in `run.json`.

| Card / arm | Calls | Wall seconds | Input | Cached | Fresh | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Receipt / native Astra | 5 | 111.205 | 75,202 | 66,432 | 8,770 | 3,100 |
| Receipt / wrapped Astra | 8 | 146.032 | 163,360 | 135,808 | 27,552 | 3,626 |
| Snapshot / native Astra | 5 | 122.932 | 78,061 | 67,968 | 10,093 | 3,435 |
| Snapshot / wrapped Astra | 8 | 156.413 | 161,623 | 133,760 | 27,863 | 3,706 |
| Planner / native Astra | 6 | 173.808 | 96,954 | 81,408 | 15,546 | 4,973 |
| Planner / wrapped Astra | 10 | 246.882 | 227,548 | 194,560 | 32,988 | 5,068 |
| Total / native Astra | 16 | 407.945 | 250,217 | 215,808 | 34,409 | 11,508 |
| Total / wrapped Astra | 26 | 549.327 | 552,531 | 464,128 | 88,403 | 12,400 |

That is 2.21 times total input, 2.57 times fresh input, 7.8% more output and
34.7% more wall time for the wrapper. Cached-input volume also increased: a high
cache-hit count alone does not show that the whole interaction is economical.
These are token counts, not a reconstructed bill.

### Extension did not silently fall back to rebuild

Each wrapped card used one native thread, one full delivery, then 7/7/9 delta
deliveries. There were zero rebases or delivery fallbacks; all 26 recorded
prompt-integrity checks passed. Delivered character totals were 41,466,
42,620 and 53,652, versus canonical full-prompt totals of 197,491, 201,259 and
293,399: 79.0%, 78.8% and 81.7% fewer transmitted characters respectively.
This is transport savings against repeatedly sending BANTAM's canonical prompt,
not a comparison with native Codex and not a token-billing calculation.

I independently reconstructed all 26 canonical prompts from the recorded
deliveries. The full delivery is `JSON.parse(modelCalls[0].request.body).prompt`
(its delivery digest matches). For each subsequent call, parse the JSON line
inside `response.normalized.codexPromptDelivery.deliveredText`, then:

```js
assert(sha256(previous) === delta.baseSha256);
current = previous.slice(0, delta.keepPrefixChars) + delta.replaceSuffix;
assert(sha256(current) === delta.canonicalSha256);
assert(current === JSON.parse(call.request.body).prompt);
```

All assertions held. Prefix lengths are JavaScript UTF-16 code units. Preserve
the surrounding delta instructions when replaying actual delivery; the snippet
above reconstructs content, not a replacement transport protocol.

The initial canonical prompts contain 9,493 characters between the BANTAM
system delimiters, including the trailing newline. Their full lengths are
14,711 / 15,864 / 14,891 characters. They introduce one-JSON-action execution,
the action menu, investigation and verification rules, probe semantics,
per-action output limits, task/state material and available engine queries.
Native sessions instead expose Codex's ordinary developer/tool/environment
scaffolding and the task as a user message. Neither representation reveals
all provider-internal processing.

### Reconstructed deltas reintroduce the previous action

The delivery starts `BANTAM_PROMPT_DELTA_V2` and asks the reused native thread
to continue its previous canonical prompt. Its new suffix begins with the
previous raw JSON action, then an observation, then the next assistant marker.
Consequently, code already emitted as the prior assistant response also appears
inside the new user-delivered update. This is an observed echo, not evidence
that the provider bills every echoed character identically.

| Wrapped call receiving the echo | Prior raw action chars | Delivered update chars | Fresh input on receiving call |
| --- | ---: | ---: | ---: |
| Receipt `modelCalls[4]` | 4,669 | 6,245 | 3,634 |
| Snapshot `modelCalls[6]` | 6,269 | 10,724 | 5,264 |
| Planner `modelCalls[4]` | 4,358 | 6,172 | 3,568 |

The respective actions write 4,497-, 6,081- and 4,186-character test files.
Each suffix contains the previous `turns[i-1].rawOutput` exactly. Observations
also add impact/verification guidance; snapshot's update includes test output.
Thus not all suffix growth is duplicate code. Character counts do not isolate
the echo's marginal token or latency cost.

### Action batching and completion work explain extra interactions

Receipt's wrapper performs inspect, public-test read, implementation write,
test write, `npm test`, DONE attempt, CLI witness, DONE. Native call 3 writes
its added tests and runs them inside one `exec` call (rollout line 30).

Snapshot's wrapper uses three source replacements in calls 2–4, adds tests in
call 5, verifies in call 6 and finishes in call 7. Native call 2 batches source
operations (line 25), and call 3 combines additional editing/test creation and
execution (line 35). The wrapper's `writeBatchEnabled` is false. These are
different action contracts, not simply differently worded copies of one plan.

Planner's native call 2 has a real tool failure: a patch attempts multiple
operations on the same file and is rejected (line 31). Native call 3 recovers
with a file rewrite (line 35); call 4 writes and runs regression tests (line 40).
Native Astra was not failure-free or being granted free recovery time.

The wrapper adds a distinct category of work after its own tests already pass:

| Card | Guard and response | Extra tail after first DONE attempt |
| --- | --- | --- |
| Receipt | Call 5 deferred by `unsimulatedTarget`; call 6 asserts CLI result bytes; call 7 finishes | 2 calls; 30.917s turn time; 3,017 fresh; 667 output |
| Planner | Call 5 gets the same deferral; call 6 asserts CLI bytes; call 7 gets the unsearched-choice guard; call 8 checks 1,728 three-job graph/state combinations; call 9 finishes | 4 calls; 89.247s turn time; 7,428 fresh; 1,818 output |

The receipt and planner test suites already reported 9 and 10 passing tests at
call 4. No product-file edits occur in either tail. These tails produce stronger
visible evidence, not demonstrated artifact repairs. Snapshot has no analogous
DONE deferral. The generic guards' assertions that an end state or search was
not reproduced should not themselves be treated as proof that earlier tests
were insufficient. Whether the additional evidence was worth these round trips
is a policy question requiring broader qualification.

### First-call cache arithmetic, with a causal boundary

Native first calls each report 9,600 cached tokens; wrapped first calls each
report zero. Native versus wrapped first-call fresh counts are:

| Card | Native fresh | Wrapped fresh | Difference |
| --- | ---: | ---: | ---: |
| Receipt | 3,863 | 14,349 | 10,486 |
| Snapshot | 4,123 | 14,608 | 10,485 |
| Planner | 3,885 | 14,373 | 10,488 |

The 31,459 first-call difference is 58.3% of the total 53,994 extra fresh tokens.
The first *total-input* differences are only 886 / 885 / 888 tokens: most of this
first-call fresh disparity is the observed cache-hit difference, not a claim
that BANTAM added ten thousand more prompt tokens. The receipts do not establish
why the provider reused one initial prefix and not the other, or whether the
wrapper could obtain the same reuse. Shared warm service state, routing and
different supplied context remain uncontrolled.

Official OpenAI documentation recommends preserving earlier messages and stable
tool definitions and measuring actual usage, rather than inferring cache
benefits from prompt size. That supports testing stable-context changes; it
does not explain these particular cache misses or establish a CLI cache knob.
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching#how-to-optimize-prompt-caching).

## First receipt card: local 27B versus native Astra

Both pass 5/5 independent groups. This is the revised V2 run, not the earlier
8K diagnostic attempt.

| Measure | Native Astra | BANTAM local 27B |
| --- | ---: | ---: |
| Contender seconds | 111.205 | 163.005 |
| Model requests | 5 | 21: 16 actions + 5 reasoning phases |
| Input / cached / fresh | 75,202 / 66,432 / 8,770 | 215,397 / 178,747 / 36,650 |
| Output | 3,100 | 11,974: 6,381 reasoning + 5,593 action |

The local endpoint receives BANTAM's prompt directly. First reasoning prompt:
14,664 characters, 3,396 local tokens, ending in an open `<think>` marker.
The first action receives that short reasoning and a closed marker. Subsequent
reasoning calls are indices 5, 7, 13 and 17; action calls are the other indices.
Reasoning requests use `n_predict:4096`, temperature 0.6 and a `</think>` stop;
actions use `n_predict:8192`, temperature 0.4. Native Astra uses medium effort,
its native tool interface, and no explicit numeric output cap in this launch.

Useful work and avoidable-looking work are both visible:

- Local turn 2/call 3 writes the implementation; turn 3/call 4 already passes
  the four protected public tests. Turn 8/call 11 adds substantial executable
  edge-case assertions, which pass. Public success alone is not hidden acceptance.
- Call 5 spends 47.829s producing its full 4,096-token reasoning allowance after
  the public tests. Its next action, call 6/turn 4, attempts `cd /workspace` and
  is rejected by the harness. That path rule was already in the initial context;
  this is not evidence of a missing instruction. The response repeats the task
  and the next action corrects the command.
- Turn 9/call 12 repeats an unchanged test command and receives a deduplication
  receipt instead of another execution. Call 13 then spends 29.915s/2,179 tokens
  reconsidering already-tested CLI behavior. Turn 11/call 15 refactors the CLI
  without a newly observed failing case; the replacement still constructs the
  entry URL the same way. Do not count this as a demonstrated correctness repair.
- Turn 13/call 18 attempts DONE, receives an end-state witness deferral, then
  turn 14/call 19 builds and asserts a multi-job result before finishing.

The five local reasoning calls occupy 86.154s of recorded HTTP time, with
6.504s prompt processing and 78.406s generation reported by the server. The
16 action calls occupy 69.250s, with 14.234s prompt processing and 54.737s
generation. These sequential request times total 155.404s of the 163.005s
contender window. The two long reconsiderations alone account for 77.744s.
This locates where time went; it does not show that simply suppressing reasoning
would retain the same outcome.

The local prompt grows to 63,565 characters. Reasoning-prefill transitions also
replace suffixes: calls 7/9/15/19 follow removal of preceding `<think>` text from
the canonical action history. Some following requests have substantially lower
reported cache reuse (for example calls 7 and 9 report only 320 cached tokens).
Their textual common prefixes are still 28,421 and 32,810 characters respectively.
The receipts therefore do **not** justify equating textual prefix length with
the server's available KV reuse; investigate server cache behavior separately.

This comparison changes model weights/quantization, tokenizer, provider hardware,
serving path, sampling, reasoning policy, tools and action granularity at once.
Cloud GPU capacity and hidden serving optimizations are not measured. Local and
frontier queues may contend for host CPU/IO. Tokens across different tokenizers
are workload indicators, not equivalent units of cognitive work. Neither
“Astra's intelligence alone explains the speed” nor “context alone explains
the speed” follows from this card.

## Hermes metering: settled supplement, not repaired primary totals

Receipt Hermes passed 5/5 in 418.842s. Its primary wire usage correctly remains
incomplete: 16 of 17 generation requests have measured usage. Request index 23
disconnects after 27ms with zero response bytes. Its final user message
(`messages[28]`) is Hermes's native post-task skill-library review prompt, after
the completed task response. Installed `agent/turn_finalizer.py:696` triggers
this review, and `run_agent.py:1816` starts its daemon thread.

The native 15-call usage plus completed context-summary request 20 reconciles
exactly with the wire partial: input 303,623 + 1,874 = 305,497; output 24,201 +
3,242 = 27,443. Native main-turn accounting alone would omit that summarization.

The immediate server snapshot at 17:27:01.823Z still reports one processing
request. The next local OpenCode lane's pre-launch snapshot at 17:27:03.286Z
reports zero processing/deferred requests and precedes its first generation at
17:27:05.749Z. Using that later endpoint as a **separate settled global window**
from Hermes's 17:20:02.957Z start gives:

| Counter-window measure | Settled delta |
| --- | ---: |
| Fresh input | 41,630 |
| Cached input | 285,230 |
| Total input | 326,860 |
| Generated output | 27,443 |

This adds 690 fresh tokens and zero generated tokens beyond the immediate
snapshot. Both fresh and cached cumulative exports are rounded at these
magnitudes. Attribution assumes no external inference client; these are global
endpoint counters, not request 23's missing receipt. Preserve null primary
totals and the canceled request. Candidate acceptance is unaffected by this
metering gap. Do not promote the supplement to exact complete token accounting.

## Priorities for a future controlled ablation — not implemented

1. **Ground verification in existing evidence.** Keep the same acceptance
   standard, but test whether source-bound verifier receipts can discharge a
   specific completion requirement before another generic DONE rejection.
   Compare missed defects as well as turns saved; do not merely disable guards.
2. **Remove semantic echo, not stable history.** Within the same Astra thread
   policy, compare today's delta with an observation-only/reference-backed
   update that does not repeat the immediately preceding action. First prove
   exact state reconstruction and grounding; then measure fresh input and quality.
3. **Equalize action opportunities.** Compare bounded atomic edit batches and
   write-plus-verify opportunities, with identical rollback and isolation
   rules. Record actual tool failures. A different batching contract is not a
   pure prompt wording experiment.
4. **Budget local reconsideration using evidence.** Compare capped or selectively
   triggered post-test reasoning with the current policy, holding weights,
   sampling, tests and action budget fixed. Demand a concrete unresolved claim
   before another broad audit; preserve access to reasoning when a witness fails.
5. **Separate cache effects from semantic changes.** Repeat/order-balance fixed
   context profiles; record first-call cache state and server/provider limits.
   Do not assume cloud cache flush control or treat warm service state as cold.

Before any future run, persist pre-launch counters immediately and add a bounded
post-cancellation idle-settlement snapshot. Keep immediate and settled snapshots
and incomplete wire receipts separately. That is a small instrumentation repair,
not a reason to rerun this series or change its frozen execution now.

## Evidence locator

All raw paths below are relative to the repository. Evidence remains in ignored
private local storage; this document does not publish transcripts or change
repository visibility. `E` abbreviates
`.bantam/acceptance/2026-09-06/factory-fights-v2-32k/repeat-1`.

- Astra totals: `E/{receipt-reducer,snapshot-drift,job-planner}/{codex-astra,bantam-codex-astra}/result.json`.
- Wrapped prompts, actions, per-call usage, guards: the matching
  `bantam-codex-astra/run.json`, especially `modelCalls[i]`, `turns[i]`,
  `metrics.codexPromptDelivery`, `metrics.codexThreads`, and
  `metrics.codexPromptIntegrity`.
- Native rollouts live beneath each `codex-astra/native-sessions/2026/09/06/`:
  receipt `rollout-2026-09-06T17-03-23-01a077ac-b85a-7f70-93f5-636727ded153.jsonl`
  (test/write execution line 30; usage lines 14,20,27,31,37);
  snapshot `rollout-2026-09-06T17-07-43-01a077b0-b118-7020-af2e-0366f4da91cd.jsonl`
  (batched calls lines 25,35; usage lines 14,20,26,37,43);
  planner `rollout-2026-09-06T17-12-28-01a077b5-0bed-70b3-950d-e973fc339783.jsonl`
  (failed patch result line 31, recovery line 35, test/write execution line 40;
  usage lines 14,20,30,37,41,47). These are physical one-based file lines.
- Local receipt: `E/receipt-reducer/bantam-local-27b/run.json`, `result.json`,
  and `wire/exchanges.jsonl`. Local `modelCalls[i]` is zero-based; wire request
  indices are separately recorded and must not be assumed identical.
- Hermes: `E/receipt-reducer/hermes/wire/00020.request.body`,
  `00023.request.body`, `exchanges.jsonl`, `native/native/usage.json`,
  `server-usage.json`; settled endpoint: `E/snapshot-drift/opencode/server-usage.json`
  field `before`, cross-checked with that lane's `wire/exchanges.jsonl`.

Bottom line: BANTAM is reliably getting these bounded artifacts through the
gauge, and its evidence machinery exposes actionable overhead rather than
forcing guesswork. The next target is a smaller, better-directed decision
context and fewer evidence-equivalent round trips—not a blanket removal of
reasoning, caching, Datalog, or verification.
