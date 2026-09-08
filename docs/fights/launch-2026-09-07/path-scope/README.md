# Path scope · selection series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Decide whether a candidate path stays inside a workspace root, without
trusting a shared string prefix. A sibling directory whose name begins with
the root's name is outside it; a normalized path that climbs above the root is
outside it; the root itself is inside it.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM FACTORY · local 27B | PASS | 5/5 | 75.1 s |
| Codex · native Astra | PASS | 5/5 | 107.9 s |

Both systems completed accepted work and passed every acceptance group. The
local 27B was 1.44× quicker than the frontier CLI on this attempt. At 75.1
seconds it is the second quickest recorded pass in the gallery, behind context
packet at 58.1 s.

**Inside each contender:** a short explanation, the recorded actions and their results, delivered files with before/after changes, and the acceptance output.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · all 16 requests | 125,827 | 5,025 | 96,652 | 29,175 |
| BANTAM FACTORY · separate idle-bounded server window | 125,770 | 5,020 | 96,600 | 29,170 |
| Astra · native aggregate | 103,844 | 2,423 | 90,240 | 13,604 |

BANTAM FACTORY's prefix reuse was 76.8% across 16 requests, the lowest ratio on any
published card and a direct consequence of the short run: fewer turns means
the fixed prompt preamble is amortized over less reused context. Astra spent
17.5% fewer input tokens and 51.8% fewer output tokens while taking longer in
wall time, so this card is a case where token economy and clock disagree.

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

These are different models on the same development work order. The work views include recorded actions, checks and delivered files. Asset hashes cover the generated files; this explanatory note is separate.

</details>
