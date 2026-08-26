# BANTAM's First Principle: It's the Context

## The working assumption

**There is very little BANTAM cannot do, given the right context and the right
harness.** Not because the model is unlimited, but because of three properties
that compound:

1. **The model is genuinely capable.** Most observed failures are not the model
   being unable to reason — they are the model reasoning correctly from an
   incomplete or contradictory picture.
2. **Any task decomposes.** Nobody assembles a car by hand. A factory builds one
   from a long line of small, repeatable operations, each simple enough to be
   done reliably and checked immediately. An arbitrarily complex coding task
   admits the same treatment.
3. **BANTAM can rebuild its own line while running on it.** It records its own
   prompts, actions, observations and decisions; it can replay a single past turn
   under a changed context; and it can author grammars, gates, probes and
   workflows that constrain the next run. It is the rare harness that can
   diagnose itself and then modify the thing it diagnosed.

The practical consequence: **when BANTAM fails, the first hypothesis is never
"the model can't." It is "the line is missing a station, or a station is missing
its gauge."**

The framing is developed further in [BANTAM as a factory](FACTORY-MODEL.md),
which maps stations, jigs, gauges and andon cords onto real components and
draws out the poka-yoke hierarchy this harness already implements.
The experimental BANTAMFACTORY program asks the next
falsifiable question: can BANTAM compile a broad product contract into an
executable route of independently contracted and inspected stations, and can
that route outperform the unchanged agent loop on fresh work?

## The assembly-line corollary: every station needs a gauge

The analogy carries a specific obligation that is easy to miss. A production line
works not because each station has *instructions*, but because each station has an
*inspection gauge* — a jig that will not close on an out-of-spec part. Instructions
without a gauge produce confident, uniform, undetected defects.

Translated: **a task's verifier is the gauge, and a blind gauge is worse than no
gauge**, because it certifies bad work. Measured on 2026-07-30, `keyed-task-pool`:

- the model was told the full async lifecycle contract, and restated it correctly;
- its only verifier ran everything at `concurrency: 1` with a single key, so the
  queue-drain path — where every recorded failure lived — was **never executed**;
- told its implementation was wrong, the model reran that verifier, saw green,
  and declared done. 6/6 replays did exactly this.

It was not failing to reason. It was reasoning correctly against an instrument
that could not show it the defect. Strengthening the gauge from the task's own
stated invariants — six revisions, each one closing a hole the previous exposed —
walked the pass rate up without touching the model or the prompt.

## The discipline that keeps this from becoming dogma

"It's the context" is only useful while it stays falsifiable. It becomes a
liability the moment it means "keep building harness forever."

- **Name the missing fact before building for it.** If you cannot say which fact,
  gauge or constraint is absent, you have a hunch, not a diagnosis.
- **Prefer the cheapest station.** Writing a missing requirement into the task
  text matched a purpose-built done-gate at ~32% fewer turns
  (spec beats the gate).
  Mechanisms are the expensive option; reach for them when the spec is one you do
  not control.
- **A mechanism that never fires is not a mechanism.** Check engagement before
  reading any outcome. The anti-spiral gate was structurally unable to fire, and a
  pass-rate win was recorded against it that the engagement check invalidated.
- **Say when you have not established it.** "No ceiling found on two fixtures" is
  not "no ceiling exists." Today's evidence is strong and narrow.

## The measured record behind this

Eight distinct failure causes were traced to root on 2026-07-30. Every one was
context, harness or benchmark; none was model capability:

| Failure | Cause |
| --- | --- |
| Model edited its own test file, run graded CHEAT | scope guard shipped default-off |
| Async deadlocks, 9 of 15 runs | verifier blind to queued work |
| Passing a 13-test suite and still failing | no concurrency check during drain |
| Confident wrong `parseEnabled` | task never stated the rejection requirement |
| Anti-spiral gate never fired in a 26-turn spiral | trigger condition unsatisfiable |
| Advisory ignored 3/3 | delivered at the wrong turn, not worded wrongly |
| Hidden-contract failures displayed as `----` | unmapped status in the formatter |
| 4,336 lines of self-improvement output | built, sometimes tested, never wired in |


**When BANTAM makes a bad choice, the cause is almost always the context — not
the model.** Before concluding "the model can't do this," study the exact
context it was handed at the exact turn it went wrong.

Every fix in the 2026-07-13/14 self-hosting arc had the same shape: the harness
*knew* something true and either failed to say it, or said something false.

