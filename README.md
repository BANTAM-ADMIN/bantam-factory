# BANTAM

**A local-model coding agent harness. Bring your own LLM — the factory does the rest.**

BANTAM is a coding agent that wraps your model in a controlled action loop.
It requests grammar-constrained generation from llama.cpp or structured output
from supported API adapters, validates actions locally, runs model-chosen shell
commands in Docker by default, and uses recorded failure cases to steer repairs.

Give it a task and a verifier such as `npm test`. BANTAM reads your project,
edits files, runs checks, and reports the observed result. A verifier pass means
that command passed on the resulting code; it does not prove requirements the
command never checked. Interactive completion can include caveats, while
`--autonomous` enables stricter completion gates.

The loop is: build prompt → request action → validate → execute → observe →
check → repeat. OpenAI-compatible API syntax alone does not guarantee constrained
generation: use the matching adapter and inspect the startup constraint check.

## Current factory fight cards

The new **[factory workshop](docs/fights/workshop-2026-09-07/public/index.html)**
adds three newly authored build/extend/repair work orders: context packets, atomic
patch planning, and streaming-response framing. This is a BANTAM-only Tiel
qualification with its own [method and results](docs/fights/workshop-2026-09-07/README.md),
not a rerun or replacement of the historical comparison. These stress cards
retain failures and unfinished work; they are an engineering report, not a
clean-sweep launch claim.

Open the **[public launch fight card](docs/fights/launch/public/index.html)**:
three build/change/repair cards, six systems, all 18 comparison attempts retained,
plus a separate latest Tiel qualification. It includes recorded replay,
shareable image/data exports and selected earlier local-attempt history.
BANTAM and DeepSeek Harness both completed 3/3 using the same local 27B;
BANTAM took 12.1 minutes total versus 22.7 minutes. These are single-attempt,
recorded-configuration results, not a universal ranking or an out-of-box promise.

The [public-package guide](docs/fights/launch/README.md) identifies the exact
directory safe to stage for public hosting. The older
[full-evidence Arena](docs/fights/factory-2026-09-06/fight-cards.html) remains a
private, non-redacted archive; do not publish the repository around the card.

The [full results](docs/FRESH-FACTORY-RESULTS-2026-09-06.md) also cover the six
native Sol/Terra follow-ups, incomplete runs, unknown token totals and measured
frontier advantages. The [private evidence package](docs/fights/factory-2026-09-06/README.md)
contains the replay, machine-readable index and hash-verifiable receipts.
It is **not privacy-redacted for public posting**. Read the
[launch plan](docs/BANTAM-LAUNCH-PLAN.md) for the video storyboard, sharing checks
and the proposed Workbench integration; this release does not implement that
new Workbench.

## A faster local-worker path: 35B-A3B

The 27B established the local baseline. Our Tiel 35B-A3B experiments explore
a different trade-off: roughly 3B active parameters per token, faster inference,
and the same obligation to deliver verifiable work. The initial recorded Tiel
configuration decoded about 2.44× faster than the historical 27B configuration;
that is not a task-speed or reliability ranking. A later fresh Snapshot run
achieved **5/5 and accepted completion in 94 seconds**. The latest Snapshot
qualification achieved **5/5 with accepted completion in 223.6 seconds** after
the subsequent recovery-context fixes. Both timings remain separately recorded;
neither single attempt establishes a reliability rate.

The opportunity goes beyond one fast run: more responsive local work,
lower-VRAM deployments through offloading, and several bounded workers sharing
one loaded model. Those last two are qualification targets, not shipped profiles.
Tiel remains experimental; its 18.63 GB weights are not a 3 GB memory footprint.
Read [the local-worker strategy](docs/LOCAL-WORKER-STRATEGY.md) for the potential,
measured progress and limits, and [the qualification record](docs/TIEL-QUALIFICATION-2026-09-06.md)
for every retained attempt. These newer experiments are not merged into the
packaged historical Arena.

## Historical fight-night record

The following board describes earlier builds and configurations, not the
current factory series above.

Open [`docs/fights/fight-night.html`](docs/fights/fight-night.html) — a fully
self-contained replayable record of **35 cards, 297 corners**, where a local
27B in this harness fights the same tasks as codex CLI, Claude Code CLI
(sonnet/opus), and the same 27B weights in rival harnesses (hermes, opencode).
Every card carries the full seven-corner roster. Twenty-five are bouts against
a broken codebase; ten are the **build-off**, where each corner is handed an
empty directory and 900 seconds to build a working tool plus its tests.

Sealed holdout judges hashed before the bell, replication bands, provenance
trails, judge errata kept on the record — including the misses. On the 34
briefs where BANTAM and a same-weights rival both finished clean, BANTAM's
median is 45s against 137s, and it is the faster of the two on 32 of 34; the
two it loses are on the board.

**What the board was fought on.** The BANTAM corners ran a Qwen 3.8 27B
fine-tune (Apache-2.0, Q4_K_M) rather than the DavidAU Q4_K_S easy-mode bundle
now offered by `bantam setup`, and in `--context-mode extension`, which is **not**
the shipped default. The harness is model-agnostic — any Qwen 3.x GGUF, or any
OpenAI-compatible endpoint, drives the same loop — but a different model or a
different mode will not reproduce these exact numbers. Extension in particular
buys prefix-cache reuse at a measured cost in per-run reliability: 22/30
against rebuild's 30/30 on the preregistered compact-strictness family,
replicated three times
([docs/context-trajectories.md](docs/context-trajectories.md)). A
stock-weights, default-mode re-fight is an open launch item — until it lands,
read these cards as a record of that configuration, not of what you get out of
the box.

