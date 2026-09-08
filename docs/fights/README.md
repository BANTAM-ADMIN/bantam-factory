# BANTAM fights

Real work orders. Independent checks. Recorded clocks and token receipts.

## Latest factory

[Browse the live launch gallery](https://bantam-admin.github.io/bantam-factory/)
(source: [launch-2026-09-07/index.html](launch-2026-09-07/index.html)).
Eight work orders, every planned contender recorded, misses included.

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

[Redaction plan · six-system comparison](launch-2026-09-07/redaction-plan/README.md):
**BANTAM 175.6s, DeepSeek Harness 391.8s, Hermes TIMEOUT with a 5/5 artifact.**
Native Astra 117.0s, Terra 134.3s and Sol 241.2s, all 5/5. The notes disclose
that BANTAM made 45 requests and used 2.1× DeepSeek's input tokens on this
work order while producing 53.6% fewer output tokens.

[Retry budget · six-system comparison](launch-2026-09-07/retry-budget/README.md):
**BANTAM 141.7s, DeepSeek Harness 445.8s, Hermes 562.0s**, all 5/5. Native
Astra 137.3s, Terra 143.2s and Sol 231.8s. BANTAM finished 4.4 seconds behind
Astra and ahead of Terra; every contender completed the work.

[Context packet · launch series](launch-2026-09-07/context-packet/README.md):
BANTAM 5/5 in **58.1s**, native Astra 5/5 in **110.6s**, OpenCode 5/5 artifact
but no clean completion at its **600s** time limit. Watch the replay, download
the share image, and inspect the accounting.

[Stream framer · launch series](launch-2026-09-07/stream-framer/README.md):
native Astra passed **5/5 in 160.7s**. BANTAM timed out at 4/5 and OpenCode at
0/5. Both local attempts retain their partial accounting; this is a disclosed
loss, not an omitted run.

## Native Claude Code references

[Sonnet, Opus and Fable on all six launch work orders](launch-2026-09-07/references/README.md).
Eighteen separately recorded attempts, all 5/5, published beside the launch
cards and rendered as one table on the gallery page with BANTAM's own attempt
for context. BANTAM's attempt was quicker than all three on Context packet
and within a second of Sonnet on Patch transaction; Claude was quicker on the
other four, including Stream framer. They are never merged into a card's
roster. The earlier
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
