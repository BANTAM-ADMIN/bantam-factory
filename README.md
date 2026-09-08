<p align="center">
  <a href="https://bantam-admin.github.io/bantam-factory/">
    <img src="docs/brand/bantam-banner.svg" alt="BANTAM — Small model. Heavy hitter. Your model. Your hardware. A better coding factory." width="100%">
  </a>
</p>

<p align="center">
  <strong>A coding agent for the model you already run.</strong><br>
  Build features. Fix bugs. Check the work. Keep the receipts.
</p>

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a> ·
  <a href="https://bantam-admin.github.io/bantam-factory/"><strong>Watch the fight cards</strong></a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f2b544?style=flat-square&labelColor=19251f" alt="License: Apache 2.0"></a>
  <a href="docs/GETTING-STARTED.md"><img src="https://img.shields.io/badge/Node.js-20%2B-9fdbb8?style=flat-square&labelColor=19251f" alt="Node.js 20 or newer"></a>
  <a href="docs/LAUNCH-READINESS.md"><img src="https://img.shields.io/badge/status-public_beta-f2b544?style=flat-square&labelColor=19251f" alt="Public beta"></a>
</p>

BANTAM turns a local language model into a working coding agent. It reads your
project, edits files, runs your checks, and uses failure evidence to repair the
result. You bring the model and the task. BANTAM supplies the process.

**Local inference on your hardware. Optional frontier power. Results you can inspect.**

<a id="start-with-what-you-already-have"></a>

## Quick start

**Linux or WSL2 · Node.js 20+ · Git · Docker**

Install from source and open guided setup:

```bash
git clone https://github.com/BANTAM-ADMIN/bantam-factory.git
cd bantam-factory
npm ci
docker pull alpine:3
./bin/bantamfactory setup
```

Setup helps you connect an existing model server or your installed Codex CLI.
With a suitable NVIDIA GPU, it also offers an optional model and runtime download.
[Connection and hardware options →](docs/FIRST-RUN-SETUP.md)

To use BANTAM from any project folder, run `npm link` in this checkout. Then:

```bash
cd /path/to/your/project
bantamfactory --verify "npm test"
```

Tell it what needs doing:

> Fix the date parser's ISO-week handling. Add coverage for year boundaries and keep the existing tests passing.

Use your project's actual verification command: `npm test`, `pytest`, or another
check. Inspect the changed files and the verification result when it finishes.

<a id="platforms"></a>

<details>
<summary><strong>Unattended tasks, installation details & platform support</strong></summary>

For a bounded task with explicit verification:

```bash
bantamfactory run --task "Fix the failing tests without weakening them" \
  --verify "npm test" --autonomous --save-run=.bantam/runs/repair.json
```

`npm link` registers both `bantamfactory` and `bantam`, replacing existing links
for those names. Use this checkout's explicit `bin/bantamfactory` path to keep
another installation's links. No npm registry package is required.

Install the toolchain and dependencies your project needs. Linux is the primary
supported platform; Windows uses WSL2 with Docker integration. Native Windows is
unsupported. macOS is unqualified and requires a different sandbox configuration.
See [the full installation guide](docs/GETTING-STARTED.md) and
[platform limits](docs/LAUNCH-READINESS.md).

</details>

## Small model. Real work.

BANTAM is built around a simple idea: useful coding work needs more than a good
model response. It needs context, executable actions, feedback, and a checked finish.

| What you need | What BANTAM brings |
| --- | --- |
| **Work on your code** | Project context, file edits, and commands through your existing toolchain. |
| **Catch mistakes early** | Validated actions, supported generation constraints, and checks that feed the next repair. |
| **Keep inference local** | Connect your own model server and run on your hardware. |
| **Use frontier help** | Opt into supported Codex models and experimental supervised workflows. |
| **Understand the result** | Saved runs, verification evidence, and clocks and token receipts you can inspect. |

