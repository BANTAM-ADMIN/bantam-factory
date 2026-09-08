<p align="center">
  <a href="https://bantam-admin.github.io/bantam-factory/">
    <img src="docs/brand/bantam-banner.svg" alt="BANTAM — Small model. Heavy hitter. Your model. Your hardware. A better coding factory." width="100%">
  </a>
</p>

<p align="center">
  <strong>Your model is the worker. BANTAM is the factory.</strong><br>
  An open source coding agent that puts your model to work.
</p>

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a> ·
  <a href="https://bantam-admin.github.io/bantam-factory/"><strong>Watch the fights</strong></a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f2b544?style=flat-square&labelColor=19251f" alt="License: Apache 2.0"></a>
  <a href="docs/LAUNCH-READINESS.md"><img src="https://img.shields.io/badge/status-public_beta-f2b544?style=flat-square&labelColor=19251f" alt="Public beta"></a>
</p>

Give BANTAM a coding job. It brings your model the project context, tools, tests,
and feedback to build it. When a check fails, the failure feeds the next repair.

**You bring the intelligence. BANTAM brings the production line.**

## Same model. Bigger punch.

Same task. Same local Qwen 27B. Both systems passed in each comparison below.

| BANTAM vs. | BANTAM finished | Watch the fight |
| --- | --- | --- |
| **Hermes** | **5.1× faster** · 112.5s vs. 577.6s | [Receipt Reducer ↗](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html) |
| **DeepSeek Harness** | **3.9× faster** · 112.5s vs. 442.7s | [Receipt Reducer ↗](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html) |
| **OpenCode** | **6.8× faster** · 81.8s vs. 559.0s | [Patch Transaction ↗](https://bantam-admin.github.io/bantam-factory/patch-transaction/share/index.html) |

These are highlights from recorded development tasks. Open a card for every
contender, the checks, and the run conditions.

**[Enter the fight gallery →](https://bantam-admin.github.io/bantam-factory/)**
Pick a task. Put agents side by side. Replay the clock. See who delivered.

## What can it do?

- **Build the thing.** Add features, fix bugs, and write tests in your project.
- **Check its work.** Run your tests and use the failures to guide repairs.
- **Work on your hardware.** Connect your local model server, with Codex available when you want it.
- **Show the result.** Follow the work as it happens, then inspect the changes and checks.

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
[Installation help](docs/GETTING-STARTED.md) · [Models & hardware](docs/FIRST-RUN-SETUP.md) · [Platform support](docs/LAUNCH-READINESS.md)

## Use the factory to improve the factory.

BANTAM can study recorded failures and build changes to its own machinery.
Its experimental self-improvement workflow tests candidates before promotion,
with a way to roll back. You choose when to run it.

The goal: **a factory that gets better at your work by doing your work.**
[Self-improvement](docs/SELF-IMPROVEMENT.md) · [Next fights: the factory builds its toolbox →](docs/NEXT-FIGHTS.md)

## Put it in the ring.

Start with BANTAM on its own. Inspect the work. Bring competitors to the same
tasks when you're ready. A solo card stands on its own; comparisons show the
contenders actually recorded.

[Run your own cards →](docs/BRING-YOUR-OWN-COMPARISONS.md)

Bring a task, a bug, or a better idea for the factory.
**[Contributions welcome →](CONTRIBUTING.md)**

[How the factory works](docs/FACTORY-MODEL.md) · [All docs](docs/README.md) · [Security](SECURITY.md) · [Apache-2.0](LICENSE)
