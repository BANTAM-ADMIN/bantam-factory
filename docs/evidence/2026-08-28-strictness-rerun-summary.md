> Copied from the experiment's own output for the record. The full evidence
> directory — per-run films, catalog, trajectory audit — is written to
> `.bantam/experiments/2026-08-28T18-26-58-355Z-qwen38-strictness-ab-v1/`,
> which is gitignored: this repo deliberately ships no run artifacts. The
> `runs/...json` paths below are relative to that directory. Re-derive by
> running the pinned spec: `node bin/bantam.js experiment
> docs/evidence/2026-08-28-strictness-rerun-spec.json` against a local server.

# qwen38 strictness ab v1

Status: complete_with_failures
Experiment: `2026-08-28T18-26-58-355Z-qwen38-strictness-ab-v1`
Spec SHA-256: `cee93d849fd59856d221dbd87777691ec55004a9c6811d333d2775b63d1ece2b`
Order counterbalancing: best possible (max position imbalance 1)

| Arm | Sweeps | Tasks | Passed | Strict | Turns | Requests | Native threads | Reused calls | Rebases | Terminal rebases | Post-rebase calls | Delivered prompt | Delivery saved | Delta calls | Input tok | Output tok | Cache hit | Cache miss | Reasoning tok | Prompt chars | Prefix reuse | Added suffix | Replaced suffix | Cost USD | Invalid | Protocol | Duplicates | Shell duplicates | No-op edits | Outcome repeats | Outcome hints | Completion audits | State audits | Masks | Progress rejects | Progress stops | Patch exposed | Patches | Patch failures | File ops exposed | Deletes | Moves | File-op failures | Gen tok | Think tok | Action tok | Task time | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen38-rebuild | 5 | 10 | 10 | 10 | 98 | 139 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | 0 | 606068 | 20694 | 422846 | 0 | 0 | 2506049 | 83.2% | 402046 | 272488 | 0.000000 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 10 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 20694 | 6321 | 14373 | 337.320 s | 339.422 s |
| qwen38-extension | 5 | 10 | 8 | 8 | 95 | 131 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | 0 | 668924 | 25800 | 600558 | 0 | 0 | 2777596 | 90.8% | 246003 | 33186 | 0.000000 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 10 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 25800 | 8480 | 17320 | 350.042 s | 352.122 s |

Escalation decisions: qwen38-rebuild complete 10 · qwen38-extension complete 8, diagnose-with-teacher 1, repair-context 1

Codex prompt integrity: qwen38-rebuild 0/0 exact, 0 failures · qwen38-extension 0/0 exact, 0 failures

Complete run integrity: qwen38-rebuild 10/10 applicable pass, 0 n/a, 0 failures, 0 warnings · qwen38-extension 10/10 applicable pass, 0 n/a, 0 failures, 0 warnings

External workspace coherence: qwen38-rebuild 0 events / 0 paths / 0 stale actions blocked · qwen38-extension 0 events / 0 paths / 0 stale actions blocked

Evaluator scope transactions (direct refusals / shell rollbacks / restored files): qwen38-rebuild 2 / 0 / 0 · qwen38-extension 1 / 0 / 0

Visual completion audit interventions (hints / alt revisions): qwen38-rebuild 0 / 0 · qwen38-extension 0 / 0

Lexical contract audit interventions: qwen38-rebuild 10 · qwen38-extension 10

Visual alt coverage interventions (hints / alt revisions): qwen38-rebuild 0 / 0 · qwen38-extension 0 / 0

## Gate interventions

| Arm | Gate | Rejections |
| --- | --- | ---: |
| qwen38-rebuild | empty_done | 4 |
| qwen38-rebuild | evidence | 0 |
| qwen38-rebuild | type_contract | 5 |
| qwen38-extension | empty_done | 1 |
| qwen38-extension | evidence | 1 |
| qwen38-extension | type_contract | 5 |

## Usage by source

