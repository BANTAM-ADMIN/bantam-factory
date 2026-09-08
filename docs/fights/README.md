# BANTAM fights

Real work orders. Independent checks. Recorded clocks and token receipts.

## Latest factory

[Browse the launch gallery](launch-2026-09-07/index.html).

[Receipt reducer · six-system comparison](launch-2026-09-07/receipt-reducer/README.md):
**BANTAM 112.5s, DeepSeek Harness 442.7s, Hermes 577.6s**, using the same local
27B. Native Terra 107.2s, Astra 114.1s and Sol 166.7s. All six passed 5/5 and
completed the work. Full counters, Hermes's partial wire accounting and its
separate server totals are documented alongside the replay.

[Patch transaction · launch series](launch-2026-09-07/patch-transaction/README.md):
**BANTAM 81.8s, OpenCode 559.0s, native Astra 90.3s.** All passed 5/5 and
finished cleanly; complete recorded totals are available for every lane.

[Snapshot drift · six-system comparison](launch-2026-09-07/snapshot-drift/README.md):
**BANTAM 124.3s, DeepSeek Harness 465.8s, Hermes 497.0s**, all 5/5. Native
Terra was fastest overall at 106.2s. Sol's five passing functional groups did
not override its protected-test modification: that attempt remains a FAIL.

[Job planner · six-system comparison](launch-2026-09-07/job-planner/README.md):
**BANTAM 193.2s, DeepSeek Harness 483.5s, Hermes TIMEOUT at 2/5.** Native
Astra 118.4s, Terra 119.3s and Sol 240.9s, all 5/5. BANTAM was the only local
contender under four minutes; the Hermes timeout is retained with its partial
accounting.

[Context packet · launch series](launch-2026-09-07/context-packet/README.md):
BANTAM 5/5 in **58.1s**, native Astra 5/5 in **110.6s**, OpenCode 5/5 artifact
but no clean completion at its **600s** time limit. Watch the replay, download
the share image, and inspect the accounting.

[Stream framer · launch series](launch-2026-09-07/stream-framer/README.md):
native Astra passed **5/5 in 160.7s**. BANTAM timed out at 4/5 and OpenCode at
0/5. Both local attempts retain their partial accounting; this is a disclosed
loss, not an omitted run. All six launch work orders are now published.

## Native Claude Code references

[Sonnet, Opus and Fable on the launch work orders](launch-2026-09-07/references/README.md).
Separately recorded reference cards sit beside each launch card and appear as
one table on the gallery page, with BANTAM's own attempt shown for context.
They are never merged into a card's roster. The earlier
[Sonnet and Opus reference set](claude-references-2026-09-07/README.md)
from September 7 is retained unchanged as its own cohort.

## Earlier reviewed comparison

[Context packet · Hermes comparison](context-packet-2026-09-07-public/README.md):
BANTAM 5/5 in 124.6s, Hermes 5/5 in 589.0s, OpenCode 0/5 in 157.8s.
This is a separate earlier attempt with different output-budget settings, not
another task or a repeat of the latest configuration. Its caveats remain attached.

## Historical records

The old generated fight cards, replay pages, raw logs, evidence archives,
showcases and share images have been moved to a private local archive outside
this repository. Historical result discussions elsewhere in the documentation
refer to those archived runs, not to a currently distributed public showcase.
Reusable work orders, graders and generators remain in the repository.

## Publication policy

New cards are generated from fresh runs and reviewed before publication.
Keep raw evidence outside tracked documentation (for example under the ignored
`.bantam/` directory). Do not publish raw prompts, workspaces, machine paths,
account details, credentials or embedded evidence bundles by default. Inspect
compressed and encoded attachments as well as visible page content. Sanitized
cards must retain truthful scores, accounting completeness, failures and timing;
privacy cleanup is not permission to improve a result or silently alter sealed
evidence. Keep original evidence private and identify sanitized derivatives.

Generated files here are ignored to prevent accidental reintroduction. Adding
a reviewed public package must be an explicit publication decision.

## Repository publication

The approved history cleanup and fresh-private-repository handoff are recorded
in the [privacy audit](../PRIVACY-RELEASE-AUDIT.md). Historical archives remain
private. The release repository was made public on September 7, 2026 with
explicit approval after hosted CI passed on the release revision; the gallery
is published through GitHub Pages by the explicit publication workflow. A
reviewed card is not blanket clearance for raw transcripts or unrelated
release assets.

See [bring-your-own comparisons](../BRING-YOUR-OWN-COMPARISONS.md) to generate
new local cards, and [launch readiness](../LAUNCH-READINESS.md) for remaining work.
