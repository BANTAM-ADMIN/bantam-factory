# Model serving benchmark — vLLM vs llama.cpp, Qwen3.8-27B, one RTX 3090

Measured 2026-09-11 on BEHEMOTH, RTX 3090 (24 GB), Qwen3.8-27B.

Every number below is **generation speed only**: the interval from the first
token arriving to the last token arriving. Prefill, queueing and stream
teardown are excluded. That definition matters — a short action's end-to-end
rate is dominated by fixed per-request cost, so it is not a generation rate.

Harness: `bench/ab_bench.mjs` (dialect-aware: vLLM nests the grammar under
`structured_outputs`, llama.cpp takes a top-level `grammar`). Six
grammar-constrained BANTAM action calls per arm, plus an unconstrained control
(300 forced tokens) so speculation's payoff is visible separately.

## Headline

**For BANTAM's actual workload — grammar-constrained single-stream actions —
llama.cpp is ~1.5-1.8x FASTER than vLLM on this card.**

| | vLLM 0.28.0 (DFlash2) | llama.cpp (embedded MTP-3) |
|---|---|---|
| grammar-constrained generation | 27.9 - 37.3 tok/s | **49.0 tok/s** |
| unconstrained generation | 112 - 127 tok/s | 63.5 - 69.0 tok/s |
| action validity | 6/6 | 6/6 |
| wall per action | ~0.5 s | < 0.9 s |

vLLM is ~2x faster when nothing constrains the output, and ~35% *slower* when a
grammar is active. BANTAM always constrains, so the unconstrained column is not
the one that applies.

## Why the ordering inverts

vLLM's advantage is speculative decoding: `--speculative-config dflash2`,
7 drafts proposed in one pass. A grammar defeats it, because the DFlash2 draft
model is not grammar-aware — masked drafts are rejected by the verifier.

Spec-decoding acceptance, read from the vLLM server log:

| | acceptance length | draft accept rate | generation |
|---|---|---|---|
| no constraint | 5.20 - 6.18 | 60 - 80% | 111.6 tok/s |
| grammar active | 1.48 - 2.83 | 15 - 38% | ~32 tok/s |

~4 tokens per forward pass become ~2. llama.cpp's MTP applies the grammar to
both draft and target natively, so it keeps its speedup instead of losing it.

## It is structured output per se, not our grammar

Same server, same prompt, generation speed only:

| constraint | generation |
|---|---|
| none | 111.6 tok/s |
| grammar constraining to *free prose* | **11.4 tok/s** |
| grammar, minimal single-verb action | 34.2 tok/s |
| grammar, full BANTAM action grammar | 31.7 tok/s |

Constraining to prose costs 10x, and a 37-byte grammar costs the same as the
2855-byte one. So it is neither grammar size, nor structure, nor JSON keys, nor
a mis-selected backend (the log confirms `backend_xgrammar`, the fast one).
It is the spec-decode interaction.

## vLLM spec-mode A/B (all CTX=long, 106496 ctx, int8 KV)

| arm | grammar | unconstrained |
|---|---|---|
| **A: SPEC=dflash2** (7 drafts, one pass) | **37.3 / 27.9 tok/s** | 112.3 / 126.9 |
| B: SPEC=off (no speculation) | 31.9 | 51.8 |
| C: SPEC=mtp (4 chained drafts) | **25.3** | 76.3 |
| D: SPEC=dflash2 CTX=fast | did not boot in the window (VRAM) | — |

- **DFlash2 is the right vLLM mode** — the current config is already best.
- **MTP is the worst under grammar** (25.3): its drafts are autoregressive, so
  one masked token cascades. DFlash2 proposes all 7 independently.
- **No speculation still helps DFlash2** (31.9 vs 37.3), so speculation is not
  purely wasteful under grammar, just heavily discounted.
- The unconstrained controls reproduce the serving repo's own README
  (no-spec 51.8 vs its stated 46; DFlash2 112-127 vs its stated ~122).
- Run-to-run spread on short actions is large (37.3 vs 27.9 for the same
  config), so treat single arms as ±25%, not ±5%.

## Constraint-mode comparison on vLLM (per-action latency, 6 tasks)

| mode | median/action | tokens | valid |
|---|---|---|---|
| GBNF grammar (what BANTAM uses) | **470 ms** | 12 | **6/6** |
| `structured_outputs.json` | 1090 ms | 93 | 5/6 |
| `response_format: json_schema` | 1111 ms | 74 | 5/6 |
| none | 182 ms | 14 | **0/6** |

A JSON constraint is ~2.3x slower per action *and* less reliable: BANTAM's
action schema is a nullable envelope, so a JSON constraint makes the model emit
every field (74-93 tokens) instead of the one verb it needs. **Keep GBNF.**

## llama.cpp arm detail

`Qwen3.8-27B-BANTAM-Q4_K_P.gguf` + embedded MTP (`--spec-type draft-mtp
--spec-draft-n-max 3`), `--parallel 1 --ctx-size 72000`, q8_0 KV,
`--batch-size 8192 --ubatch-size 3072`, port 8085.

Per action: 40.4 / 57.0 / 59.0 / 62.9 / 41.1 / 47.9 tok/s — 49.0 aggregate.
All six returned a valid action object, each under 0.9 s wall.

## Caveats

- Single run per cell except where noted; short actions are noisy.
- The vLLM arms ran on a shared box (the desktop compositor holds ~1.3 GiB), so
  `GPU_UTIL=0.88`.
- The llama.cpp arm ran with vision loaded on CPU. `--no-vision` would free VRAM
  but should not change generation speed.
- Both servers were measured on the same card, but not simultaneously (24 GB
  holds one 27B at a time).
- Power limit was not verified during these runs. The serving repo's own data
  says this card swings 57.5 -> 85.6 tok/s between 200 W and 250 W, which is
  larger than most differences below.
