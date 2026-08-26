# BANTAM Team mode

Team mode is an optional, operator-triggered collaborative workflow for one
Local model and three Codex roles. It never starts automatically.

For the complete implementation narrative, adversarial hardening history, live
evidence, and present claims boundary, see the
[Collaborative Team mode report](superpowers/reports/2026-07-26-collaborative-team-mode.md).

```text
Local, when reachable  repository scout       read-only
Luna medium            contract/test scout    read-only
Sol high               adversarial reviewer   read-only
Terra medium           accountable primary    sole candidate writer
```

The purpose is not to make four agents edit one checkout. It is to gather
different kinds of evidence in parallel, then give one accountable primary a
small, bounded briefing. This preserves BANTAM's constrained action protocol,
verification, artifacts, and transactional apply boundary.

## Starting and stopping

Start the normal interactive REPL:

```bash
./bin/run-dev.sh
```

Then opt in:

```text
bantam ❯ :team on
bantam ❯ Diagnose the flaky retry tests and implement a robust fix.
```

Team mode remains active for later ordinary requests until it is turned off,
reset, or a candidate is applied:

```text
:team status
:team compare
:team apply
:team reset
:team off
```

`:team on` performs a live Codex catalog check and requires Luna, Sol, and
Terra. It probes the configured Local endpoint but does not launch a server. If
Local is healthy it joins; if it is offline, the three Codex roles continue.
The currently selected single-model setting is not changed.

`:team off` closes model clients. Saved evidence and isolated lane state remain
under `.bantam/teams/`. It does not apply or discard a candidate.

`:team reset` closes the current team and captures a new baseline from the
current live workspace.

## What happens for each request

### Phase 1: parallel specialists

BANTAM sends role-specific versions of the operator request to the available
scouts concurrently. Terra does not perform a disposable scout run before its
primary run; this avoids duplicating repository reads and then throwing that
history away. Every scout is forced through BANTAM's advisory action mask:

- repository inspection and grounded queries are allowed;
- every current and future non-read-only protocol action is denied, including
  dynamically enabled `patch`, `edit_lines`, delete, and move operations;
- file writes and shell operations are rejected again at execution time;
- code verification is not misused to grade an advisory response;
- each member works in a separate externally materialized workspace.

Specialist trajectories have a separate five-turn ceiling and are instructed
to spend no more than two actions gathering evidence before responding. The
Terra primary retains the normal task turn budget. This keeps a scout from
turning a bounded briefing into a second full implementation investigation.

The roles deliberately search for different evidence:

- **Local** maps relevant code, architecture, and dependencies.
- **Luna** produces a compact exhaustive requirement ledger, marks each item
  `SATISFIED`, `GAP`, or `UNKNOWN`, and supplies a concrete proof.
- **Sol** challenges observed code assumptions and supplies risk-ranked
  adversarial probes without repeating the ordinary plan.

The specialists do not see one another's work. BANTAM bounds every returned
finding at 8,000 characters before it enters the integration prompt. The
previous 2,000-character limit could silently discard later requirements from
large contracts and was removed after live evaluation exposed the loss.

### Phase 2: Terra primary

After all specialists settle, BANTAM proves that every scout workspace has an
empty captured diff. It then discards every scout materialization and scout
history, restoring each lane to its exact pre-scout content-addressed commit.
If any diff is non-empty or cannot be captured, the task terminates as
`scout-policy-violation`; Terra integration never starts.

From that clean phase boundary, BANTAM gives Terra:

1. the original operator request;
2. the task intent determined by BANTAM;
3. bounded specialist findings, labeled as untrusted advice.

Terra is told to validate important claims against its own isolated workspace.
For implementation tasks it must reconstruct a ledger from the original task,
audit every item before completion, and preserve already-compliant files rather
than treating every ledger entry as a rewrite instruction.
For an advisory request it synthesizes a read-only answer. For an
implementation request it becomes the only writer and performs the ordinary
BANTAM edit-and-verify loop in its private candidate workspace.

Advisory integration receives a separate two-action investigation budget. The
primary already has three or four bounded specialist reports, so it may validate
the most important seams but cannot repeat an open-ended repository audit.
Implementation integration retains the normal full turn and investigation
freedom.

If an advisory Terra response is empty or merely claims that a finding “has
been provided,” BANTAM does not discard the useful work. It emits a
self-contained fallback containing the bounded grounded specialist findings
and records `response-fallback` in telemetry.

After an implementation primary settles, BANTAM rematerializes every specialist
lane from Terra's candidate commit and clears its stale conversational summary.
A follow-up Team task therefore inspects the current candidate, not the
session's original baseline. This synchronization is internal to the isolated
session; it still does not change the live workspace.

This is a two-stage workflow, so total wall time is approximately the slowest
parallel scout plus the Terra integration run. It is intentionally more
expensive than a single-model turn.

## Isolation and safety

Starting Team mode captures one content-addressed baseline. Every member gets a
private materialization outside the source tree. Consequently:

