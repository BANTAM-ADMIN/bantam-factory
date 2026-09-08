# Patch transaction · launch series

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Extend an edit engine to validate all preimages and apply compatible edits as
one transaction. Same starter and independent grader for every system; one
recorded attempt each, without manual candidate repairs.

| System | Independent groups | Outcome | Wall time |
|---|---:|---|---:|
| BANTAM FACTORY · local 27B | 5/5 | PASS, accepted completion | 81.772 s |
| OpenCode · same local 27B | 5/5 | PASS, clean completion | 559.000 s |
| Codex · native Astra | 5/5 | PASS, clean completion | 90.337 s |

BANTAM FACTORY took 85.4% less elapsed time than OpenCode in this same-model attempt.
All three systems completed accepted work. Astra is a different-model reference,
not an ablation of BANTAM FACTORY's local harness.

<details>
<summary>Token receipts, run conditions & provenance</summary>

## Complete recorded totals

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY · 16/16 requests | 117,752 | 5,018 | 99,749 | 18,003 |
| OpenCode · 20/20 requests | 429,797 | 35,018 | 379,806 | 49,991 |
| Astra · native aggregate | 74,840 | 2,269 | 66,304 | 8,536 |

BANTAM FACTORY used fewer tokens than OpenCode, but more than Astra. Input includes
cached input; the columns are not additive. Astra's native aggregate does not
provide the same request-level coverage as the local wire recorder.

Separate idle-bounded server counters differ from wire totals by one cached
input token for BANTAM FACTORY and four for OpenCode. The public data retains both
sources; these overlapping scopes must not be added or forced to match.

## Conditions and provenance

Frozen factory checkout `6bf118ba5f5fc0d06127fa1368ee85c5011d7590`; runtime
unchanged by subsequent history-only privacy cleanup and presentation work.
Local contenders used the existing Qwen 27B Q4_K_P control, 72K context and
CPU vision projection, not the recommended DavidAU download. OpenCode had a
32,768-token per-request output allowance; BANTAM FACTORY and native Astra have their
own action/output policies. Local inference was serial, with frontier work
allowed alongside it. Sampling, cache and native tool policies were not equalized.

This is one previously used development work order, not a held-out reliability
study or universal ranking. This directory is a one-card derivative of the
broader launch series; all three planned contenders are retained. Raw evidence
and the frozen benchmark clone remain private. Public exports contain only
allowlisted labels, measurements and replay counters—not source, prompts or
machine paths. Asset manifests hash generated files, excluding this README;
they do not attest authorship or authorize execution.

</details>
