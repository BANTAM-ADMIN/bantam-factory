# Native Claude Code references

Fresh native Claude Code attempts on the launch work orders, three models per
work order: the `sonnet`, `opus` and `fable` aliases, which reported
`claude-sonnet-5`, `claude-opus-5` and `claude-fable-5-1`. Each reference card
is a separately recorded package beside the launch card of the same name. It is
never merged into that card's roster and never feeds the gallery's featured
same-model comparison.

| Work order | Claude Sonnet | Claude Opus | Claude Fable | BANTAM local attempt |
|---|---:|---:|---:|---:|
| [Receipt reducer](receipt-reducer/README.md) | 36.6 s · 5/5 | 89.4 s · 5/5 | 58.5 s · 5/5 | [112.5 s · 5/5](../receipt-reducer/README.md) |
| [Snapshot drift](snapshot-drift/README.md) | 35.7 s · 5/5 | 74.8 s · 5/5 | 82.5 s · 5/5 | [124.3 s · 5/5](../snapshot-drift/README.md) |
| [Job planner](job-planner/README.md) | 49.7 s · 5/5 | 64.2 s · 5/5 | 65.4 s · 5/5 | [193.2 s · 5/5](../job-planner/README.md) |

All nine attempts passed 5/5 with complete native aggregate token and cache
accounting. Every Claude attempt here was quicker than BANTAM's local 27B
attempt on the same work order. Different models, native policies and run
windows matter: this table compares individual observations across cohorts,
not simultaneous trials or a general ranking. The launch cards and all their
contender outcomes remain unchanged. References for the remaining launch work
orders are recording and are not results until published here.

## Shared conditions

Frozen source `ecc26d8`, the revision that added the explicit `claude-fable`
lane; Claude Code 2.1.263, standalone Linux x64 installation. All attempts used
medium effort and the CLI's native system prompt and tools inside an outer
non-root Docker boundary. User settings, skills and external MCP servers were
disabled; the existing file credential was mounted read-only. Offline
dummy-auth runtime checks passed before scoring. No installer, login or manual
candidate repair was used.

Claude attempts ran serially in their own queue while a separate local/Codex
comparison was recording on the same machine, so CPU and I/O contention
remained possible. The local model was not used by Claude. Work-order and
starter materials were frozen; candidates received the same independent
graders.

Each card contains a complete final native input/output/cache aggregate. These
are not request-level HTTP receipts. Input includes cache creation and reads;
fresh input includes cache creation. Do not add overlapping scopes. The CLI's
reported costs remain private metadata, not a claim about subscription billing.
Public exports omit raw prompts, source, credentials and machine paths. Asset
hashes cover generated files, not these notes, authorship or permission to
execute imported material.

The earlier [September 7 reference set](../../claude-references-2026-09-07/README.md)
recorded Sonnet and Opus on Context packet and Patch transaction from source
`96b6d1a`. It is retained unchanged as a separate cohort.