- members cannot overwrite each other;
- the source project does not see partial edits;
- tests cannot recursively discover copied workspaces under the project;
- Terra receives text findings, not another member's unreviewed filesystem;
- a Terra scout can never become an ancestor of the Terra writer candidate;
- any attempted scout mutation fails the phase closed and is discarded;
- there is exactly one candidate lineage.

The live workspace stays unchanged until `:team apply`.

Apply requires a configured verifier and explicit confirmation. It:

1. refuses if live source bytes no longer match the frozen baseline;
2. verifies the Terra candidate outside the source tree;
3. computes a conflict-aware transactional change set;
4. applies that change set to the live workspace;
5. runs the verifier again in the live workspace;
6. commits on green or restores exact backups on failure;
7. turns Team mode off after success.

Local, Luna, and Sol are never selectable apply targets because their Team
phase is read-only.

## Telemetry and artifacts

Each completed task prints a table containing, per specialist and for the
Terra primary:

- status;
- BANTAM turns;
- model requests;
- input, output, and reasoning tokens;
- elapsed time.

The comparison also records parallel scout wall time, Terra integration time,
total estimated wall time, and aggregate model traffic. Subscription Codex
usage is reported as token traffic with zero metered API cost; it is not “free
of limits.”

Saved state has this shape:

```text
.bantam/teams/<session-id>/
├── team.json
├── team-summary.md
├── team-report/index.html
├── manifest.json
├── events.jsonl
├── comparisons/
├── runs/<member>/
└── transactions/          # after apply attempts
```

`team.json` is the staged workflow record. `manifest.json` is the generalized
isolated-lane engine record. The HTML report links the underlying run artifacts
so token use and trajectories can be inspected later.

## Team versus Trio

These modes answer different questions:

| Mode | Question | Writers | Result |
| --- | --- | --- | --- |
| Single model | Can this selected model do the task? | one | one direct result |
| Trio | How would Local, Sol, and Terra independently solve it? | three isolated writers for implementation tasks | three candidates to compare |
| Team | Can parallel specialists improve one accountable solution? | Terra only | one integrated candidate |

Use Trio for comparative research and model/harness telemetry. Use Team for a
hard real task where diverse review is worth extra subscription traffic but
you want one coherent implementation.

## When Team mode is worthwhile

Good candidates include:

- unfamiliar cross-cutting changes;
- migrations with implicit compatibility contracts;
- concurrency, lifecycle, security, or data-integrity work;
- tasks where hidden tests or ambiguous requirements are likely;
- high-value design reviews where multiple independent readings matter.

Prefer single-model mode for small mechanical edits, obvious fixes, and routine
questions. Team mode invokes two or three scout trajectories plus a Terra
integration trajectory. It should be a deliberate quality/assurance purchase,
not a default routing policy.

The current evidence-backed default is **solo Terra medium**. In the broad
twelve-module migration it matched Team's public and hidden correctness while
finishing in 10–12 requests and roughly 1m45s–1m51s; Team required 26 requests
and 4m29s. Team earned its keep only on the harder keyed-concurrency contract,
where v2 repaired Team v1's missed validation requirement. Do not enable Team
merely because a task is large.

## Non-goals and limitations

- Team mode never auto-fires from prompt wording, task complexity, failures, or
  self-improvement signals.
- It does not launch a Local server.
- It does not let several writers merge changes.
- It does not automatically apply Terra's candidate.
- It does not automatically start governed self-improvement.
- Specialist findings can still be wrong; Terra is explicitly required to
  validate them.
- Aggregate token totals measure provider traffic, not semantic usefulness.
- Parallel execution reduces scout wall time but does not reduce aggregate
  subscription usage.
- The five-turn scout ceiling favors concise high-signal findings over
  exhaustive independent repository reviews.

Team evidence can later inform a separate experiment or governed
self-improvement proposal, but that remains another explicit operator action.

## Live integration proof

On 2026-07-26, with Local intentionally offline and `npm test` configured as
the project verifier, an advisory Team smoke run discovered Luna, Sol, and
Terra from the live authenticated catalog. Each scout completed in exactly
three turns: two read-only inspection actions followed by a schema-forced
response. No scout invoked the verifier or changed a workspace.

The run used 14 total model requests: nine parallel scout requests and five
Terra synthesis requests. Scout wall time was 65 seconds (bounded by Sol), Terra
integration took 23 seconds, and the recorded total was 288,664 input, 4,248
output, and 2,463 reasoning tokens. The evidence is stored at:

```text
.bantam/teams/2026-07-26T10-21-07-275Z-db4b7f3d/
```

That is a wiring and policy proof, not a broad quality benchmark. It also shows
why Team mode stays opt-in: parallel review can improve coverage, but aggregate
subscription traffic is materially larger than a single-agent answer.

### Phase-boundary hardening proof

A later adversarial live run deliberately gave the read-only scouts an
implementation-shaped request. It exposed that optional `patch` could be
dynamically enabled after the original base-only advisory mask was assembled,
and that Terra's scout and writer reused one materialization. The source
checkout remained isolated, but the private candidate provenance was weaker
than documented.

