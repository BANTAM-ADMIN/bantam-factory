# Compare with the tools you already use

Status: September 7, 2026. `bantamfactory cards` now provides a guided front door
to the frozen factory cards, participant selection, prerequisite checks, explicit
execution consent and automatic local replay/export generation. Hermes/OpenCode
support persistent installation-folder registration and offline readiness checks.
Other installation adapters and generic agent APIs still need work.
Model setup does not install Hermes, OpenCode, pi, DeepSeek Harness or Claude Code.

Listing checks PATH/registered executable metadata and the prepared DeepSeek
image using read-only `docker image inspect`; it never starts or pulls an image.
Claude Code presence is listed without invoking it. Detection is not runtime
qualification, and Claude remains outside the frozen-card runner for now.

## Start a card

```bash
bantamfactory cards --list
bantamfactory cards
# Inspect a plan without inference, Docker execution or output-directory creation:
bantamfactory cards --card context-packet --arms bantam-local-27b,hermes --dry-run
# Explicit unattended authorization for these participants and this task:
bantamfactory cards --card context-packet --arms bantam-local-27b,opencode --endpoint http://127.0.0.1:8085 --yes
# Also generate a sanitized local page, without uploading anything:
bantamfactory cards --card context-packet --arms bantam-local-27b,hermes --public --yes
```

The default kit is `factory-2026-09-07`: context-packet, patch-transaction and
stream-framer. Select a card, participants and an endpoint; inspect the plan;
then approve it. Enter at the final confirmation cancels. Listing and dry runs
do not execute participants or contact a model. Interactive server discovery is
bounded loopback model metadata only. Discovery is not a readiness certificate.

Results go into a fresh `.bantam/fight-cards/<timestamp>/` directory (override
with `--out`). Each contender gets a fresh starter workspace, not your project.
The command preserves failed attempts and produces `fight-cards.html`,
`fight-card.json` and raw evidence locally. The HTML embeds recorded source and
transcripts: **inspect before sharing**. Nothing is uploaded automatically.
Exit 0 means the requested series completed and every participant passed;
failed/incomplete outcomes return 1, setup/command errors return 2.

With `--public`, a separate `public/` subdirectory contains an allowlisted
summary page, JSON and package hashes. It excludes raw prompts, source, private
paths and transcripts; preserves failed outcomes, measured timings and accounting
gaps; and does not upload anything. Review only that directory for sharing.
The surrounding evidence and default `fight-cards.html` are still private.

Local counter windows now retain post-cleanup observations in each contender's
`server-usage.json`. The runner waits up to ten seconds for two unchanged idle
samples, 250 ms apart, so canceled requests can finish before the next local
contender starts. This drain interval is recorded separately from contender
wall time. Known-busy work that does not settle stops the local queue. Missing
metrics are explicitly unavailable; ordinary server identity/idle checks still
apply before the next contender. Endpoint counters remain supplementary and
assume exclusive server use; they never replace missing request-level receipts.

Rebuild presentation from existing evidence without any model calls:

```bash
bantamfactory cards --replay /absolute/path/to/recorded-run
```

This regenerates the derived export and HTML; it does not rerun candidates,
change grades or hide a failed attempt. If export validation fails, the command
still attempts a readable replay and returns an error rather than claiming a
successful portable export.

Select cloud IDs explicitly (`codex-astra`, `bantam-codex-astra`); `--yes` also
requires explicit `--arms` and `--card`. Cloud-only execution no longer requires
a local model. The isolated Codex benchmark runtime requires Linux x64 and a
non-root numeric UID/GID. It discovers Node/Git/npm paths and supports the known
npm Codex layout or a standalone Linux x64 Codex executable on PATH. Ordinary
BANTAM Codex setup is separate from this container adapter.

