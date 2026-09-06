# Fresh factory fight cards — September 6, 2026

This is a new exploratory series, not a rewrite of the historical fight board.
The tasks and judges were developed before the scored model runs. All attempts,
including integration failures and losing candidates, remain on the record.

## Work orders

Each card is an independent Node.js builtins-only tool. Every corner receives
identical task and starter bytes. No corner's output becomes a rival's starter.

| Card | Work | Independent acceptance groups |
| --- | --- | --- |
| Receipt reducer | Build a JSONL job-attempt report and CLI | Ordering, duplicate identity, strict fields, lifecycle rules, CLI |
| Snapshot drift | Extend a supplied selected-file manifest builder | Byte/mode drift, source identity, unsafe/missing paths, validation, CLI |
| Job planner | Repair deterministic dependency planning and CLI | Lexical Kahn order, transitive failed ancestors, current readiness, validation/cycles, CLI |

Full contracts and protected public tests live in
`examples/fights/factory-2026-09-06/`. Five external groups per card test only
requirements declared in the public task. Reviewer implementations are used to
qualify gauges, never delivered to contestants. The three gauges accepted all
three reviewer implementations and rejected the unfinished starters and 15
deliberately faulty variants in offline, read-only Docker qualification.
These are behavioral tests for ordinary generated code, not proof against a
malicious candidate subverting the grader process.

## Six corners

- Local 27B in BANTAM, cache-fast extension/immutable history, **probe enabled**,
  full prompt recording and factory telemetry, no cloud teacher.
- The identical 27B in DeepSeek Harness's published standard/headless profile.
- The identical 27B in OpenCode.
- The identical 27B in Hermes.
- Native Codex CLI, exactly `gpt-6-astra`, medium effort.
- BANTAM-constrained Codex app-server, exactly `gpt-6-astra`, medium effort,
  cache-fast extension/immutable history and probe enabled.

The BANTAM probe remains opt-in in the product. This series measures that
explicit configuration, not an unconfigured first install. The local model is
the operator's current Qwen3.8 27B GGUF, **not a claim about stock Qwen weights**.
The model file SHA-256, server metadata and actual request settings are captured
in the run manifest. Native main/auxiliary model requests use the same supplied
local endpoint; title generation and other auxiliary calls count in totals.

Installed native runtimes are pinned/identified rather than silently upgraded:
DeepSeek Harness 0.1.2-rc.1 on Node 22.19.0; OpenCode 1.18.23; Hermes
0.20.0/release 2026.8.3. Per-run launch receipts retain executable/configuration
digests and container metadata. BANTAM and native Codex use the installed Node
20 toolchain; DeepSeek's minimum runtime requires Node 22. These differences,
native sampling, tool contracts and resource caps are part of the tested system.
This is a same-weights harness comparison, **not a pure context-only ablation**.

## Protocol fixed before scoring

One initial pass comprises three cards by six corners: 18 runs. Each has a
600-second wall ceiling; BANTAM also has its existing 60-turn ceiling. Order
rotates by two corner positions between cards. In the revised series, the local
queue and frontier queue run concurrently to reduce total waiting time; each
queue itself is serial. No two local inference runs share the GPU at once.
Frontier tool activity can still contend for host CPU/IO, so these timings are
not fully isolated latency measurements. The local endpoint is checked idle
before each local run. It is not restarted or cache-erased:
shared-server warm state and any cross-run prefix reuse remain possible.

Task/material, runtime source and judge hashes are frozen before generation,
checked before and after each contender and after grading. Presentation and
exchange exporters are deliberately outside the runtime-source seal: they may
be built while fights run but cannot affect task execution or acceptance.
No prompts, implementations, budgets or gauges are tuned in response to scores
within this series. A discovered experimental defect requires a separately
identified revision and retained original evidence.

Each candidate is inspected only after the model process and its exact owned
container have stopped. Public tests and the hidden gauge run in separate
offline read-only Docker inspections, without model-account credentials.
Protected package/public-test tampering prevents acceptance. A valid final
grader record must contain the exact expected groups; a bare process exit 0 is
insufficient. Candidate correctness and clean harness completion are recorded
separately, including correct artifacts left by a timed-out/incomplete run.

The outer peer container is filesystem isolation, not network-egress isolation:
host networking reaches the loopback model recorder, and other network services
remain reachable. Codex needs provider network access and saved CLI auth mounted
read-only. No private repository tree, hidden judge, operator home or unrelated
credentials are supplied to a competing agent. This is not a hostile-agent
credential-secrecy certification.

## Metering and the replay chain

Local contenders all pass through the same loopback HTTP recorder. It forwards
request bodies unchanged, preserving actual prompts, tool definitions, context
injections, sampling and streaming responses. Authorization headers are neither
stored nor forwarded. Final usage is normalized once per generation request,
including auxiliary calls. Missing/malformed usage is unknown, never zero.
Fresh input means total prompt input minus the reported reused prefix.

