<p align="center">
  <a href="https://bantam-admin.github.io/bantam-factory/">
    <img src="docs/brand/bantam-banner.svg" alt="BANTAM FACTORY — Small model. Heavy hitter. Your model. Your hardware. A better coding factory." width="100%">
  </a>
</p>

<p align="center">
  <strong>Your model is the worker. Give it a factory.</strong><br>
  An open source coding factory that can improve its own machinery.
</p>

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a> ·
  <a href="https://bantam-admin.github.io/bantam-factory/fights.html"><strong>Watch the fights</strong></a> ·
  <a href="https://bantam-admin.github.io/bantam-factory/assets/showcase/examples/tetris/index.html">Play what it built</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f2b544?style=flat-square&labelColor=19251f" alt="License: Apache 2.0"></a>
  <a href="docs/GETTING-STARTED.md"><img src="https://img.shields.io/badge/status-public_beta-f2b544?style=flat-square&labelColor=19251f" alt="Public beta"></a>
</p>

Give BANTAM FACTORY a job: build an app, fix a stubborn bug, automate the boring part.
It brings your model the tools, context, and checks to get the work done.
Run a local 27B, or put **Codex Astra, Sol, or Terra** inside the factory.

The factory formula: **turn big jobs into chicken problems**. Put the model at
one station at a time—as worker, reviewer, or test builder. The factory runs
the checks, feeds back the result, and directs the next repair or delivery.

## Get more from Codex.

**Your Codex account. Same models. A better way to work.**
Connect your signed-in Codex CLI during setup. The factory gives Astra, Sol,
or Terra focused context, reusable tools, and checks that guide the next step.

Recorded Context Packet fights against each model's native Codex CLI:

