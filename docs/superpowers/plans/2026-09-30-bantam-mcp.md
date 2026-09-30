# BANTAM MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bantam mcp serve` exposes a durable room, BANTAM worker jobs and Jev to Claude Code over MCP Streamable HTTP.

**Architecture:** One localhost Node HTTP server per room directory. A hand-written JSON-RPC layer (`src/mcp/protocol.js`) dispatches to a registry of toolsets (`room`, `jobs`, `jev`). State is an append-only JSONL log plus per-job atomic JSON records; worker jobs reuse BANTAM's WorkspaceStore, worker-control mailbox and WorkspaceTransaction.

**Tech Stack:** Node ≥ 20 ESM, `node:http`, `node:test`; no new dependencies.

**Spec:** `docs/specs/2026-09-30-bantam-mcp-design.md`

## Global Constraints

- No new npm dependencies.
- Bind 127.0.0.1 only; default port 8095; Bearer token in `<room>/.crew/runtime/token` (0600).
- Agent path segment matches `^[a-z][a-z0-9-]{0,31}$`; `bantam` and `operator` are reserved.
- Messages ≤ 16 KiB text, ≤ 16 artifacts; request body ≤ 1 MiB; `room_wait` ≤ 600 s.
- Steering: worker-control limits (32 messages, 8000 chars) surface as tool errors.
- Workspace capture refused above 20 000 files or 512 MiB.
- Jobs found `running`/`queued` at startup become `interrupted`; never re-run automatically.
- `job_apply` always goes through `WorkspaceTransaction` with a verifier (`"true"` must be explicit).

## Review Focus