Everything needed to *read* that record ships here — walls, verdicts, sealed
truths, provenance, and every corner's own recorded output, replayable offline
with no model and no GPU. Re-*deriving* the verdicts (`node
bin/fight-concord.mjs`) additionally needs each corner's archived workspace,
which is hundreds of MB of run artifacts and is deliberately not in the repo;
the command says so plainly rather than pretending.

New here? Start with **[Getting started](docs/GETTING-STARTED.md)**.

## Quick start

**Already have a model?** (a local llama.cpp/vLLM server, or an
OpenAI-compatible API):

```bash
git clone https://github.com/BANTAM-ADMIN/bantam-factory && cd bantam-factory
npm ci                                             # two small deps (acorn); required
docker pull alpine:3                               # the shell sandbox's base image, once (8 MB)
node bin/bantam.js doctor                          # check local server and sandbox setup
# Or register a compatible API (use --api-dialect vllm for vLLM):
node bin/bantam.js doctor --api-url http://HOST:PORT/v1
node bin/bantam.js                                 # interactive REPL
```

**First use:** setup offers an existing server first (bounded localhost scan
or manual IP/port), an installed Codex CLI, or an optional DavidAU 27B easy-mode
bundle for Linux with a 24GB NVIDIA GPU. First interactive startup asks even
when a server is already running. Nothing is downloaded or granted cloud access
merely by opening the chooser. Codex has a separate context-sharing/quota consent
step. Approved connections are remembered across project folders.

```bash
node bin/bantam.js setup
```

Easy mode downloads revision-pinned, SHA-256-checked DavidAU Q4_K_S weights and
their BF16 vision projector (18.47 GB decimal combined), and offers a runtime
install if needed. Choose **72K / CPU vision** (baseline), **92K / CPU vision**,
or **72K / GPU vision**. The latter two require a machine-specific fit check;
24GB capacity alone is not a promise of fit. MTP is embedded in these weights.
Existing model files, launch configurations, and serving processes are not
replaced. See [First-run setup](docs/FIRST-RUN-SETUP.md) for requirements and limits.

Then, from any project directory:

```bash
node /path/to/bantam/bin/bantam.js run --task "fix the failing test" \
  --verify "npm test" --autonomous --save-run=.bantam/runs/first-repair.json
```

`bantam addons` lists legacy optional add-ons; those separate MTP/projector
downloads are not companions for the managed DavidAU bundle. Nothing is vendored.

The harness ships with **no model, no weights, no bundled inference server**.
Easy-mode components are installed only on request. Advanced `doctor --setup`
and `doctor --provision` retain the older generic provisioning path; they do
not install this managed DavidAU profile.
With a local model and local tools, inference stays on your machine. Choosing a
hosted model or an external image tool sends the relevant prompts and context
to that provider. Docker shell network access is **off by default**; interactive
runs can ask for permission to fetch dependencies.

## Factory workflow

For an isolated candidate with a separate apply step, use
[`bantam factory build`](docs/FACTORY-GETTING-STARTED.md). It snapshots the source,
runs the agent in a private workspace, records inspections in a durable event
history, and requires an explicit `bantam factory apply <job-id> --yes` to update
the source workspace. Release is conditional on the supplied verifier.

`bin/bantamfactory` is a convenience launcher for the same CLI; by itself it
opens the ordinary interactive agent. `run --factory` adds factory telemetry
to an ordinary run. Neither selects the isolated `factory build` workflow.
The broader factory scheduler and research mechanisms remain experimental;
the operator guide describes the implemented path and its limits.

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

## Platforms

**Linux** is the platform this is built and tested on — the suite runs on
Ubuntu in CI, and the fight record was made on Linux. Two things make it
Linux-shaped by design, not by accident: every model-chosen shell command
runs through `/bin/sh`, and the Docker sandbox bind-mounts the host's own
`/usr`, `/bin`, and `/lib` read-only into a bare container, so the model uses
the toolchain you already have without an image that ships one.

- **Windows — use WSL2.** Inside WSL2 it *is* Linux: Docker Desktop's WSL
  integration provides `docker`, and everything above holds. Native Windows
  (PowerShell/cmd) is not supported: there is no `/bin/sh` and nothing to
  bind-mount. The llama.cpp installer does know Windows builds, so a model
  server can live on the Windows side while BANTAM runs in WSL2.
- **macOS** — untested. The Docker sandbox cannot work there (a Mac's `/usr`
  holds Mach-O binaries a Linux container cannot run), so the only path is
  `BANTAM_SHELL_SANDBOX=host`, which keeps the workspace confinement and path
  checks but drops container isolation and the offline default — see the
  operator guide before handing that mode an untrusted model.

If you make it run somewhere else, a seam test that proves it is the kind of
contribution `CONTRIBUTING.md` asks for.

## License

Apache-2.0 (see `LICENSE`). Contributions welcome under a simple DCO
sign-off — see `CONTRIBUTING.md`. The BANTAM name is reserved.

## Status

Pre-release. APIs and station names may still move. The benchmark record in
`docs/fights/` is real and regenerable, but treat the whole thing as a
fast-moving workshop, not a stable platform — that's what launch day is for.