| Same model | Faster completion | Fewer input tokens | See the work |
| --- | --- | --- | --- |
| **Astra** | **1.2×** | **46%** | [Round 1 ↗](https://bantam-admin.github.io/bantam-factory/codex/context-packet-astra-context-1/share/index.html) · [Round 2 ↗](https://bantam-admin.github.io/bantam-factory/codex/context-packet-astra-context-2/share/index.html) |
| **Sol** | **1.8×** | **44%** | [Round 1 ↗](https://bantam-admin.github.io/bantam-factory/codex/context-packet-sol-1/share/index.html) · [Round 2 ↗](https://bantam-admin.github.io/bantam-factory/codex/context-packet-sol-2/share/index.html) |
| **Terra** | **2.3×** | **73%** | [Replay ↗](https://bantam-admin.github.io/bantam-factory/codex/context-packet/share/index.html#card=context-packet&view=results&layout=compare&left=bantam-codex-terra&right=codex-terra) |

Same task, starting files, and medium reasoning effort. Every run passed all
five independent check groups. Astra and Sol combine two paired repeats;
Terra is one pair. Each replay includes the code, tests, wall clock, input,
output, and prefix-cache tokens. Cache hits are included in input.

**Another Astra fight: 35% less input, 14% less output, 12% less time.**
Both snapshot checkers passed all five acceptance groups.
[Watch Astra inside the factory vs. native Codex →](https://bantam-admin.github.io/bantam-factory/codex/snapshot-drift-qualified-4/share/index.html#card=snapshot-drift&view=results&layout=compare&left=bantam-codex-astra&right=codex-astra)

**[Play what Astra built →](https://bantam-admin.github.io/bantam-factory/assets/showcase/examples/arcade/index.html)**
Same brief. Two playable games. Compare the factory and native CLI builds.

<p align="center">
  <img src="docs/brand/chicken-problems.png" alt="A chicken struggles with a square peg, then builds a factory that sorts the pieces and sends the right one to the job." width="100%">
</p>

## Same model. Bigger punch.

Same task. Same local Qwen 27B. Both systems passed in each comparison below.

The local rig: **one RTX 4090 · 24 GB**. BANTAM FACTORY's recorded generation speed
across the published cards: **82.6–105.2 tokens/second**.

| BANTAM FACTORY vs. | Faster completion | Fewer input tokens | Watch the fight |
| --- | --- | --- | --- |
| **Pi** | **6.0×** | **74%** | [Context Packet ↗](https://bantam-admin.github.io/bantam-factory/context-packet/share/index.html#card=context-packet&view=results&layout=compare&left=bantam-local-27b&right=pi) |
| **Hermes** | **8.8×** | **≥69%** | [Context Packet ↗](https://bantam-admin.github.io/bantam-factory/context-packet/share/index.html#card=context-packet&view=results&layout=compare&left=bantam-local-27b&right=hermes) |
| **DeepSeek Harness** | **3.9×** | **47%** | [Receipt Reducer ↗](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html) |
| **OpenCode** | **6.8×** | **73%** | [Patch Transaction ↗](https://bantam-admin.github.io/bantam-factory/patch-transaction/share/index.html#card=patch-transaction&view=results&layout=compare&left=bantam-local-27b&right=opencode) |

These are highlights from recorded development tasks. Open a card for every
contender, the checks, and the run conditions.
Hermes' token saving is a lower bound: 18 of its 19 requests have token counters.

The little model can trade punches with frontier agents, too:
[Context Packet](https://bantam-admin.github.io/bantam-factory/context-packet/share/index.html)
took **58.1s locally vs. 110.6s in native Codex/Astra**, both 5/5.

**[Enter the fight gallery →](https://bantam-admin.github.io/bantam-factory/fights.html)**
Pick a task. Put agents side by side. Read how it went. Inspect every recorded
action and the files they delivered.

**[Try a tool the factory built in 58 seconds →](https://bantam-admin.github.io/bantam-factory/context-packet/share/index.html#try-it)**

## What can it do?

- **Build what you need.** Features, tools, scripts, fixes, and tests.
- **Check and repair.** Use real test results to guide the next attempt.
- **Make the next job easier.** Build reusable tools for the work you keep doing.
- **Put your hardware to work.** Run a local model, or bring your Codex account.

**Let Astra supervise.** Watch it direct a Terra or Sol worker on the
[context packer](https://bantam-admin.github.io/bantam-factory/codex/context-packet-qualified-1/share/index.html)
or [stream decoder](https://bantam-admin.github.io/bantam-factory/codex/stream-framer-qualified-1/share/index.html).
Both models' work and tokens are included.

<a id="start-with-what-you-already-have"></a>

## Quick start

<a id="platforms"></a>

**Linux / WSL2 · Node.js 20+ · Git · Docker**

```bash
git clone https://github.com/BANTAM-ADMIN/bantam-factory.git
cd bantam-factory
npm ci
docker pull alpine:3
npm link
bantamfactory setup
```

Setup connects your model server or installed Codex CLI. Need a local model?
It also offers a guided download for supported NVIDIA GPUs.

Then open your project:

```bash
cd /path/to/your/project
bantamfactory --verify "npm test"
```

Tell it what you want:

> Add dark mode. Remember my choice. Make sure the tests pass.

Use your project's test command in place of `npm test`.
[Installation help](docs/GETTING-STARTED.md) · [Models & hardware](docs/FIRST-RUN-SETUP.md)

## Use the factory to improve the factory.

BANTAM FACTORY records recurring friction. Its experimental self-improvement workflow
can study those signals, build a change to BANTAM FACTORY, and test its own work before
adopting an eligible improvement. You choose when to run that cycle.

**Better tools. Fewer repeated mistakes. A better-equipped factory.**
[Try self-improvement →](docs/SELF-IMPROVEMENT.md)

## Put it in the ring.

Give it a task worth solving. Watch the work. Bring competitors to the same
task and see what the harness changes.

[Run your own cards →](docs/BRING-YOUR-OWN-COMPARISONS.md)

Bring a task, a bug, or a better idea for the factory.
**[Contributions welcome →](CONTRIBUTING.md)**

[How the factory works](docs/FACTORY-MODEL.md) · [All docs](docs/README.md) · [Security](SECURITY.md) · [Apache-2.0](LICENSE)
