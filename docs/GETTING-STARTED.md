# Getting started with BANTAM

*Connect a running model, complete a repair, and inspect the evidence.*

## What BANTAM is, in one breath

BANTAM is a coding agent that runs **your** model — a local one on your GPU,
or a supported API endpoint. Give it a task in plain English and a command
that checks the result. It reads your project, edits files, runs checks, and
reports what passed, failed, or remains unverified.

You bring the engine. BANTAM is the rest of the car.

## What makes it different

- **Actions are validated before execution.** llama.cpp can constrain generation
  with a grammar; API adapters use their supported structured-output mechanism.
  Server support matters, and malformed responses become repair turns.
- **Completion carries evidence.** A configured verifier grades the final code.
  Completion gates catch several common failures; interactive sessions can
  finish with caveats, and `--autonomous` enables stricter gates.
- **Stations catch drift.** Measured guardrails (we call them stations)
  notice patch-thrashing, unverified streaks, missing edge-case coverage —
  and steer the model back, mid-run. Each one exists because a real recorded
  failure motivated it.
- **Local operation.** A local model keeps inference on your machine. Hosted
  models and external image tools send their inputs to that provider. Docker
  shell network access is off by default.
- **Receipts.** Open `docs/fights/fight-night.html` for the replayable
  benchmark: this harness + a tuned Qwen 3.8 27B in `extension` context mode
  against other harnesses and cloud agents, misses included. Those weights and
  that mode differ from the stock model and `rebuild` default installed today;
  see the [configuration disclosure](../README.md#receipts-not-benchmarks).

Use Linux, or Linux inside WSL2 with Docker available. You need Node 20+ and
the toolchain and dependencies for your project. Native Windows is unsupported;
macOS is untested and requires explicit host execution because the default
sandbox mounts Linux host tools. See [platforms](../README.md#platforms).

## Path A — you already have a model

A running llama.cpp server is the shortest path. vLLM and other compatible
servers need the appropriate API adapter and structured-output support:

```bash
git clone https://github.com/BANTAM-ADMIN/bantam-factory && cd bantam-factory
npm ci                                        # two small deps; BANTAM won't start without them
docker pull alpine:3                          # the shell sandbox's base image — once, 8 MB
node bin/bantam.js doctor                     # checks a local server and Docker setup
# — or —
node bin/bantam.js doctor --api-url http://HOST:PORT/v1 --model MODEL
# For vLLM, add --api-dialect vllm; for a chat-only API, use --api-dialect chat.
# Add --api-key KEY only when the provider requires authentication.
```

The API check reports reachability and exercises the chosen constraint path.
Read both results: a reachable server is not proof that it enforces a grammar
or schema. A failed constraint check means the generation guarantee is absent.
See the [runtime guide](MODEL-RUNTIMES-AND-IMPROVEMENT.md) for provider selection.

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
node /path/to/bantam/bin/bantam.js --verify "npm test"  # use your project's check command
```

Type what you want:

> the date parser in src/utils fails on ISO weeks — fix it and make sure
> the tests stay green

Watch the feed: one dim line per action, test output when it runs. When it
finishes, inspect the changed files and the verifier outcome. `verifier passed`
means the configured command passed; a warning or `unverified` result needs
attention. Passing existing tests does not establish requirements they omit.
For an
unattended run:

```bash
node /path/to/bantam/bin/bantam.js run \
  --task "fix the failing test" --workspace . --verify "npm test" --autonomous \
  --save-run=.bantam/runs/first-repair.json
```

## Three things worth knowing on day one

1. **Give it a verifier.** BANTAM auto-detects `npm test` and friends, and
   can offer one interactively. Pass `--verify` explicitly in scripts. Choose
   checks that exercise the requested behavior; agent-written tests are useful
   but are not independent acceptance evidence.
2. **Network requests come to you.** If the model wants to download
   something, you'll get a prompt: yes once / always this session / no.
   `--dangerously-allow-net` skips the asking — your call.
3. **The feed is calm on purpose.** Internal course corrections aren't shown
   (they read like malfunctions; they're the factory working). Set
   `BANTAM_SHOW_STATIONS=1` if you want the shop-floor view.

## Where to next

- [Factory build, inspect, apply](FACTORY-GETTING-STARTED.md) — build a private
  candidate before explicitly updating your source workspace
- [The System Handbook](BANTAM-SYSTEM-HANDBOOK.md) — the complete tour
- [The interactive experience](INTERACTIVE-EXPERIENCE.md) — feed, films, and
  the network-consent model in depth
- [The factory doctrine](FACTORY-MODEL.md) — why guardrails beat bigger models
- [Fight Night](fights/README.md) — how the benchmark works and how to run it
