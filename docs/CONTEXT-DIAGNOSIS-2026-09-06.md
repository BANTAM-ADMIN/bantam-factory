# Follow-up: RepoBrief grounding and Codex context amplification

Subsequent implementation and validation are recorded separately in
[Context delivery fixes](CONTEXT-DELIVERY-FIXES-2026-09-06.md).

This is a diagnosis of the preserved RepoBrief experiment, not a replacement
score or a production fix. Original candidates, prompts, tasks and graders
remain unchanged. The 27B's original 2/3 result describes one complete
harness/model system under those conditions; it does not establish a model
capability ceiling.

## 27B: the unresolved experiment that became a completion claim

The original destination-only rename requirement is present in all 56 actual
model-request prompts; all recorded prompt hashes were verified. The final
parser instead overwrites the destination with the second NUL field, the
original filename.

The trace, using zero-based original turn indices:

1. Turn 8 implements an incorrect recollection of porcelain `-z` ordering.
2. Turn 10 obtains a real ordinary-entry byte dump. It supports correcting the
   normal status/path split, but establishes nothing about rename ordering.
3. Turns 11–22 try rename experiments in an increasingly confused scratch Git
   repository. They execute, but produce setup errors, additions, deletions or
   untracked records—not a successful rename record. These observations reach
   subsequent prompts intact. No valid rename witness was hidden or ignored
   in this original sequence.
4. Turn 27 repairs ordinary parsing and keeps the wrong rename ordering. The
   model recognizes that the public tests do not cover renames. BANTAM supplies
   passing-test/finish guidance and a stale `[peer]` excerpt of the old parser.
   The later post-green audit in that observation is clipped out of the actual
   next request. A panel that this audit refers to is not rendered either.
5. By the final review, both the rename requirement and the erroneous current
   source are visible. Nevertheless, the review equates having an R/C branch
   with having verified destination semantics. BANTAM accepts completion.

The earlier clipped-read/reread trap is also real: the harness tells the model
to request smaller reads, then rejects those reads because it incorrectly
claims the bytes exist in `<open_files>`. However, the missing public helper
bodies do not contain the rename-format answer. That bug must not be used as
an unsupported explanation for every downstream error.

The supported system failure is **an incorrect assumption was never replaced
by trustworthy experimental evidence, yet it became a confident completion
claim**. The relevant harness improvement is to preserve unresolved questions,
execution scope and current-source provenance. An unsuccessful setup or a
passing test unrelated to a question must not quietly close that question.
This does not require the harness to contain a special Git-rename answer.

### Controlled continuation: the generic reminder was not sufficient

Two copies resumed the original saved dialogue through turn 34 with identical
candidate/task/public-test bytes, the same extension settings and local model,
20 additional action turns available, and a three-minute wall limit per arm.
The original artifact stayed unchanged. This is one exploratory continuation
pair, not fresh-build replication or a replacement for the three-card score.

The control had no added reviewer observation. The treatment received only
generic guidance to distinguish tested requirements from assumptions, use a
fresh fixture per case, and confirm setup and the intended case before drawing
a conclusion. It named neither Git renames nor their correct ordering, and
supplied no hidden test, application repair, expected output or raw Git record.
It used the existing `--review-file` wrapper, whose external-review framing is
also part of the intervention; this was not a byte-identical replay differing
only in an unframed sentence. Both continuations retain the exact original
rename requirement in every new request; the treatment's reviewer text also
remains present in every new request.

| Continuation | Additional actions | Wall time | Accepted completion | Held-out result |
| --- | ---: | ---: | --- | --- |
| Unchanged control | 9 | 71.5 s | Yes | Fail: old rename pathname |
| Generic probe discipline | 20 | 151.9 s | Yes | Fail: addition + deletion instead of one rename |

The treatment did create a clean rename fixture and independently read the
actual `R` record at turn 38. It then chose `--no-renames` and ultimately
reported separate destination-addition/source-deletion rows. This directly
violates the task's single-destination-change requirement, despite public tests
passing. Neither arm changed the protected tests or package configuration.

This result narrows the diagnosis: obtaining the previously missing witness
is helpful but **not sufficient**. The model also has to interpret that witness
against the original contract and verify its corrected behavior; BANTAM did
not catch the unresolved contradiction before accepting completion. It would
be incorrect to claim this pair proves the read-residency bug caused the rename
failure, or that the model necessarily succeeds once any missing bytes arrive.
It does not establish incapability either. Adding another general reminder
is not demonstrated to solve this failure.

