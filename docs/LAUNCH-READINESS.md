# Launch readiness — evidence, not a completion claim

Updated September 7, 2026. The launch objective remains open. A passing test
suite is necessary, not proof of a smooth installation on an unfamiliar PC.

Release scope: a public beta centered on existing model servers on Linux.
Managed hardware profiles and the optional Astra foreman retain their stated
experimental limits; new supervisor experiments are deferred, not launch gates.

Privacy gate: archived raw cards and known historical identifiers have been
removed from the cleaned history. A fresh repository holds that history at
the original URL; the previous repositories remain private archives. The
release repository was made public on September 7, 2026 at `f67925e` with
explicit owner approval, after hosted CI passed on that revision and a
credential and operator-identifier sweep of the tracked tree found nothing.
New public cards still require review; see the [archive policy](fights/README.md).
The [privacy audit record](PRIVACY-RELEASE-AUDIT.md) records checks and remaining gates.

Publication so far: green CI on the release revision, the approved visibility
change, and the reviewed six-card gallery published through the explicit
GitHub Pages workflow. Remaining: create a beta tag/release describing the
supported Linux bring-your-own-server path and experimental options.
Announcements are a separate opt-in step. No additional model or supervisor
experiments are required for this beta gate.

| Requirement | Current evidence | Remaining qualification/work |
|---|---|---|
| Existing llama.cpp first | Guided discovery/manual URL, consent, saved connection, real HTTP adapter regression tests | Fresh-machine exercise against multiple runtime versions; remote recorded-card support |
| Other OpenAI-compatible APIs | Explicit dialect/model/key selection and tiny constrained-response check | Provider matrix, authenticated remote comparison recording, clear unsupported-capability handling |
| Existing Codex account | Explicit consent and chooser; Linux x64 isolated runtime discovers tools and non-root UID/GID; dummy-auth offline checks before scored cards | Additional account/install layouts, keyring/custom-home authentication, account-validity qualification |
| Claude Code only when explicitly requested | Removed implicit REPL/default-picker Claude selection; direct CLI agent corner retained | Put explicit Claude agent comparison under the new frozen-card/isolation flow; do not use it as a model/teacher/judge |
| Optional recommended model download | Pinned DavidAU artifacts and three context/vision configurations; consent/integrity/startup inference tests | Clean-machine installation; physical 92K and GPU-vision fit under real workloads |
| Lower-VRAM option | Explicit experimental Tiel 32K CPU-expert profile; GPU/RAM admission tests | Actual 8–16GB systems, occupied-context fit, repeated accepted coding completions, complete performance accounting |
| Easy installed-harness comparison | `bantamfactory cards` chooser, plans, consent; Hermes/OpenCode/DeepSeek path registration; all three plus Codex offline checks; installed npm DeepSeek with prefix/PATH Node and native tool/usage/deadline tests | Additional packaging layouts and DeepSeek versions, additional Codex account layouts and explicit Claude frozen-card adapter |
| Live progress and polished replay | `cards --live` token-protected loopback view, receipt-driven running/settling/grading phases, public final snapshot; `--card all` frozen build/extend/repair set; static replay/export | Further clean-machine/browser exercises and long-run reconnect qualification; live public counters are not a full private-context viewer |
| Fair, auditable accounting | Local HTTP recorder, native receipts, independent grades, completion separately recorded | Require complete accounting for efficiency claims across every supported adapter; preserve unavailable metrics rather than inventing totals |
| Community sharing/learning | Portable evidence validation; `cards --public` creates an allowlisted local summary; no implicit execution/promotion/upload | Richer privacy preview and governed import/qualification workflow |
| Public repository | Made public at `f67925e` with explicit approval after a clean credential and identifier sweep; raw evidence remains local and ignored | Recheck the tracked tree before each push; a public repository is not clearance for raw transcripts or archived evidence |

## Fresh evidence

The [launch gallery](fights/launch-2026-09-07/index.html) now contains all six
launch cards and 27 recorded system attempts. BANTAM passed Context Packet in
58.1s, Patch Transaction in 81.8s, Receipt Reducer in 112.5s, Snapshot Drift in
124.3s and Job Planner in 193.2s; its Stream Framer attempt timed out at 4/5.
On the same local 27B, DeepSeek Harness took 442.7s, 465.8s and 483.5s on the
three six-system cards and Hermes 577.6s, 497.0s and a 2/5 timeout. All
competitor results, including the native Codex lanes that were faster than
BANTAM, accounting limitations and conditions are retained. Native Claude Code
Sonnet, Opus and Fable references are published beside the cards as separately
recorded packages. Two further work orders from the controls kit are recording;
pending runs are not results. The gallery is deployed through the explicit
GitHub Pages workflow.

