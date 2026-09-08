# Glob select · selection series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Match paths against an ordered list of glob patterns, with the last matching
pattern deciding inclusion, and return a receipt naming the deciding pattern
for every path. The assignment states its own preconditions: the pattern list
must be a dense array of unique nonempty strings, and a single `*` never
crosses a path separator.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM FACTORY · local 27B | PASS | 5/5 | 264.1 s |
| Codex · native Astra | PASS | 5/5 | 155.8 s |

Both systems completed accepted work and passed every acceptance group,
including the hidden group that exercises the uniqueness precondition the
visible tests never touch. Astra was 1.70× quicker on this attempt.

**Inside each contender:** a short explanation, the recorded actions and their results, delivered files with before/after changes, and the acceptance output.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Tokens and prefix reuse

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · all 27 requests | 503,914 | 19,280 | 459,965 | 43,949 |
| BANTAM FACTORY · separate idle-bounded server window | 503,950 | 19,280 | 460,000 | 43,950 |
| Astra · native aggregate | 77,389 | 4,409 | 63,104 | 14,285 |

BANTAM FACTORY's prefix reuse was 91.3% across 27 requests. It read 6.5× Astra's input
tokens to reach the same passing result, which is the cost of a small model
re-reading its context rather than carrying more of the task in one pass.

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
