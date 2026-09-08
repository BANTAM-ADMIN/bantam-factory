# Native Claude reference cards

Four fresh native Claude Code attempts, all **PASS 5/5**, on two of the same
public work orders used in the launch gallery. These are separately recorded
reference cards, not replacements for the original BANTAM comparison attempts.

| Work order | Claude Sonnet | Claude Opus | Earlier BANTAM local attempt |
|---|---:|---:|---:|
| [Context packet](context-packet/README.md) | 62.2s · 5/5 | 67.3s · 5/5 | [58.1s · 5/5](../launch-2026-09-07/context-packet/README.md) |
| [Patch transaction](patch-transaction/README.md) | 31.4s · 5/5 | 129.3s · 5/5 | [81.8s · 5/5](../launch-2026-09-07/patch-transaction/README.md) |

BANTAM's earlier Context Packet attempt was quicker than these Claude attempts;
Sonnet's Patch Transaction attempt was quicker than BANTAM. Different models,
native policies and run windows matter. This table compares individual
observations across cohorts, not simultaneous trials or a general ranking.
The original launch cards and all their contender outcomes remain unchanged.

## Shared conditions

Frozen source `96b6d1afd9388537d0530b758c2ce60e1b8f84e8`; Claude Code 2.1.263,
standalone Linux x64 installation. The selected `sonnet` and `opus` aliases
reported `claude-sonnet-5` and `claude-opus-5` respectively. Both used medium
effort and the CLI's native system prompt and tools inside an outer non-root
Docker boundary. User settings, skills and external MCP servers were disabled;
the existing file credential was read-only. Offline dummy-auth runtime checks
passed before scoring. No installer, login or manual candidate repair was used.

Claude attempts ran serially alongside a separate local/Codex comparison,
so CPU/I/O contention remained possible. The local model was not used by Claude.
Work-order and starter materials were frozen; candidates received the same
independent graders. The BANTAM reference attempts linked above used the earlier
frozen source and runtime specified in their own notes.

Each card contains a complete final native input/output/cache aggregate. These
are not request-level HTTP receipts. Input includes cache creation and reads;
fresh input includes cache creation. Do not add overlapping scopes. The CLI's
reported costs remain private metadata, not a claim about subscription billing.
Public exports omit raw prompts, source, credentials and machine paths. Asset
hashes cover generated files, not these notes, authorship or permission to
execute imported material. No evidence was uploaded to a public site.