| Arm | Source | Requests | Input tok | Output tok | Cache hit | Cache miss | Reasoning tok |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen38-rebuild | action_generation | 139 | 606068 | 20694 | 422846 | 0 | 0 |
| qwen38-extension | action_generation | 131 | 668924 | 25800 | 600558 | 0 | 0 |

## Tool outcomes

| Arm | pass |
| --- | ---: |
| qwen38-rebuild | 0 |
| qwen38-extension | 1 |

## Failure evidence

| Arm | Round | Fixture | Status | Contract | Artifact |
| --- | ---: | --- | --- | --- | --- |
| qwen38-extension | 4 | channel-filter | contract-fail | fail (1/2 passed) | `runs/qwen38-extension/round-04/channel-filter-run-2026-08-28T18-33-56-709Z-2b6ac7.json` |
| qwen38-extension | 5 | channel-filter | contract-fail | fail (1/2 passed) | `runs/qwen38-extension/round-05/channel-filter-run-2026-08-28T18-37-11-360Z-adebce.json` |

## Reliability

Wilson 95% intervals describe observed binary runs; they do not account for fixture-selection bias.

| Arm | Runs | Pass rate | Wilson 95% | pass@1 |
| --- | ---: | ---: | ---: | ---: |
| qwen38-rebuild | 10 | 100.0% | 72.2%-100.0% | 100.0% (2/2) |
| qwen38-extension | 10 | 80.0% | 49.0%-94.3% | 80.0% (2/2) |

### qwen38-rebuild

| Fixture | Runs | Passed | Turns | Requests | Input tok | Output tok | Cache hit | Reasoning tok | Duplicates | Masks | Progress rejects | Progress stops | Outcome repeats | Outcome hints | Completion audits | State audits | Gen tok | Think tok | Action tok | Task time | Pass rate | Wilson 95% | pass@1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| channel-filter | 5 | 5 | 58 | 83 | 361797 | 10377 | 254190 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 5 | 0 | 10377 | 3329 | 7048 | 181.374 s | 100.0% | 56.6%-100.0% | 100.0% |
| channel-filter-explicit | 5 | 5 | 40 | 56 | 244271 | 10317 | 168656 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 10317 | 2992 | 7325 | 155.946 s | 100.0% | 56.6%-100.0% | 100.0% |

### qwen38-extension

| Fixture | Runs | Passed | Turns | Requests | Input tok | Output tok | Cache hit | Reasoning tok | Duplicates | Masks | Progress rejects | Progress stops | Outcome repeats | Outcome hints | Completion audits | State audits | Gen tok | Think tok | Action tok | Task time | Pass rate | Wilson 95% | pass@1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| channel-filter | 5 | 3 | 53 | 72 | 352593 | 9844 | 322983 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 5 | 0 | 9844 | 2405 | 7439 | 135.786 s | 60.0% | 23.1%-88.2% | 60.0% |
| channel-filter-explicit | 5 | 5 | 42 | 59 | 316331 | 15956 | 277575 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 15956 | 6075 | 9881 | 214.256 s | 100.0% | 56.6%-100.0% | 100.0% |

Reference arm: `qwen38-rebuild`

- `qwen38-extension` minus `qwen38-rebuild`: pass -2, pass rate -20.0 pp, strict -2, turns -3, requests -8, input tokens +62856, output tokens +5106, cache hits +177712, reasoning tokens 0, generated tokens +5106 (think +2159, action +2947), duplicate action replays -1, shell duplicate replays -1, immutable edit refusals -1, shell scope rollbacks 0, restored scope files 0, no-op edits +1, outcome repeats 0, outcome hints 0, completion audits 0, lexical audits 0, visual audits 0, visual audit alt revisions 0, visual coverage hints 0, visual coverage alt revisions 0, state audits 0, external change events 0, external paths 0, stale actions blocked 0, progress rejects 0, progress stops 0, patch exposure 0, patches 0, patch failures 0, file-op exposure 0, deletes 0, moves 0, file-op failures 0, task time +12.722 s, wall time +12.700 s.
- Pass@k deltas: pass@1 -20.0 pp.
