# Path scope · selection series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Decide whether a candidate path stays inside a workspace root, without
trusting a shared string prefix. A sibling directory whose name begins with
the root's name is outside it; a normalized path that climbs above the root is
outside it; the root itself is inside it.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 75.1 s |

One system is recorded on this work order so far. BANTAM completed accepted
work and passed every acceptance group. At 75.1 seconds it is the second
quickest recorded pass in the gallery, behind context packet at 58.1 s.

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 16 requests | 125,827 | 5,025 | 96,652 | 29,175 |
| BANTAM · separate idle-bounded server window | 125,770 | 5,020 | 96,600 | 29,170 |

Prefix reuse was 76.8% across 16 requests, the lowest ratio on any published
card and a direct consequence of the short run: fewer turns means the fixed
prompt preamble is amortized over less reused context. Input already includes
cached input: do not add those columns together. Server attribution assumes no
other inference client used the endpoint during the window.

## Conditions and provenance

Recorded on frozen factory source
`7d6d304a419e99da3bfdf347f8fc47a67a147791`, which derives the history window
from the served context, reserves a final action against the wall budget, and
quotes the assignment's own named requirements back into the completion audit.
The manifest records a 72,192-token served window, a 173,260-character history
budget, a 600-second wall deadline and a 48-second closure reserve.

The local contender used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. Local inference
was serial. No manual repairs, teacher requests or post-result changes to the
candidate were made.

One recorded attempt is an observation, not an expected value, and a
single-system card is not a comparison. Public exports contain allowlisted
measurements and replay counters, not private source, prompts or machine
paths. Raw evidence remains private. Package hashes check generated assets,
excluding this README; they do not attest authorship or authorize execution.
