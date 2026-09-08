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
- **Receipts.** Generate local comparisons with the
  [comparison guide](BRING-YOUR-OWN-COMPARISONS.md). Old replay packages are
  privately archived; new public cards require a privacy review. See the
  [archive policy](fights/README.md).

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

For a guided connection remembered across project folders, run
`node bin/bantam.js setup` and choose **Use an existing model server**. It scans
common localhost ports or accepts your IP/port, asks for the backend/model, and
requests consent before a tiny compatibility inference. An installed Codex CLI
is a separate option. See [First-run setup](FIRST-RUN-SETUP.md).

## Path B — you have a GPU and nothing else

Optional command installation: `npm link` inside the cloned repository registers
both `bantamfactory` and `bantam`. It changes those PATH links. Alternatively,
use the checkout's explicit `bin/bantamfactory` path without replacing an
existing installation. GitHub source installation is the supported release
route; there is no promised npm registry package.

```bash
npm ci                # if you haven't already
node bin/bantam.js setup
```

Choose **Easy mode** to install the community-tuned DavidAU 27B Q4_K_S and its
matching vision projector (18.47 GB decimal), with revision/hash verification
and explicit download consent. Managed installation currently requires Linux
and a detected NVIDIA GPU of approximately 24GB or more. It reuses an existing
llama-server or offers the prebuilt runtime installer.

Choose 72K/CPU vision (baseline), 92K/CPU vision, or 72K/GPU vision. The latter
two require machine-specific fit qualification; they are not universal 24GB
guarantees. MTP is embedded; do not install the legacy add-on sidecar for this
model. No existing model/server is replaced. See the first-run guide for runtime,
disk-space and platform limits. Bring-your-own servers remain the primary path.

With a smaller GPU, menu item 5 offers experimental **Tiel 35B-A3B** with CPU
expert offload, 32K context and no vision projector. It checks for roughly 8GB
NVIDIA VRAM and 32GB system RAM, asks before downloading, and runs a startup
inference before saving the connection. Low-VRAM performance and full-context
fit are not yet physically qualified. These checks are not a hardware guarantee;
see [the experimental profile](FIRST-RUN-SETUP.md#experimental-tiel-for-cpugpu-offload).

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
