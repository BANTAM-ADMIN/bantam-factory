# DavidAU NEO-CODER MTP versus the current BANTAM 27B

Status: initial matched comparison complete; latest adaptive stream rerun passed 5/5, 2026-09-07. One adaptive pass does not establish launch-wide reliability.

Latest follow-up: `stream-obligations6` independently passed all five groups
in 169.707 seconds with accepted completion and no operator intervention.
All 21 requests have complete usage: 243,478 input, 9,838 output, 221,269
cached input, and 22,209 fresh input tokens (90.88% prefix reuse). Source/kit
seals matched. The CR-framing coverage fix and full harness suite were tested
before this rerun. This remains adaptive development evidence, not a new
matched-model comparison or repeated qualification result.

Previous follow-up: `stream-obligations5` finished in 202.206 seconds with an
accepted receipt but failed independent field-parsing coverage (embedded CR
data was truncated). The other four groups, including CLI canonical encoding,
passed. Complete usage: 436,442 input, 8,966 output, 397,299 cached input,
39,143 fresh input tokens across 30 requests. This is adaptive development
evidence, not a replacement for the matched comparison below. Repository tests
overlapped on the host; wall time is not a controlled speed comparison.
See `STREAM-TIMEOUT-REPAIR-2026-09-07.md` for fixes, validation, and limitations.

## Predeclared initial comparison

Question: can the selected DavidAU MTP Q4_K_S perform the same factory work as
the current older local 27B, with comparable accepted quality and lower token
use or wall time? This is a comparison of two usable quantized model stacks,
not an isolated tuning or quantization ablation.

Harness: commit `730ceec4a3d23a4d85c4a2d9c7886724dd158c7c`. No runtime-code
changes, teacher, manual candidate repairs or relaxed acceptance during testing.
Uncommitted planning/report documents do not alter runtime or sealed tasks.

Kit: `factory-2026-09-07`, all three cards: `context-packet` (build),
`patch-transaction` (extend), `stream-framer` (repair). Fresh workspaces for
every attempt, one initial repetition per model, 600-second lane deadlines,
read-only configured verification and accepted terminal completion required.
These are existing adaptive development cards, not new held-out tasks.

Use only BANTAM's local arm. The runner's historical `bantam-local-27b` arm
label appears in both archives; actual model identity is determined by the
recorded endpoint model, artifact hash and comparison-directory label below.
Do not interpret the common arm name as identical model weights.

Complete downloads/checksums before timed tests. Run the current-model suite
first and the candidate suite second, serially on the same GPU. Restart the
server before each suite and use the runner's normal recorded warmup/probe
policy. Fixed order is a confound; this first screen is not a stable speed or
reliability ranking. Sampling remains the existing runner policy, without a new
fixed-seed claim. Preserve all failures and unknown measurements.

## Artifact identities

Control: `Qwen3.8-27B-BANTAM-Q4_K_P.gguf` from the existing local installation.
SHA-256: `ba36dc3c2b2ff5e0aa5d71092a8894546996a6a119ae391803dda07cdc08516d`.
Existing BF16 projector SHA-256:
`5681b690bcb8eb10cd28d62d078cb4e01521a3ea4880a3fc7d54de72de2dd142`.

Candidate repository:
`DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF`,
revision `a51791d22b62b03aa5132feaac27147f32f289f7`.
Selected artifact:
`Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-MTP-Q4_K_S.gguf`,
17,537,488,416 bytes. Expected SHA-256:
`889caf9975ef423464dd319f8bc97318d5bab7d034060efee8711cdb15708766`.
Matching `mmproj-BF16.gguf`: 931,145,920 bytes; expected SHA-256:
`b0d8d89e9c9c90e0fb8ca74742d9d9bd7cc0f966a29b6f8c14227000ea6bd89e`.
Downloaded bytes must match before activation.

