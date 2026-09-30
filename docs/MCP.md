# BANTAM MCP: BANTAM's tools inside Claude Code

`bantam mcp serve` makes BANTAM an MCP server. Claude Code runs in its own terminal,
connects to it, and gets BANTAM as tools:

| Toolset | What Claude gets |
|---|---|
| `room` | A shared message log and task board with you (the operator) and BANTAM. |
| `jobs` | BANTAM workers (local model, Codex-backed BANTAM, native Codex) on isolated copies of a folder, steerable mid-run, applied to the live files only through verification. |
| `jev` | Calibrated yes/no, choice and score judgments from Jev mode's local engine. |

Design: `docs/specs/2026-09-30-bantam-mcp-design.md`.

## 1. Quick start

```bash
# 1. In the folder you want as the room (or pass --room DIR):
bantamfactory mcp serve
#   BANTAM MCP serving http://127.0.0.1:8095/mcp/<agent>  room /path/to/room

# 2. Print the command that connects Claude Code (it carries the room's token):
bantamfactory mcp config
#   claude mcp add --transport http bantam http://127.0.0.1:8095/mcp/claude --header "Authorization: Bearer …"

# 3. Run that command once, then start Claude Code as usual.
```

Write the goal and acceptance criteria into `<room>/.crew/brief.md`. Claude reads it with
`room_brief`.

While you work:

```bash
bantamfactory mcp log --follow           # watch the room
bantamfactory mcp say --to claude "Stop after chapter 2 and ask me."
bantamfactory mcp status                 # server and recent jobs
```

## 2. The room

- **Messages** (`room_post`, `room_inbox`, `room_wait`, `room_ack`, `room_history`). Address
  agents by name. `operator` is you, and `all` reaches everyone. BANTAM itself posts as `bantam`, for example
  "Job j3 (local) succeeded after 4m12s. 2 files changed…".
- **`room_wait`** blocks until a message for the caller arrives, for up to 10 minutes per call.
  Claude calls it instead of polling while a job runs. MCP cannot push into an idle
  Claude session, so this long-poll is how events reach it. If you want Claude's
  attention while it is waiting, `mcp say` wakes it.
- **Tasks** (`task_create`, `task_claim`, `task_update`, `task_list`) move through ready → claimed →
  working → review → verified → done, or to blocked. Only the owner moves its own task, and
  **review → verified must be done by someone other than the owner**. The operator
  can make any listed move.

Everything is in `<room>/.crew/room.jsonl` (append-only, fsynced before anyone is told).
Restarting the server keeps messages, read positions and tasks.

## 3. Jobs

```
job_start(worker, task, workspace, verify?, model?, effort?, max_turns?, timeout_min?, exclude?, room_task?)
```

| worker | What runs | Steerable |
|---|---|---|
| `local` | `bantam run` on the local llama.cpp model (`--local-endpoint`, default :8085) | yes |
| `codex` | `bantam run` with Codex as its model | yes |
| `codex-native` | `codex exec`, Codex's own agent loop | no |

One job per lane at a time (local and Codex lanes run in parallel). Others queue.

How a job flows:

1. The workspace is captured (respecting `.gitignore`; `.bantam`, `.crew`, `.git`,
   `node_modules` and `exclude` are left out) and copied twice, into a baseline and a working copy. The
   live folder is never touched. Folders over 20 000 files or 512 MiB are refused, and so are
   symbolic links and unreadable files: results are applied file by file, so exclude them.
2. The worker runs in the copy. `job_steer` sends it guidance through BANTAM's
   supervisor mailbox, which it reads between actions. The guidance is framed as peer guidance for its
   current task, not a new task. `job_status` shows when it is delivered.
3. When it exits (state `finishing`: no more steering or cancelling), the result is captured and, if `verify` was given, **the verifier runs again on a
   fresh copy of the result** (the worker's own claim is not enough). The
   job's creator gets a room message.
4. `job_result(job, diff: true)` shows the changes. `job_apply(job)` runs the verifier on the
   candidate, then writes the files transactionally. It refuses, writing nothing, if any of them
   changed in the live folder since the job started. Then it runs the verifier on the live folder and
   rolls everything back if that fails. Without a verifier you must pass `verify: "true"`
   explicitly.

Job state lives in `<room>/.crew/runtime/jobs/<id>/` (`job.json`, `worker.log`,
`baseline/`, `ws/`, `candidate/`, `transactions/`). A job that was running when the server
stopped is marked `interrupted` and never silently re-run. An apply cut off by a crash is
rolled back from its journal on the next start. Applies to one folder run one at a time.

## 4. Jev

`jev_decide(state, questions, model?)` takes the Jev wire format:

```json
{"canon":   {"type": "noul",   "instructions": "Does the passage contradict the character notes?"},
 "best":    {"type": "choice", "instructions": "Which opening is strongest?", "criteria": {"A": null, "B": null}},
 "tension": {"type": "score",  "instructions": "How tense is the scene?", "criteria": ["flat", "some", "gripping"]}}
```

It needs Jev mode set up (`bantamfactory jev setup`). Under the swap policy Jev waits for the
local llama.cpp model to idle-sleep before it takes the GPU, for up to `gpu.sleepTimeoutMs` in
`~/.bantam/jev.json`, so that must exceed llama-server's `--sleep-idle-seconds`. Jev
expects about 5 s; with a longer idle window, raise the timeout to match. The engine starts on the first question, which can
take minutes, and is turned off when the server stops, unless it was already running
before. It shares the GPU with the local worker through Jev mode's swap policy. While a local
job runs, each answer hands the GPU straight back.

## 5. Security

- The server listens on 127.0.0.1 only. Every request needs the room's bearer token
  (`.crew/runtime/token`, mode 0600), and browser origins other than localhost are refused.
- The URL names the caller (`/mcp/claude`), and the server stamps it on every message.
  `bantam` is reserved, and `operator` is accepted only from the `mcp` CLI.
- Workers run in copies with BANTAM's normal sandboxing. Only `job_apply` writes to the live
  folder, and only through the verified transaction.

Trust model: this is built for one operator on one machine. The token proves local
access; agent names are declarations. Anyone holding the token can speak as any agent, so
the independent-verification rule on tasks guards against mistakes, not against a hostile
client.

## 6. Options

```
bantamfactory mcp serve [--room DIR] [--port 8095] [--toolsets room,jobs,jev] [--local-endpoint URL]
```

`--toolsets` limits what Claude sees (each tool's description costs context). A toolset that
cannot start is reported and left out; the others still serve. One server per room: a
second `serve` on the same room is refused.
