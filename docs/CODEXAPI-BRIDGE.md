# codexapi as a BANTAM model: the chat dialect, held-open sessions, the picker, and the fight corners

> Privacy note: workstation paths and connection examples below are placeholders,
> not the original operator settings. Historical measurements are unchanged.

**Measured 2026-08-24/25.** codexapi is an OpenAI-compatible HTTP bridge in front
of the `codex` CLI (discovered as a sibling checkout, not a git repo). It serves
`/v1/chat/completions`, `/v1/models`, `/v1/sessions` and web search, on the LAN,
in a text-only "chat mode" whose sandbox and tool tripwire guarantee that nothing
runs on the API end. BANTAM runs every action itself, so the bridge is a text
brain — exactly the role it was built for. This page is the operating record:
what was built, what was measured, what to keep in mind.

## Run BANTAM on the bridge

```bash
# chat / run / exec — the flags are the same
BANTAM_CHAT_BODY_EXTRA='{"chat_preamble":false}' \
bin/run-dev.sh --api-url http://127.0.0.1:8787/v1 --api-key "$BANTAM_CODEXAPI_KEY" \
  --api-dialect chat --model gpt-5.3-codex-spark:low --context-mode extension
```

Or pick it at startup: when no local model is running, the picker lists
`codexapi · <model> · <effort> reasoning` entries after the Codex app-server
entries. Selecting one launches the bridge if it is down, asks for the key if
the bridge answers 401, switches to the chat dialect with the conversational
persona declined, and remembers the choice (`.bantam/model-preference.json`
kind `codexapi`; bridge url/key/dir under `codexapi` in `~/.bantam/settings.json`).

Config precedence: `BANTAM_CODEXAPI_URL` / `BANTAM_CODEXAPI_KEY` /
`BANTAM_CODEXAPI_DIR` → the saved setting → `http://127.0.0.1:8787/v1`. The
checkout is discovered as `codexapi/` beside the repo or one of its parents
(`src/codexapi-bridge.js`); nothing is hardcoded.

Effort rides in the model slug (`sol:high`, `spark:low`). Aliases `sol`,
`luna`, `terra` work. `/v1/models` lists what the bridge serves.

## What had to change, and why

| seat | before | after |
| --- | --- | --- |
| BANTAM OpenAI path | raw-prompt `/v1/completions` + GBNF grammar | `--api-dialect chat` (`src/openai-transport.js` `buildChatCompletionsBody`): transcript → chat roles, the action JSON Schema in standard `response_format`, generic profile, no GBNF; actions validated locally like every other transport |
| codexapi `response_format` | accepted, ignored | `json_schema` passed to the app-server's `outputSchema` on `turn/start` — replies are constrained, not requested |
| codexapi preamble | one block: "no tools" + "plain prose, never plan" | split. `TOOL_RULES` always apply in chat mode; `chat_preamble:false` declines only the conversational persona |
| SSE error frames | read as an empty completion → "no JSON object found" + repair turns | `_readStream` throws (`code: stream_error`) with the server's own message |
| startup probe | "this API does NOT honor GBNF" for every non-llama server | dialect-aware: a schema probe, a calm line, then sessions if the server lists them |

The preamble split was paid for: with the whole preamble dropped, `gpt-5.6-luna`
reached for `commandExecution` to "take a look" and the tripwire killed three
turns in a row — BANTAM saw empty output and blamed the JSON. The no-tools rule
is what the text-only API is for; only the persona is a client's to decline.

## Held-open sessions (`src/chat-sessions.js`)

A reused codexapi session sends ONLY the newest message and the thread keeps
its own replies. BANTAM's prompt is rebuilt every turn, so a planner decides per
prompt:

- **delta** — the prompt byte-extends the run's last prompt: send the new user
  content (several new user turns are joined into one message; the assistant's
  own reply is not resent).
- **rebase** — same head (system + task), not an extension (history was
  rewritten): a new session with the full transcript; the old one is retired.
- **ephemeral** — a different head (an auxiliary call): no session; the run
  session is untouched.

