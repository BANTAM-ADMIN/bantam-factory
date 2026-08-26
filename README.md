# BANTAM

**A local-model coding agent harness. Bring your own LLM — the factory does the rest.**

BANTAM is a constrained-action agent loop built on one thesis: you don't need a
smarter model, you need a better factory around the one you have. Every model
action is structurally constrained (GBNF grammar locally, strict JSON Schema on
API backends), executed in a sandboxed workspace, verified by the project's own
tests, and steered by a set of measured stations — poka-yokes forged from real
failure films, each one shipped with the A/B that proved it.

Point it at any OpenAI-compatible endpoint (llama.cpp, vLLM, a cloud API) and
it runs the full loop: build prompt → constrained completion → execute →
observe → verify → repeat until done.

## Receipts, not benchmarks

Open [`docs/fights/fight-night.html`](docs/fights/fight-night.html) — a fully
self-contained replayable record of 25 sealed cards where a stock 27B in this
harness fights the same tasks as codex CLI, Claude Code CLI (sonnet/opus/
fable), and the same 27B weights in rival harnesses. Sealed holdout judges
hashed before the bell, replication bands, provenance trails, judge errata
kept on the record — including the misses. Run `node bin/fight-concord.mjs`
to re-judge the whole board from artifacts.

## Quick start

```bash
git clone <this repo> && cd bantam
./bin/run-dev.sh doctor            # checks readiness, tells you what's missing
./bin/run-dev.sh                   # interactive REPL against your endpoint
BANTAM_ENDPOINT=http://127.0.0.1:8085 node bin/bantam.js run \
  --task "fix the failing test" --workspace ./myproject --autonomous
```

The harness ships with **no model, no weights, no bundled inference server**.
Optional add-ons (installed on request by `doctor --setup`, never vendored):
a llama.cpp build with a measured, certified launch profile for local models,
and voice I/O. Your code and your model never leave your machine; shell
network access is **off by default** and interactive runs ask you per fetch.

## What's inside

- `src/` — the agent loop, stations (steers, gates, gauges), prompt machinery
  with an append-only extension trajectory tuned for llama.cpp prefix reuse
- `bin/` — CLI (`bantam.js`), fight arena, replay page generator,
  `judge-card.mjs` (instrument-manifest judge), `fight-concord.mjs`
- `test/` — 3,100+ tests; stations are tested at the seam, through the real
  dispatcher
- `docs/` — the [System Handbook](docs/BANTAM-SYSTEM-HANDBOOK.md), the
  [operator guide](docs/GUIDE.md), [the interactive experience &
  network-consent model](docs/INTERACTIVE-EXPERIENCE.md), and
  [the factory doctrine](docs/FACTORY-MODEL.md)

## Status

Pre-release. APIs and station names may still move. The benchmark record in
`docs/fights/` is real and regenerable, but treat the whole thing as a
fast-moving workshop, not a stable platform — that's what launch day is for.
