# Prefix Cache and Shared-KV Supervision (measured)

How to make a local llama.cpp slot reuse its KV cache turn-over-turn, and how to
make a supervisor watch a worker's context for nearly free. Every number here is
measured against the live BANTAM Q4 stack (Qwen3.8-27B, RTX 4090) on 2026-08-20.

The definitive gauge throughout is **`timings.cache_n`** from the raw llama.cpp
response (parsed by `usageFromResponse`), NOT effective tokens/sec. Effective
tok/s conflates prefill with generation and will lie to you; `cache_n` is the
count of prompt tokens actually reused from cache. Trust it.

---

## Part 1 — Turn-over-turn reuse needs THREE things aligned

A local llama.cpp slot has **checkpoint-or-nothing** prefix reuse (it restores a
saved checkpoint or reprocesses from scratch — it does not rewind to an arbitrary
prefix). So the prompt prefix must be **byte-identical** across turns, on **one
slot**. Miss any of the three and `cache_n` silently degrades:

| Layer | Symptom if wrong | Fix |
|---|---|---|
| 1. One slot | `--parallel 4` scatters a solo run across cold slots → `cache_n=0` every turn, 45-min timeout | `--parallel 1` (certified `launch-bantam-q4.sh`) |
| 2. Stable history | mutable history rewrites earlier turns → prefix churns | `BANTAM_IMMUTABLE_HISTORY=1` (append-only) |
| 3. Stable whole prompt | `rebuild` trajectory re-renders volatile sections (the live `<open_files>` panel) → `cache_n` plateaus at the static menu (~2168) while the growing context reprocesses; turns creep back to 24-41s at depth | `BANTAM_PROMPT_TRAJECTORY=extension` — each prompt a byte-level extension of the prior; frozen head, no volatile tail, open-files folded into the newest observation |

Measured, gpt2-codegolf, at depth (~16k context):

- `rebuild` trajectory: `prompt_n ~15,200, cache_n 2168` (~13% reuse), 24-41s/turn.
- `extension` trajectory: `cache_n` GROWS with context (2168 → 3804 → …), 67-100%
  reuse, 0.3-2.9s/turn.

`extension` is deliberately **off by default**: `rebuild` scores higher on
repair-heavy tasks because the live open-files panel prevents the model editing
from stale self-knowledge. Preregistered and replicated three times on the
compact-strictness family — rebuild **30/30**, extension **22/30** (08-12 7/10,
08-14 7/10, 08-28 8/10).

The old argument for running extension anyway — *rebuild's cache-death times out
at zero reward, so a finished run at slightly lower accuracy wins* — **no longer
holds on this rig and has been withdrawn.** Re-measured 2026-08-28 (build
`113cc17`): rebuild finished every run and was *faster end-to-end* than extension
(339.4 s vs 352.1 s), because rebuild's own reuse has climbed to 83.2% against
extension's 90.8%, and extension's failures each bought an escalation. Nothing
timed out in either arm. See the dated [August 28 rerun summary](evidence/2026-08-28-strictness-rerun-summary.md).

The bare-history think remedy is default-on in extension mode, so the single
flag `BANTAM_PROMPT_TRAJECTORY=extension` is the whole switch.

**Mitigation path:** stale-edit failures need an authoritative current-file
view, not merely advice to consult a panel extension does not display. The
[2026-09-05 context-delivery repair](CONTEXT-DELIVERY-2026-09-05.md) supplies
bounded typed source updates at that failure boundary and protects optional
decision snapshots from ordinary observation clipping. Actual outgoing prompts
must be checked: a snapshot-created counter alone previously overstated delivery.
This is not a guarantee of speed everywhere or zero accuracy penalty. The newer
small pilot favored extension; the older 30/30 versus 22/30 score is scoped to a
fixture whose base wording omitted the error type required by its hidden grader.

---

## Part 2 — Shared-KV supervision: a supervisor watches a worker for ~free

**Claim:** if a worker and a supervisor share the same large context and differ
only in a short instruction SUFFIX, the second reuses the first's cached prefix,
so supervision costs only its own critique tokens.

**Experiment** (single `--parallel 1` slot; `scratchpad/shared_kv_test.py`): a
~11k-token shared "working context", asked as worker vs supervisor vs a variant
that diverges at the HEAD.

| request | what | prompt_n | cache_n | reuse | wall |
|---|---|---|---|---|---|
| A | worker, cold | 11270 | 0 | 0% | 38.7s |
| B | supervisor — same head+context, different suffix | 520 | 10754 | **95%** | **0.4s** |
| C | worker again (alternation) | 516 | 10754 | 95% | 0.4s |
| D | supervisor — **diverged HEAD** | 11297 | 0 | **0%** | 5.3s |
| E | supervisor — shared head again | 520 | 10754 | 95% | 1.0s |

**Findings (all confirmed):**

1. **The supervisor reuses the worker's prefix.** B reused 10,754 of ~11,274
   tokens, prefilling only its 520-token critique suffix: **38.7s → 0.4s, ~97×
   cheaper.** A genius can watch every station and the watching costs a few
   hundred tokens, not a full re-read.
2. **Alternation preserves the shared prefix.** C (worker again, after the
   supervisor ran) still hit 95%. Worker↔supervisor ping-pong on one slot keeps
   the common context warm; only the small divergent tails re-prefill.
3. **You must share the HEAD; diverge only at the SUFFIX.** D moved the
   divergence to the front (different persona preamble) and reuse collapsed to
   **0%** — all 11k tokens reprocessed. E restored the shared head and reuse
   returned to 95%.

### Design rules for a shared-KV worker+supervisor

- **One shared head + shared working context, verbatim and byte-identical** for
  both roles. Same system preamble, same task, same history.
- **Put the only role difference in a short SUFFIX** at the very end
  (worker: "your next action"; supervisor: "review the above, flag any issue").
- **Serialize on one slot** (`--parallel 1`). This is what BANTAM's duo mode
  should do: the worker acts, the supervisor critiques the *same* warm context,
  the worker acts again — each new request re-prefills only its own suffix.
- Everything in Part 1 still applies: immutable history + extension trajectory,
  so the shared head+context stays byte-stable across the whole exchange.

### Serial vs true-parallel

This experiment proves **serial single-slot** sharing: requests run one at a time
on the one slot, and each reuses the prior's cached prefix. That already delivers
the win (the supervisor is ~free). **True simultaneous** execution — worker on
slot 0 and supervisor on slot 1 at the same instant — would need a KV *copy*
across slots (llama.cpp slot save/restore), because `--parallel` slots hold
separate caches and, as Part 1 shows, a multi-slot server otherwise *breaks* solo
reuse. Serialization is the safe, proven path; reach for parallel slots only with
an explicit KV-copy step and a re-measured `cache_n`.

---

## How to reproduce

1. Certified single-slot server: `launch-bantam-q4.sh [--no-vision] [--ctx N]`.
2. Verify turn-over-turn reuse: run any agent task with
   `BANTAM_PROMPT_TRAJECTORY=extension`, pull `run.json`, confirm `cache_n` grows
   with context across DEPTH (not just one early turn).
3. Verify shared-KV supervision: `scratchpad/shared_kv_test.py` (freeze any live
   run with `kill -STOP` first for a clean slot; `kill -CONT` after).