The candidate's inspected GGUF header declares `qwen35`, 65 blocks,
`nextn_predict_layers=1`, and context capacity 262,144. Its embedded general
name is `Qwen3.8 27B Brainwaves NM HERETIC BR LOA1`; retain this metadata rather
than assuming the marketing filename equals the embedded name. These metadata
observations do not establish runtime compatibility or task quality.

## Shared runtime configuration

Same existing llama.cpp binary and RTX 4090; model and matching projector paths
are the intended changes. Preserve 72,000 requested / 72,192 allocated context,
one slot, full main-model GPU offload, Q8 K/V caches, CPU mmproj, MTP draft limit
3, batch 8192, ubatch 1024, 32 context checkpoints, host prompt-cache limit
8000 MiB and keep 4096. Preserve launch sampling and thinking configuration;
archive actual request overrides separately. BANTAM uses extension/cache-fast.
The text cards do not qualify visual quality, even though the projector is loaded.

Before the candidate's scored suite: require healthy startup, correct reported
model/context, a small constrained-output completion and active draft-MTP
evidence. Any needed runtime change creates a disclosed new configuration, not
a silent adjustment. If it cannot load, retain the diagnostic and restore the
control; do not kill unrelated GPU processes or delete existing models.

## Accounting and interpretation

For every card record independent groups, artifact acceptance, accepted
completion receipt, wall time, model calls, total input tokens, cached input,
fresh input, output tokens, timing coverage, prefill/decode and MTP counters
when available. Summed input includes repeatedly supplied cached prefixes;
fresh input is not the same quantity. Tokens from different tokenizer bytes
are not automatically equivalent work; retain tokenizer/model identity.

Compare actual trajectories: initial implementation correctness, redundant
reads/probes, authored test mistakes, repair loops and final verification.
Explain token differences using saved contexts, not only aggregate counters.
Never treat a faster timeout or incomplete artifact as a productivity win.
Report three-card totals with all attempts included, as well as individual cards.

Private evidence directories (planned):

- `.bantam/benchmarks/factory-davidau-20260907-control`
- `.bantam/benchmarks/factory-davidau-20260907-candidate`

Existing historical 75.559-second patch success is context only, not the matched
control for this experiment. Do not replace a new slower control with that best
historical sample. Broader/repeated qualification follows only if this first
screen makes the candidate worth pursuing.

## Results

Both stacks passed two of three cards. DavidAU was faster and used fewer output
tokens on the first two cards, but timed out on the third. The control's third
card earned a completion receipt but failed independent acceptance (3/5).
Do not promote either third-card outcome to PASS.

| Stack / card | Result | Seconds | Input | Output | Cached input | Fresh input |
|---|---|---:|---:|---:|---:|---:|
| Control / context-packet | 5/5 PASS | 97.690 | 155871 | 6656 | 126164 | 29707 |
| DavidAU / context-packet | 5/5 PASS | 66.377 | 136966 | 3964 | 112482 | 24484 |
| Control / patch-transaction | 5/5 PASS | 139.658 | 150363 | 9655 | 128203 | 22160 |
| DavidAU / patch-transaction | 5/5 PASS | 48.316 | 94927 | 2001 | 72227 | 22700 |
| Control / stream-framer | 3/5 FAIL | 467.030 | 1195135 | 28040 | 1049208 | 145927 |
| DavidAU / stream-framer | TIMEOUT; grading unavailable | 600.017 | incomplete | incomplete | incomplete | incomplete |

DavidAU's timed-out run has usage receipts for 29/30 requests: measured subtotal
421485 input, 17119 output, 371499 cached, 49986 fresh. Request index 34 has no
complete usage receipt. These are lower-bound measured subtotals, not full totals;
do not silently treat the interrupted request as zero. Control totals across
three cards: 704.378 seconds, 1501369 input, 44351 output, 1303575 cached,
197794 fresh. DavidAU total wall time: 714.710 seconds; full token totals remain
incomplete. All six original outcomes remain archived, with no manual repairs.

The follow-up uses a changed harness and a fresh stream-framer workspace. It is
an adaptive development rerun, not a replacement for these matched results.
