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
  <a href="https://bantam-admin.github.io/bantam-factory/"><strong>Watch the fights</strong></a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f2b544?style=flat-square&labelColor=19251f" alt="License: Apache 2.0"></a>
  <a href="docs/GETTING-STARTED.md"><img src="https://img.shields.io/badge/status-public_beta-f2b544?style=flat-square&labelColor=19251f" alt="Public beta"></a>
</p>

Give BANTAM FACTORY a job: build an app, fix a stubborn bug, automate the boring part.
It brings your model the tools, context, and checks to get the work done.

The factory formula: **turn big jobs into chicken problems**—clear inputs,
useful tools, and results you can check. Build. Test. Repair. Repeat.

## Same model. Bigger punch.

Same task. Same local Qwen 27B. Both systems passed in each comparison below.

The local rig: **one RTX 4090 · 24 GB**. BANTAM FACTORY's recorded generation speed
across the published cards: **82.6–105.2 tokens/second**.

| BANTAM FACTORY vs. | BANTAM FACTORY finished | Watch the fight |
| --- | --- | --- |
| **Hermes** | **5.1× faster** · 112.5s vs. 577.6s | [Receipt Reducer ↗](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html) |
| **DeepSeek Harness** | **3.9× faster** · 112.5s vs. 442.7s | [Receipt Reducer ↗](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html) |
| **OpenCode** | **6.8× faster** · 81.8s vs. 559.0s | [Patch Transaction ↗](https://bantam-admin.github.io/bantam-factory/patch-transaction/share/index.html) |

These are highlights from recorded development tasks. Open a card for every
contender, the checks, and the run conditions.

The little model can trade punches with frontier agents, too:
[Context Packet](https://bantam-admin.github.io/bantam-factory/context-packet/share/index.html)
took **58.1s locally vs. 110.6s in native Codex/Astra**, both 5/5.

**[Enter the fight gallery →](https://bantam-admin.github.io/bantam-factory/)**
Pick a task. Put agents side by side. Replay the clock. See who delivered.

## What can it do?

- **Build what you need.** Features, tools, scripts, fixes, and tests.
- **Check and repair.** Use real test results to guide the next attempt.
- **Make the next job easier.** Build reusable tools for the work you keep doing.
- **Put your hardware to work.** Run a local model, or bring your Codex account.

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
