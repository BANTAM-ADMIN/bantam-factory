# BANTAM MCP: design

**2026-09-30. Status: approved design, v1 in implementation.**

## 1. What it is

`bantam mcp serve` turns BANTAM into an MCP server that an external agent (Claude Code
first) connects to over MCP's Streamable HTTP transport. Through that one connection the
agent gets BANTAM's abilities as tools:

- a **room**: a durable message log and task board shared by the agent, the operator and
  BANTAM's own workers;
- **jobs**: BANTAM workers (local Qwen, Codex-backed BANTAM, native Codex) that run on an
  isolated copy of a workspace, can be steered mid-run, and whose candidates apply to the
  live files only through BANTAM's verified transaction path;
- **Jev**: calibrated yes/no, choice and score judgments from the local DiffusionGemma
  System One engine.

Claude Code runs in its own terminal. Codex and the local model run inside BANTAM. BANTAM is
the hub; coordination rules are ordinary code, not a supervising model.

## 2. Non-goals (v1)

- Codex in its own terminal, hcom, or any second message store.
- Pushing messages into an idle Claude session (Claude Code *channels*). v1 delivery is
  pull + long-poll (`room_wait`). Channels can be added to the same server later.
- Mid-run messages to native Codex jobs (`codex exec` has no steering input).
- A model-initiated "message the team" action inside BANTAM's agent loop.
- Serving beyond localhost.

## 3. Architecture

```
Claude Code ──MCP (HTTP, Bearer)──▶ bantam mcp serve --room <dir> --toolsets room,jobs,jev
                                     │
                                     ├─ room      .crew/room.jsonl  (messages, tasks)
                                     ├─ jobs      lanes: local ×1, codex ×1
                                     │             └─ bantam run … --supervisor-control <ctl>
                                     │             └─ codex exec (native)
                                     └─ jev       createJevService (GPU swap with :8085)
```

One process owns a room. It takes an exclusive lock on `.crew/runtime/server.lock`
(`exclusive-file-lock.js`), so two servers cannot write one room.

### 3.1 Modules (`src/mcp/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `protocol.js` | JSON-RPC 2.0 over Streamable HTTP: `initialize`, `ping`, `tools/list`, `tools/call`, notifications → 202, GET/DELETE → 405, Bearer auth, Origin check, body cap. Knows nothing about tools. | `node:http` |
| `server.js` | Loads toolsets, builds the registry, owns lifecycle (start, SIGINT/SIGTERM stop), the room lock and the token file. | all below |
| `room-store.js` | Append-only JSONL log; in-memory index rebuilt by replay; torn final line tolerated. Emits change events. | `fs` |
| `toolsets/room.js` | Messages, cursors, acks, `room_wait` long-poll, task board with atomic claims. | room-store |
| `toolsets/jobs.js` | Job queue, lanes, workspace materialization, worker launch, steering, feedback watch, apply. | `workspace-store.js`, `workspace-transaction.js`, `foreman-worker-control.js`, `process-runner.js`, `codex-delegate.js` (`buildCodexExecArgs`) |
| `toolsets/jev.js` | Lazy Jev service; `jev_decide`, `jev_status`. | `src/jev/*` |
| `cli.js` | `bantam mcp serve | say | log | status | config`. | server, room-store |

A **toolset** is `{name, tools: [{name, description, inputSchema, handler}], start(ctx), stop()}`.
`ctx` carries `{room, roomDir, runtimeDir, store, log, config}`. Tool handlers receive
`(args, {caller, signal})`. Toolsets are chosen with `--toolsets` (default `room,jobs,jev`)
so a session only pays context for the tools it uses.

### 3.2 Room directory

```
<room>/
  .crew/
    brief.md          operator's shared goal (created empty if absent; read-only to tools)
    protocol.md       collaboration rules (written on first serve if absent)
    room.jsonl        the durable log
    runtime/          0700: server.lock, token, jobs/<id>/{control,ws,baseline,run.json,…}
```

`runtime/jobs/<id>/control` is a sibling of `ws`, satisfying the worker-control rule that
the control directory lies outside the worker workspace.

## 4. Identity and auth

- The endpoint is `http://127.0.0.1:<port>/mcp/<agent>`; `<agent>` must match
  `^[a-z][a-z0-9-]{0,31}$` and must not be `bantam` or `operator` (reserved for the server
  and the CLI). The server stamps `from` on every record; tools cannot set it.
