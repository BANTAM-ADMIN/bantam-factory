# BANTAM MCP: BANTAM's tools inside Claude Code

`bantam mcp serve` makes BANTAM an MCP server. Claude Code runs in its own terminal,
connects to it, and gets BANTAM as tools:

| Toolset | What Claude gets |
|---|---|
| `room` | A shared message log and task board with you (the operator) and BANTAM. |
| `jobs` | BANTAM workers (local model, Codex-backed BANTAM, native Codex) on isolated copies of a folder, steerable mid-run, applied to the live files only through verification. |
| `jev` | Calibrated yes/no, choice and score judgments (`jev_decide`) and plain text (`jev_generate`) from DiffusionGemma, the fast local model behind Jev. |

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

### Two modes

A room normally stays in one mode; switching is a restart with the other flag.

| | `--mode llama` (default) | `--mode jev` |
|---|---|---|
| Loaded on the GPU | the local llama.cpp model (:8085) | DiffusionGemma, started with the server and kept awake |
| `local` jobs | BANTAM on the local model | BANTAM with a Codex model standing in (`--stand-in-model`, default the current Luna, `gpt-6-luna` today; e.g. `sol` or `gpt-6.1-sol`) |
| `codex`, `codex-native` jobs | as usual | as usual |
| Jev (`jev_decide`, `jev_generate`) | starts on first use and trades the GPU with the local model | always ready, fast |

BANTAM is fully functional in both modes.

### Codex in its own terminal too

Any MCP client can join the same room under its own name. For Codex:

```bash
bantamfactory mcp config --agent codex    # prints the lines below for this room
codex mcp add bantam --url http://127.0.0.1:8095/mcp/codex --bearer-token-env-var BANTAM_MCP_TOKEN
# in ~/.codex/config.toml, under [mcp_servers.bantam]:
#   tool_timeout_sec = 660                    (room_wait blocks up to 600 s)
#   default_tools_approval_mode = "approve"   (needed for codex exec; optional interactively)
BANTAM_MCP_TOKEN=$(cat <room>/.crew/runtime/token) codex
```

Claude and Codex then address each other by name (`room_post` to `codex` or `claude`), each
waits with `room_wait`, and both can start, steer and apply BANTAM jobs (the local model,
Codex-backed BANTAM, or native Codex in Docker).

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
| `codex-native` | `codex exec`, Codex's own agent loop, inside Docker (Codex's own sandbox cannot start on every host) | no |

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

## 4. Writing a book together (`writer`)

The writer toolset runs a book through a fixed process between agents in the room
(design: `docs/specs/2026-09-30-collaborative-writer-design.md`):

| Role | Default | Does |
|---|---|---|
| writer | `claude` | outline, drafts, repairs, answers every finding |
| critic | `codex` | approves the outline, critiques every draft, decides acceptance |
| checker | BANTAM | checks every draft against canon and rules (local model, or Jev in Jev mode) |
| operator | you | creates the book, decides chapters that exhaust their rounds |

1. `writer_book_create`: premise, voice, rules, chapter count and length, roles, rounds.
2. `writer_outline` (writer), then `writer_outline_review` (anyone but its author).
3. Per chapter, in order:
   - `writer_draft`: prose, a `beat_map` placing every beat, new canon facts with quotes.
   - Bantam's check runs, then the critic is asked for a review.
   - `writer_critique`: verdict, 1–5 scores, findings pinned to a paragraph with a
     verbatim quote, a ruling on every check flag.
   - On revise: `writer_draft` again, answering every finding (`fixed` or `disputed` with
     a reason).
   - On approval: `writer_accept`.
4. `writer_status` and `writer_context` show the state, the text and whose move it is. Every
   step is posted to the room.

What it enforces:
- The critic never judges its own version.
- Every quote (findings, canon, check flags) must be in the chapter's text.
- Revisions answer every finding.
- Chapters go in order, and accepted canon is shown to every later chapter.
- After `max_rounds` without approval, the operator decides (`writer_unblock`).

Everything lives in `<room>/books/<slug>/`: `book.json`, `outline.json`, `canon.json`, `chapters/NN/`
(`state.json`, every `draft-vK.md`, `final.md`) and `manuscript.md`.

## 5. Jev

`jev_generate(prompt, system?, max_tokens?)` returns plain text from DiffusionGemma: a line of
draft, a quick summary, alternatives. It is fast and capable, but its context window is about
16k tokens including the reply, so give it focused material.


`jev_decide(state, questions, model?)` takes the Jev wire format:

```json
{"canon":   {"type": "noul",   "instructions": "Does the passage contradict the character notes?"},
 "best":    {"type": "choice", "instructions": "Which opening is strongest?", "criteria": {"A": null, "B": null}},
 "tension": {"type": "score",  "instructions": "How tense is the scene?", "criteria": ["flat", "some", "gripping"]}}
```

It needs Jev mode set up (`bantamfactory jev setup`). Under the swap policy Jev waits for the
local llama.cpp model to idle-sleep before it takes the GPU, for up to `gpu.sleepTimeoutMs` in
`~/.bantam/jev.json`, so that must exceed llama-server's `--sleep-idle-seconds`. Jev
expects about 5 s; with a longer idle window, raise the timeout to match. If the local model needs
nearly the whole card, set `gpu.handback` to `"stop"`. Otherwise the sleeping DiffusionGemma
process still holds about 2.5 GB of VRAM, and llama.cpp can fail to wake into what is left. The engine starts on the first question, which can
take minutes, and is turned off when the server stops, unless it was already running
before. It shares the GPU with the local worker through Jev mode's swap policy. While a local
job runs, each answer hands the GPU straight back.

## 6. Security

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

## 7. Options

```
bantamfactory mcp serve [--room DIR] [--port 8095] [--toolsets room,jobs,jev] [--local-endpoint URL]
```

`--toolsets` limits what Claude sees (each tool's description costs context). A toolset that
cannot start is reported and left out; the others still serve. One server per room: a
second `serve` on the same room is refused.