A 409 `session_unavailable` marks the session lost and the retry carries the
full transcript on a new id. Sessions arm when `GET /v1/sessions` is 200
(`BANTAM_CHAT_SESSIONS=0` disables) and are deleted at run end — awaited, because
a fire-and-forget DELETE lost at process exit leaves a session that, at the
bridge's TTL of 0, lives forever. Sessions pay only under the **extension**
trajectory: a rebuilt prompt rebases every turn. The chat auto-dial therefore
treats a session-holding server as stateful and picks extension for read-only
requests; `run`/`exec` take `--context-mode extension` (or
`BANTAM_PROMPT_TRAJECTORY=extension`). The chat summary line reports
`sessions N delta/M full`.

Measured on a fixture edit task (add a function + its test, `npm test`) on
spark:low: one session for all 8 calls, 7 delta calls of 75–964 chars, delta
turns 1.4–1.9 s against 4–6 s cold; 8 turns in 27 s where the same task took
6 turns / 41 s without sessions.

## Fight corners and the scoreboard (`src/fight.js`)

Arms `bantam-codexapi-sol` and `bantam-codexapi-spark` run this harness through
the bridge (chat dialect, sessions, extension). Beside `bantam-codex` (the
app-server corner) the difference is the transport; beside each other, the
model. Every BANTAM-driven arm saves `run.json` beside its workspace, and the
card's scoreboard reads usage from each corner's own evidence — BANTAM
artifacts (turns, input/output/cache-hit tokens, prefix reuse), the codex CLI's
"tokens used" tail, Claude's stream-json result — never from narration.
`scoreboard.json` sits beside `fight.json`. An arm without `--verify` is
"unverified", not failed.

Card 8R (`docs/fights/card8r.html`, the log-analyzer rematch, sealed truth
recomputed before the bell): six corners, six exact, six WIN. Local 27B 44.7 s
(card 8: 44.7 s) · bridge spark 61.2 s · bridge sol 63.6 s — one session,
5 delta / 1 full, 15% faster on 3.2× fewer input tokens than the app-server sol
corner at 74.5 s · hermes 67.5 s · codex CLI 98.4 s. Card 11 (codebase surgery)
is recorded in `docs/fight-season-1.md`.

Luna and Terra on the same surgery task through the bridge (2026-08-25, not a
fight card — two parallel API-mode runs, same materials, same sealed check):

| model | wall | turns | input tok | output tok | prefix reuse | sessions | sealed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| terra:medium | 180.0s | 22 | 540,435 | 7,482 | 81% | 21 delta / 2 full | EXACT |
| luna:medium | 291.3s | 54 | 1,578,194 | 9,669 | 93% | 53 delta / 1 full | EXACT |

Both migrated all 32 callers exactly with the provided tests green. Terra worked
in bulk (8 inspects, 3 replaces, 5 shells); luna edited file-by-file (34
replaces), which is why its wall and input grow — but sessions held one thread
for 53 delta turns, so 93% of that input was cache hits. Ran concurrently on one
bridge: different sessions genuinely proceed in parallel. Sol on the same task:
137.1s / 12 turns (card 11). The earlier session-engagement inconsistency did
not recur in either run; still worth recording the planner's per-call decision
in the run artifact before calling it closed.

## Keep in mind

- The bridge's `TOOL_RULES` must stay; `chat_preamble:false` is a persona knob.
- Restart the bridge in its own command: `setsid nohup node bin/codexapi.js`
  returns exit 144 on detach and aborts the rest of a compound command.
  Launch env: `CODEXAPI_PORT=8787 CODEXAPI_HOST=0.0.0.0 CODEXAPI_KEY=…
  CODEXAPI_SESSION_TTL_MS=0`.
- The arena's default port can be held by something else (8378 was, by an
  unrelated `python3`); pick a free one.
- `:model` (the mid-session switcher) does not list bridge entries yet.
- Prefix reuse on the local corner is a harness setting: card 8R's `bantam` arm
  ran the rebuild default and `cache_n` sat at the head checkpoint on 6 of 8
  calls (45%). The BANTAM arms now run extension.
