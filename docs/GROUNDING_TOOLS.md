# Symbolic-Tool Surface — design + plan

**Goal.** Give the agent an on-demand way to ask exact symbolic questions or request deterministic
ranked retrieval — instead of guessing or being force-fed the whole KB (context cost, which an A/B
showed is net-negative). One clean interface, designed as a **registry** so more
powerful engines (GPU tensor-datalog reachability, the superopt synth+proof engine, RT-core
search) can register as tools on the identical socket later, once GPU-sharing is decided.

This is the principle from the tau "death of heuristics" work applied to the agent: when exact
reasoning is ~free relative to a token (proven: ~130k CPU datalog queries fit in one token's
time), the agent should *compute* answers, not *guess-and-check* them.

## Current status

Implemented and unit-tested:

- `src/logic/datalog.js`: dependency-free recursive Datalog engine with indexed joins.
- `src/logic/codefacts.js`: deterministic JS/MJS fact extraction (`file`, `defines`,
  `imports`, `depends`, `calls`) plus derived `symbol` / `reaches` from resolved relative import
  edges. This avoids the older symbol-name overlap false positives; `calls` facts remain
  for future caller queries.
- `src/logic/grounding.js`: agent grounding context, optional code-map injection,
  missing-path rejection with nearest-file suggestions, and incremental post-edit refresh —
  a successful write/replace/shell edit rereads only the changed JS/MJS files and atomically
  replaces the derived facts, or fails closed and keeps the stale-KB refusal (see
  [`reports/2026-07-10-incremental-grounding.md`](superpowers/reports/2026-07-10-incremental-grounding.md)).
- `src/logic/tools.js`: tool registry with the `code`, `concept`, `map`, `sqlite`, `history`, and
  `view_image` tools, each verb-routed through the same `{name, description, answer(q)}` socket.
- `src/logic/concept-search.js`: bounded deterministic behavior retrieval over named
  function/class chunks. Weighted lexical evidence (path, identifiers, comments, code) is reranked
  with the dependency graph; there is no network call, embedding service, or model-side index.
- Agent action: `{"a":"query","q":"..."}` routes through the registry when grounding is on. An
  identical query on an unchanged workspace is replayed from cache (a repeated `map` query is not
  re-shelled), and in interactive mode a `query` counts toward the investigation budget so a
  query-only session is still forced to wrap up. See
  [`reports/2026-07-11-map-steer-and-query-spiral.md`](superpowers/reports/2026-07-11-map-steer-and-query-spiral.md).

Important measurement result:

- Always injecting the full code map into every prompt was net-negative in early A/B: it
  increases context and invites extra thinking. The default remains pull-based. A narrow exception
  now seeds one bounded live `map brief` for repository-architecture and feature-ideation questions,
  where the alternative was dozens of blind reads. It is cached until an edit, refreshed after
  edits and regression rollback, and superseded by an explicit map query.
- The first query-surface structural test was positive. The broader A/B evidence still needs to be
  reproduced and written down before this should be treated as more than an initial signal.

Still open:

- Broaden/reproduce query-on vs query-off on more structural code tasks with turn counts,
  correctness, and real harness impact now that dependency edges use resolved imports.
- Decide how GPU-backed tools share the local GPU with model inference before wiring
  tensor-datalog / superopt / RT-core engines.

Now done:

- The socket is proven beyond a stub. `sqlite` (a SQLite/WAL recovery probe with verbs
  `files | tables | wal | schema | query`, auto-registered when the workspace has database
  files) and `history` (per-run run-log queries: `edits | tests | actions | at`) both register
  through the same `{name, description, answer(q)}` interface as `code`.
- `map` (whole-repo structure at **symbol + call-graph** granularity, a separate engine from the
  file-level `code` datalog — `brief | arch | flow <file> | callers <sym> | impact <file> |
  reach <sym> | explain <sym>`, 7 verbs) registers on any workspace with 5+ source files. It shells out
  to the standalone `repo_map/` extractors (Go/JS/Python), picking the **single dominant language** per
  workspace, and caches by a source revision so repeated queries don't re-shell. Precision is honest:
  **JS cross-module imports resolve exactly; Go and Python call graphs are syntactic** (an exact
  `go/types` extractor exists only in `EXPERIMENTAL/repo_map` and is not what ships). `callers` is an
  alias for query.py's `explain`; the standalone `hot`/`blast`/`path` commands aren't exposed through the
  tool. Its description leads with intent ("understand a whole repo in ONE call") so a small model reaches
  for it on comprehension tasks instead of keyholing. The development build resolves a bundled
  `repo_map/`, then the exact sibling `../repo_map`; `BANTAM_REPOMAP_DIR` is an authoritative
  override. Extracted structures live in private `0700` temporary directories with `0600` files and
  are disposed after each run. Off with `BANTAM_NO_MAP`.
