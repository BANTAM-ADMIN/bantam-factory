# llama.cpp prefix-cache controls — measured on this machine

Companion to the historical [prefix-cache measurements](PREFIX-CACHE-AND-SHARED-KV.md).
This records what the server could be told to do, and **what it actually did
when asked**.

Rig and raw data: [`tools/prefix-cache-bench/`](../tools/prefix-cache-bench/).
Every number below is `timings.cache_n` and wall-clock from a real request, run
2026-08-22 on the RTX 4090 with `Qwen3.8-27B-BANTAM-Q4_K_P`.

> **The definitive gauge is `cache_n`, never effective tok/s.** A miss and a hit
> can post similar `prompt_per_second` while differing 4× in wall-clock, because
> the miss is processing 8,552 tokens fast and the hit is processing 2,052.

## Corrections to the first draft of this document

The first version was written from `--help` and source. Three of its claims were
wrong, and the headline recommendation was the wrongest:

| First draft said | Measured |
|---|---|
| `--cache-reuse` / `n_cache_reuse` is "the one lever aimed at rebuild's weakness" | **Unavailable on this model, permanently.** The server logs `cache reuse is not supported - ignoring n_cache_reuse = 256` on every request, and disables it at startup with `cache_reuse is not supported by this context`. Still disabled with vision off — the blocker is the hybrid/recurrent architecture (`llama_memory_can_shift()` is false), not multimodal. |
| `--cache-ram 8000` is "the stock default left in place" | **Deliberate.** `launch-bantam-q4.sh` carries `# 32000 made it the kernel's OOM target`. It was tuned, and raising it backfired before. |
| `--slot-save-path` is off, implying setting it turns the feature on | Setting it is necessary but **not sufficient: vision blocks it.** `{"code":501,"message":"This feature is not supported by multimodal"}`. Works text-only. |
| `--ctx-checkpoints`: "yours: 12" | Only `launch-bantam-multiuser.sh` hardcodes 12. `launch-bantam-q4.sh` uses `${CKPTS:-32}`. |

**The lever this document missed entirely is `--ubatch-size`.** It is the
dominant control, and it is worth 2.6× wall-clock on the shape BANTAM emits
every turn.

## Why this model cannot do partial reuse — the root constraint

`Qwen3.8-27B` is hybrid: SWA + gated-delta recurrent layers (the server log says
`hybrid`, `recurrent`, `SWA`). A recurrent state cannot be rewound to an
arbitrary position — it is sequential. So the server can only resume from a
position where it *snapshotted* the state. **Checkpoint, or nothing.**

That single fact explains every result here:

- New prompt **extends** the cached one → the cached state is already valid at
  that position → full reuse.
- New prompt **diverges anywhere in the middle** → the server must rewind to
  before the divergence → it needs a checkpoint at or before that point → if
  there is none, it restores the checkpoint at position 0 and reprocesses
  **everything**.

Seen directly in the server log (divergence at 6811):

```
Checking checkpoint with [8547, 8547] against 6811...
Checking checkpoint with [8035, 8035] against 6811...
Checking checkpoint with [0, 0] against 6811...
restored context checkpoint (pos_min = 0, ..., n_past = 1)
```

### Where checkpoints get placed

From `server-context.cpp`, and confirmed by the positions in the log:

1. **`n_ubatch + 4` tokens before the end**, and **4 tokens before the end**
   ("process the last few tokens of the prompt separately in order to allow for
   a checkpoint to be created").
2. **At user-message starts**, when the request came through the chat endpoint so
   the server knows where messages begin (`spans.is_user_start`), spaced at least
   `--checkpoint-min-step` apart, capped at `--ctx-checkpoints`.

**BANTAM uses `/completion` with one rendered prompt string** (`src/model.js:394`),
not the chat-messages API. It therefore has **no user spans and gets only rule 1**.
Its entire safe-change window is `n_ubatch + 4` tokens.

Each checkpoint costs ~150–185 MiB of host RAM at these context sizes — which is
what `--cache-ram` is actually budgeting, and why 32 GiB of it became an OOM
target.

## E1 — the four shapes BANTAM emits

Production solo: `ctx 72000`, vision on, MTP on. 8,552-token prompt.

| shape | ubatch 512 | | ubatch 2048 | |
|---|---|---|---|---|
| | reuse | wall | reuse | wall |
| `identical` (resend) | 100.0% | 540 ms | 100.0% | 648 ms |
| `append` (extension trajectory) | 94.9% | 668 ms | 94.9% | 673 ms |
| `panel-edit` (**rebuild, every turn**) | **0.0%** | **3813 ms** | **76.0%** | **1513 ms** |
| `panel-edit-grow` (panel changes size) | **0.0%** | **4101 ms** | **71.6%** | **1588 ms** |

The rebuild trajectory's own shape goes from total cache loss to 76% reuse and
**2.6× less wall-clock, from one flag.**

## E2 — how late must a change be? (token-exact sweep)

`ctx 32768`. Divergence placed exactly *d* tokens from the end.

| d from end | ub 512 | ub 1024 | ub 2048 |
|---|---|---|---|
| 0 | 99.9% | 99.9% | 99.9% |
| 256 | **94.0%** | **88.0%** | **76.0%** |
| 512 | **94.0%** | **88.0%** | **76.0%** |
| 1024 | 0.0% | **88.0%** | **76.0%** |
| 2048 | 0.0% | 0.0% | **80.1%** |
| 3072 | 0.0% | 0.0% | 0.0% |
| 4096 | 0.0% | 0.0% | 0.0% |
| **checkpoint sits at** | 8036 | 7524 | 6500 |
| **safe window** | **516** | **1028** | **2052** |
| wall, hit | ~880 ms | ~1040 ms | ~1400 ms |
| wall, miss | ~4000 ms | ~3720 ms | ~3360 ms |

The window is exactly `n_ubatch + 4`. **A hit is 3–4× cheaper than a miss at any
ubatch** — what matters is landing inside the window.

### Bigger is not better — there is an optimum

`ctx 72000`, panel divergence 1,750 tokens from the end:

| ubatch | window | reuse | wall | VRAM used / free |
|---|---|---|---|---|
| 512 | 516 | 0.0% (miss) | 3813 ms | — |
| **2048** | **2052** | **76.0%** | **1513 ms** | **21836 / 2244 MiB** |
| 4096 | 4100 | 52.1% | 2135 ms | 23048 / **1032 MiB** |

`ubatch 4096` puts the checkpoint *further back than the change needs*, so it
reprocesses 4,100 tokens instead of 2,052 — slower than 2048 — and leaves only
1 GiB of VRAM, below a safe desktop margin.

> **Tuning rule: set `n_ubatch` to just cover the volatile tail (panel + newest
> observation), rounded up to a power of two. No larger.**

Cost of 512 → 2048, measured at `ctx 32768`: **+766 MiB VRAM** (19304 → 20070).

## E2b — the sizing measured on REAL BANTAM prompts, not synthetic ones

Everything above used synthetic prompts. The number that decides `ubatch` is how
far from the end a **real** BANTAM turn diverges, so a live 8-turn run was
captured with llama.cpp's `--log-prompts-dir` and the actual bytes compared
turn-to-turn (tokenised, not estimated):

| turn | tokens | diverges this far from the end |
|---|---|---|
| 1 | 2319 | 17 |
| 2 | 2832 | 530 |
| 3 | 2962 | 538 |
| 4 | 3206 | 698 |
| 5 | 3417 | 784 |
| 6 | 3613 | 856 |
| 7 | 3727 | 805 |
| 8 | 4277 | **1254** |
| 9 | 4324 | 47 |

**min 17 · median 698 · max 1254**

| ubatch | window | real turns that would HIT |
|---|---|---|
| 512 | 516 | **2 of 9** |
| 1024 | 1028 | 8 of 9 |
| **2048** | **2052** | **9 of 9** |
| 4096 | 4100 | 9 of 9, but reprocesses 4100 instead of 2052 |

`2048` is the smallest window that covers this workload. Runs holding larger
files in `<open_files>` will push the max higher — re-measure with
`--log-prompts-dir` rather than assuming.

## The per-profile decision (re-measured per-process)

**First pass got this wrong.** `nvidia-smi` "used" includes the desktop
compositor, which swings between ~250 and ~560 MiB here — ±300 MiB of noise
under every comparison. Measuring the llama-server process's OWN usage
(`--query-compute-apps`) changed the answer, and caught a profile that "fit"
once and OOM'd the next time.

Certified 2026-08-22, desktop budgeted at 560 MiB:

| profile | ctx | ubatch | window | server | free |
|---|---|---|---|---|---|
| `bantam-q4` (solo) | 72k · 1 slot | **2048** | 2052 | 21578 MiB | 2426 MiB |
| `bantam-q4-crewsplit` | 120k · 4 split | **2048** | 2052 | 22372 MiB | 1632 MiB |
| `bantam-q4-duo` | 96k · 2 split | **2048** | 2052 | 23094 MiB | 910 MiB |
| `bantam-q4-crewmtp` | 72k · 4 unified | 1536 | 1540 | 23080 MiB | 924 MiB |
| `bantam-q4-solomax` | 112k · 1 slot | 1536 | 1540 | 23160 MiB | 844 MiB |
| `bantam-q4-crew` | 140k · 4 unified | 1536 | 1540 | 23296 MiB | 708 MiB |

**The ubatch cost scales with PER-SLOT context, not total.** Per doubling:
~368 MiB on solomax (112k/slot), ~272 on duo (48k/slot), **~110 on crewsplit**
(30k/slot). That is why crewsplit reaches 2048 for ~220 MiB while crew and
crewmtp **OOM** there.

`ubatch 1536` (window 1540) is the sweet spot for anything that cannot reach
2048 — it clears the measured workload with margin at a fraction of the cost.
**No context had to be sacrificed on any profile.** Trading context would have
worked (measured at ~49 KiB/token, so one ubatch step ≈ 15,000 tokens of ctx)
but proved unnecessary.

## E8 — the window sized against a REAL run, not a synthetic one

Everything above sized `ubatch` from synthetic prompts and one short real run
whose workspace held two toy files. Profiling a **13-turn run on a real source
tree** (3 modules, 11 tests, verification passing) changed the answer.

`runlens` named the choke first:

```
wall clock: 44.2s total
  model    41.4s (94%)  — prefill 25.7s · generate 15.4s
  other     2.8s ( 6%)  — actions and harness
ledger: 10 value · 2 recon
```

Not the harness (6%), and not wandering (2 recon turns). **Prefill was 58% of
the entire run.** Decomposing the divergence on that run's 18 captured prompts:

| turn | divergence | of which the tail block | the rest |
|---|---|---|---|
| 6 | 2526 | **2338** | 188 |
| 9 | 2726 | **2419** | 307 |
| 13 | 2646 | **2429** | 217 |
| 15 | 2530 | **2429** | 101 |

**11 of 17 turns missed the 2052 window**, and the tail block was essentially the
whole divergence. Reading it:

```
   16 tok  Reminder — your objective…
  177 tok  Task: …
 2241 tok  <open_files>      ← 92% of it
```

So it IS the volatile panel. The earlier run looked otherwise only because its
workspace was two toy files. At 2241 tokens the panel pushes the divergence just
past 2052 — and that single overshoot converts a cheap resume into a full
reprocess of a 6–9k prompt.

### Replaying the same prompts through each window

Agent runs take a different path every time, so an end-to-end A/B is noise (the
three runs I tried took 10, 12 and 11 turns). Replaying the **captured prompts**
removes every model variable — same prompts, same order, only the server differs
(`tools/prefix-cache-bench/e8.py`):

| ubatch | window | tokens processed | reuse | prefill |
|---|---|---|---|---|
| 2048 | 2052 | 57,355 | 51.5% | 26.2 s |
| **3072** | **3076** | **42,444** | **64.1%** | **20.8 s** |
| 4096 | 4100 | 48,031 | 59.4% | 23.4 s |
| 6144 | — | OOM | | |

**4096 is worse than 3072**: it covers a few more turns but reprocesses 4,100 per
hit instead of 3,076. There is a genuine optimum, and it is the *smallest* window
that covers the divergence distribution.

> **Sizing rule: `n_ubatch` ≈ the `<open_files>` panel + one turn's new content.**
> Not a fixed number — it scales with how much of the workspace is open. The run
> summary's reuse line is the gauge that tells you when it is violated.

Applied to `bantam-q4` (22154 MiB, 1850 free) and `bantam-q4-crewsplit` (22100,
1904). `duo` and `solomax` **OOM** at 3072 and stay where they are. Verified
through the certified launch script on the same prompts: **51.5% → 61.4% reuse,
prefill 26.2 s → 22.4 s.**

## E3 — user-message boundaries (chat endpoint only)

Same content sent as `messages`, `ubatch 2048`, 7,522 tokens:

| case | reuse | wall |
|---|---|---|
| identical resend | 99.9% | 395 ms |
| **panel edited inside the newest user message** | **80.2%** | **1090 ms** |
| history edited (turn 2, mid-conversation) | 0.0% | 3887 ms |
| both edited | 0.0% | 3880 ms |

A checkpoint landed at 6028 — exactly the newest user message's start. **Any edit
confined to the newest message costs only that message.** Any edit to an older
message costs everything.

This is the mechanical case for the extension trajectory's "fold open files into
the newest observation", and the mechanical case against rebuild's rewriting of
superseded bodies in older turns.

**BANTAM cannot use this today** — it sends a rendered prompt, so the server sees
no message boundaries. Moving BANTAM to the chat endpoint would add a second,
larger safe window that does not cost VRAM. That is unbuilt and untested.

## E7 — the chat transport: worth it at depth, blocked by one newline

E3 said the chat endpoint checkpoints at user-message boundaries. E7 asks
whether BANTAM should use it.

**Replaying a real run down both paths** — the 10 captured prompts, same server,
same order, only the endpoint differs — showed **no gain at all**:

| | prompt tokens processed | wall |
|---|---|---|
| A `/completion` (rendered) | 10311 | 6.3 s |
| B `/v1/chat/completions` | 10352 | 7.2 s |

B did *more* work. The reason is in the numbers: that run's divergences were at
most 1254 tokens from the end, comfortably inside solo's 2052 window, so
`/completion` already had the best checkpoint available and boundary checkpoints
added nothing.

**At depth it is a different story.** BANTAM-shaped turns with a larger tail:

| history | A `/completion` | B chat messages |
|---|---|---|
| ~6k | 69.1% reuse, 1277 ms | **90.1% reuse, 729 ms** |
| ~20k | 87.8% reuse, 1471 ms | **96.0% reuse, 864 ms** |
| ~48k | 94.5% reuse, 1919 ms | **98.2% reuse, 1157 ms** |

B processes **764** prompt tokens where A processes **2350**, at any size. The
gain appears exactly when the divergence falls outside the ubatch window — which
is every profile except solo, since VRAM caps the rest at ubatch 1024 (window
1028), and the real run's turn 8 already diverged 1254.

### What the divergence actually is (not the panel)

Reading the bytes at the divergence point in two consecutive real prompts: it is
not `<open_files>`. BANTAM appends a **"Reminder — your objective…" re-anchor
block after the history**. Next turn the real assistant action and its
observation are inserted *before* that block, so every turn diverges at
"wherever last turn's reminder started". Anything placed after the growth point
costs a reprefill of itself, every turn. That is the price of the re-anchor's
recency, and it is bounded and small — which is why raising ubatch fixed so much.

### How far back the prompt changes — the actual formula

Measured on the captured run, per turn: the re-anchor block's own size against
the turn's divergence distance.

| turn | re-anchor | divergence |
|---|---|---|
| 4 | 571 | 698 |
| 5 | 658 | 784 |
| 6 | 689 | 856 |
| 7 | 702 | 805 |
| 8 | 700 | **1254** |
| 9 | 747 | 47 |

**The re-anchor plateaus around 750 tokens** — it does not grow without bound
with turn count. So:

```
divergence  ≈  re-anchor (~750, flat)  +  that turn's observation
```

It climbs with **how big a file you just read**, not with how long the run is.
A 1,300-token observation exhausts even the 2052 window; a 5,000-token file read
exceeds anything `ubatch` can buy.

That also explains E7's numbers exactly: the chat path processed **764** tokens
per turn — which *is* the re-anchor. A boundary checkpoint sits at the newest
message's start, so its cost is the last message, not the distance back.
`/completion` pays the whole window (2052) even on a hit. **The chat transport
is ~2.7× cheaper even when `/completion` succeeds, and unboundedly better when
a large observation blows past the window.** That is the structural argument;
ubatch is the workaround that costs VRAM.

### The integration questions, all answered

- **Grammar works.** `grammar` is honored on `/v1/chat/completions`. First read
  said otherwise because the output was in `reasoning_content`, not `content` —
  read the whole response, not the convenient field.
- **Prefill works.** A trailing `assistant` message is continued rather than
  starting a new turn (`--prefill-assistant`, on by default), and that is what
  keeps a grammar-constrained action in `content`. The echo of the prefill is
  stripped client-side.
- **Template injection is suppressible.** By default the template prepends
  *"Reasoning effort is set to xhigh…"* to the system message — text BANTAM never
  wrote, coming from the server's `--chat-template-kwargs` (which never affected
  the `/completion` path at all). `chat_template_kwargs: {"enable_thinking": false}`
  is the only kwarg tested that removes it.