Native Sol and Terra are explicit optional contenders, not additions to the
default quota-consuming roster. Their isolated runner and portable accounting
paths have mocked integration coverage; `bb31e5f` passed hosted CI. Real model
outcomes belong in completed cards, not inferred from those adapter tests.

### Earlier reviewed comparison

The [September 7 context-packet card](fights/context-packet-2026-09-07-public/README.md)
was run from a clean clone of `7459b17`: BANTAM and Hermes passed all five
groups; OpenCode left the starter unimplemented after reaching its output cap.
The public derivative includes replay, portable JSON and SVG/PNG share images.
Hermes has one canceled request without a wire usage receipt; separate settled
endpoint counters are documented, not substituted into complete-receipt totals.
New runs retain bounded post-cleanup counter polling and require two unchanged
idle samples before treating settlement as successful. A known-busy endpoint
that does not settle stops the local queue. This is covered by synthetic HTTP
lifecycle tests; the historical card is unchanged. Missing wire receipts remain
missing, and broader runtime/accounting qualification is still required.

Keep the full objective intact. Missing adapters or qualifications are not solved
by relabeling a narrower demo as the finished launch product. Existing historical
results are evidence of those configurations and attempts, not guarantees about
the newest installer, a new model, or another user's hardware.

## Verification records

The subsequent installed-peer/config-isolation change passed 4,108 host tests,
zero failures and 76 skips. All 15 opt-in installed Hermes/OpenCode scripted
tool-loop tests passed with no real model or cloud inference. These prove
the checked installed versions can start and execute the scripted tool path,
not that every version or all five comparison adapters are qualified.

The final September 7 cards-front-door change passed the full host regression suite:
4,092 passed, zero failed, 76 skipped. Focused coverage exercises actual CLI
help/dry-run dispatch, default-No execution consent, explicit participant lists,
no implicit cloud teacher, cloud-only runner execution without local probes
(with test doubles for agent/grader execution), and selected-lane replay rendering.
These tests do not constitute a real Codex/Hermes/OpenCode comparison run.

Live/model and browser verification results belong in separately identified
run records, with exact runtime/source seals and all failed attempts preserved.

### Real front-door exercise

Run: `.bantam/benchmarks/cards-frontdoor-20260907-local-1/` (private local evidence).
Invoked through `bantamfactory cards --card context-packet --arms bantam-local-27b`
with explicit endpoint/output and `--yes`, using the existing older Q4_K_P
27B control on port 8085, not a newly downloaded DavidAU or Tiel model.

- Accepted completion and independent **5/5 PASS**, 135.8 seconds, 16 turns.
- 28/28 recorded requests: 368,957 input, 320,884 reused-prefix, 48,073 fresh,
  and 7,538 output tokens. No candidate edits or teacher intervention by the operator.
- Global server counters recorded four fewer reused-prefix tokens than the
  wire receipts; both sources remain intact. They were not forced to agree.
- Source/kit checks passed during generation/grading. This was a development
  worktree exercise with its recorded source hashes, not a final-commit benchmark
  or a comparative speed ranking.
- The first CLI invocation returned 2 **after the model passed**, because the
  export validator treated metric coverage objects as numeric counters. The
  original log/result was retained. The validator now checks coverage records
  separately and has a regression for this exact structure.
- `bantamfactory cards --replay ...` then successfully regenerated export/HTML
  from the same evidence, without rerunning the model. All 83 attachments passed
  hash/size verification. This validates recovery and presentation, not a second
  model attempt or an uninterrupted successful original invocation.
- Browser-enabled focused suite: 46 passed, zero failed/skipped, including
  offline inspection, hostile candidate text, mobile layout and receipt-timed
  counters. The actual one-lane replay was also visually inspected in Chromium.

Subsequent installed-peer exercises and comparisons are identified above. This
earlier BANTAM-only pass is not evidence that those peers run correctly.