Evidence is local and Git-ignored at
`.bantam/acceptance/2026-09-06/repobrief-context-diagnosis/`: both continuations,
their exact reviewer text and commands, hashes, grades, and the independent
Astra transport audit. Production source, defaults and the original scored
test kit were not changed.

## Astra: why the wrapped token count grew

The user's recollection of previous savings is supported by the project's
records. On the earlier ordered-map task, constrained Sol used 106,312 input
tokens versus native Sol's 714,354; constrained Terra used 97,634 versus native
Terra's 132,528. See [the recorded comparison](NATIVE-CODEX-DELEGATES.md).
Those constrained controls also used direct app-server run/delta, but each had
only six calls on a compact repair. They were not all bridge-based runs.

The Astra cards used 6 / 15 / 15 calls. All 36 saved usages reconcile with the
reported total. The transport takes per-completion `tokenUsage.last`, not
cumulative `total`; summing a thread counter twice is not the cause.

| Across the three RepoBrief cards | Wrapped Astra | Native Astra |
| --- | ---: | ---: |
| Input tokens, including cached | 1,574,510 | 293,826 |
| Cached input | 1,202,816 | 234,624 |
| Input not reported cached | 371,694 | 59,202 |
| Cache-hit share | 76.4% | 79.9% |

Input and cached input must be inspected separately, as described in the
[official OpenAI caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance).
These counts are runtime-reported traffic, not a calculated bill.

### The exact delivery mechanism

`src/codex-transport.js:424` retains the **first** canonical prompt as its delta
base. `buildCodexPromptDelivery` at line 697 constructs the entire replacement
suffix since that base. `turn/start` at line 369 appends that message to the
same native thread, which already contains earlier deliveries. The official
[app-server documentation](https://developers.openai.com/codex/app-server)
describes these turns as additions to a thread.

For an append-only trajectory, this means sending:

```text
first request:    base
second request:   history A
third request:    history A + history B
fourth request:   history A + history B + history C
```

The native thread retains each earlier message. This removes repeated delivery
of the initial base, but does not implement incremental delivery of subsequent
history. Prefix caching does not make redundant history useful or remove it
from reported input counts.

All 33 saved deltas were reconstructed and hash-checked. They all extend the
previous canonical prompt exactly, and none triggered a rebase:

- Total serialized deliveries: 673,918 characters.
- Decoded replacement suffixes: 581,943 characters.
- Unique post-base material: 93,271 characters.
- Previously delivered history sent again: **488,672 characters, 84.0% of
  suffix material**.

At card 2's final decision, the canonical BANTAM prompt is 52,180 characters,
but the accumulated delivered user messages total 338,504 characters. The
provider reports 116,541 input tokens for that one request. Characters are
not tokens; these figures establish duplication, not an exact forecast of
savings after a repair.

The transport used in the original run was unchanged by the Astra additions. Longer trajectories
exposed an existing scaling cost, while the different native-model baseline
also means the older advantage cannot simply be assumed for this workload.
Earlier transport evaluations already recorded higher total input despite
lower cache misses; see [the historical measurements](CODEX-INTEGRATION-IMPROVEMENTS.md).

### Other measured contributors and limits

Card 2's false requirement for literal `.repobrief/snapshots/NAME.json` induced
three requests after the first completion attempt. These consumed 314,361
input tokens—about 20% of all wrapped input—with no application edit needed
in that interval. The final request reported zero cached input despite thread
reuse. Its 116,541 fresh tokens are 31.4% of all wrapped fresh input. The
record does not establish why this provider cache miss happened; expiry,
compaction and routing must not be invented as explanations.

The existing optional adaptive rebase floor of 0.2 would not have fired: the
minimum per-envelope savings on these cards were 39.0%, 22.9% and 27.3%.
That policy checks the latest message against the canonical prompt, not the
amount of accumulated native-thread duplication.

The separate `codexapi` bridge already has more genuinely incremental delivery:
`src/chat-sessions.js` sends only the newest user content and does not resend
the native assistant's own reply. This is a useful implementation precedent,
not proof that switching the Astra experiment to it would achieve a particular
score or token reduction.

## Next implementation boundary

For direct Codex delivery, send only newly acknowledged material when the
canonical prompt extends the previous one; use explicit full rebases when
context is rewritten or session continuity is lost. Preserve exact replay
evidence and test recovery, auxiliary calls and rejected actions. Evaluate
accumulated thread size and fresh tokens, not just envelope savings or cache
percentage. Repair false completion obligations independently, then compare
the same workloads and model before/after. No production patch or default
change has been made in this diagnostic turn.