Selected Codex cards first run an offline probe with dummy credentials; a
broken runtime stops the comparison before any scored participant. The probe
checks executable startup, tools, writable candidate space, isolated home and
container cleanup, not account validity or task quality. Run it separately with
`bantamfactory cards --check --arms codex-astra --yes` (no cloud/model request).
Scored comparisons additionally require a readable default file-backed Codex
auth cache. They mount that cache read-only; no login, export, credential write
or keyring migration is performed. Keyring-only/custom-home accounts still need
another adapter. Expired credentials can still fail at actual inference.
See [official credential-storage guidance](https://developers.openai.com/codex/auth#credential-storage).

Local recorded cards currently need a credential-free loopback llama.cpp origin
with `/health`, `/v1/models`, `/props` and `/slots`. A saved llama.cpp connection
is offered; a server on another loopback port can be selected directly. Remote
servers and generic OpenAI-compatible APIs work through BANTAM setup but still
need additional adaptation for this recorded comparison flow. The historical
lane ID `bantam-local-27b` is retained for evidence compatibility, not a check
that the user's selected model has 27B parameters.

Preflight checks selected executables and Docker/image availability, then runs
selected Hermes/OpenCode offline startup checks before any scored contender.
It does not pull images or prove compatibility of every harness version. Missing runtime
prerequisites fail before contender execution. All local inference contenders
run serially. Frontier work may overlap; use `--serial` to serialize everything.

## What works today

- `scripts/peer-fight-cli.mjs` runs installed Hermes/OpenCode in disposable
  outer containers. Runtime discovery uses the registered executable or PATH; for Hermes
  it also resolves that environment's installed Python package. It does not
  copy the operator's whole home or reuse personal harness memory/configuration.
- `scripts/deepseek-fight-cli.mjs` uses a separately prepared, identified
  DeepSeek Harness container. This is not silently provisioned by first-run setup.
- `src/fight.js` contains the existing Claude Code CLI corners. They are not
  automatically included in the newer six-arm factory runner, and installing
  BANTAM does not grant permission to use a Claude subscription.
- The factory runner and replay/export tools already provide frozen materials,
  independent grading, raw evidence and static-card presentation. See
  [fresh factory protocol](FRESH-FACTORY-FIGHTS-2026-09-06.md) and
  [exchange format](FIGHT-CARD-EXCHANGE.md).

Run `node scripts/peer-fight-cli.mjs --help` to inspect its actual interface.
Supply a disposable workspace, task file, new output directory, exact model ID
and local recording endpoint. These are advanced runner interfaces beneath the
guided `cards` command.

## Point at an existing installation

```bash
bantamfactory cards --register hermes --path /path/to/hermes-install
bantamfactory cards --register opencode --path /path/to/opencode-executable
bantamfactory cards --check --arms hermes,opencode --yes
```

Registration resolves a bounded set of known executable locations and saves
the exact executable path and SHA-256. It does not run the tool, authorize an
account or install anything. A changed registered executable requires explicit
re-registration; a missing one does not silently fall back to a different PATH
installation. Registration currently supports only Hermes and OpenCode.

The offline check requires explicit consent, uses network-disabled disposable
containers, and verifies version/help startup, writable candidate space, an
isolated home and cleanup. It makes no model requests and does not certify task
quality or metering. Its report is retained separately from scored evidence.
The peer adapter supports Linux x64 with a non-root numeric UID/GID; it discovers
Node/Git/npm and Hermes Python locations instead of assuming this workstation's
paths. Unknown packaging layouts can still need an adapter change.

## Remaining product flow

The guided entry point is implemented. Complete its portability, remaining installed-folder
adapters and agent-API support while keeping comparison setup separate from
the initial model chooser:

1. Offer “Compare with my tools” after BANTAM's own readiness check. Detect
   executable availability without launching tasks or reading account secrets.
   Let the user supply a specific executable or installation directory.
2. Resolve a known adapter and show executable/version, model, backend, network
   destination, task-data exposure and potential account usage. An unknown
   installation is unsupported until adapted, not guessed into a shell command.
3. Require explicit permission for each participant. Do not install missing
   harnesses, log into accounts, copy credentials or enable subscriptions merely
   because an executable is present. Report unavailable participants as not run.
4. Run capability and metering checks, then a selected frozen card in fresh
   workspaces. Serialize contenders sharing one local server. Frontier runs may
   overlap, with host contention disclosed. Never silently run a rival in the
   user's active project directory.
5. Preview the static replay and machine-readable evidence locally. Sharing
   requires a separate explicit export/publication action and privacy review.

A model's OpenAI-compatible endpoint is **not** an agent/harness endpoint.
An agent API adapter must define task submission, workspace ownership,
completion, cancellation, event streaming and usage reconciliation. Connecting
two harnesses to the same model is different from invoking a remote agent.
pi and generic remote-agent adapters remain future work.

## Honest comparison and reusable learning

Use two unmistakable labels:

- **Same-model harness comparison:** exact weights/quantization, server settings,
  task/starter/judge hashes and resource budgets recorded. Different tools,
  sampling and context policies are part of the treatment, not proof that only
  context caused a difference.
- **Whole-system comparison:** each tool uses its selected model/subscription.
  This compares the systems users can choose, not model intelligence in isolation.

Record input, output, reused-prefix and fresh tokens, timing, auxiliary calls,
retries, model/runtime identity and evidence completeness. Unknown accounting
must block a token-efficiency claim; it is neither zero nor a reason to hide a
participant. Keep accepted completion separate from independent correctness.
Retests and repairs get new identities; they do not replace original failures.

An exchanged card can carry evidence and a proposed process improvement, not
authority to execute downloaded code or weaken acceptance. Imported jigs need
schema/hash validation, inspection, isolated tests, local holdouts and explicit
promotion. Never automatically import another machine's prompts, credentials,
project files or executable hooks. Community learning is a governed qualification
process, not an automatic skill-install side effect of viewing a fight card.

## Claude Code boundary

Claude Code is only a direct CLI agent contender, explicitly requested by name
or number. It is not used as BANTAM's model backend, teacher, planner or judge.
The REPL's implicit `:fight` and the legacy picker's Enter/“all” selection now
stay local; the legacy local BANTAM lane no longer enables a cloud teacher.
The legacy command `bantam fight --arms bantam,claude-sonnet --task "..."` is
available for a deliberate direct comparison. Its execution/isolation/grading
protocol differs from the frozen `cards` runner; do not label them equivalent.