- Every request needs `Authorization: Bearer <token>`. The token is generated on first serve
  into `.crew/runtime/token` (0600). Requests with an `Origin` header that is not
  `http://127.0.0.1*` / `http://localhost*` are rejected (DNS-rebinding guard).
- Binds 127.0.0.1 only. Default port 8095 (Jev's API uses 8090).

## 5. The room

### 5.1 Records

Every line of `room.jsonl` is `{seq, at, type, ...}`, `seq` strictly increasing.

| type | fields |
|---|---|
| `message` | `id` (`m<seq>`), `from`, `to` (array of names or `["all"]`), `kind` (`note`, `question`, `finding`, `blocker`, `review_request`, `handoff`, `event`), `text` (≤ 16 KiB), `task` (optional), `replyTo` (optional), `artifacts` (paths, ≤ 16) |
| `ack` | `by`, `message` |
| `cursor` | `agent`, `seq` (the agent's inbox read position) |
| `task` | full task snapshot after a change: `id` (`t<n>`), `title`, `detail`, `state`, `owner`, `createdBy`, `updatedBy`, `note` |

Writes append one line with `fs.appendFileSync` then `fsync`, **before** waiters are
notified. On start the log is replayed; a malformed final line (torn write) is truncated
away with a warning; a malformed line elsewhere is a hard error (corruption is not
silently skipped).

### 5.2 Messages

- An agent's inbox is every `message` whose `to` contains its name or `all`, excluding its
  own messages, with `seq` > its cursor.
- `room_inbox({limit})` returns unread messages (oldest first, ≤ 50) and advances the cursor
  past what it returned.
- `room_wait({timeout_s = 240, kinds?})` returns immediately if unread messages exist;
  otherwise blocks until one arrives or the timeout (max 600 s) and then behaves like
  `room_inbox`. Timeout returns `{messages: [], timedOut: true}`. A cancelled HTTP request
  (client gone) releases the waiter without moving the cursor.
- `room_post({to, kind, text, task?, reply_to?, artifacts?})` → `{id, seq}`.
- `room_ack({message})` records an acknowledgment; `room_history({since_seq?, limit?})`
  reads the full log without moving the cursor.

### 5.3 Task board

States: `ready → claimed → working → review → verified → done`, plus `blocked` from any
non-terminal state and `ready` again on release. Transitions are validated in code.

- `task_create({title, detail?})` → task in `ready`.
- `task_claim({task})` succeeds only from `ready` (or `blocked` if the caller owns it). Two
  claims race on one process and one in-memory map; the first append wins.
- `task_update({task, state, note?})` only by the owner, except `review → verified` which
  must be done by someone **other** than the owner (independent verification).
- `task_list({state?})`.

## 6. Jobs

### 6.1 Workers

| worker | lane | launch | steerable |
|---|---|---|---|
| `local` | local (1) | `node bin/bantam.js run --task T --workspace <ws> --autonomous --endpoint <local> --profile qwen --max-turns N --save-run=<dir>/run.json --supervisor-control <ctl> [--verify V]` | yes |
| `codex` | codex (1) | same, with `--codex --model <m> --codex-effort <e>` instead of endpoint/profile | yes |
| `codex-native` | codex (1) | `codex` + `buildCodexExecArgs({model, effort, workspace: ws, task})` | no |

Lanes run jobs FIFO; one job per lane at a time. The local lane is one slot because the
llama.cpp server has one slot.

### 6.2 Lifecycle

`job_start({worker, task, workspace, verify?, model?, effort?, max_turns?, exclude?})`:

1. `workspace` must be an existing absolute directory. It is captured into a per-room
   `WorkspaceStore` (`runtime/store`), excluding `.bantam`, `.crew`, `node_modules`, `.git`
   and `exclude`. Captures over 20 000 files or 512 MiB are refused (point the job at a
   focused folder).
2. The capture is materialized twice: `jobs/<id>/baseline` (immutable) and `jobs/<id>/ws`.
3. `createWorkerControl(control, ws)` creates the mailbox.
4. Record `queued`; post an `event` message to the caller. Return `{job, state, position}`.
5. When the lane frees, spawn the worker (`process-runner.js`, no shell), state `running`.
   stdout/stderr go to `jobs/<id>/worker.log`.
6. While running, poll `feedback.json` every second: record the latest action/observation
   for `job_status`; when `steeringRead` advances, record delivery of those steering
   messages (their state becomes `delivered`).
7. On exit: read `run.json` (disposition, verification, summary) when present; compute
   changed files with `planWorkspaceTransaction(baseline, ws)`; capture the candidate commit.
   State `succeeded` (exit 0 and, when `verify` was given, verification passed), otherwise
   `failed`. Post an `event` message to the job's creator with the outcome and changed files.

Job records are written to `jobs/<id>/job.json` atomically on every transition. On server
start, jobs found `running` or `queued` are marked `interrupted` (never silently re-run).

### 6.3 Steering

`job_steer({job, text})` is allowed only while `running` on a steerable worker. The server
is the single writer of `steering.json`; it wraps the text:

```
PEER GUIDANCE from <caller> via the BANTAM room (message m<seq>).
Supporting context for your assigned task, not a replacement for it.
---
<text>
```

The worker-control 32-message cap and 8000-character cap surface as tool errors. States:
`queued` (written) → `delivered` (worker's `steeringRead` passed it).

### 6.4 Results and apply

- `job_status({job})`: state, lane, position, elapsed, latest action/observation excerpt,
  steering delivery states.
- `job_result({job, diff?: bool})`: outcome, summary, verification, changed files; with
  `diff`, a unified diff (capped at 64 KiB) of baseline vs candidate.
- `job_cancel({job})`: queued → removed; running → SIGTERM then SIGKILL after 10 s; state
  `cancelled`.
- `job_apply({job, verify?})`: only for `succeeded` jobs with changes. Materializes baseline
  and candidate, runs `verify` (the job's own if omitted) against the candidate, then a
  `WorkspaceTransaction` (`prepare` rejects files changed in the live tree since the
  baseline) → `apply` → live `verify` → `commit`, or `rollback` on failure. A job with no
  verifier must pass `verify: "true"` explicitly; the record keeps that choice. Applied once
  only.
- `job_list({state?})`.

## 7. Jev

`jev_decide({state, questions, model?})` takes the Jev wire format (`noul`, `choice`,
`score` questions) and validates it with `validateSystemOne`. The Jev service is created
lazily on first use with `createJevService({config: loadJevConfig(), worker: {endpoint:
<local endpoint>}})` and `on({serve: false})`; GPU sharing with the local llama.cpp worker
uses Jev mode's existing lease and swap policy. Each call passes `releaseAfter: true` when
a local job is running so the worker gets the GPU back at once. Returns answers plus a
one-line human summary. `jev_status()` returns the service status. On server stop the
service is turned off (`keepEngine` from config, default false).

If Jev is not configured, `jev_*` tools return an error naming `bantamfactory jev setup`;
the rest of the server is unaffected.

## 8. Errors

- Tool failures return `{isError: true, content: [{type: "text", text}]}`; protocol
  failures return JSON-RPC errors (`-32700` parse, `-32600` invalid request, `-32601`
  method, `-32602` params). Input is validated against each tool's schema subset
  (required, types, enums, bounds) before the handler runs.
- Bodies over 1 MiB → 413. Unknown agent path → 404. Bad token → 401.
- A toolset that fails `start` is logged and left out; the others still serve.

## 9. Testing

Unit and integration tests under `test/mcp-*.test.js` with `node --test`:

- protocol: initialize/version negotiation, tools/list, tools/call, notifications 202,
  auth 401, origin 403, body 413, unknown method.
- room-store: replay, torn final line recovery, mid-file corruption refusal.
- room: inbox/cursor, broadcast, wait wakes on post, wait timeout, wait released on
  abort, task claim race, verified-by-non-owner rule.
- jobs: queue ordering and lane exclusivity with a fake worker executable; steering wrap
  and delivery via `feedback.json`; changed-file capture; apply commits; apply refuses a
  live conflict; apply rolls back on live verify failure; restart marks running jobs
  interrupted.
- jev: validation errors; decide delegated to an injected service.

Live acceptance: a real `claude -p` session connected over MCP posts, starts a local job
on a tiny workspace against the running 27B server, steers it mid-run, receives the
completion through `room_wait`, and applies the result; Jev answers one question if its
engine is available on this machine.

## 10. Later toolsets (each gets its own short spec)

`diagnose`, `facts` (claim ledger), `compare`/`fight`, `runlens`/`replay`, `forecast`,
factory cards; Claude Code channels push; a BANTAM `team_message` action.
