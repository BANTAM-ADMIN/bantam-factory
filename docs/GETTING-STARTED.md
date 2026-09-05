# Getting started with BANTAM

*Five minutes from clone to your first completed task.*

## What BANTAM is, in one breath

BANTAM is a coding agent that runs **your** model — a local one on your GPU,
or any OpenAI-compatible API — and wraps it in a factory of guardrails so a
small model works like a much bigger one. You give it a task in plain
English; it reads your project, edits files, runs your tests, and doesn't
say "done" until the work verifies.

You bring the engine. BANTAM is the rest of the car.

## What makes it different

- **Actions can't be malformed.** Every step the model takes is constrained
  by a grammar — it physically cannot emit a broken tool call.
- **Done means verified.** A stack of "done gates" bounces empty, untested,
  or unearned completions back to the model with instructions.
- **Stations catch drift.** Measured guardrails (we call them stations)
  notice patch-thrashing, unverified streaks, missing edge-case coverage —
  and steer the model back, mid-run. Each one exists because a real recorded
  failure motivated it.
- **Private by default.** Everything runs on your machine. Shell network
  access is OFF unless you approve it — interactively, per request.
- **Receipts.** Open `docs/fights/fight-night.html` for the replayable
  benchmark: this harness + a stock 27B against codex CLI and Claude Code
  CLI on sealed tasks, misses included.

## Path A — you already have a model

Any llama.cpp / vLLM / LM Studio server, or an OpenAI-compatible API:

```bash
git clone <repo> bantam && cd bantam
npm ci                                        # two small deps; BANTAM won't start without them
node bin/bantam.js doctor                     # finds a running local server
# — or —
node bin/bantam.js doctor --api-url http://HOST:PORT/v1 --api-key KEY
```

Doctor probes the endpoint and tells you honestly whether it supports
grammar-constrained output (the thing BANTAM relies on). Green check → go.

## Path B — you have a GPU and nothing else

```bash
npm ci                # if you haven't already
node bin/bantam.js setup
```

One command, with consent at every step: prebuilt llama.cpp (~50 MB, no
compiler needed), the stock Apache-2.0 Qwen 3.8 27B (~19 GB, resumable
download), and a start script using our **measured** launch configuration —
every flag annotated with why. Needs ~24 GB VRAM for the default model.

`node bin/bantam.js addons` shows the optional extras (vision input, faster
generation) with sizes. Nothing optional ever downloads silently.

## Your first task

```bash
cd ~/your-project
node /path/to/bantam/bin/bantam.js            # interactive REPL
```

Type what you want:

> the date parser in src/utils fails on ISO weeks — fix it and make sure
> the tests stay green

Watch the feed: one dim line per action, test output when it runs. When it
finishes, the summary says what changed and what verified. For an
unattended run:

```bash
node /path/to/bantam/bin/bantam.js run \
  --task "fix the failing test" --workspace . --autonomous
```

## Three things worth knowing on day one

1. **Give it a verifier.** BANTAM auto-detects `npm test` and friends, and
   its whole discipline works best when a test command grades the work.
2. **Network requests come to you.** If the model wants to download
   something, you'll get a prompt: yes once / always this session / no.
   `--dangerously-allow-net` skips the asking — your call.
3. **The feed is calm on purpose.** Internal course corrections aren't shown
   (they read like malfunctions; they're the factory working). Set
   `BANTAM_SHOW_STATIONS=1` if you want the shop-floor view.

## Where to next

- [The System Handbook](BANTAM-SYSTEM-HANDBOOK.md) — the complete tour
- [The interactive experience](INTERACTIVE-EXPERIENCE.md) — feed, films, and
  the network-consent model in depth
- [The factory doctrine](FACTORY-MODEL.md) — why guardrails beat bigger models
- [Fight Night](fights/README.md) — how the benchmark works and how to run it
