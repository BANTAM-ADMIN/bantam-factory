# Put it in the ring

A fight card is a job with a fixed starting point, independent checks, and a
recorded result. Watch the agents work, compare them side by side, and inspect
what actually passed.

**[Watch the public fights →](https://bantam-admin.github.io/bantam-factory/)**

## Start with BANTAM FACTORY

```bash
bantamfactory cards --list
bantamfactory cards --card context-packet --arms bantam-local-27b --live --public
```

Review the plan and confirm to start. The terminal prints a local browser URL.
A solo card works on its own; no competitor installations are required.

The default kit contains Context Packet, Patch Transaction, and Stream Framer:
build a tool, extend it, and repair it. Use `--card all` for that set, or the
interactive `bantamfactory cards` chooser. `--dry-run` shows a plan without
running a model.

Local recorded cards currently require a credential-free loopback llama.cpp
server, Linux x64, Docker, and a non-root user. General model setup supports
more connections than the recorded comparison runner.

## Bring a challenger

Use an installed contender with the same task:

```bash
bantamfactory cards --card context-packet \
  --arms bantam-local-27b,hermes --live --public
```

Available contender IDs include:

| System | Card ID |
| --- | --- |
| BANTAM FACTORY with your local model | `bantam-local-27b` |
| Hermes / OpenCode | `hermes` / `opencode` |
| DeepSeek Harness with the local model | `deepseek-local-27b` |
| Native Codex | `codex-astra`, `codex-sol`, `codex-terra` |
| Codex inside BANTAM FACTORY | `bantam-codex-astra` |
| Native Claude Code | `claude-sonnet`, `claude-opus` |

Cloud contenders need an installed, authenticated client and explicit selection;
the scored work uses that account. Supported credential and installation layouts
vary. The chooser and checks report missing prerequisites.

To register a local contender that isn't found automatically:

```bash
bantamfactory cards --register hermes --path /path/to/hermes-install
bantamfactory cards --check --arms hermes --yes
```

Registration also supports `opencode` and `deepseek`. It records an existing
installation; it doesn't install competitors. The offline check starts disposable
containers without making model calls.

## Make the comparison count

Freeze the work order, starter, and judge before comparing systems. For a
same-model fight, use the same weights and server settings. Each contender gets
a fresh workspace; keep the recorded budgets and failed attempts visible.

You can develop a task with BANTAM FACTORY first, then freeze it and run challengers.
Keep those development attempts and identify their role. Same-model comparisons
show the harness's contribution; native frontier runs compare whole systems.
A selected development win isn't a held-out reliability score.

## Keep and share the result

Each run gets a fresh directory under `.bantam/fight-cards/`. It keeps the original
evidence and generates a replay. Rebuild a saved replay without another model run:

```bash
bantamfactory cards --replay /absolute/path/to/recorded-run
```

Raw evidence and the default `fight-cards.html` can contain source and prompts.
`--public` creates a separate `public/` folder with a summary, JSON, and hashes.
Review that folder before sharing. Nothing is uploaded automatically.

Published cards show recorded outcomes, job time, and available token receipts.
Local generation speeds use tokens divided by server generation time across
measured requests; partial coverage is labeled. Hardware identifies the reviewed
run's machine, not a forecast for yours.

**[Published card notes](fights/README.md) · [Models & hardware](FIRST-RUN-SETUP.md) · [Docs](README.md)**