- Client disconnects during `room_wait`: waiter released, cursor not advanced → test in Task 3.
- Server restart mid-job: job becomes `interrupted`, room log intact, cursors kept → test in Task 5.
- Live file edited after job start: apply refuses that file (conflict), live tree untouched → test in Task 5.
- Torn last line of `room.jsonl` after a crash: server starts, drops only that line → test in Task 2.
- Steering a finished or native-Codex job: clear tool error, no mailbox write → test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mcp/protocol.js` | `createMcpHttpHandler({resolveAgent, token, tools, serverInfo, log})` → `(req, res)` handler; JSON-RPC + auth + validation. |
| `src/mcp/schema.js` | `validateArgs(schema, args)` → error string or null (required, type, enum, min/max, maxLength, maxItems). |
| `src/mcp/room-store.js` | `class RoomStore { constructor(file); append(record) → record; records(); on('record', fn) }` with replay + torn-line recovery. |
| `src/mcp/toolsets/room.js` | `createRoomToolset()` → toolset; exports `Room` class used by jobs toolset for posting events. |
| `src/mcp/toolsets/jobs.js` | `createJobsToolset({launch?})`; `workerCommand(job, paths, env)` pure builder. |
| `src/mcp/toolsets/jev.js` | `createJevToolset({serviceFactory?})`. |
| `src/mcp/server.js` | `startMcpServer({roomDir, port, toolsets, env})` → `{url, token, close()}`. |
| `src/mcp/cli.js` | `runMcpCli(argv)` for `serve | say | log | status | config`. |
| `bin/bantam.js` | dispatch `cmd === "mcp"` to `runMcpCli`. |
| `docs/MCP.md` | user guide. |
| `test/mcp-*.test.js` | tests. |

### Task 1: Protocol layer

**Files:** Create `src/mcp/schema.js`, `src/mcp/protocol.js`; Test `test/mcp-protocol.test.js`.

**Interfaces — Produces:**
- `validateArgs(schema, value): string|null`
- `createMcpHttpHandler({ token, resolveAgent(name) → bool, listTools() → tool[], callTool(name, args, {caller, signal}) → Promise<result>, serverInfo, instructions })`
- Tool result shape from handlers: any JSON value → wrapped as `{content:[{type:"text", text: JSON.stringify(value, null, 2)}], structuredContent: value}`; thrown `ToolError(message)` → `{isError:true, content:[{type:"text", text: message}]}`.
- Supported protocol versions: `2025-11-25`, `2025-06-18`, `2025-03-26`; echo the client's if supported else latest.

- [ ] Step 1: tests — initialize negotiates version and returns `capabilities.tools`; `tools/list` returns tools; `tools/call` success and `ToolError` → `isError`; invalid args → `isError` with message naming the field; notification → 202 empty; unknown method → `-32601`; bad JSON → `-32700`; missing/bad token → 401; foreign Origin → 403; body > 1 MiB → 413; unknown agent → 404; GET → 405; request abort fires `signal`.
- [ ] Step 2: run `node --test test/mcp-protocol.test.js` → fails (module missing).
- [ ] Step 3: implement.
- [ ] Step 4: tests pass.
- [ ] Step 5: commit.

### Task 2: Room store

**Files:** Create `src/mcp/room-store.js`; Test `test/mcp-room-store.test.js`.

**Produces:** `new RoomStore(file)`; `.append({type, ...}) → {seq, at, type, ...}` (append + fsync, then emit); `.records()` array; `.lastSeq`; `.onAppend(fn) → unsubscribe`.

- [ ] Step 1: tests — seq increments and survives reopen; torn final line (no trailing newline, invalid JSON) truncated and reported via `store.recovered === true`; invalid JSON mid-file throws; listeners fire after the line is on disk.
- [ ] Steps 2–5: fail, implement, pass, commit.

### Task 3: Room toolset (messages + tasks)

**Files:** Create `src/mcp/toolsets/room.js`; Test `test/mcp-room.test.js`.

**Consumes:** `RoomStore`. **Produces:** `class Room { constructor(store); post(from, {to, kind, text, task, replyTo, artifacts}) → msg; inbox(agent, {limit}) → msgs (advances cursor); wait(agent, {timeoutMs, signal}) → {messages, timedOut}; ack(agent, id); history({sinceSeq, limit}); createTask(by, {title, detail}); claimTask(by, id); updateTask(by, id, state, note); listTasks({state}) }`; `createRoomToolset()` → toolset with tools `room_post, room_inbox, room_wait, room_ack, room_history, task_create, task_claim, task_update, task_list`; `toolset.start(ctx)` sets `ctx.room`.

- [ ] Step 1: tests — direct and `all` delivery, sender excluded; inbox advances cursor and cursor survives store reopen; `wait` resolves on post within 1 s; `wait` timeout; aborted `wait` does not move cursor; two synchronous claims → one error; owner-only updates; `review→verified` by owner rejected, by other accepted; invalid transition rejected; text > 16 KiB rejected.
- [ ] Steps 2–5.

### Task 4: Server + CLI + bin wiring

**Files:** Create `src/mcp/server.js`, `src/mcp/cli.js`; Modify `bin/bantam.js` (dispatch next to `jev`); Test `test/mcp-server.test.js`.

**Produces:** `startMcpServer({roomDir, port = 8095, toolsets = ["room","jobs","jev"], toolsetFactories?, log}) → Promise<{url, port, token, close()}>`: creates `.crew/{brief.md,protocol.md,runtime/}`, token, lock (`acquireExclusiveFileLock(runtime/server.lock, {kind:"bantam-mcp"})`), store, toolsets (failing `start` → logged, skipped). CLI: `serve [--room DIR] [--port N] [--toolsets a,b]`, `say "text" [--to name]` (appends as `operator` directly via RoomStore under the same lock? — no: POST to the running server at `/mcp/operator-cli`?). Decision: `say`/`log` operate on the file store directly only when no server holds the lock; otherwise `say` calls the server's `room_post` over HTTP with the token and agent `operator` allowed for the CLI via header `X-Bantam-Operator: <token>`. Simpler and final: the server accepts `/mcp/operator` only when the request also carries `X-Bantam-Operator: 1` **and** the token (the token already proves local operator access). `log` tails `room.jsonl` read-only. `status` prints lock owner, url, jobs. `config` prints the `claude mcp add` command.

- [ ] Step 1: tests — end-to-end over real HTTP on port 0: initialize, tools/list includes room + a fake toolset; second server on same room fails with ELOCKED; failing toolset skipped; `close()` releases lock.
- [ ] Steps 2–5.

### Task 5: Jobs toolset

**Files:** Create `src/mcp/toolsets/jobs.js`; Test `test/mcp-jobs.test.js` with fixture worker `test/fixtures/mcp-fake-worker.mjs`.

**Produces:** tools `job_start, job_status, job_result, job_steer, job_cancel, job_apply, job_list`. `workerCommand({worker, task, ws, control, runFile, verify, model, effort, maxTurns, endpoint}) → {exe, args, env}`. Injectable `commandFor(job, paths)` for tests so the fake worker runs instead of BANTAM.

Fake worker behavior (`mcp-fake-worker.mjs --ws W --control C --run R --mode M`): opens worker control, writes a file into W, loops draining steering for up to 3 s writing each drained text to `W/steered.txt` and noting an action, writes `run.json` `{disposition:"completed", verification:{pass:true}}`, exits 0 (`--mode fail` exits 1).

- [ ] Step 1: tests — `workerCommand` argv for local/codex/codex-native; job runs to `succeeded`, creator receives `event` message, `job_result` lists changed files and diff; lane exclusivity (second local job `queued` position 1 until first ends); `job_steer` wraps text, fake worker receives it, status shows `delivered`; steer on finished job → error; steer on codex-native → error; cancel running job → `cancelled`; apply commits candidate into live; apply refuses when a changed file was edited live (live untouched); apply rolls back when live verify fails; apply without verifier and no job verify → error; restart with a `running` job.json → `interrupted`.
- [ ] Steps 2–5.

### Task 6: Jev toolset

**Files:** Create `src/mcp/toolsets/jev.js`; Test `test/mcp-jev.test.js`.

**Produces:** tools `jev_decide({state, questions, model?})`, `jev_status()`; `createJevToolset({serviceFactory})` where default factory = `createJevService({config: loadJevConfig(), worker: {endpoint}})` then `on({serve:false})` once.

- [ ] Step 1: tests — invalid questions → `isError` from `validateSystemOne`; decide delegated to fake service with `resolveProfile(model)`; summary line; unconfigured factory error mentions `bantamfactory jev setup`; `stop()` calls `off`.
- [ ] Steps 2–5.

### Task 7: Docs + live acceptance

**Files:** Create `docs/MCP.md`; room scaffold in the collaboration folder.

- [ ] Run all `test/mcp-*.test.js` and a broader regression subset.
- [ ] Start server on the collaboration room; `claude mcp add`; drive a real `claude -p` session: post, start local job on a tiny workspace, steer mid-run, `room_wait` for completion, apply. Try `jev_decide`.
- [ ] Record results in the final report; commit.