The local server's independent fresh/cache/generated-token counters are also
captured before and after each run. These are endpoint-wide window counters;
their attribution assumes no external inference client. They are retained for
reconciliation, not silently substituted for contradictory wire receipts.

Native Codex retains session rollouts; distinct response-usage records provide
per-request counters and are cross-checkable against final CLI totals. Wrapped
Codex retains BANTAM's exact request/response artifacts, delivered-context
records and factory traveler. Provider-side undisclosed context is not observable
and is not represented as captured evidence.

Wall time covers contender process startup through exit, not just generation.
Grading time is separate. Input, output, cached and fresh input, request count,
completion, individual inspection groups, commands, source and context evidence
stay available behind the headline result. Attractive presentation must preserve
losses and uncertainty. A faster failed artifact does not win a quality comparison.

## Running and sharing

The [context audit](FRESH-FACTORY-CONTEXT-AUDIT-2026-09-06.md) traces the completed
Astra runs and the first local card without modifying candidates or requesting
additional inference. At the user's subsequent request, a separate native-only
Sol/Terra comparison uses the same three cards, medium effort and 600-second
deadline, alternating model order. Its six runs overlap the remaining local
queue; they do not rewrite the frozen six-corner main series.

```sh
node scripts/factory-frontier-sidecar.mjs /absolute/new/sol-terra-follow-up
```

The follow-up saves distinct native-response usage and verifies the model and
effort recorded in native turn contexts. These are observations of CLI selection,
not attestations of provider internals. Model selection was checked against
[official Codex model documentation](https://learn.chatgpt.com/docs/models)
and the installed client's model metadata.

### Output-policy correction and retained diagnostic series

After the first receipt-reducer attempts, both DeepSeek Harness and OpenCode
exhausted the configured 8,192-token combined response budget before writing
an implementation. The saved responses report `finish_reason: length`.
BANTAM's native local loop separates a reasoning request of up to 4,096 tokens
from an action request of up to 8,192 tokens and can force that transition.
The original result is therefore evidence about the configured systems, not
evidence that those peers cannot complete the task with the same model.

The initial plan was to complete the 8K series and then run all nine peer cells
again at 32K. That was amended before the remaining cards were judged: continuing
the known cap-confounded setup would waste additional inference. The original
`factory-fights-v1` was stopped after three completed receipt-reducer results.
The active Hermes attempt was explicitly operator-interrupted and remains
unscored, not a natural failure or timeout. Its `INTERRUPTED.md` retains that
history; original result records and candidates were not rewritten.

The revised full 18-run series, `factory-fights-v2-32k`, restarts all six
contenders from original materials. All three native local peers receive a
32,768-token main-response allowance and the same 600-second wall ceiling,
unchanged tasks, starters, judges, weights and server. Native short auxiliary
calls keep their own budgets and remain metered. This is an
**output/reservation-policy correction**, not a pure context ablation: a native
harness may reserve additional output space and compact its input earlier.
It has separate configuration and source seals. At the user's request to
accelerate testing, its local and frontier queues overlap as described above.
The 8K diagnostic run is not pooled with it into an undifferentiated leaderboard.

```sh
# New output directories only. Preflight is a separate non-scored tiny task.
node scripts/factory-fight-preflight.mjs /absolute/new/preflight
node scripts/factory-fights.mjs /absolute/new/fights --peer-output-tokens 32768
node scripts/factory-fight-replay.mjs /absolute/new/fights
node scripts/factory-fight-export.mjs export /absolute/new/fights
```

Raw evidence stays under ignored local acceptance storage; no publication or
repository visibility change is part of this run. Full replay exports can contain
private source, paths and transcripts: inspect before sharing. Machine-readable
cards are unsigned evidence, not trusted instructions or installable skills.
Another factory may propose a context jig from a replay, then qualify it locally
before adopting it. A hash establishes byte identity, not a trustworthy author,
sufficient judge, or universally useful improvement.

For a clean early stop, create `STOP_AFTER_CURRENT` in the output directory.
Both queues finish their current contenders and stop before starting another.
`--serial` selects non-overlapping queues. Contender wall time, independent
public/hidden grading durations and their sum are retained separately in the
revised result records; the headline contender clock excludes grading.

This first series measures bounded implementations on three new public contracts.
It does not establish broad parity with frontier models, production-readiness on
all hardware, or a statistically stable leaderboard. Repeated unfamiliar cards
and explicit human-intervention accounting remain the next qualification step.

Official interfaces checked during setup:
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[DeepSeek Harness](https://deepseek.com/harness/en/),
[OpenCode](https://opencode.ai/docs/),
[Hermes](https://hermes-agent.nousresearch.com/docs/).
