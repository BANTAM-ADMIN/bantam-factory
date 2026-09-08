# Retry budget · fight card

[Open the fight](share/index.html) · [Share image](share/share-card.png) · [Measurements](share/fight-card.json)

Repair retry logic so it respects server hints and backoff without spending more time than the job has left.

| System | Independent groups | Outcome | Elapsed time |
|---|---:|---|---:|
| BANTAM FACTORY · local 27B | 5/5 | PASS | 141.654 s |
| DeepSeek Harness · same local 27B | 5/5 | PASS | 445.841 s |
| Hermes · same local 27B | 5/5 | PASS | 562.038 s |
| OpenCode · same local 27B | 5/5 | PASS | 375.419 s |
| Codex · native Astra | 5/5 | PASS | 137.291 s |
| Codex · native Sol | 5/5 | PASS | 231.835 s |
| Codex · native Terra | 5/5 | PASS | 143.182 s |

**Same local model:** BANTAM FACTORY, DeepSeek Harness, Hermes and OpenCode use the same Qwen 27B weights. Codex uses the frontier model named in its row.

PASS means accepted work and a clean finish. OUTPUT_ONLY means accepted output without a clean finish. A timeout's elapsed time is its stopping boundary, not its time to successful completion.

**The local rig:** NVIDIA RTX 4090 · 24 GB · Qwen 27B Q4_K_P · 72,192-token context. Open a lane for its measured generation speed and coverage.

**Inside each contender:** a short explanation, the recorded actions and their results, delivered files with before/after changes, and the acceptance output.

<details>
<summary>Run conditions, token accounting & recording receipts</summary>

This is a selected development work order. BANTAM FACTORY was qualified before the missing challenger lanes were run. The task was used during development before these recordings. The task was not changed for a challenger, and no candidate received manual repairs.

**Follow-up recordings:** OpenCode, starting 2026-09-08T18:34:43.100Z UTC (the `Z` suffix denotes UTC). All planned follow-up attempts for this card are included, including failures and timeouts. The original published lanes remain unchanged. The replay aligns each run's start to zero; these were separate recording windows.

The follow-ups ran from frozen checkout `75012c4426841e45fc960390608e5c0482389b12`. The task, starter, independent grader and model file hashes matched the saved BANTAM FACTORY baseline before execution and during export. The portable measurements contain a follow-up receipt with hashes of the original public summary, both private manifests, the task materials and the model weights. Raw records remain private.

Recorded challenger versions: OpenCode 1.18.23.

Each challenger had a ten-minute wall limit and a 32,768-token per-request output allowance. Peer clients declared a 65,536-token context; the server served 72,192 tokens. BANTAM FACTORY uses separate requests allowing up to 4,096 reasoning tokens and 8,192 action tokens. Native prompts, tools, sampling, input reservation and compaction policies differ.

Local inference was serial on the existing warm server, with no restart or cache erase. Earlier runs may have left reusable prefixes. The host also performed lightweight reporting and browser checks during the follow-ups. Some original frontier runs overlapped original local runs; see the [original recording notes](https://github.com/BANTAM-ADMIN/bantam-factory/blob/75012c4426841e45fc960390608e5c0482389b12/docs/fights/launch-2026-09-07/retry-budget/README.md) for their conditions.

BANTAM FACTORY's token receipts cover all 23 requests. Other lanes identify full totals, measured subsets and native aggregates separately. Missing counters remain unknown. Input already includes cached input. Server windows and native reports overlap the request receipts and must not be added to them. Generation speed uses saved server timing receipts; it excludes tools and tests, and partial coverage is labeled.

The work views include recorded actions, supervisor checks and delivered files. Machine paths are normalized in the displayed record. Asset hashes bind the published files to this export. This explanatory file is outside the asset hashes.

</details>
