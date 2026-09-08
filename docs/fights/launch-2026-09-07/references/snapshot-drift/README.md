# Snapshot drift · native Claude Code references

[Watch the attempts](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Three fresh native Claude Code attempts on the same frozen work order, starter
and independent acceptance checks used by the
[launch card](../../snapshot-drift/README.md). All three completed accepted
work. These are separately recorded references beside that card, not additions
to its roster.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| Claude · native Sonnet | PASS | 5/5 | 35.7 s |
| Claude · native Opus | PASS | 5/5 | 74.8 s |
| Claude · native Fable | PASS | 5/5 | 82.5 s |

For context, BANTAM's earlier local 27B attempt on this work order passed 5/5
in 124.3 s, and native Codex Terra in 106.2 s. Those came from a different run
window and, for BANTAM, a different model. Individual observations, not a ranking.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| Claude · native Sonnet · native aggregate | 246,731 | 3,609 | 232,567 | 14,164 |
| Claude · native Opus · native aggregate | 150,244 | 6,893 | 135,902 | 14,342 |
| Claude · native Fable · native aggregate | 158,178 | 7,694 | 142,546 | 15,632 |

Each row is the CLI's complete final native input/output/cache aggregate, not
request-level HTTP receipts. Input already includes cached input; fresh input
includes cache creation. Do not add overlapping columns. The CLI's reported
costs remain private metadata, not a claim about subscription billing.

## Conditions and provenance

Frozen factory source `ecc26d8` (worktree revision carrying the explicit
`claude-fable` lane). Claude Code 2.1.263, standalone Linux x64 installation.
The selected `sonnet`, `opus` and `fable` aliases reported `claude-sonnet-5`,
`claude-opus-5` and `claude-fable-5-1` respectively, all at medium effort,
using the CLI's native system prompt and tools inside an outer non-root Docker
boundary. User settings, skills and external MCP servers were disabled; the
existing file credential was mounted read-only. Offline dummy-auth runtime
checks passed before scoring. No installer, login or manual candidate repair.

These attempts ran serially in their own queue while a separate local/Codex
job-planner comparison was recording on the same machine, so CPU and I/O
contention remained possible. The local model was not used by Claude.
Work-order and starter materials were frozen; candidates received the same
independent graders. Public exports omit raw prompts, source, credentials and
machine paths. Asset hashes cover generated files, not these notes.