- `concept` finds behavior when the user knows the idea but not the symbol: for example
  `concept error recovery`, `concept validate user input`, or `concept read configuration`.
  Results are stable, bounded source locations with the matched fields and graph-support evidence.
  Its index follows the atomically replaced grounding snapshot after writes, deletes, and rollbacks,
  and refuses to claim results while grounding is stale.
- `view_image` (describe a workspace image via the server's `/v1/chat/completions` vision path)
  registers only when `/props` reports a loaded vision projector (`mmproj`); it is simply absent
  otherwise. Disable with `BANTAM_NO_VISION`. The same vision path drives the `preview` tool's
  screenshot description below.
- `preview` (render a web deliverable and report what actually happened) drives a **real headless
  Chromium** subprocess (`preview-runner.mjs`) that serves the workspace on a loopback port, injects a
  collector script to capture page errors / console / unhandled rejections and a measured layout digest,
  and — in `interact` mode — clicks the primary control and drives the keyboard to smoke real interaction
  defects. Network egress is dead-proxied by default so page JS can't exfiltrate the workspace;
  screenshots are written outside the workspace so they don't look like edits. Its compact proof feeds the
  `preview` done-gate (a red/stale/empty/timed-out render bounces a web `done`). The push-based
  auto-preview is opt-in (`BANTAM_AUTOPREVIEW=1`) — a measured 36-run A/B found no pass-rate benefit for
  *static* preview, so only the pull-based tool + the gate stay on.

## The interface

A new action the model can emit:

    {"a":"query","q":"affects agent.js"}

routed to a **tool registry**. Tool #1 is `code`, backed by the datalog KB of the workspace.
It answers a small, safe verb language (not arbitrary datalog from the LLM):

| query | answers |
|-------|---------|
| `exists <path>`      | does the file exist? (+ nearest real path if not) |
| `defines <symbol>`   | which file(s) define it, or "undefined" |
| `symbols <file>`     | symbols defined in a file |
| `deps <file>`        | files it transitively depends on |
| `affects <file>`     | files that transitively depend on it (blast radius) |
| `files [substr]`     | list files (optionally matching) |

Each answer is exact and returns in microseconds. New tools register `{name, description, answer(q)}`;
the model learns them from the prompt.

`concept <question>` uses that same socket but intentionally returns a ranked answer rather than an
exact logical fact. It reports bounded function/class locations, lexical evidence, and graph support;
ranking is deterministic and local, and the first query builds its bounded index on demand.

## Plan (phases)

0. **Document** (this file). **Done.**
1. **`src/logic/tools.js`** — the registry + the `code` tool (verbs above) over the datalog KB.
   Unit-tested against a fixture codebase. **Done.**
2. **Wire the `query` action** — actions.js (Zod) + grammar.js (GBNF) + executor/agent routing +
   prompt.js introduces it when grounding is on. Unit-tested end-to-end. **Done.**
3. **Measure (honest A/B)** — a structural task ("what breaks if I change X?") with the query tool
   available vs not. Unlike the force-fed code map (net-negative), on-demand query has NO context
   cost, so the prediction is: fewer investigative turns, same/better correctness, or at worst
   neutral. Report the real numbers either way. **Initial proof done; broaden next.**
4. **Commit** with the socket documented for the GPU tools. **Done for the CPU/code tool; GPU
   backends remain future work.**

## What SUCCESS looks like (measurable)

- The model can emit `{"a":"query","q":"affects <file>"}` and get the exact, correct answer as its
  observation, in <1ms of engine time. (unit tests, green)
- On a structural task, query-available uses **fewer investigative turns** than query-off to reach
  the correct answer — or is at least neutral (no regression), reported honestly with turn counts.
- The registry cleanly supports more tools (demonstrated by the real `sqlite` and `history`
  tools), proving the socket.
- Full suite stays green; the feature is opt-in via the existing `grounding` flag.

## Non-goals (staying in scope)

- No arbitrary datalog from the LLM (safety/complexity) — a fixed verb menu.
- No GPU integration yet (gated on GPU-sharing) — but the socket is shaped for it.
- No always-on context injection (that was the net-negative path).

## Future tools (same socket)

`tensor-datalog` (632-TOPS reachability), `superopt` (synthesize+prove exact kernels),
`RT` (RT-core massive search). Each registers as `{name, description, answer(q)}`. The agent-facing
interface never changes when the backend gets 1000× faster.
