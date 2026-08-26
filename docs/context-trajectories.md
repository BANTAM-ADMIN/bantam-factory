# Context trajectories: why bantam rebuilds its prompt, and when you shouldn't

**The decision, stated once:** bantam's default prompt trajectory is
`rebuild` — every turn, the volatile parts of the context are re-rendered
from the live workspace, and the prefix cache is knowingly sacrificed.
`--context-mode extension` opts a session into the cache-preserving
trajectory instead. This document is the full reasoning, the measurements
behind it, and the honest map of when each mode is the right tool.

It exists because the trade is surprising. The industry's instinct — formed
by API pricing — is that prefix-cache preservation is an unalloyed good.
Running locally, we measured the opposite: **cache-hostile context produces
measurably better engineering work**, and the mechanism is worth
understanding, not just obeying.

---

## 1. The two trajectories, mechanically

Every bantam turn sends the model one prompt: a system head, the task, the
turn history, and context panels. The two modes differ in *which bytes are
allowed to change between turns*.

### `rebuild` (default)

The prompt is reassembled every turn:

- The **`<open_files>` panel** re-renders from disk each turn — the model
  always sees the CURRENT bytes of the files it is editing, with line
  numbers, refreshed after every mutation.
- **History slimming rewrites old turns in place**: when a file's live
  panel supersedes an old read observation, the old body collapses to a
  pointer. Old bulky evidence gives way to fresh authoritative evidence.
- **Re-anchor blocks and coaching** (budget countdowns, steers, the read
  map) render in the tail, positioned where attention lands, reflecting
  the current state of the run.

Consequence: consecutive prompts share only ~40% of their bytes as a
prefix. Measured across three real runs (2026-08-18, `timings.prompt_n`):
**26–30% prefix-cache reuse.** Most of every prompt re-prefills.

### `extension` (`--context-mode extension`)

Every prompt is a byte-level extension of the previous one:

- Frozen head, append-only history, **no volatile tail**. Run-stable
  guidance moves into the initial turns; changing guidance folds into new
  observations.
- Nothing already sent is ever rewritten, so a local llama.cpp slot
  (including hybrid-attention models, which restore saved checkpoints
  rather than rewinding to arbitrary positions) reuses nearly all prior
  state each call.

Consequence, measured on the workday benchmark (2026-08-18): **90–96%
prefix reuse** — e.g. one 45-call run processed 37k of 846k prompt tokens.
Prefill wall-time drops roughly in half on real workloads.

---

## 2. Why the economics invert between API and local

For API inference, cached prompt tokens are billed at a deep discount
(often 10× cheaper). A cache-hostile prompt structure multiplies your bill;
prefix discipline is a first-order financial concern, and harnesses built
for API models rightly contort themselves to preserve it.

For local inference the cache saves only *time*, not money — prefill
throughput on this rig is ~2k tok/s, so rebuild mode costs a real but
bounded number of seconds per turn. That changes the question from "can we
afford to break the cache" to "what does breaking the cache buy us?" The
answer, measured twice, is: accuracy where it matters most.

---

## 3. The evidence

### The 08-12 preregistered ruling

Extension mode won its efficiency case decisively (92% slot reuse, less
than half the wall time) and **lost the quality decision**: rebuild 10/10
vs extension 7/10 on the compact-strictness family. The recorded mechanism:
*"the missing panel makes post-bounce repairs land on stale
self-knowledge."* When a done-gate bounces a run and demands a fix, an
extension-mode model repairs against its memory of the file — which its own
earlier edits have already invalidated. A rebuild-mode model repairs
against the file as it is.
(`docs/superpowers/reports/2026-08-12-strictness-routing-results.md`)

### The 08-18 rematch

Re-run on the current harness — after the ledger honesty notes,
panel-residency guards, repeat coaches, and landing masks all shipped — on
workday requests 1–5, one arm per mode:

| Request | rebuild | extension | verdict |
|---|---|---|---|
| 1 build from empty | 2 convention divergences | same 2 | parity |
| 2 bug report | 4/5 | **5/5** | extension better |
| 3 vague complaint | 6/6 | 6/6 | parity |
| 4 question, "don't change anything yet" | **respected: 0 edits, 9 turns** | violated: 2 edits, 29 turns | extension worse |
| 5 debug from symptom | **7/7 — found the marker bug** | 6/7 — missed it | extension worse |
| cache reuse | 26–30% | 90–96% | extension 3× better |

The ruling held, with sharper resolution: extension is fine — sometimes
better — on forward-building work, and loses exactly where **discipline
under accumulated context** decides the outcome: honoring a freeze
instruction late in a long context, and pinpointing a subtle bug. Both
failures are the same failure: decisions made against remembered context
instead of fresh context.

### Why this is the "bantam-class" bet

Bantam runs a 27B where the incumbents run frontier models. The margin has
to come from somewhere, and the whole factory's finding — replaying the
operator's real Codex/Claude sessions — is that it comes from **context
integrity**: the model is never asked to detect that its world model has
drifted from the world. Rebuild mode is the purest expression of that bet.
Every turn, the harness pays fresh prefill to guarantee the model's view of
the workspace is true. A frontier model might paper over stale context with
raw capability; a 27B cannot, and with rebuild it doesn't have to.

Trading seconds for that guarantee is cheap. We are local; the meter isn't
running. **Effective intelligence = model capability × context integrity ×
verification bandwidth** — and for a small model, the second factor is the
one you can actually max out.

---

## 4. When to choose extension mode

`--context-mode extension` (or `BANTAM_PROMPT_TRAJECTORY=extension`) is the
right call when the work is **read-heavy, forward-moving, and low-stakes on
mid-run edits**:

- long reconnaissance or survey sessions (codebase reviews, "where were
  we" orientation, research reading)
- big-batch conveyor jobs where wall-clock dominates and each job's output
  gets independently verified afterward
- any workload you would happily run twice — speed makes retries cheap

Avoid it for: bounce-and-repair editing loops, tasks with standing
constraints that must survive a long context ("don't touch X",
"behaviour must not change"), and debugging that hinges on one detail.
That is not superstition; it is the two rows of the table above.

The active mode is printed in the session banner
(`context rebuild` / `context extension (cache-fast)`) — the mode is a
visible choice, never a hidden env var.

---

## 5. Measuring it honestly

The one instrument rule, learned twice in one day: llama.cpp's streamed
`tokens_evaluated` is the request's **total** prompt tokens.
`timings.prompt_n` is what the slot actually **processed**. Reading the
first as the second will "prove" a working cache is dead (it did, for
several hours, on 2026-08-18).

The correct computation is built into the tooling: `bantam runlens
<artifact.json>` prints `cache: N% prefix reuse (X of Y prompt tokens
processed across Z calls)` for any run artifact with timed calls. If you
are about to reason about cache behavior from anything other than that
line, stop and use that line.

---

## 6. Standing summary

- **Default: `rebuild`.** Freshness is a quality feature, and for a local
  27B it is the cheapest capability multiplier we have.
- **Optional: `extension`**, first-class and banner-visible, ~3× cache
  reuse, for recon-heavy and batch work.
- **The ruling is evidence-bound, not sacred.** It was preregistered on
  08-12, re-verified with new machinery on 08-18, and should be retested
  when the guard ecology changes materially. The workday benchmark plus
  `runlens`'s cache line make the retest an evening's work.