| The model's "bad choice" | What the context actually said | The fix |
| --- | --- | --- |
| Re-read the same file 41 times | Nothing — the file was in `<open_files>` but nothing said so | Panel short-circuit (#22) |
| Ran `node --test \| grep 'not ok'` 17× on a green suite | grep exits 1 with no output; a pass looked like a crash | Pipe guard runs the test bare (#20) |
| Called `client.models()` — a method that does not exist | Nothing checked the API until the test suite, 20 turns later | api-check at edit time (#15) |
| Retried the same failed `replace` six times | "not found" — no position, no reason | Divergence diagnosis naming the exact line and the invisible U+FEFF (#17/18) |
| Chased a regression it had not caused | "You broke working code" — after a flaky suite, with no edit in between | Flaky-suite notice (#30) |
| Scrolled a 1,500-line file 100 lines at a time | Nothing named `search` as the faster route | Paging steer + one-turn read mask (#26) |

In each case the model was behaving *correctly* given what it believed. The
defect was in what it was told.

## The capstone proof (2026-07-14)

The strongest evidence in the whole arc, because it was measured, not argued.
Self-hosting run v31 built a working `bantam exec`, wrote its own test suite, and
drove it from 4 failures to 1. The survivor was an argument-parser bug:
`exec --json --endpoint URL task` worked; `exec --endpoint URL --json task` did
not (`--json` wrongly consumed the task as its value, so the task was lost and
the command exited "usage error").

The model **found the buggy function** (`parseArgs`) and **rewrote it three
times, byte-for-byte identically.** It could not see the flaw. It was one edit
from a reasoning-ceiling verdict.

We rewound to the stuck turn and replayed it with one injected sentence — *"`--json`
is a boolean flag; it takes no value, so `--json <task>` must not consume the
task."* With that context the model produced the correct fix on the first try, in
**all three samples**, adding a `BOOL_FLAGS` set correctly populated from the
codebase's real boolean flags. Tested standalone, its new `parseArgs` handled
both argument orders correctly.

The fact it needed — *`--json` is boolean* — was already present in the model's
own `usage()` string. The harness never connected the usage text (which declares
every flag's arity) to the parser (which ignored it). **Not a reasoning limit. A
context omission.** When the model has localized the bug and can implement the
fix given the missing fact, "the model can't do this" is provably false.

## The working rules

1. **Stop at the first bad turn.** Do not run the loop to completion hoping it
   recovers. A failure is a specimen; collect it while it is fresh.
2. **Read the actual context.** Not a summary of it — the assembled prompt for
   that turn (`BANTAM_SAVE_PROMPTS=1` records it; `bantam replay` reconstructs
   it).
3. **Test the counterfactual, don't argue it.** Replay that one turn with an
   adjusted context and see whether the decision changes. Thirty seconds beats
   an eighty-minute rerun and a hypothesis.
4. **Every rejection carries its correction.** "No" without "here is the right
   move" is a turn spent teaching nothing. Where the harness can simply *do*
   the right thing (run the test unfiltered, list the directory, serve the
   slice), it should.
5. **Words persuade; constraints bind.** Advisory text moved this 27B about a
   third of the time; the same instruction with the wrong verb masked out of
   the grammar moved it every time. State the rule, then make the wrong move
   unavailable.
6. **Say only true things.** A false signal ("you regressed") is worse than
   silence: the model will act on it, correctly, and waste the run.
7. **Measure before and after.** A fix that is not A/B'd against the recorded
   failure is a guess with better prose.

## The self-improvement loop (`bantam diagnose`)

The manual loop above is now mechanized. Given any recorded run:

```bash
bantam diagnose .bantam/runs/<run>.json            # witness: which turns went wrong, and why
bantam diagnose <run>.json --turn 21 --samples 3   # rewind: A/B candidate contexts on that turn
```

- **Witness** — scan the trajectory for the harness's own distress signals
  (duplicate actions, failed edits, reverts, phantom replaces, redundant reads,
  invalid outputs) and classify each into a problem kind.
- **Rewind** — for a problem turn, replay the exact recorded request against
  the live model; an injected candidate context is explicitly labelled a
  counterfactual rather than overclaiming byte-exact fidelity.
- **Score** — classify each resulting action as recon / productive / repeat and
  compare the distributions. A remedy that moves the model from recon-loop to
  productive work is a real improvement, not a plausible one.
- **Preregister** — a remedy that wins is written into an experiment manifest
  with its measured lift. Only a later channel promotion changes `regular`;
  diagnosis itself never mutates ambient knowledge.

This is the same distillation idea as the self-building skills library, pointed
at the harness instead of the task: the model witnesses its own failure, the
harness proposes the context that would have prevented it, and only measured
wins ship.

## The second principle: agent performance belongs to the whole system

The first controlled native-Codex comparison established a second principle:

> **A stronger model does not eliminate the need for a strong harness. The
> model, context, action space, tools, state, verifier, recovery policy, and
> stopping rule jointly determine observed performance.**

On the ordered-map repair, BANTAM-constrained Sol and Terra reached the same
hidden-contract pass as native Codex CLI controls while using less elapsed
time, total provider-reported input, output, and reasoning output. The result
does not mean BANTAM changed Codex's intelligence. It means BANTAM removed
agent-management work Codex would otherwise perform through inference.

The native general agent had to solve both:

1. the software repair; and
2. how to explore, operate, remember, verify, recover, and stop.

BANTAM implemented much of the second problem in deterministic infrastructure.
Codex could concentrate on semantic decisions:

```text
Codex:
  understand intent
  localize behavior
  diagnose semantics
  choose the repair
  interpret unfamiliar evidence

BANTAM:
  preserve explicit state
  constrain legal actions
  execute validated operations
  bound observations
  run authoritative verification
  admit or reject completion
  retain comparable telemetry
```

This is why six narrow BANTAM requests can represent less total work than one
native outer turn. An outer turn may contain many model messages, tool
operations, reconsiderations, and context updates. Request count is not the
same as cognitive work.

The operational rule is:

> **Move recurring mechanical reasoning into tested infrastructure. Preserve
> model freedom where semantic judgment remains necessary.**

Constraint helps when it removes irrelevant branches, ambiguous state, invalid
operations, and subjective stopping decisions. Constraint hurts when the task
requires an action or observation the harness cannot express. BANTAM must
therefore maintain and measure its capability envelope rather than assuming
that either constrained or native execution is globally superior.

The native Codex delegate remains valuable as:

- an escape hatch beyond BANTAM's current action envelope;
- an experimental baseline;
- a source of new tool and policy ideas.

It is research-only by default because the current paired evidence favors
constrained Codex for ordinary bounded work.

For the full measurements, causal account, capability-envelope model, threats
to validity, and research program, see
[Why Codex Works Efficiently Inside BANTAM](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md).

---

## The third principle: the instrument lies before the model does

Every finding below is from a single day (2026-07-31 / 08-01) of measuring BANTAM
against Codex. Not one was a bug in the agent. All of them were bugs in the things
that *watch* the agent, and each produced a confident, plausible, wrong number that
redirected real engineering.

### Absent is not zero, and "no observation" is not "failure"

The recurring shape. An instrument reaches for a value, does not find one, and
reports a number anyway:

| what happened | what it claimed |
| --- | --- |
| 34 of 42 agent counters never copied into the artifact | "no gate ever fired for Codex" |
| a competitor blocked by a read-only sandbox | "codex FAIL 0/4 — winner: bantam-codex" |
| an eval hitting an exhausted account | "evidence-invalid" — a broken fixture |
| a missing grader | `0/0`, which reads as a clean sheet |
| a gate with no evaluation counter | indistinguishable from a gate that is unreachable |
| a run killed by the wall clock | scored as a capability failure |

**Rule: an instrument that cannot see must say so.** `available: false`, `blocked`,
`NO-VERDICT`, `not-instrumented`, `NOT RECORDED` — never a default that reads as a
result. Three of the six above would have produced a *flattering* number, which is
worse than a crash, because a crash does not get published.

### A measurement taken where something is cheap does not transfer

Four defaults were wrong the same way — generalised from the regime where the cost
happened to be near zero.

| default | measured on | true cost elsewhere |
| --- | --- | --- |
| grounding KB on | 2-file fixture, **14 ms** | 198-file repo, **28,498 ms** |
| `high` reasoning effort | never A/B'd | −50% reasoning tokens at medium, same result |
| completion audit on | assumed useful | **+54% turns** on Codex |
| wider `inspect` batching | "saves a turn" | **+61% cache misses** |

**Rule: state the regime a measurement came from, and bound the default to it.**
The grounding default now carries a 40-file budget for exactly this reason — and
that guard was added an hour after shipping the unqualified version, by the same
person writing this paragraph.

### Growth is free; rewriting is paid twice

BANTAM builds a full prompt each turn and the provider delivers it as a delta.
Appended bytes cost their own size. Bytes that change *after being sent* invalidate
the prefix cache **and** enlarge the delta suffix — the same waste billed twice.
Four separate mechanisms were quietly rewriting history: a file body restored when
the open-files window slid past it, a pointer with two wordings, replayed edit
bodies following the same window, and a panel ordered by recency.

**Rule: prompt assembly is append-only until proven otherwise.** None of these were
visible in a diff. The prompt always looked correct; it just was not the same bytes
twice.

### The same mechanism can be worth its cost for one worker and not another

Measured per-model, every arm passing the hidden contract identically:

| mechanism | effect on Codex |
| --- | --- |
| state audit | −14% turns, −39% cache miss |
| grounding KB (small trees) | −16% turns, −22% cache miss |
| blast-radius context | −12.5% turns |
| completion audit | **+54% turns** |
| sixteen rejection gates | evaluated every run, never fire |

The gates were all built from failures a local 27B genuinely makes. A frontier
model does not make them, so they stay silent — while the *advisory* mechanisms do
the real work. **Rule: supervision defaults fork per model, and each fork needs its
own measurement.** A jig that stops a novice inserting the part backwards is
friction for someone who has done it ten thousand times.

### A rule you cannot apply before measuring is a summary, not a predictor

After the completion-audit result, "a specific fact helps, a general instruction
costs" looked like a clean generalisation. It was pre-registered against the state
audit and **falsified on the very next case**: the state audit reads as an
instruction and is the most valuable mechanism measured. Afterwards it is obviously
a compressed expert briefing wearing an instruction's grammar — but that reading
was not available in advance, to the person who had just written the rule.

**Rule: keep the generalisation, and keep measuring anyway.** The cost of one A/B
is about six minutes. The cost of trusting a plausible rule was, in one recorded
case, a 46.5%-headroom figure that would have justified building parallel dispatch
nobody needed.

### The corollary for this project

BANTAM's first principle says failures are context, not capability. Today extends
it one layer: **before trusting a finding about the agent, check that the
instrument could have seen the alternative.** Eleven times in one day, it could
not — and every one of those instruments was itself part of BANTAM.

## The fourth principle: an instrument drifts toward flattering whoever built it

The third principle says the instrument lies before the model does. This one is
narrower and more uncomfortable: **when the instrument is built by the party it
measures, its errors are not randomly distributed.** They point one way.

`bantam compare` exists to answer whether BANTAM+Codex beats bare Codex. Four
separate defects were found in it in one afternoon, and all four favoured BANTAM:

| defect | what it did |
|---|---|
| preference-order tiebreak | crowned `bantam-codex` on any tie |
| unrun arms scored | `--only` printed the other three as `FAIL 0/0` |
| solo arm crowned | one arm alone "beat" four that never competed |
| blocked arm counted | a competitor the harness stopped counted as beaten |

None was written in bad faith. Each is the kind of shortcut that looks reasonable
at the moment it is typed. The asymmetry does not come from intent — it comes from
the fact that a result flattering the subject *terminates the investigation*, and
an unflattering one prompts a second look. **The bias is in which errors get
caught, not in which get made.**

### The variable you did not name is not held constant

The sharpest instance. The comparison's own opening comment states the claim —
"the SAME Codex model, once driven by BANTAM and once bare" — while the code
spawned the competitor as a bare `codex exec` with no `--model`, so it ran whatever
`~/.codex/config.toml` defaulted to. Subject: `gpt-5.6-terra`. Competitor:
`gpt-5.6-sol`.

Five head-to-heads were run, reported, and believed before anyone checked. Pinning
the model took one fixture from **3.7× to 1.5×**. Over half the celebrated
"harness advantage" was one model being slower than another.

**A comparison that fails to control its main variable does not produce a weaker
finding. It produces a finding about something else, phrased as though it were
about the thing you asked.** The stated claim and the executed claim were different
sentences, and only the stated one was ever read.

### The practical rule

Before believing a comparison — especially your own — answer three questions:

1. **How does it break ties?** A tie reported as a win is the most consequential
   form of the lie, because it lands in the one line everybody reads.
2. **What does it do with the cases it did not observe?** Unrun, blocked, and
   timed-out are missing observations. Scoring them as losses manufactures wins.
3. **Is every variable the claim does not mention actually held constant?** Read
   the spawn arguments, not the comment above them.

And one heuristic that would have caught all of it sooner: **an excellent result is
a reason to audit the instrument, not a reason to stop.** The invalid 2.8× sweep
was never questioned precisely because 2.8× was the number we wanted.

### What survived the audit

The honest answer, with the model controlled across seven fixtures: BANTAM+Codex
scores **identically** to bare Codex on every hidden contract — it does not make
Codex more correct, anywhere — and finishes sooner on all seven, 1.32× in
aggregate (two-sided sign test, p = 0.016). A real, modest, defensible result,
which is worth more than the impressive one it replaced.
