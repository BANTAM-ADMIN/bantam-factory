# Patch transaction · native Claude Code references

[Watch the attempts](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Three fresh native Claude Code attempts on the same frozen work order, starter
and independent acceptance checks used by the
[launch card](../../patch-transaction/README.md). All three completed accepted
work. These are separately recorded references beside that card, not additions
to its roster.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| Claude · native Sonnet | PASS | 5/5 | 81.5 s |
| Claude · native Opus | PASS | 5/5 | 153.5 s |
| Claude · native Fable | PASS | 5/5 | 41.2 s |

For context, BANTAM FACTORY's earlier local 27B attempt on this work order passed 5/5
in 81.8 s and native Codex Astra in 90.3 s. Fable's attempt was quicker than
BANTAM FACTORY's; Sonnet's was within a second of it; Opus's was slower. Those came
from a different run window and, for BANTAM FACTORY, a different model. Individual
observations, not a ranking.

**Inside each contender:** a short explanation, the recorded actions and their results, delivered files with before/after changes, and the acceptance output.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| Claude · native Sonnet · native aggregate | 212,980 | 7,151 | 196,202 | 16,778 |
| Claude · native Opus · native aggregate | 384,296 | 13,091 | 363,963 | 20,333 |
| Claude · native Fable · native aggregate | 70,082 | 3,691 | 59,700 | 10,382 |

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
comparison was recording on the same machine, so CPU and I/O contention
remained possible. The local model was not used by Claude. Work-order and
starter materials were frozen; candidates received the same independent
graders. The work views include recorded actions, checks and delivered files. Asset hashes cover generated files, not these notes.

The earlier [September 7 reference set](../../../claude-references-2026-09-07/patch-transaction/README.md)
recorded Sonnet in 31.4 s and Opus in 129.3 s on this work order from source
`96b6d1a`; it is retained unchanged as a separate cohort.

</details>
