# Semver range · selection series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Repair a version selector so it orders versions by real semantic precedence
and admits prereleases into a range only when the range invites them. Numeric
identifiers compare numerically, a prerelease sorts below its own release, and
build metadata is ignored for precedence. The range is validated on every
invocation, including when no versions are offered.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 399.9 s |

One system is recorded on this work order so far. BANTAM completed accepted
work and passed every acceptance group. This is the longest passing run in the
selection series, and the heaviest by request count.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 66 requests | 1,701,335 | 24,787 | 1,568,845 | 132,490 |
| BANTAM · separate idle-bounded server window | 1,701,290 | 24,790 | 1,568,800 | 132,490 |

Prefix reuse was 92.2% across 66 requests, the highest request count on any
published card. The run consumed 1.7M input tokens while emitting under 25K
output tokens, so almost all of the cost is re-read context rather than
generation. Input already includes cached input: do not add those columns
together. Server attribution assumes no other inference client used the
endpoint during the window.

## Conditions and provenance

Recorded on frozen factory source
`7d6d304a419e99da3bfdf347f8fc47a67a147791`, which derives the history window
from the served context, reserves a final action against the wall budget, and
quotes the assignment's own named requirements back into the completion audit.
The manifest records a 72,192-token served window, a 173,260-character history
budget, a 600-second wall deadline and a 48-second closure reserve.

The assignment on this work order states the range-validation rule explicitly
rather than leaving it implied by the acceptance groups. The grader was not
weakened to accommodate a candidate.

The local contender used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. Local inference
was serial. No manual repairs, teacher requests or post-result changes to the
candidate were made.

One recorded attempt is an observation, not an expected value, and a
single-system card is not a comparison. Public exports contain allowlisted
measurements and replay counters, not private source, prompts or machine
paths. Raw evidence remains private. Package hashes check generated assets,
excluding this README; they do not attest authorship or authorize execution.
