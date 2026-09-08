# Stream framer · native Claude Code references

[Watch the attempts](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Three fresh native Claude Code attempts on the same frozen work order, starter
and independent acceptance checks used by the
[launch card](../../stream-framer/README.md). All three completed accepted
work. These are separately recorded references beside that card, not additions
to its roster.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| Claude · native Sonnet | PASS | 5/5 | 125.9 s |
| Claude · native Opus | PASS | 5/5 | 185.7 s |
| Claude · native Fable | PASS | 5/5 | 128.3 s |

For context, this is the work order BANTAM FACTORY's earlier local 27B attempt did not
finish: it timed out at 4/5 at the 600 s limit, while native Codex Astra
passed in 160.7 s. That disclosed loss stands. Different models and run
windows: individual observations, not a ranking.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| Claude · native Sonnet · native aggregate | 321,517 | 11,975 | 299,106 | 22,411 |
| Claude · native Opus · native aggregate | 481,769 | 14,763 | 458,394 | 23,375 |
| Claude · native Fable · native aggregate | 325,357 | 10,167 | 306,209 | 19,148 |

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

These attempts ran serially in their own queue while separate local/Codex
comparisons were recording on the same machine, so CPU and I/O contention
remained possible. The local model was not used by Claude. Work-order and
starter materials were frozen; candidates received the same independent
graders. Public exports omit raw prompts, source, credentials and machine
paths. Asset hashes cover generated files, not these notes.

</details>