With local models and local tools, inference stays on your machine. Hosted models
and external tools receive the context you send them. Project commands run in
Docker by default, with shell network access off by default.
[How the factory works →](docs/FACTORY-MODEL.md)

## Watch the fight

Same work order. Same starting files. Independent acceptance checks. See what
BANTAM and the other systems delivered, how long it took, and what the meters recorded.

[![Receipt Reducer: BANTAM and five other systems, with recorded outcomes and elapsed times](docs/fights/launch-2026-09-07/receipt-reducer/share/share-card.png)](https://bantam-admin.github.io/bantam-factory/receipt-reducer/share/index.html)

**Receipt Reducer, same local 27B:** BANTAM finished in **112.5s**, DeepSeek Harness
in **442.7s**, and Hermes in **577.6s**. All three passed 5/5 and completed cleanly.
Native Terra finished in **107.2s**, Astra in **114.1s**, and Sol in **166.7s**.
[Inspect the run conditions and accounting →](docs/fights/launch-2026-09-07/receipt-reducer/README.md)

**[Explore the fight gallery →](https://bantam-admin.github.io/bantam-factory/)**
Choose a task, compare agents side by side, replay the measurements, and download
the record. The gallery includes slower results, failures, unfinished runs, and
[separately recorded frontier references](docs/fights/launch-2026-09-07/references/README.md).
These are individual development-task observations, not a universal ranking.

### Run BANTAM first. Bring the competition later.

A solo card is useful on its own. Run a frozen work order through BANTAM and
inspect whether it earns its finish:

```bash
bantamfactory cards --card context-packet --arms bantam-local-27b --live --public
```

When you're ready, run a comparison with installed contenders on that work order:

```bash
bantamfactory cards --card context-packet \
  --arms bantam-local-27b,opencode --live --public
```

The second command makes a **new comparison**, including a new BANTAM attempt.
It does not splice results into the earlier run. Keep the original card and its
conditions when comparing later evidence. Use `bantamfactory cards --list` to
see available tasks and participants.

BANTAM asks you to review the plan before execution. `--public` creates a sanitized
local summary; it does not upload or publish the run. Competitors are explicitly
selected, and only the recorded roster appears on the card.
[Bring your own tools →](docs/BRING-YOUR-OWN-COMPARISONS.md)

## Local work. Frontier backup.

Connect an existing llama.cpp server, a compatible API backend, or your installed
Codex CLI through setup. BANTAM can use supported Codex models while retaining
its own action and verification workflow. Hosted usage consumes provider access
and quota; setup asks before using your account or sharing task context.

For heavier coordination, the experimental Astra foreman can supervise a local
BANTAM worker and a Codex worker in a separate candidate workspace.
[Explore the foreman →](docs/FOREMAN.md)

Want a separate build-and-apply boundary? The
[isolated factory workflow](docs/FACTORY-GETTING-STARTED.md) builds a private
candidate and requires an explicit apply step to update your project.

## Go deeper

| Start here | Explore |
| --- | --- |
| [Installation & your first task](docs/GETTING-STARTED.md) | [Factory design](docs/FACTORY-MODEL.md) |
| [Model connections & hardware](docs/FIRST-RUN-SETUP.md) | [System handbook](docs/BANTAM-SYSTEM-HANDBOOK.md) |
| [Fight gallery](https://bantam-admin.github.io/bantam-factory/) | [Comparison adapters & accounting](docs/BRING-YOUR-OWN-COMPARISONS.md) |
| [Security model](SECURITY.md) | [All documentation](docs/README.md) |

A passing verifier establishes what that verifier checked. BANTAM makes the
evidence visible so you can assess its scope.

## Build a better factory

Bring a useful task, a reproducible failure, or a better way to catch mistakes.
Contributions to context delivery, verification, adapters, and the user experience
are welcome. **[Contributing guide →](CONTRIBUTING.md)**

Apache-2.0 licensed. Public beta. Your model. Your hardware. Put it to work.
