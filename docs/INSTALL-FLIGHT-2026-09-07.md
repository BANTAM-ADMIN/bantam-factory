# Private GitHub installation flight — September 7, 2026

This tests the first experience on the development machine using a fresh
shallow clone from private GitHub, not a copy of the working directory.
It is not evidence of a clean operating-system install or another GPU's fit.

## Verified path

- Cloned committed `a8332af` from the private remote into a disposable directory.
- Installed only BANTAM's two locked npm dependencies with `npm ci
  --ignore-scripts --no-audit --no-fund`, using an isolated npm cache.
- Invoked that checkout's explicit `bin/bantamfactory setup` in a disposable
  project with a new absolute `BANTAM_CONFIG_DIR`. No global linking or PATH edit.
- The real terminal chooser detected Codex and offered existing-server,
  DavidAU and experimental Tiel options without installing a rival or model.
- Selected discovery found the already-running llama.cpp server. Approved its
  tiny constrained compatibility request with no project content; it passed.
  No server restart, model replacement or runtime-flag change was performed.
- A second disposable project reused that saved connection and produced a
  five-participant dry-run plan for BANTAM, Hermes, OpenCode, DeepSeek and Codex.
- Registered the existing Hermes and OpenCode executable paths in the isolated
  registry. Both passed actual network-disabled readiness checks from the clone:
  Hermes 0.20.0 (2026.8.3), OpenCode 1.18.23. Containers were removed.

## Discovery issue found

The initial listing marked the already-installed DeepSeek adapter image as
needing setup. Discovery was amended to inspect image metadata without starting
a container. The listing also now checks Claude Code's PATH presence without
invoking it. Regression coverage distinguishes discovery from execution consent.

## What this does not prove

This particular flight was setup plus offline installed-peer qualification, not a scored fight.
No Claude or Codex agent request ran, and no claim of task quality or token
efficiency follows. At the time of this flight, native DeepSeek folder registration
and portable Codex packaging were unfinished. Subsequent updates added installed
npm DeepSeek registration and qualified tool/usage/deadline checks, plus more
portable Codex runtime discovery and offline checks. See the current
[comparison guide](BRING-YOUR-OWN-COMPARISONS.md) for their tested scope and limits.
The explicitly opted-in frozen Claude contender remains unfinished. The
prepared DeepSeek image is not the same as a generic native adapter.
General remote-agent APIs and remote recorded-model comparisons also remain work.

This installation flight does not clear the repository for public release;
see the [privacy audit](PRIVACY-RELEASE-AUDIT.md).
