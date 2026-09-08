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
| BANTAM FACTORY · local 27B | PASS | 5/5 | 399.9 s |
| Codex · native Astra | PASS | 5/5 | 136.2 s |

Both systems completed accepted work and passed every acceptance group. Astra
was 2.94× quicker, its widest margin over BANTAM FACTORY in the selection series. This
is the heaviest card BANTAM FACTORY has published, at 66 requests.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · all 66 requests | 1,701,335 | 24,787 | 1,568,845 | 132,490 |
| BANTAM FACTORY · separate idle-bounded server window | 1,701,290 | 24,790 | 1,568,800 | 132,490 |
| Astra · native aggregate | 97,141 | 3,665 | 86,016 | 11,125 |

BANTAM FACTORY's prefix reuse was 92.2% across 66 requests, the highest request count
on any published card. It consumed 1.7M input tokens while emitting under 25K
output tokens, so almost all of the cost is re-read context rather than
generation, and 17.5× Astra's input to reach the same passing result. On a
local model those input tokens are cheap in money and expensive in clock; that
trade is the whole shape of this card.

Input already includes cached input: do not add those columns together. A
native aggregate is not a per-request wire recording, and the two systems'
meters must not be forced to agree. Server attribution assumes no other
inference client used the endpoint during the window.

## Conditions and provenance

The two lanes were recorded separately, not simultaneously, on the same frozen
kit, starter bytes and independent grader. BANTAM FACTORY ran on frozen factory source
`7d6d304a419e99da3bfdf347f8fc47a67a147791`, which derives the history window
from the served context and reserves a final action against the wall budget;
its manifest records a 72,192-token served window, a 173,260-character history
budget, a 600-second wall deadline and a 48-second closure reserve. Astra ran
its own native CLI, tools and policies on frozen source
`f236c47ac813fd67e71ee45ec50e817e25143dbc`.

The local contender used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. Local inference
was serial. No manual repairs, teacher requests or post-result changes to the
candidates were made.

These are different models on one development task: an individual observation,
not a ranking or a held-out reliability study. Public exports contain
allowlisted measurements and replay counters, not private source, prompts or
machine paths. Raw evidence remains private. Package hashes check generated
assets, excluding this README; they do not attest authorship or authorize
execution.

</details>
