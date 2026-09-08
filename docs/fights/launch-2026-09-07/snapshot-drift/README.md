# Snapshot drift · six-system comparison

[Watch the fight](share/index.html) · [Share image](share/share-card.png) ·
[Detailed replay](index.html) · [Portable measurements](share/fight-card.json)

Extend a file-snapshot tool with validation, source binding and drift detection.
All contenders received the same starter, task and independent grader. BANTAM
was the fastest local contender; native Terra was fastest overall.

| System | Outcome | Independent groups | Wall time |
|---|---|---:|---:|
| BANTAM · local 27B | PASS | 5/5 | 124.343 s |
| DeepSeek Harness · same 27B | PASS | 5/5 | 465.784 s |
| Hermes · same 27B | PASS | 5/5 | 496.987 s |
| Codex · native Astra | PASS | 5/5 | 146.163 s |
| Codex · native Sol | FAIL · protected test modified | 5/5 | 513.418 s |
| Codex · native Terra | PASS | 5/5 | 106.217 s |

Sol passed the functional acceptance groups but changed a protected starter
test. That violates the work-order rules and is not an accepted completion.
The changed-test finding is retained separately from the functional grade;
neither is rewritten to make the result look better or worse.

## Token and cache accounting

| System / scope | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM · all 29 requests | 409,391 | 8,124 | 377,438 | 31,953 |
| DeepSeek Harness · all 17 requests | 485,350 | 28,346 | 470,652 | 14,698 |
| Hermes · measured wire subset | 211,676 | 31,045 | 196,714 | 14,962 |
| Hermes · separate idle-bounded server window | 239,170 | 31,045 | 223,600 | 15,570 |
| Astra · native aggregate, 6 responses | 98,851 | 3,822 | 87,552 | 11,299 |
| Sol · native aggregate, 7 responses | 116,959 | 5,663 | 87,296 | 29,663 |
| Terra · native aggregate, 9 responses | 145,342 | 4,101 | 106,752 | 38,590 |

BANTAM reused 92.2% of input tokens. It used fewer total input/output tokens
than DeepSeek but more fresh input tokens. All three frontier references used
fewer total input/output tokens than BANTAM. Speed and token efficiency are
separate measurements, not interchangeable claims.

Hermes's complete wire totals remain unknown; the partial subset and settled
server window are distinct meters. Server attribution assumes exclusive
endpoint use during the serial local window. Small differences between wire
and server meters for BANTAM and DeepSeek remain in the replay. Cached input
is included in input. Do not sum overlapping meters or substitute the Hermes
subset for a complete receipt total.

## Conditions and provenance

Frozen source `bb31e5fb680ce3503aae5ea94e3521a576d94ca4`; same Qwen 27B
Q4_K_P control, 72K context and CPU vision projection for local contenders.
This is not the recommended DavidAU download. DeepSeek and Hermes had a
32,768-token per-request output allowance. Native Codex selected `gpt-6-astra`,
`gpt-5.6-sol` and `gpt-5.6-terra` at medium effort. Native prompts, tool policies
and sampling were not equalized. Local work ran serially alongside a serial
Codex queue; later separate Claude examples could also contend for CPU/I/O.

This is one previously used development task, not a held-out reliability study
or a universal ranking. No manual candidate repairs or teacher interventions
were made. Every planned contender remains visible. Public exports contain
allowlisted measurements, not private source/prompts/machine paths. Raw evidence
remains private. Package hashes exclude this README and do not establish
authorship or authorize executing imported evidence.
