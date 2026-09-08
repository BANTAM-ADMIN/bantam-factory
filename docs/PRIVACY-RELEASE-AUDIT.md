# Privacy release audit — September 7, 2026

Status: **release-candidate audit in progress; repository remains private**.
The checks below distinguish completed evidence from the final publication gate.

## Completed checks and cleanup

- Moved all 261 historical generated fight-card files (315,735,868 bytes) to
  a private local archive outside the repository. Before/after ordered file
  inventories and SHA-256 hashes matched. The archive is not an off-machine backup.
- Removed workstation-specific paths from remaining operator documentation;
  examples are explicitly marked as placeholders. Removed the recorded LAN
  bridge address and inline example credential. If that example credential was
  ever used by a reachable service, rotate it; removing documentation is not revocation.
- Replaced hardcoded operator-home checks in container probes with the actual
  runtime home, retaining their confinement assertions.
- Git author/committer identities used the project GitHub no-reply address.
- Ran Gitleaks 8.30.1 locally against all reachable Git history at `7376db3`
  (65 commits, about 471 MB scanned), with redaction enabled, archive depth 3,
  decode depth 8 and inline allow-comments ignored. All 32 reported alerts
  were source-checksum fields; each matched SHA-256 of historical source bytes.
  No confirmed credential was found by that scan. No repository contents were
  sent to an external scanning service.
- A separate scan of the tracked working-tree snapshot after documentation
  cleanup reported no leaks. This is pattern-based evidence, not a guarantee
  that all personal information or possible credential forms have been found.

Scanner binary source: [official Gitleaks v8.30.1 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).
The Linux x64 archive SHA-256 was checked against the GitHub release asset digest:
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.
Private reports remain outside the repository; this document intentionally does
not include matched values, workstation paths or raw evidence.

## Required before public launch

1. Complete the approved coordinated history cleanup: remove archived raw-card
   paths and sanitize historical workstation identifiers. Preserve a verified
   private bundle and the commit map. Check a fresh remote clone afterward.
2. Finish review of remaining dated documents, image assets and fixture records
   for unrelated personal work and provenance. Scan the exact release tree,
   including newly added files, and inspect final public packages and their
   compressed/encoded payloads. Audit any release assets, hosted sites and
   externally shared bundles separately; a local Git scan does not cover them.
3. Create fresh cards from controlled public-safe tasks. Keep private originals
   separate from sanitized derivatives, with truthful accounting and outcomes.
4. Obtain explicit publication approval and recheck repository visibility.

The earlier launch-plan-only rewrite did not remove the raw cards. Current
release preparation extends that cleanup. Credential rotation and repository
visibility changes are separate actions; neither is implied by a clean scan.
Source kits and graders remain intact. GitHub-internal unreachable objects and
old independent clones cannot be certified erased by a local history rewrite.

## Final preparation findings

- The tracked release-candidate tree passed another redacted Gitleaks scan.
- GitHub reported no forks, pull requests, releases, release artifacts or Pages
  deployment at audit time. Earlier Actions runs require separate review or
  removal before publication because a Git rewrite does not sanitize their logs.
- Eight tracked PNG assets were inventoried. The distinct fixture artwork and
  sanitized comparison image were visually reviewed; fixture text is synthetic,
  including an intentional prompt-injection test label, not a real credential.
- Hosted CI exposed a host-UID assumption in a container test and diagnostic
  stderr backpressure in a stream jig. Release fixes preserve non-root identity
  checks and mandatory completion evidence; diagnostic EAGAIN no longer becomes
  a false protocol failure. Focused regression tests passed.
- Package command metadata now includes `bantamfactory` alongside `bantam` and
  the lockfile matches the package name/version. No global command was relinked.

The final remote revision, history scan, clean-install smoke test and CI outcome
must be recorded before marking this candidate cleared for publication.
