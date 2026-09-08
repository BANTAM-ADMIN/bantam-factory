# Privacy release audit — September 7, 2026

Status: **cleaned release candidate in a fresh private repository; final CI and
explicit publication approval remain required**.
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

## Publication checklist

1. The approved coordinated history cleanup is complete, including the final
   historical example-credential correction described below. Verified private
   bundles and commit maps preserve the originals; a remote installation
   exercise is recorded below. Do not reintroduce old branches or clones.
2. Dated documents, image assets and fixture records have been reviewed for
   known personal identifiers and unrelated work. Re-scan the exact release tree,
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

## Clean repository handoff

The approved cleanup removed 263 historical raw-card paths and replaced known
operator/workstation/private-project identifiers throughout reachable history.
A verified private Git bundle, raw evidence archive and commit map retain the
originals. The resulting tip tree is identical to the prepared release tree;
source changes for installation and CI were separately committed and tested.

Gitleaks scanned all 78 cleaned commits (14.20 MB of scanned changes) with no
leaks found. A separate scan of 2,203 historical blobs found no targeted operator
or private-project identifiers. Remaining home paths and email strings were
reviewed as container paths, placeholders and synthetic fixtures. These are
bounded checks, not a guarantee that every possible sensitive datum is absent.

GitHub still served an old removed commit by SHA after the force-push. Therefore,
the old repository was kept private under an archive name, and a fresh private
repository was created at the original project URL with only cleaned history.
That old commit returns HTTP 404 in the new repository. Do not push old clones,
private bundles, old tags or archived run data into the new repository.

All 44 prior Actions runs had their available logs backed up privately before
removal. Their results were not rewritten; the private logs retain failures.
The clean repository starts a new CI record. No releases, hosted Pages or
release artifacts were migrated.

An isolated GitHub clone installed its two locked dependencies, registered both
commands under a disposable prefix, and launched `bantamfactory --help` without
relinking the operator's installation. The source package was separately unpacked
and scanned. The package remains marked private to prevent accidental npm
publication; that does not prevent a public GitHub source release.

Local qualification: 4,159 tests passed, zero failed, 76 skipped, plus the new
installed-command test passed separately. Hosted CI passed on `f67925e`. The
repository was made public on September 7, 2026 at that revision with explicit
owner approval, after a credential and operator-identifier sweep of the tracked
tree found nothing beyond documented placeholders and synthetic fixtures. A
public repository is not clearance for raw transcripts or archived evidence,
which remain private and ignored. Later cards were added to the public
repository only as reviewed sanitized packages.

## Final historical example correction

A manual documentation-history review found one literal API-key example that
the pattern scanner did not flag. It was replaced throughout release history
with an environment-variable placeholder. This demonstrates why a clean
pattern scan alone is not sufficient. If the value was ever a real service
credential, rotation remains necessary; history cleanup does not revoke it.

The second cleanup preserved the prepared tip tree byte-for-byte. Gitleaks then
scanned 80 rewritten commits (14.21 MB) with no findings, and the targeted
documentation-history check found zero remaining literal examples. Reports,
the original value, recovery bundle and commit map remain private and outside Git.

Because unreachable objects can remain retrievable on GitHub, the intermediate
repository was also retained as a private prelaunch archive. The current project
URL now points to a fresh private repository containing only the final cleaned
history. The pre-cleanup commit returns HTTP 404 there. Those archive repositories
remain private; neither is the release target. No Pages site or release assets
were migrated. The cleaned baseline `a25b4e7` passed hosted CI.

The fresh launch-series cards are separate reviewed derivatives with raw evidence
kept privately. Their public packages retain timeouts, failures and partial
accounting. Recheck CI and scans on the final presentation revision before
publication; explicit approval to change repository visibility is still required.

## Private planning withdrawal and latest gallery review

The requested roadmap document was moved to private storage and removed from
all reachable release history. Its private copy matched the original bytes.
A verified recovery bundle and commit map remain outside the release repository;
the prepared tip tree was unchanged by the history-only rewrite. Gitleaks scanned
82 rewritten commits (14.63 MB) with no findings. Both local history inspection
and a fresh GitHub clone found no remaining history for the withdrawn path.

The intermediate repository was retained as a third private historical archive.
The original project URL now points to another fresh private repository with
only the cleaned history. The removed pre-cleanup commit lookup reports no
commit found. All historical archives must remain private. No Pages site or
release assets were migrated. Cleaned revision `06fb455` and the subsequent
native-model comparison revision `bb31e5f` passed hosted CI. A manual Pages
dispatch with publication consent disabled correctly skipped deployment.

The three-task launch gallery at `e8997f2` retains all nine recorded attempts,
including both parser timeouts. Desktop and mobile gallery layouts were visually
reviewed. Its generated public directory passed a redacted secret scan with no
findings; package hashes were validated. Focused accounting/gallery tests passed
37 tests with one skip, and share-page tests passed seven with two browser-gated
skips. These are focused checks, not a new full-suite result. Later cards,
changes and the final release revision still require their own checks.
