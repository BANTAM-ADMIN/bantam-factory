# Privacy release audit — September 7, 2026

Status: **not cleared for public release**. The repository remains private.

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

1. Choose and explicitly approve either a clean public repository with reviewed
   source only, or a coordinated history rewrite. Do not make the existing repo
   public merely because its newest tree no longer contains the old cards.
2. Finish review of remaining dated documents, image assets and fixture records
   for unrelated personal work and provenance. Scan the exact release tree,
   including newly added files, and inspect final public packages and their
   compressed/encoded payloads. Audit any release assets, hosted sites and
   externally shared bundles separately; a local Git scan does not cover them.
3. Create fresh cards from controlled public-safe tasks. Keep private originals
   separate from sanitized derivatives, with truthful accounting and outcomes.
4. Obtain explicit publication approval and recheck repository visibility.

No history rewrite, credential rotation, public upload or visibility change was
performed by this audit. Source kits and graders remain intact.
