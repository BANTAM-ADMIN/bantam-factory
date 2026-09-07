# Launch readiness — evidence, not a completion claim

Updated September 7, 2026. The launch objective remains open. A passing test
suite is necessary, not proof of a smooth installation on an unfamiliar PC.

Privacy release blocker: old generated fight-card outputs have been moved to
a verified private local archive outside the working tree. They remain in Git
history. Keep this repository private pending the full secret/personal-data
audit and an explicitly approved history-cleanup or clean-public-repository
process. New public cards require review; see the [archive policy](fights/README.md).

| Requirement | Current evidence | Remaining qualification/work |
|---|---|---|
| Existing llama.cpp first | Guided discovery/manual URL, consent, saved connection, real HTTP adapter regression tests | Fresh-machine exercise against multiple runtime versions; remote recorded-card support |
| Other OpenAI-compatible APIs | Explicit dialect/model/key selection and tiny constrained-response check | Provider matrix, authenticated remote comparison recording, clear unsupported-capability handling |
| Existing Codex account | Explicit context/quota consent, Luna/Terra/Sol/Astra chooser, existing adapter | Fresh account/install layouts; portable isolated comparison runtime |
| Claude Code only when explicitly requested | Removed implicit REPL/default-picker Claude selection; direct CLI agent corner retained | Put explicit Claude agent comparison under the new frozen-card/isolation flow; do not use it as a model/teacher/judge |
| Optional recommended model download | Pinned DavidAU artifacts and three context/vision configurations; consent/integrity/startup inference tests | Clean-machine installation; physical 92K and GPU-vision fit under real workloads |
| Lower-VRAM option | Explicit experimental Tiel 32K CPU-expert profile; GPU/RAM admission tests | Actual 8–16GB systems, occupied-context fit, repeated accepted coding completions, complete performance accounting |
| Easy installed-harness comparison | `bantamfactory cards` chooser, plans, consent, Docker/image checks, existing peer runners | User-supplied installation directories/executables, native DeepSeek installations, version-specific readiness, portable Codex and explicit Claude adapters |
| Live progress and polished replay | CLI progress plus local static replay/export; dynamic participant counts; frozen workspaces and independent grading | Unified visual live view and clean-machine browser/runner exercises; do not treat a static replay as live streaming |
| Fair, auditable accounting | Local HTTP recorder, native receipts, independent grades, completion separately recorded | Require complete accounting for efficiency claims across every supported adapter; preserve unavailable metrics rather than inventing totals |
| Community sharing/learning | Portable evidence format; validation; no implicit execution/promotion | End-user privacy preview and governed import/qualification workflow |
| Private repository | Verified private at the last push; evidence remains local | Recheck before subsequent pushes; publication requires explicit authorization |

Keep the full objective intact. Missing adapters or qualifications are not solved
by relabeling a narrower demo as the finished launch product. Existing historical
results are evidence of those configurations and attempts, not guarantees about
the newest installer, a new model, or another user's hardware.

## Verification records

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

Next live qualification should run the committed front door against installed
peer harnesses, after portable runtime readiness and explicit selection paths
are tightened. A BANTAM-only pass is not evidence that those peers run correctly.
