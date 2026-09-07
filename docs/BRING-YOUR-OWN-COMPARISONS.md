# Compare with the tools you already use

Status: September 7, 2026. Existing adapters are implemented; a unified end-user
comparison-registration wizard is **planned, not implemented**. Model setup
does not install Hermes, OpenCode, pi, DeepSeek Harness or Claude Code.

## What works today

- `scripts/peer-fight-cli.mjs` runs installed Hermes/OpenCode in disposable
  outer containers. Runtime discovery uses the executable on PATH; for Hermes
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
and local recording endpoint. An executable outside PATH can be exposed using
a command-scoped PATH; pointing at an arbitrary folder or remote agent URL is
not currently a supported generic registration mechanism. These are advanced
runner interfaces, not a one-click comparison experience.

## Product flow to build next

Keep comparison setup separate from the initial model chooser:

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