### The blocker: the template strips one newline

BANTAM renders `…content\n<|im_end|>`; the template renders `…content<|im_end|>`.
That single convention difference re-tokenises everything after it:

```
turn   BANTAM tok   chat tok   Δtok   common prefix   % identical
   0         2302       2304     +2            1861        80.8%
   5         3417       3429    +12            1861        54.5%
   9         4324       4345    +21            1861        43.0%
```

Δ is tiny in count and enormous in consequence — from token 1861 the model would
see different bytes. **So the transport ships gated: it measures, and refuses
unless the re-render is byte-identical.** On this stack it refuses.

**One change would unblock it:** BANTAM's renderer stops emitting `\n` before
`<|im_end|>`. That alters the bytes on the working `/completion` path too, so it
is a deliberate, evaluated change — not something the transport does quietly.

### What shipped

`--chat-transport` (or `BANTAM_CHAT_TRANSPORT=1`), off by default. It arms, then
**self-tests on the first real prompt** and disarms unless fidelity is exact — a
flag that cannot take effect would be a lie, and a transport armed without proof
would be worse. Verified on a live run:

```
chat transport: OFF — the server's re-render and BANTAM's prompt differ;
                2289 tokens vs 2291 (+2), identical for the first 1861 (81.3%)
reached done: true    turns: 3, invalid: 0
```

