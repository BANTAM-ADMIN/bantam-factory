# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/BANTAM-ADMIN/bantam-factory/security/advisories/new).
That opens a private advisory only the maintainers can read.

Please include the version or commit, what an attacker gains, and the smallest
reproduction you have. You'll get an acknowledgement within a week.

## Scope — what BANTAM FACTORY's threat model actually is

BANTAM FACTORY runs model-authored actions against your files and your shell. The
security posture is built on that, so the interesting reports are the ones
where a boundary that is *supposed* to hold does not:

- **Workspace escape.** A model action that reads or writes outside the
  selected workspace — path traversal, symlink games, an alias that
  normalizes wrong.
- **Network egress.** Shell network access is off by default and interactive
  runs ask per fetch. Anything that reaches the network without passing that
  gate is a bug worth reporting.
- **Secret leakage.** Credentials reaching a prompt, a saved run artifact, a
  ledger line, or a fight card that should have scrubbed them.
- **Approval bypass.** An action that executes without the consent step its
  class requires, or a gate that can be talked out of firing.
- **Supply chain.** Anything wrong with the two pinned runtime dependencies,
  or with the hash-checked add-on downloads in `src/llama-install.js`.

## Not vulnerabilities

- **A model doing something dumb inside the sandbox it was given.** That is
  the harness working. Constrain the workspace, or file it as a station bug.
- **`--autonomous` skipping prompts.** That is what the flag is for.
- **Weaknesses in models, weights, or llama.cpp.** Report those upstream.
  BANTAM FACTORY vendors no weights and no inference server.

## Supported versions

Pre-release. Only `main` is supported — fixes land there, not in backports.