The hardened implementation now denies the complete non-read-only protocol,
intersects that policy with the exact per-turn schema, restores all scout lanes
before integration, and refuses integration on any non-empty or unavailable
scout diff. Regression coverage exercises the dynamically enabled patch path,
candidate restoration, fail-closed mutation handling, clean Terra history, and
content-free synthesis fallback. With the subsequent comparison-driven
workspace-capture and advisory-lane regressions included, the complete
verifier reports 1,033 passing tests and zero failures.

The post-hardening live audit is stored at:

```text
.bantam/teams/2026-07-26T11-25-30-110Z-fc027b94/
```

With Local offline, Luna, Sol, and Terra scouts all completed as read-only
`response` in three turns each. Terra then produced a concrete, file-citing
answer from a restored lane. The run took 1 minute 59 seconds and recorded 16
requests, 418,607 input, 5,486 output, and 1,646 reasoning tokens. This proves
the corrected live phase transition and visible-answer path, while reinforcing
that Team remains a deliberate high-cost mode rather than a routine default.

The subsequent advisory-integration cap limits Terra to two additional
investigation actions after it receives the specialist packet. Deterministic
coverage proves the cap and preserves unrestricted implementation work; it has
not yet been measured in another live subscription run. This distinction is
intentional: tested policy behavior is not presented as measured provider
savings.

## Next evaluation phase

The next question is not whether Team can run safely—it can—but when its
additional evidence improves a verified outcome enough to justify its traffic.
The planned study compares solo Terra, solo Sol, Team, and Local when available
on identical fresh tasks. It records correctness, strict contracts, requests,
input/cache/output/reasoning tokens, critical-path time, aggregate traffic,
investigation behavior, and verification activity.

No automatic benchmark or self-improvement starts when Team completes.
`:team benchmark` is a proposed future command, not a current command. Today,
operators can use the existing gauntlet/experiment runners for controlled solo
arms and retain Team artifacts as an explicit treatment.

See [Evaluation and Improvement Loop](EVALUATION-AND-IMPROVEMENT-LOOP.md) for
the study matrix, grading order, current commands, proposed automation, and
the evidence gates between a finding and a promoted BANTAM improvement.

### First solo-versus-Team implementation sample

The first controlled `keyed-task-pool` sample compared Terra medium alone with
Luna/Sol/Terra scouts followed by a Terra primary. Both candidates passed 2/2
public and 4/4 supplied hidden tests. Solo Terra alone passed an extra
task-derived check requiring a missing `payload` field to be rejected before
worker execution.

Team's primary used 10 requests and 273,064 input tokens versus solo's 14 and
490,147, but complete Team traffic was 25 requests and 529,338 input tokens,
and Team took 2m44s versus solo's 1m43s. The specialists therefore compressed
the primary trajectory without producing an aggregate efficiency or
correctness win in this sample.

The experiment also found and fixed ancestor-ignore baseline capture and
implementation-shaped advisory response rejection. The measured Team numbers
precede the latter efficiency fix. See the
[full evaluation report](superpowers/reports/2026-07-26-solo-terra-v-team-keyed-task-pool.md).

### Team v2 controlled follow-up

The corrected keyed-task-pool rerun removed the disposable Terra scout and
used Luna contract auditing plus Sol adversarial review before the Terra
primary. Team v2 passed public 2/2, hidden 4/4, and the missing-`payload`
requirement probe that Team v1 failed. It fell from 25 to 12 requests and from
529,338 to 223,590 input tokens. Compared with Solo Terra it used fewer
requests, total input, and reasoning, but remained 12.4% slower and used 31.0%
more cache-miss input.

A second twelve-module adapter migration also passed public 2/2 and hidden
4/4, but Team took 26 requests and 4m29s versus two prior Solo Terra rounds at
10–12 requests and 1m45s–1m51s. The primary rewrote every adapter instead of
preserving compliant implementations.

That run exposed two additional handoff defects now fixed: 2,000-character
finding truncation discarded later ledger items, and completeness language
could incentivize unnecessary rewrites. Findings are now bounded at 8,000
characters, Luna labels items `SATISFIED`/`GAP`/`UNKNOWN`, Sol prioritizes
observed gaps, and Terra is explicitly required to preserve compliant files.
The preservation-aware policy is covered deterministically but has not been
assigned invented live savings. See the
[Team v2 follow-up report](superpowers/reports/2026-07-26-team-v2-controlled-followup.md).

The subsequent exact adapter repeat measured the improvement: Team retained
2/2 public and 4/4 hidden correctness while falling from 26 to 13 requests,
1,054,572 to 268,638 input tokens, and 4m29s to 2m40s. Its Terra primary fell
from twenty turns to seven. Solo still won on latency and uncached traffic.

That repeat also revealed a shell-heredoc bulk edit. BANTAM observed and
reverified the mutation, but structured edits are safer. Explicit migrations
across every module/adapter now enable the atomic multi-file patch action,
whose bounded capacity is sixteen exact edits. This patch-policy change is
tested but was introduced after the measured run.