`bantam chat-transport <captured-prompt-file>` reports the same verdict without
running a task. Capture prompts with `llama-server --log-prompts-dir DIR`.

## E4 — unified vs split KV: the crew collapse, measured

`--parallel 2`. A worker warms slot 0; an attendant then works on slot 1; the
worker returns.

| step | split KV | unified KV |
|---|---|---|
| worker warms slot 0 | 0% (cold) 4164 ms | 0% (cold) 4172 ms |
| worker repeats (control) | 100% · 378 ms | 100% · 379 ms |
| attendant works slot 1 | 0% (cold) 2327 ms | 0% (cold) 2335 ms |
| **worker returns to slot 0** | **100% · 661 ms** | **0% · 4139 ms** |
| attendant repeats slot 1 | 99.9% · 327 ms | **0% · 2035 ms** |
| worker returns again | 100% · 374 ms | **0% · 3867 ms** |

Under `--kv-unified`, **both** slots lose their cache on every alternation —
**11× slower** (374 ms → 4139 ms). The server states it at startup:

```
init: idle slots will be saved to prompt cache and cleared upon starting a new task
```

and the log shows the sibling's checkpoints being `erased invalidated
(... pos_next = 0)`. The RAM copy *is* written (`saving prompt with length 8567,
total state size = 467.869 MiB`) but was **never restored** — `cache_n` stayed 0.

### It is the KV mode, not the slot count — and unified buys nothing

Repeating E4 at `--parallel 4` settles the question the first draft left open:

| worker returns after a sibling ran | 2 slots | 4 slots |
|---|---|---|
| split KV | 100% · 661 ms | **100% · 675 ms** |
| unified KV | 0% · 4139 ms | **0% · 4154 ms** |

And unified does not pay for it in throughput. Same rig, `--parallel 4`,
`ctx 140000`, `--no-mtp`, four concurrent streams:

| | solo stream | 4-way aggregate | vs solo | VRAM |
|---|---|---|---|---|
| **split** | 41.4 tok/s | **82.7 tok/s** | 2.00× | 23424 MiB |
| unified | 40.9 tok/s | 79.2 tok/s | 1.94× | 23636 MiB |

Split is equal-or-better on throughput, lighter on VRAM, and keeps its caches.
The only thing unified buys is **elasticity**: one sequence may grow into the
whole pool (140k) where split pre-commits a fixed share per slot.

That is what `bantam-q4-crewsplit` is (added 2026-08-22): 4 slots, split,
30,208 tokens each, `--no-mtp`, ubatch 1024. Certified — worker returns at
**100% reuse / 687 ms**, 4-way aggregate **83.2 tok/s**, 1351 MiB headroom.
**Use `crew` only when one sequence genuinely needs more than 30k of context.**

**`crew` and `crewmtp` pass `--unified`; `solo`, `solomax`, and `duo` do not.**
This is the mechanism behind duo's already-measured advantage, and it is not
about slot count: a 4-slot *split* profile would not behave this way (untested).

## E5 — explicit prefix points (`--slot-save-path`): does not work here

Vision on: `501 {"message":"This feature is not supported by multimodal"}`.
Setting the flag is necessary but not sufficient.

Vision off, the API is accepted — and still does not deliver reuse:

```
warm the slot                                  cache_n=0      4096 ms
save    -> {"n_saved": 8559, "n_written": 455090328, "save_ms": 334}
erase   -> {"n_erased": 8559}
control: resend after erase, no restore        cache_n=0      3772 ms
save2   -> {"n_saved": 8559}
displace with a different prompt (3800 tok)    cache_n=0      1889 ms
restore -> {"n_restored": 8559, "n_read": 455090328, "restore_ms": 55}
resend the saved prefix  <-- expect ~100%      cache_n=3796  2316 ms  (44.4%)
```

**3796 is the displacing prompt's cached length, not the restored state** — and
those two prompts share only 1,020 tokens, so 3796 cannot be a prefix match
against the restored one. After a restore that reports 8,559 tokens read, the
slot's reusable prefix is still whatever it held *before* the restore.
Reproduced twice, including with an explicit `erase` first.

**Treat slot save/restore as non-functional on this stack.** It also costs
53 KB/token on disk (455 MB per 8.5k-token snapshot). Worth retesting after a
llama.cpp rebuild — the running binary is 432 commits old.

## E6 — sleep: the VRAM primitive, and the gauge it breaks

`--sleep-idle-seconds 15`:

| | `/health` | `/props is_sleeping` | VRAM used / free |
|---|---|---|---|
| loaded | 200 | `False` | 20062 / 4018 MiB |
| idle 10s → 45s | **200** | `True` | **696 / 23384 MiB** |
| after a real request | 200 | `False` | 20062 / 4018 MiB |

The model fully unloads — **23.4 GB freed** — while the process and port stay
alive. Waking on a real request cost **7218 ms** (page-cache hot). Polling
`/props` four times did **not** wake it.

This is the primitive for sharing one card with ComfyUI or a video model. **But
`/health` answers 200 the entire time the model is unloaded**, by design — it
bypasses the sleep gate. BANTAM's liveness is `/health`, and
`startRegisteredModel` already treats health as proof a model is up. Before
enabling sleep anywhere, BANTAM's health gauge must move to `/props` and read
`is_sleeping`.

## Best choices, by mode — what shipped

All of this is now applied to the launch scripts and certified (`.bak-preubatch`
copies sit beside them).

| BANTAM mode | profile | why |
|---|---|---|
| `extension` | `solo`, ubatch 2048 | 94.9% reuse on append. Changes are already at the end, so ubatch barely matters — the fastest mode, measured. |
| `immutable` | `solo`, ubatch 2048 | Its whole benefit is a stable prefix, worth nothing if the volatile panel sits outside the window. **This is the mode ubatch rescues**: 0% → 76%, 3813 ms → 1513 ms. |
| `rebuild` | `solo`, ubatch 2048 | Still pays a full reprefill when a superseded body in *older* history changes (0%, ~3.9 s). Correct when accuracy beats latency — now with the price quantified. |
| concurrent workers | **`crewsplit`**, never `crew` | Split keeps both caches (687 ms) where unified destroys both (4154 ms), at equal-or-better throughput and less VRAM. |
| one agent needing >30k ctx | `crew` (unified, 140k) | The only thing unified actually buys: a single sequence may grow into the whole pool. |
| long single-agent context | `solomax`, ubatch 1024 | 112k ctx; 2048 would leave 300 MiB. |
| vision work | any profile with `--mmproj` | Accept that slot save/restore is refused outright. |
| sharing the GPU | `--sleep-idle-seconds` | Frees 23.4 GB in 15 s, wakes in 7.2 s. **Now safe to enable**: BANTAM's liveness reads `/props` and `is_sleeping`, and `bantam swap` draws a sleeping server as `◐`. |

### Not worth pursuing on this model

- **`--cache-reuse` / `n_cache_reuse`** — refused by the architecture with and
  without vision. Setting it is a silent no-op plus a log warning.
- **`--slot-save-path`** — refused under vision; text-only it reports success and
  delivers no reuse (E5, reproduced twice).
- **Raising `--cache-ram`** — already tuned; 32 GiB made the process an OOM
  target, and in E4 the RAM cache demonstrably restored nothing.
- **`--ctx-checkpoints` above 32** — the binding constraint is *where*
  checkpoints may land, not how many are kept. Raising the cap adds ~150–185 MiB
  each and does not widen the window.
- **`--ubatch-size 4096`** — measurably worse than 2048 whenever the edit is
  smaller than the window, and it takes the VRAM that keeps the desktop alive.

### The one unbuilt idea worth doing next

Move BANTAM from `/completion` to the chat-messages endpoint. E3 shows the server
then checkpoints at every user-message boundary: an edit confined to the newest
message cost **80.2% reuse / 1090 ms** against **0% / 3887 ms** for an edit to
older history. That is a safe window the size of the newest message — larger than
any `ubatch` setting, **at no VRAM cost**, and it would help `solomax`, `duo`,
and the crew profiles that cannot afford ubatch 2048. Untested beyond E3.

### A method note, paid for in one OOM

`crewsplit` was first written from a fit test run with `--no-mtp` while the
profile itself left MTP on. It OOM'd on the first launch: MTP's context is
~727 MiB on top of mmproj's ~1136 MiB. **Rig parity before comparing** — a VRAM
measurement transfers only to a config that differs in nothing else.

## The llama.cpp rebuild — measured, and ADOPTED

The binary was 432 commits behind, which left open whether the E5 slot-save
result and `cache_reuse`'s unavailability were just staleness. Master was
fast-forwarded (483 commits, head `b21e4de74`) and built into a **separate**
`build3/`, leaving the certified `build2/` untouched.

### Synthetic first — which pointed the wrong way

Three reps at the solo config, reprocessing the same 2,052 tokens:

| | `build2` (1899) | `build3` (2814) |
|---|---|---|
| prefill | **2166 tok/s** (948 ms) | 1972 tok/s (1041 ms) — 9.0% slower |
| generation | 117.7 tok/s | **123.1 tok/s** — 4.6% faster |
| VRAM, cache window | 21578 MiB, 76% reuse | identical |

Reproducible to ±1 ms. On that evidence the first conclusion here was **do not
adopt** — reasoning that BANTAM is prefill-dominated, citing the 100-turn
artifact's 912.9 s prefill against 318.9 s generating, a 2.86:1 ratio.

**That ratio was measured on a run with 37% reuse — before the ubatch fix.** It
was the convenient gauge, not the definitive one.

### The real A/B, which reversed it

Same task, same workspace, both binaries, twice each, artifacts saved and
normalised for the differing token counts:

| | prefill | generation | prefill time | generation time | wall |
|---|---|---|---|---|---|
| `build2` | 1973 tok/s | 101.5 tok/s | 3.05 s | **4.26 s** | 10.5 s |
| `build3` | 1739 (−11.9%) | **105.9 (+4.4%)** | 3.45 s | **3.15 s** | **9.3 s** |

**With the cache fixed, the ratio inverts.** Prefill work is now bounded by the
ubatch window per turn rather than by context size, so it stops growing — and
generation dominates (0.72:1, not 2.86:1). `build3`'s generation win outweighs
its prefill loss, and it finished the same task faster on both repetitions.

All six profiles boot on it with VRAM identical or better (`crewsplit` and
`crew` each ~272 MiB lighter), the reuse window is unchanged at `n_ubatch+4`,
and `bantam swap` certifies through the real launch scripts.

**Adopted.** `build/bin/llama-server` now points at `build3`. Rollback is one
command, and `build2` is untouched:

```
ln -sfn …/llama.cpp/build2/bin/llama-server …/llama.cpp/build/bin/llama-server
```

Caveat worth keeping: the prefill regression is real, so a workload that runs
*badly cached* — large observations blowing past the window every turn — would
still prefer `build2`. The reuse line in the run summary is how to tell.

### What the rebuild settled

- **`cache_reuse` is refused on the new binary too** — with vision (`not
  supported by multimodal`) and without it (`not supported by this context`).
  Confirmed on two builds 483 commits apart. That question is closed.
- **The unified-KV collapse is unchanged**: split 100% / 727 ms, unified 0% /
  4105 ms. The crew finding holds on both binaries.
- **Slot save/restore got worse.** On `build3` the host-RAM prompt cache now
  genuinely restores across a prompt switch — the control step, with no restore
  at all, scored **100%** where `build2` scored 0%. Explicitly calling
  `action=restore` then produced **0%**. It now destroys a cache that would
  otherwise have served the request. Do not use it.
- **The RAM prompt cache restoring is a real gain** for one slot alternating
  between prompts (0% → 100%, ~3.5 s per switch). It does not help the
  multi-slot unified case.

## Provenance

| Label | Means |
|---|---|
| **MEASURED** | Run here; raw JSONL in `tools/prefix-cache-bench/results/` |
| **BINARY** | From `llama-server --help` of the binary this machine runs |
| **SOURCE** | From the llama.cpp checkout's C++ |

Every table above is MEASURED. Mechanism explanations are SOURCE, and the binary
is **432 commits behind** the checkout (`1899 / c1304d7b2`, 2026-06-16 vs
`c588c4f47`, 2026-07-23) — so where the two could disagree, the measurement on
the running binary is what was trusted.
