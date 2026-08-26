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

New here? **[Getting started](docs/GETTING-STARTED.md)** is the five-minute path.

## Quick start

**Already have a model?** (a local llama.cpp/vLLM server, or an
OpenAI-compatible API):

```bash
git clone <this repo> && cd bantam
node bin/bantam.js doctor                          # diagnoses; wires a found server
node bin/bantam.js doctor --api-url http://HOST/v1 # or register any OpenAI-compatible API
node bin/bantam.js                                 # interactive REPL
```

**Starting from nothing but a GPU?** One command installs the add-ons
(prebuilt llama.cpp ~50 MB + stock Apache-2.0 Qwen 3.8 27B, ~19 GB — sizes
shown, consent asked, downloads resumable), scaffolds the certified launch
profile, and starts the server:

```bash
node bin/bantam.js setup
```

Then, from any project directory:

```bash
node /path/to/bantam/bin/bantam.js run --task "fix the failing test" --autonomous
```

`bantam addons` lists everything optional — vision input, the MTP
speculative-decoding sidecar, voice — with sizes and install commands.
Nothing optional is ever bundled.

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
- `src/supervisor/` — `bantam supervise`: the film archaeologist that
  drafts findings (with evidence) from a saved run — see
  [docs/SUPERVISOR.md](docs/SUPERVISOR.md)
- `test/` — 3,100+ tests; stations are tested at the seam, through the real
  dispatcher
- `docs/` — the [System Handbook](docs/BANTAM-SYSTEM-HANDBOOK.md), the
  [operator guide](docs/GUIDE.md), [the interactive experience &
  network-consent model](docs/INTERACTIVE-EXPERIENCE.md), and
  [the factory doctrine](docs/FACTORY-MODEL.md)

## License

Apache-2.0 (see `LICENSE`). Contributions welcome under a simple DCO
sign-off — see `CONTRIBUTING.md`. The BANTAM name is reserved.

## Status

Pre-release. APIs and station names may still move. The benchmark record in
`docs/fights/` is real and regenerable, but treat the whole thing as a
fast-moving workshop, not a stable platform — that's what launch day is for.
