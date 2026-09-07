# Tiel local-worker qualification — 2026-09-06

For the accessible model comparison and product implications, start with
[Local workers: the 27B baseline and the 35B-A3B opportunity](LOCAL-WORKER-STRATEGY.md).
This document preserves the detailed experimental record rather than replacing
it with a best-run summary.

Update: the operator subsequently handed the GPU back. A fresh confirmation
series recorded 3/3 accepted artifacts but only 1/3 accepted completions;
the later complete repair10 series recorded 2/3 accepted artifacts and 1/3
accepted completions, with all 185 generation calls fully metered.
[Completion receipts and fight-card evidence](FIGHT-CARD-EVIDENCE-2026-09-07.md)
records each series, the identified controller/context defects, the final
regression-tested tool-schema delivery fix, and the Hermes accounting
investigation. No fresh live cohort has tested that final fix. The prior shutdown described below is a
historical event, not the current GPU hold state.

Tiel runs on the existing 4090/llama.cpp stack and is substantially faster at token generation in the earlier exploratory series. It is **not promoted to BANTAM's default**. The original, repair1, repair2, repair3 and repair4 series remain separately recorded below, with strict completion counts of 1/3, 2/3, 1/3, 0/3 and 1/3. Repair5's Snapshot-only run, all three repair6 cards and repair7's Snapshot-only run passed their frozen functional checks but exhausted their action budgets without accepted completion. Repair7's assertion station did not establish a completion improvement and ships disabled by default. These adaptive reruns do not establish reliability or complete correctness. The original 27B comparison remains unchanged; repair3 timings also include shared-endpoint contention.

Repair8's fresh Snapshot run subsequently achieved **PASS: 5/5 independent groups, accepted completion in 30 turns and 93.738 seconds**. Its collection-audit branch did not engage, so this is not a live exercise or causal demonstration of the repaired focused-launch recognizer; that fix has separate executable regression coverage below.

This report covers single-worker, 72K-requested-context, MTP1 qualification, beginning with the original series finished at `2026-09-06T19:30:01.980Z`. CPU-only/8GB operation and concurrent multi-worker performance remain unqualified. After repair8, the operator requested the GPU back: the recorded Tiel server was gracefully stopped, its port/process disappearance confirmed, and a local GPU-hold marker prevents restart without explicit handback.

## Model and download receipt

- Repository: [peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP/tree/199cff20cda0575344172543809cb0f990bfbceb).
- Pinned revision: `199cff20cda0575344172543809cb0f990bfbceb`.
- Artifact: [Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP/blob/199cff20cda0575344172543809cb0f990bfbceb/Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf).
- Exact size: `18,629,540,384` bytes; whole-file SHA256: `bf12bfacb04f587be6eecd578a5dc3d06861797d3a4cf81b1fad3d72b29dbbce`.
- Local file and exact server model ID: `/home/operator/Desktop/nai/local-models/models/TIEL35BA3B/Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf`.
- Observed server quantization description: `IQ4_XS - 4.25 bpw`. This is a roughly 35B-total-parameter MoE with about 3B active parameters, not a 3B-resident-weight model.
- The optional `mmproj-BF16.gguf` was also downloaded: `902,822,016` bytes, verified SHA256 `d9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837`. It was not loaded or vision-qualified in this series.

The initial Hugging Face transfer stalled with a missing `28,827,648`-byte range. Recovery fetched `28,835,840` bytes including 4KiB overlap on each side, filling bytes `7,172,636,672..7,201,472,511`, then the entire final file was hashed and matched the pinned expected SHA256 at `19:19:42.837Z`. Partial-download progress was not treated as install readiness. Download integrity, successful loading, runtime compatibility and coding qualification are separate gates.

Local provenance root throughout this report is `.bantam/acceptance/2026-09-06/tiel-qualification/`. Download receipts are `weights-verified.json` and `download-recovery.json`; service provenance is `original-27b.json`, `active-server.json`, `control.jsonl`, and the two `tiel-*.server.log` files. These local records can contain private paths and source; this report does not claim that the ignored evidence directory is included in a fresh clone or publicly shareable.

## Runtime actually tested

Installed llama.cpp: `0.2.0-dev`, build `2814`, commit `b21e4de74567f5eef213765c9476a843c2e43f0d`; endpoint reports `b2814-b21e4de74`. The invoked path was `/home/operator/Desktop/nai/local-models/llama.cpp/build/bin/llama-server`; the process executable resolved to that repository's `build3/bin/llama-server`. No llama.cpp rebuild was required for these tests.

The coding run requested context `72000`; the server allocated `72192`, one slot, non-unified KV, and integrated `draft-mtp` with maximum draft length `1`. It was text-only: no mmproj, vision/video/audio all false. The operator's startup GPU snapshot was `19,638 MiB` used and `4,443 MiB` free. That is an observed startup reading, not peak memory or a promise that all longer/concurrent workloads fit.

The exact launch argv is retained in `active-server.json`. Its relevant settings were:

```text
--host 127.0.0.1 --port 8085 --parallel 1 --no-kv-unified
--ctx-size 72000 --n-gpu-layers 99 --flash-attn on
--cache-type-k q8_0 --cache-type-v q8_0
--batch-size 1024 --ubatch-size 512
--ctx-checkpoints 8 --cache-ram 2048
--jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0
--presence-penalty 0 --repeat-penalty 1 --metrics --perf
--spec-type draft-mtp --spec-draft-n-max 1 --spec-draft-p-min 0.0
```

The 27B baseline already used working MTP, with maximum draft length `3`. It also used batch/microbatch `8192/3072`, `32` context checkpoints, `8000` cache-RAM setting, CPU mmproj, `--keep 4096`, and explicit reasoning/chat-template options omitted from this Tiel launch. Tiel explicitly enabled flash attention and non-unified KV and bound only loopback. Context allocation, slot count, target q8 K/V, and the baseline sampling values were retained. BANTAM still made its own raw completion prompts and request-level sampling choices; the GGUF chat template was not automatically substituted for BANTAM's framing.

Consequently this is a model/quantization/runtime-configuration comparison, not a pure model-weight or MTP ablation. Faster Tiel results cannot be credited simply to “turning MTP on.” The earlier 32K diagnostic and the 72K coding series are also distinct configurations.

## First coding series: all outcomes retained

Source: `factory-c72000-s1-mtp1/manifest.json`, schema `bantam.factory-local-variant.v1`, base commit `af4609f26c1fc35aaeef130c87266a2e6289572e`. The series records its own actual-model arm, `bantam-local-tiel35ba3b-iq4-xs-72k-mtp1`; no historical 27B row was relabeled.

| Card | Outcome | Accepted artifact | Accepted completion | Independent groups | Public / hidden exit | Contender seconds |
|---|---|---|---|---:|---:|---:|
| receipt-reducer | PASS | Yes | Yes | 5/5 | 0 / 0 | 102.748 |
| snapshot-drift | FAIL | No | Yes | 4/5 | 1 / 1 | 122.278 |
| job-planner | OUTPUT_ONLY | Yes | No | 5/5 | 0 / 0 | 176.290 |

Total: **1/3 clean passes, 2/3 accepted artifacts, 14/15 independent groups, 401.316 contender seconds**. All three processes exited zero, without wall timeout, abort or output-buffer exhaustion; process exit zero alone is not accepted completion. All protected-file checks were clean. Grading adds another `4.554` seconds; it is not hidden inside the contender timings.

Snapshot has a genuine validation defect: `size` uses `Number.isInteger`, which accepts an integer outside JavaScript's safe-integer range. The hidden invalid-manifest group includes `Number.MAX_SAFE_INTEGER + 1` and correctly rejects this implementation. The safe-integer requirement was present in the task context; the context audit found the worker incorrectly reasoned that `Number.isInteger(2**53 + 1)` would be false. This is not evidence that the requirement was missing. A better executable witness or validation jig is a plausible future fix, not a reason to discount the miss.

Snapshot's public test command also failed separately: Node's test discovery encountered a retained scratch symlink at `.bantam/scratch/snap-verify-Qn0iIO/link.txt` and reported that it could not find the path. Its internal earlier verification had passed the three supplied tests. The public recheck failure and independent semantic failure are both retained; cleaning scratch would not fix the missing safe-integer validation.

The context audit also found a false-green custom check: `verify.mjs` used an invalid SHA value (`'z'.repeat(64)`), threw, but its output was piped to `tail`; the pipeline's zero exit status was stored as success. The scratch failure separately reflects the generation/verifier temporary-mount difference. These are concrete evidence-quality and harness-context problems worth fixing, without conflating them with the already-present safe-integer requirement or changing this series' score.

Planner produced an accepted implementation, with `23/23` public tests and `5/5` hidden groups, but exhausted the `60`-turn allowance without emitting `done`. Its saved result has `reachedDone:false`, no completion summary, and no interruption/model failure. It used 31 read-file actions, 7 writes, 8 replacements, 13 shell actions and 1 inspect action, with zero invalid/protocol outputs. Calling that run PASS would erase a real workflow-completion problem.

### Token and timing accounting

| Card | Measured requests | Input | Cached input | Fresh input | Output | Server decode tokens/s |
|---|---:|---:|---:|---:|---:|---:|
| receipt-reducer | 35/35 | 428,885 | 395,203 | 33,682 | 15,877 | 198.326 |
| snapshot-drift | 26/26 | 339,547 | 292,657 | 46,890 | 19,871 | 204.046 |
| job-planner | 74/74 | 1,563,520 | 1,309,334 | 254,186 | 18,461 | 197.853 |
| Total | 135/135 | 2,331,952 | 1,997,194 | 334,758 | 54,209 | 200.219 |

All primary wire accounting is complete. Aggregate prefix reuse is `85.64%`; repeated cached input still counts as input, and unknown accounting would not be replaced with zero. Decode rates are `sum(timings.predicted_n) / (sum(timings.predicted_ms) / 1000)` across the recorded generation responses, not averages of request rates or end-to-end project throughput. Fresh-prefill rates similarly use summed `prompt_n` and `prompt_ms`: `3,146.018`, `4,051.431`, and `4,278.030` tokens/s respectively; aggregate `4,097.579` tokens/s. These per-response timing calculations remain distinct from the supplementary global counter windows.

For context, the [prior 27B BANTAM series](FRESH-FACTORY-RESULTS-2026-09-06.md) had 3/3 clean passes in `726.726` seconds, 81 requests, 1,210,844 input / 1,077,976 cached / 132,868 fresh / 50,431 output tokens. Using the same per-response timing calculation, its aggregate rates were `82.152` decode and `1,648.290` fresh-prefill tokens/s. Tiel was faster per generated token but made more requests and consumed more fresh input, with worse clean completion. Neither raw throughput nor cache percentage substitutes for accepted useful work.

Server counter windows remain separately attributed supplemental evidence, never replacements for wire totals. In planner they report four fewer cached/input tokens than the wire receipts; the report retains wire totals rather than silently reconciling rounded global counters. There was no cache-clear intervention between cards, and first-call cache state can affect timings. One repeat, different configurations, and different failure behavior prevent a statistical or causal ranking.

## Earlier 32K runtime diagnostic: compatible output, missed semantics

`probe-c32768-s1-mtp1-v2/result.json` is a closed-thinking, grammar-constrained runtime/cache diagnostic using four unique JavaScript cases across nine requests. It obtained **9/9 structurally valid outputs but only 4/9 semantically correct answers**. The repeated cases and tiny sample are not nine independent coding tasks. The phase named `concurrent-load` used concurrency `1`, so it does not qualify multi-user throughput.

All nine HTTP usages were measured: 19,879 input tokens, 13,784 cached, 6,095 fresh, and 100 output. Runtime identity stayed stable; responses recorded actual MTP draft/accept counts. This demonstrates that grammar, prefix reuse and integrated MTP can operate together on this installed stack. It does not demonstrate general coding capability or equal quality. In particular, valid JSON containing the wrong answer remains a semantic failure and must not be dismissed as an inconvenient smoke result.

The preceding `probe-c32768-s1-mtp1/result.json` is a retained setup error: the expected model was supplied as a basename while the server advertised its full absolute path. The identity guard rejected it before any diagnostic phase/model request. The later `-v2` invocation supplied the exact identity; it did not weaken the guard.

## Reproduction and evidence boundaries

The new runners are [factory-local-variant.mjs](../scripts/factory-local-variant.mjs) and [local-runtime-probe.mjs](../scripts/local-runtime-probe.mjs), with corresponding focused tests. The frozen card source is [factory-2026-09-06](../examples/fights/factory-2026-09-06/README.md). The coding recipe remains extension/immutable, Qwen framing, probe enabled, teacher disabled, 60 turns, up to 4096 reasoning / 8192 action tokens, and a 600-second contender deadline. No candidate repairs were carried into another card.

The following records the coding invocation from the repository root; its existing output is intentionally not overwritable. Any repeat needs a new evidence directory and explicit GPU availability, with the intended server already running:

```bash
tiel_model=/home/operator/Desktop/nai/local-models/models/TIEL35BA3B/Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf
tiel_evidence="$PWD/.bantam/acceptance/2026-09-06/tiel-qualification"
node scripts/factory-local-variant.mjs \
  --output "$tiel_evidence/factory-c72000-s1-mtp1" \
  --label 'Tiel35BA3B IQ4_XS · 72K · MTP1' \
  --variant-id tiel35ba3b-iq4-xs-72k-mtp1 \
  --endpoint http://127.0.0.1:8085 --model-id "$tiel_model" \
  --model-file "$tiel_model" --timeout-seconds 600
```

The earlier diagnostic command, against the separately launched 32768-context server, was:

```bash
node scripts/local-runtime-probe.mjs \
  --endpoint http://127.0.0.1:8085 \
  --output "$tiel_evidence/probe-c32768-s1-mtp1-v2" \
  --expected-model "$tiel_model" --concurrency 1 --requests 4 \
  --tokens 256 --timeout-seconds 120
```

The local-only `runtime-control.mjs` records controlled service swaps and the GPU hold/handback procedure; it is not a globally installed launcher. Neither command above starts, stops, or promotes a model.

The coding manifest seals 403 runtime source files and 23 kit files, with no recorded source/kit mismatches. Each card retains exact task/material hashes, command, HTTP wire bodies/usage, BANTAM `run.json`, factory records, public/hidden logs and final artifact hashes under `factory-c72000-s1-mtp1/repeat-1/CARD/bantam-local-tiel35ba3b-iq4-xs-72k-mtp1/`. Per-run JSON matched its manifest row on review. All three post-run server identity/settings checks matched. Exact-workspace container cleanup was confirmed for every card, with no containers requiring removal. Offline read-only grading, protected-file checks and explicit completion checks remain enforced.

## First harness repair: completed regression rerun

The operator subsequently authorized repairs and a new run. The original series above remains immutable. The repair changes the factory, never the scored candidate or frozen public/hidden checks:

- Preserve pipeline failure status for both named suites and ad-hoc executable checks; retain explicit uncertainty when outer-shell success cannot establish the inner result. Expected-error prose alone is not a failure signal.
- Keep a bounded executable recovery path when duplicate reads follow failed/inconclusive verification. Stronger caller and document policies still apply; the original turn limit does not increase.
- Label recycled worker reasoning as an unverified hypothesis. New execution evidence can supersede it; it is not a controller instruction to preserve a speculative diagnosis.
- Move managed persistent `/tmp` outside the deliverable tree into a private workspace-identity-keyed host directory. Preserve its exact location in execution receipts. Historical scratch is not deleted or silently migrated; readonly grading still uses independent temporary storage.
- Supply a small JavaScript runtime witness only when the public task explicitly names a safe-integer contract. It demonstrates the distinction between `Number.isInteger` and `Number.isSafeInteger`, is bound to the task hash, and explicitly grants no candidate verification.
- Reserve the final action for a truthful completion after a current passing check; do not prescribe optional cleanup followed by completion when only one action remains.

Completed rerun evidence is at `factory-c72000-s1-mtp1-repair1/`, with a separately identified `tiel35ba3b-iq4-xs-72k-mtp1-repair1` arm. All three original cards used fresh starter copies, the same running model/server configuration, extension/immutable context, teacher disabled, and the unchanged 60-turn/600-second limits. No server-cache clearing was introduced. Exact runtime and kit hashes were sealed before the series; all outcomes, token accounting, public/hidden results and completion status are retained. Because these failures informed the repairs and several harness changes are combined, this is a regression rerun, not held-out evidence or a single-change causal ablation.

Before the GPU rerun, `npm test` passed **3,551 tests, zero failures, 36 skips** (`68.413` seconds). A final focused run over verification evidence, agent, state audit, landing, pipefail, recovery and numeric witness passed **100/100**. Live Docker scratch/pipeline checks passed **21/21**, including a three-container reproduction of persistent absolute-symlink scratch followed by independent readonly Node test discovery. An earlier full test attempt exposed three compatibility regressions in compound-verifier and heredoc handling; those were repaired before the green run and before source sealing.

| Card | Outcome | Independent groups | Protected files | Contender seconds | Input | Cached input | Fresh input | Output |
|---|---|---:|---|---:|---:|---:|---:|---:|
| receipt-reducer | PASS | 5/5 | Intact | 128.989 | 684,385 | 634,913 | 49,472 | 20,009 |
| snapshot-drift | FAIL | 3/5 | Existing test appended | 193.966 | 1,578,100 | 1,315,777 | 262,323 | 18,689 |
| job-planner | PASS | 5/5 | Intact | 147.347 | 1,047,951 | 916,630 | 131,321 | 18,395 |
| Total | 2/3 PASS | 13/15 | One violation | 470.302 | 3,310,436 | 2,867,320 | 443,116 | 57,093 |

All 180 generation calls reconcile with the saved model calls; all 192 HTTP exchanges have matching retained bodies and finished status-200 receipts. Prefix reuse was `86.615%`, aggregate decode approximately `197.73` tokens/s and fresh prefill `4,129.39` tokens/s. All 405 sealed runtime files and 23 kit files matched. Server identity/settings stayed stable; all three exact-workspace cleanup checks confirmed no remaining owned writers. All 68 shell receipts used the external private scratch directory.

This is a **partial repair, not an overall win**: clean completions improved from 1/3 to 2/3, but accepted artifacts stayed at 2/3, total wall time rose, and Snapshot regressed from 4/5 to 3/5 independent groups and violated test-file protection. Receipt passed 17 public tests; Planner passed four public tests and completed the protocol. Snapshot's five passing public tests include two worker-added tests in a protected file, so that result is not a clean public-suite pass.

### What actually broke in Snapshot

The raw record is `factory-c72000-s1-mtp1-repair1/repeat-1/snapshot-drift/bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-repair1/run.json`; turn indices below are zero-based.

1. Turn 6 wrote correct safe-integer validation and all four required output sorts; turn 7 read them back. The public-task numeric witness was present in every recorded request and bound to the correct task hash.
2. Turn 8 added `runCli` with a replacement whose `old` anchor contained the four sorting statements, but whose `new` text omitted them. The edit succeeded. Turn 10 then described the arrays as sorted, relying on the earlier implementation rather than the current bytes. Every action prompt still contained the sorting requirement: this was not a missing-task-text failure.
3. Turns 33–40 used distinct CLI checks with status-masking shell control. They correctly remained unverified, but a duplicate-only recovery trigger did not engage. At turns 41–42 the controller incorrectly demanded a **first** implementation despite earlier source edits and a passing public check.
4. The worker appended two tests to supplied `test/snapshot.test.js`. The first attempt failed syntax validation; the corrected append was accepted. It did not weaken existing assertions, but it still violated the public task's prohibition. The independent protected-file hash gate correctly rejected it. The new single-item checks could not expose missing sorting.

The independent failures concerned output ordering: `changed` and `unsafe` retained insertion order. The original numeric defect and scratch-discovery problem were absent. A final claim that arrays were sorted did not override the observed source and grades.

## Second harness repair: preserve work and recover verification

This repair targets the observed mechanisms, without naming the benchmark, changing its checks, repairing its candidates, or extending its budget:

- **Review additive edits that remove existing statements before committing them.** The executor compares complete before/staged-after JavaScript ASTs for every direct edit verb. When existing functions lose executable statements while new top-level functions appear, the first attempt leaves files unchanged and shows bounded removed statements plus current anchors. A corrected additive edit can proceed; an identical reissue explicitly confirms the exact before/after hashes. Atomic batches retain confirmations until the entire transaction commits. Intentional refactors remain possible. Offline reconstruction of the failed replacement identifies exactly the four removed sorts and new `runCli`, in a 2,007-character review.
- **Enforce existing-test protection from the public task.** The instruction guard freezes exact existing test paths before actions, including relevant canonical aliases. Direct edits are refused; Docker mounts the existing files read-only; host execution has scoped rollback. The containing test directory is not mounted read-only, so genuinely new tests remain permitted. This policy comes from the user's task, not hidden grader knowledge.
- **Track whether work was actually authored.** Typed successful direct edits and observed shell mutations advance this state, including on resume. Rejected/no-change edits do not. Once work exists, inactivity cannot demand a first draft. Stalled failed/inconclusive verification can retain a bounded shell recovery route even when commands differ; caller restrictions and the original turn limit still prevail.
- **Persist the evidence in factory telemetry.** Numeric-contract witnesses, verification-recovery masks and edit-preservation reviews now create material factory events with content-addressed artifact references. They are observations/review decisions, never verification PASS certificates.

The preservation check is deliberately bounded: complete parseable JavaScript files up to 256 KiB, 50,000 AST nodes and 4,000 statement rows; at most six removed-statement excerpts and four added-function anchors are shown. It does not establish semantic equivalence, catch every control-flow/binding/order change, cover other languages, or guard arbitrary shell-generated source edits. A null witness is not proof of preservation. Confirmation proves acknowledgment of an exact change, not correctness. Passing executable checks remain necessary.

Before the second rerun, the full suite passed **3,592 tests, zero failures, 36 skips** (`71.778` seconds). Final integration passed **28/28 with no skips**, including an actual Docker check that a supplied test stays read-only while a new test can be written, and a grammar-plus-progress reproduction that keeps verification available after authored work. The structural module's final focused tests passed **13/13**. These tests cover exact retry binding, multi-file atomic confirmation, corrected additions, resumed work, unapplied-edit controls and unchanged turn budgets.

The completed evidence directory is `factory-c72000-s1-mtp1-repair2/`, arm `bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-repair2`. All three cards retained the same server configuration, starter/task/grader bytes, extension/immutable recipe and 60-turn/600-second limits. All 406 runtime files and 23 kit files matched their seals before source was released for further repairs. As with repair1, this is an informed regression rerun, not held-out or single-change causal evidence.

| Card | Outcome | Independent groups | Protected files | Contender seconds | Generation calls |
|---|---|---:|---|---:|---:|
| receipt-reducer | PASS | 5/5 | Intact | 86.853 | 26 |
| snapshot-drift | FAIL | 4/5 | Intact | 40.753 | 28 |
| job-planner | OUTPUT_ONLY | 5/5 | Intact | 207.019 | 72 |
| Total | 1/3 PASS | 14/15 | Intact | 334.625 | 126 |

Wire accounting reconciles exactly: **2,243,057 input, 1,924,253 cached, 318,804 fresh and 42,257 output tokens**, across 21 reasoning and 105 action calls, plus 12 non-generation diagnostic exchanges. Prefix reuse was `85.787%`, aggregate decode `199.636` tokens/s and fresh prefill `4,307.164` tokens/s, using summed per-response timings. Independent grading added `4.055` seconds. All candidate/task/starter/protected hashes, three factory journal/traveler chains and 337 factory blob hashes validated. Cleanup receipts confirmed no remaining candidate writers, and server identity/settings were stable with idle slot boundaries.

The review actually activated on Receipt turns 6/7 for legitimate removal of the starter's `throw ... not implemented`, followed by identical confirmation; it added an acknowledgment step, not a demonstrated saved regression. Planner had reviews at turns 5/7/8, confirmation at 9, and verification-recovery events at 46/51/53–56. Snapshot had neither preservation nor recovery activation. Tests and offline reconstruction demonstrate the previous destructive replacement is caught; this fresh run does not establish that guard caused a quality improvement.

Snapshot retained sorting and safe-integer checks, but `verifyManifest` omitted root validation: an empty manifest with a symlink root returned success instead of throwing. Its worker then became stuck rereading the CLI tail. The controller stopped the run at turn 23 after repeated rejected reconnaissance; the saved `reachedDone:true` and completion summary describe that controller stop, **not a worker-emitted `done`**. The independent card remains FAIL. Planner exhausted 60 turns without accepted completion; it was not a wall timeout. Factory release/public-verifier success and independent benchmark acceptance remain separate facts.

### Further context defects established from the exact requests

Snapshot's raw request `wire/00014.request.body` (SHA256 `d886d428385239fb466629d736f61dd668a214142f3a3df9828178b46d04714d`) delivered the turn-7 source read only through a partial line 98, followed by clipping. The next request `wire/00015.request.body` (SHA256 `55b6afd08d9264463fa7861ca3014aa70166735cadb2c3e72df28dd598c3216f`) replaced the new request for lines 86–117 with a pointer claiming that range was already shown at turn 7. Later reads for lines 95–117 repeated the false pointer. History compaction had indexed raw source lines that downstream prompt clipping removed.

This is a real read-evidence reference defect, not context-window overflow. The full source still existed elsewhere as JSON-escaped earlier `write_file.content`; it was not globally absent from the requests. After a successful shell read the raw CLI tail also became visible, yet the worker continued repeating. That nuance matters: fixing delivery is warranted, but it is not proof that it alone fixes the missing root validation.

The base behavior-comparison rule also recommended `cmd; echo exit=$?`, while verification feedback marked that shape inconclusive because the suffix can mask the executable's status. Planner repeatedly used the recommended shape. The next repair aligns initial instructions with measured shell receipts and child-process assertions for expected errors, and makes source compaction references depend on actually rendered evidence. No task-specific validation hint or hidden-grader value is added.

## Third repair: delivered evidence, consistent instructions and strict completion

The source-reference repair preserves compaction but changes its authority boundary. Only complete numbered source lines surviving final observation clipping and rendering become pointer targets. A clipping gap cannot transfer another file's orphaned tail to the preceding file. Repeated reads can supply missing lines; fully delivered unchanged lines still compact to their actual origin. Frozen-fragment metadata records the observation that really accompanied each frozen fragment, so recomputed raw history cannot invent evidence inside an already-emitted prefix. Evicted fragments cannot supply source knowledge to the current window. Raw observations remain unchanged, and source data carried privately through the budgeted view is not serialized as a new evidence artifact. The per-observation cap is unchanged.

The initial behavior-comparison rule now tells the worker to inspect the shell receipt's exit/stdout/stderr and to assert child-process outcomes for expected errors. The optional background-job rule no longer recommends a status-masking suffix either. This aligns the initial instructions with subsequent verification feedback; expected failures still need a test of the expected outcome, not an artificial green exit.

Review of the new protection also found and repaired four edge cases: valid same-task resumes retain the original protected paths and hashes rather than freezing worker-created tests; purpose clauses about satisfying tests do not themselves prohibit editing tests; explicit test-file exceptions are respected without weakening other named/caller restrictions; and the final Datalog immutable check receives the exact frozen test hashes. Restored metadata is bounded and task-hash/path validated, not cryptographically authenticated against a caller able to forge an entire checkpoint. Legacy or different-task checkpoints conservatively capture current supplied tests.

Completion accounting is intentionally stricter in this version. `acceptedBantamCompletion` rejects controller-stop counters and controller-authored stop summaries; a supplied turn log must end with an actual non-rejected `done`. Legacy artifacts without a serialized turn log still require their explicit success/completion fields. This changes the benchmark's **protocol-completion classification**, not its frozen functional grader, public tests or artifact checks. All 10 PASS results across the 15 checked historical BANTAM runs remain PASS. Repair2 Snapshot's misleading completion flag no longer qualifies under the helper, but its overall FAIL score is unchanged. Historical receipts are not rewritten.

Prelaunch validation on the frozen source: full suite **3,612 passed, zero failed, 37 skipped** (`86.638` seconds); explicitly enabled live Docker checks **38/38 passed, no skips**. Nine new delivered-source regressions and 22 existing history/prefix/pointer tests passed. Focused instruction/resume/immutable checks passed 92 tests with one opt-in Docker skip; strict completion and caller fixtures passed 22/22.

Read-only replay of the exact repair2 Snapshot turns confirms the delivery change: the original broad read still occupies 4,000 characters and clips line 108. The next narrow read now occupies 768 characters, points only lines 86–97 back to their visible origin, and restores lines 98–117 literally, including the CLI entry guard. Sequential frozen stable prefixes remain unchanged. The original `run.json` SHA256 remained `50e15ef6fea5367cebccf69f5d15870b65534c9199e5557e3d3d59cc86322136`. This is replay validation, not a new model success or candidate repair. History budgeting remains an intermediate-view estimate, not an exact final prompt-byte bound; the unchanged observation cap bounds each recovered read.

The completed fresh run is separately recorded at `factory-c72000-s1-mtp1-repair3/`, arm `bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-repair3`, with identical functional tasks/starters/graders, the same model/server settings and unchanged turn/wall limits. No model/default promotion or server-cache clearing was part of this run.

### Repair3 results: no clean completions; timing is contended

| Card | Recorded outcome | Independent groups | Public exit | Contender seconds | Generation calls | Input | Cached input | Fresh input | Output |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| receipt-reducer | OUTPUT_ONLY | 5/5 | 0 | 129.381 | 34 | 473,074 | 432,961 | 40,113 | 9,974 |
| snapshot-drift | FAIL | 5/5 | 1 | 157.132 | 57 | 1,255,478 | 1,004,973 | 250,505 | 16,901 |
| job-planner | OUTPUT_ONLY | 5/5 | 0 | 188.269 | 78 | 1,741,641 | 1,519,067 | 222,574 | 20,065 |
| Total | 0/3 PASS | 15/15 | One failure | 474.782 | 169 | 3,470,193 | 2,957,001 | 513,192 | 46,940 |

All 169 primary wire calls reconcile with exact request/response bytes, hashes, `modelCalls` and full `metrics.usage`. Planner's output includes 374 tokens from three auxiliary diagnosis requests (106/133/135 tokens); its legacy `metrics.tokens` excludes these, so it is not the correct total. Grading added `4.702` seconds. All 406 runtime files and 23 kit files matched their seals; candidate/task/starter/protected hashes were unchanged. All three factory chains and 424 blobs validated. All exact-workspace cleanup receipts confirmed no remaining candidate writers, with stable model/build and idle slot boundaries.

The operator reported possible concurrent local-LLM use during testing. Receipt's global window recorded 16,998 output tokens versus 9,974 in its own proxy traffic: **7,024 additional output tokens**, plus approximately 32,497 additional fresh input tokens, demonstrate endpoint work outside this contender's recorded requests. The exact overlap interval and causal slowdown are unknown. Snapshot/Planner global differences were only a handful of input/cache tokens, consistent with printed-counter rounding, but this does not retrospectively certify exclusive service. Do not use this series for uncontended wall-clock, cache or prefill ranking, and never assign global totals to the contender. Own wire accounting remains exact. Local receipts: `operator-contention-note.json` and `operator-contention-counter-check.json`.

### Repair3 causal audit: distinguish repaired context from remaining faults

- **Read-reference repair works in real requests.** Receipt's broad read clipped after line 96; the next narrow read pointed only the actually delivered lines backward and restored lines 97–173 literally. All 196 source-pointer occurrences across its 34 generation requests had visible source-line targets. The later read/shell repetition is not the old clipped-origin defect. Obsolete initial `cmd; echo exit=$?` guidance was absent.
- **Receipt repaired an early CJS/ESM mismatch, then stalled on a real edge case.** It identified fragility in its NUL-separated grouping key. A repair redeclared a variable and was refused by syntax validation; the following replacement treated rejected proposal text as current source. Later reads had truthful source pointers, and an allowed shell read also showed current bytes, but the worker continued repeating inspections. The controller stopped at zero-based turn 28. Public 4/4 and frozen independent 5/5 remain recorded, not a claim of universal correctness.
- **Receipt's frozen grader missed a public-contract defect.** A separate post-grade readonly, offline Docker check supplied one JSONL started event with job `a\u0000b` and attempt 1. The output truncated the job to `a` and produced `NaN` for attempt (JSON renders it as null). This violates opaque-string preservation. The forensic receipt retains both the first invalid probe, which incorrectly supplied an array instead of JSONL and correctly threw, and the corrected JSONL assertion, which demonstrates the bug. No candidate, grader or canonical score was changed. Local receipt: `operator-receipt-identity-forensic.json`.
- **Snapshot's implementation passed every frozen independent group, but its added test was wrong.** In new `test/verify.test.js`, `good({sha256:hex})` inherits valid default path/size/mode, yet an assertion expected it to throw. The worker diagnosed this correctly at turn 29, but a large replacement's anchor did not match current source. Later probes confirmed the helper semantics, then it drifted into repeated inspection of a private function's exports. The controller stopped at turn 45. Supplied tests were untouched. Active line-edit recovery suppressed the separate verification-recovery mask despite the failed test: another control interaction to investigate, not missing safe-integer or ordering behavior.
- **Planner was falsely rejected by a factory completion gate.** It wrote a real CLI test that compared exact stdout with `assert.equal`, as well as exit status and stderr; the final direct configured verifier passed 11/11. At turn 59 its `done` was rejected by `simulate-to-target.js`. That gate's target matcher accepted only `produce n` from the ordinary requirement “invalid graphs produce nonempty stderr,” and its comparison matcher omitted Node's `assert.equal` spelling. It therefore demanded a target reproduction despite existing execution-backed comparisons, spending the final turn. This failure must not be attributed simply to Tiel refusing to finish.

Two further control/accounting discrepancies remain explicit. The pipe guard sometimes says “send exactly this” with a compound redirect/echo/cat command that verification feedback separately marks inconclusive; changing the base rule alone did not align every correction surface. Receipt's factory journal also still ends in `job.released` under the old controller-stop `reachedDone` semantics, while the stricter benchmark reader correctly reports OUTPUT_ONLY. Correcting a benchmark reader is not the same as correcting the factory's release semantics.

A separate frozen-history eviction limitation also remains. Snapshot requests `wire/00045`–`00047` and Planner `wire/00066`–`00067` retain an old frozen public-test pointer after its original turn has left the history window. The new compactor does not grant new pointer credit to evicted fragments, but it does not rewrite these already-frozen old pointers. Do not generalize Receipt's successful pointer audit to all historical fragments under eviction. This was not the identified Snapshot failed-test repair or Planner final-gate cause: Snapshot's final request still visibly contains both its helper definition and the failing assertion as actual read evidence.

## Repair4: general control corrections and exclusive-service rerun

The operator explicitly reserved the running Tiel endpoint for this rerun. No runtime/model promotion, larger turn allowance, relaxed task, candidate repair, or grader change is part of repair4.

The repair addresses independently reproduced harness defects:

- Target detection requires an actual stated target/equivalence rather than ordinary output-shape language. Node equality assertions and accepted direct-edit source count as comparison evidence; rejected proposals and blocked commands do not. This is comparison-step detection, not a claim that every asserted comparison executed or passed. Existing explicit DNA/compression/cipher target checks remain.
- Failed-anchor line editing and typed verification recovery compose. The context labels a refused proposal **not applied**, never current source, and does not require an unrelated edit to clear recovery. Caller/document restrictions and original run budgets remain authoritative. Post-authoring hard refusals now ask for a demonstrated repair or executable check instead of a first draft.
- Pipe corrections suggest a standalone check only when it can be identified safely. Compound capture/echo recipes are refused without execution and without claiming that dropping suffixes preserves their whole program. Simple passive-filter pipelines still run the direct test. Required prior setup, opaque substitutions, and executable filters are not silently transformed.
- Cached source observations track their actual delivered origins. Evicting or changing an origin invalidates dependent observations and restores literal source as needed, including chained references. Valid ordinary appends retain their frozen prefix; originally frozen action/context-update bytes remain unchanged. Recorded Snapshot/Planner eviction shapes were reproduced offline without changing the historical films.
- Progress/artifact/interactive controller stops carry a typed receipt, leave `done`/`reachedDone` false, and retain final verification separately. Actual `done` acceptance is persisted in turns, crash observation events, and saved films. Factory release rejects both typed stops and contradictory legacy completion flags accompanied by stop counters/summaries. Passing final tests alone cannot release a stopped worker or qualify it for successful-run learning.

Pre-run validation: full suite **3,635 passed, zero failed, 37 opt-in skips** (3,672 total); live Docker checks **38/38 passed**, no skips. The final checkpoint/resume metadata passthrough was added after that full-suite run; its focused completion/artifact/recovery/checkpoint suite then passed **39/39**, no skips. Diff whitespace checks passed. Source was frozen during the separately identified fresh `factory-c72000-s1-mtp1-repair4/` series.

### Repair4 settled results

| Card | Strict outcome | Independent groups | Independent public suite | Contender seconds | Calls | Input | Cached input | Fresh input | Output |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| receipt-reducer | FAIL | 5/5 | 26/29 | 137.317 | 45 | 884,798 | 824,214 | 60,584 | 21,208 |
| snapshot-drift | FAIL | 4/5 | 14/14 | 65.488 | 32 | 401,014 | 358,773 | 42,241 | 8,439 |
| job-planner | PASS | 5/5 | 22/22 | 263.973 | 52 | 1,125,206 | 1,036,457 | 88,749 | 20,613 |
| Total | 1/3 PASS | 14/15 | Two accepted public suites | 466.778 | 129 | 2,411,018 | 2,219,444 | 191,574 | 50,260 |

All three workers reached genuine accepted `done`, without controller stops. This demonstrates recovery/completion improvement relative to repair3's two controller stops and exhausted Planner; it is **not** a claim of improved final correctness or statistically established reliability. Grading added 4.649 seconds.

- Receipt repaired its source and a mistaken self-authored whitespace-ID assertion, then passed 29/29 during the run. Three added CLI tests wrote fixtures into the workspace; independent grading alone mounted the whole workspace read-only, causing EROFS. That restriction was absent from the public task and worker verification context. This is an evaluator/verification-environment mismatch, not evidence of a Receipt functional failure. The strict historical FAIL remains unchanged.
- Snapshot's new verifier omitted the existing root-validation call. With an empty manifest, its loop never inspects anything, so an invalid/symlink root returns success. The public task required root validation and was visible; its tests covered invalid roots through `create`, not through the new `verify` API with zero entries. The independent grader demonstrated this real contract violation. Read-only source review also found a comparator using `.path` on strings in `unchanged`; that observation is source inference, not an additional independently executed grader result.
- Planner passed after repairing a broken Python fuzz launcher that passed literal `$PWD` to a subprocess. The broken and corrected 3,000-case fuzz runs consumed roughly 128 seconds. A scaffold notice incorrectly inferred continued product failure from repeated run counts; repeated CLI inspection and this setup error remain efficiency/context debt, not missing final acceptance.

`operator-evidence-audit.json` reconciles all 129 generation calls and 141 HTTP receipts, 383 factory events, 337 blob hashes, and 47 shell receipts. All 407 source files and 23 kit files matched their launch seals immediately before repair5 edits. Protected files remained unchanged; cleanup and journal chains passed. Global output counters exactly equal each contender's wire output, with input/cache differences within printed precision: no extra inference traffic was detected. Global prompt timers do not exactly match summed per-response prompt timings; their definitions are not assumed interchangeable.

## Repair5: bounded API review and verification-environment parity

The requested follow-up targets the missed unconditional-precondition/zero-work combination, without inserting Snapshot-specific answers or hidden tests into the worker context. Existing contract-state auditing is extended to explicit callable/collection/validation contracts. A clean view of the public task and current source reviews each API independently. Collection audits are scheduled at green/proposed completion rather than spending their first opportunity on an unfinished draft; at most two audits run, and test-only changes do not re-audit identical source.

A first targeted replay exposed a problem with the auditor itself: unconstrained Tiel consumed 2,400 output tokens in unfinished thinking and identified neither defect. That failed diagnostic is preserved at `repair5-audit-replay/`, with 2,952 input tokens and one exact model call. The raw response reported `stop_type: limit`, but the old client failed to normalize that field. Native stop-limit normalization is now corrected across plain and streaming paths. The collection audit now uses a closed grammar/schema for a small findings-first response; an incomplete or invalid response remains unavailable, never a completed review.

The single constrained diagnostic replay (`repair5-audit-replay-constrained/`) completed valid JSON using 2,928 input and 231 output tokens, but **still missed both defects and made an unsupported ordering claim**. Grammar fixed response completion, not reviewer accuracy. Both diagnostic replays used only the public task and unchanged repair4 source, with no hidden grader or worker history; neither is a fresh candidate build or rescore. Audit advice is not authoritative, and executable assertions must test it rather than blindly implementing it.

The recovery checkpoint requires a current-generation focused executable check followed by configured project verification, not a prior green suite, merely adding a test, or a fresh broad suite alone. Execution shape and provenance are checked; they do not prove that an assertion covers every requirement or that a model-designed oracle is correct. Existing structured `probeEvidence` is not credited by this checkpoint yet. One requested check may execute again after a new audit without clearing all deduplication or claiming a workspace mutation. Caller restrictions and the original turn budget remain authoritative.

Read-only configured verification is now an explicit opt-in execution profile (`--verify-workspace-read-only` / `BANTAM_VERIFY_WORKSPACE_READ_ONLY=1`). The worker is told that configured acceptance uses read-only source and fresh writable `/tmp`; ordinary edits/manual shells stay writable. Writable manual proof cannot substitute for read-only completion proof. Host mode refuses an unsupported read-only promise. A real Docker regression demonstrates writable manual success, read-only EROFS reaching the worker, a temp-fixture repair, and read-only acceptance with protected files unchanged. Historical tasks, candidates, graders, and scores are not rewritten.

Final pre-run validation on the frozen repair5 source: **3,668 tests passed, zero failed, 38 opt-in skips** (3,706 total, 71.287 seconds). Explicitly enabled live Docker checks passed **39/39 with no skips**. The final focused collection-audit/recovery/native-stop/verification-parity checks passed **39/39**. The integration regression uses mock model replies but actual Node assertions: the missing precondition fails a focused check, the repaired implementation passes it, and completion requires subsequent project verification. It establishes control flow, not real-model audit accuracy.

### Repair5 fresh Snapshot result

`factory-c72000-s1-mtp1-repair5/` contains one fresh Snapshot candidate, using explicit `configured-readonly-v1`. The public task, starter and functional grader are unchanged; the newly disclosed verification environment is a runtime-policy change, not a pure matched historical ablation. Outcome: **OUTPUT_ONLY**, all **5/5 independent groups and 29/29 public tests passing**, 60 actions exhausted without accepted `done`, no operator candidate repair. Contender time is 250.822 seconds, with 1.588 seconds of independent grading. No controller stop or wall timeout occurred; final automatic verification passed read-only, but that alone cannot substitute for protocol completion.

The authored source included unconditional root validation and correct string-array sorting before the first audit. Its initial CLI guard incorrectly compared a filesystem path with `import.meta.url`, causing empty stdout/exit zero; its own executable CLI tests exposed this, and the worker repaired it using `fileURLToPath`. The API auditor cannot be credited with either the already-correct root/sort behavior or that independently diagnosed CLI repair.

Both real audits were structurally complete but semantically unreliable. The first listed passing scenarios as findings; the second invented interleaved validation despite the source visibly validating the complete manifest before the loop. Their immediate worker requests lost the report in observation clipping; later completion recovery delivered the second report. The worker correctly disputed it and wrote assertions, but repeatedly appended `; echo EXIT=$?`, making those shell statuses inconclusive. A clean filtered Node test actually passed one case, yet the focused-check recognizer rejected Node's `--test-name-pattern` option. Later broad suites did not clear the focused gate. These are delivery/protocol failures, not remaining root/sort defects.

The run also established false controller feedback: repetition converted unknown outcomes to a boolean false and called them **FAILED**, while scaffold guidance assumed repeated program executions meant the artifact was still wrong. Raw receipts retained the correct unverified state. Repairing the language must not weaken the underlying execution-evidence requirement.

All **79 model calls** reconcile exactly with complete wire receipts: 60 actions, 17 reasoning calls, and two auxiliary audits. Totals are **1,835,727 input; 1,438,083 cached; 397,644 fresh; 25,442 output tokens** (78.3386% prefix reuse). Legacy think/action counters omit the audits' 863 output tokens; full `metrics.usage` includes them. Four other HTTP exchanges were diagnostic, not generation. All 408 source files and 23 kit files matched their seals before repair6 edits; task/starter/final/protected hashes, journal/traveler chains and 190 blob hashes validated. Server identity/settings remained stable, cleanup confirmed no candidate writers, and global output matched own wire exactly; small input/cache counter differences fit their printed precision, not proof of exclusive access.

## Repair6: make actual verification evidence usable

This follow-up targets the observed context/protocol defects, not the scored candidate or hidden tests: deliver bounded typed audit advice outside clipped tool output; recognize an actual nonzero passing named Node test; distinguish failed from unverified or passing executions in repetition/scaffold guidance; and normalize only a strictly passive status-print suffix on a single recognized direct check. Compound setup, cleanup, arbitrary CLI calls and opaque shell programs must remain unverified rather than silently transformed. No added turns, relaxed acceptance, stronger reviewer model or benchmark-specific fixture is part of this repair.

Final frozen-source validation: **3,694 passed, zero failed, 38 opt-in skips** (3,732 total, 70.783 seconds). Explicitly enabled Docker sandbox/integration tests passed **30/30 with no skips**. Focused parent integration and status-normalization checks passed **23/23**, including actual Node assertions, named-case selection and passive-echo commands reaching accepted completion. Mock model responses in these integration tests do not qualify Tiel. Offline replay separately confirmed that both complete repair5 audit reports reach their first next prompt without altering original observations; frozen prefix appends and budget accounting remain tested.

### Repair6 completed results

The fresh BANTAM/Tiel-only series is recorded at `factory-c72000-s1-mtp1-repair6/`, in Snapshot, Receipt, Planner order. These are three tasks, not three harnesses. The operator explicitly deferred other-harness comparisons while qualifying the 35B-A3B worker.

All three cards settled **OUTPUT_ONLY**: **3/3 accepted artifacts, 15/15 independent groups, but 0/3 accepted completions**. Every worker exhausted 60 actions. All independent public/hidden commands exited zero, all protected-file checks were clean, and all final configured verifiers passed read-only. No wall timeout, interruption or controller-stop receipt occurred. The worker processes exited zero, but no `done` was accepted; these are not strict PASS results.

| Card | Strict outcome | Independent groups | Public tests | Contender seconds | Calls | Input | Cached input | Fresh input | Output |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| receipt-reducer | OUTPUT_ONLY | 5/5 | 4/4 | 306.774 | 82 | 1,574,905 | 1,267,563 | 307,342 | 43,773 |
| snapshot-drift | OUTPUT_ONLY | 5/5 | 19/19 | 269.306 | 75 | 1,608,375 | 1,179,766 | 428,609 | 28,795 |
| job-planner | OUTPUT_ONLY | 5/5 | 8/8 | 302.614 | 79 | 1,735,380 | 1,182,406 | 552,974 | 32,834 |
| Total | 0/3 PASS | 15/15 | 31/31 | 878.694 | 236 | 4,918,660 | 3,629,735 | 1,288,925 | 105,402 |

Independent grading adds **3.961 seconds**, for **882.655 contender-plus-grading seconds**. Primary wire accounting reports every generation request measured, with no unknown usage replaced by zero. Global server counter windows remain supplementary rather than substitutes for these per-contender totals. The completed manifest records no source/kit mismatches against its 408 runtime and 23 kit seals. These repairs used fresh starters; no operator candidate changes or grader changes are recorded.

Both complete collection reports now reached the immediately following raw requests, confirming the delivery fix in the real run. Both auditors still made unsupported claims that the worker correctly disputed from current source. Root validation was present. The new implementation initially repeated the mixed string/object comparator mistake, which the worker repaired at turn index54; this repair was not identified by the auditor. No focused-eligible assertion check occurred anywhere in the run: repeated inline probes caught errors and printed good/bad labels without asserting them. At index56 an `execFileSync` call treated the required drift exit1 as an unexpected uncaught failure. A later read-only project suite passed, but no focused passing receipt preceded it, so the final rejection remained justified by the stated protocol. The named-test and passive-echo corrections were not exercised here and cannot be credited with a model success.

Snapshot's wire/full usage reconciles all **75 generation calls**: 12 reasoning, 61 action-shaped calls including a repair/retry, and two audits. Its audits contribute 648 output tokens, included in full usage but not the legacy 28,147 counter. One action output hit its limit and was correctly normalized; no input truncation occurred. The earlier Snapshot checkpoint validated task/source/audit hashes, protected files, factory chains and 187 blob hashes; workspace-writer cleanup was confirmed.

Receipt's late completion attempt was also rejected by the focused recovery checkpoint, followed by another command that printed API results instead of asserting them. Planner's last two actions requested `done`; both were rejected with focused-execution/project-verification still pending despite the broad suite passing. The factory obtained useful implementations but did not reliably turn its audit requests into the required execution sequence. This is a remaining harness/workflow qualification failure, not a reason to remove the distinction between printed observations and assertions or to relabel OUTPUT_ONLY as PASS.

The exact per-card `result.json`, `run.json`, `public.stdout.log`, wire evidence and task/material/final hashes remain under `factory-c72000-s1-mtp1-repair6/repeat-1/CARD/bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-repair6/`. The aggregate receipt is that series' `manifest.json`. These are local private evidence paths, not an assertion that ignored records ship in a fresh clone.

## Repair7 design: an explicit, bounded assertion station

Repair7 moves one small assertion procedure into the controller instead of repeatedly asking the worker to invent a valid launcher. It reuses [the existing isolated probe executor](../src/probe.js) and its [FactBus/Datalog evidence projection](../src/probe-evidence.js), with a [declarative case format](../src/contract-assertion-spec.js), [station controller](../src/contract-assertion-station.js) and [recovery binding](../src/contract-audit-recovery.js). No scored source, public task, starter or hidden grader is changed.

The station is conditional: unattended collection-contract auditing must be active, probes must already be explicitly enabled (`BANTAM_PROBE=1`), the shell sandbox must be Docker, and current caller policy must allow probe and shell actions. **The post-run shipping default is off**; direct BANTAM callers can explicitly select `BANTAM_CONTRACT_ASSERTION_STATION=on`. The station setting does not disable the independent audit or normal verification. There is at most one station per new audit, within the existing two-audit cap. It adds bounded auxiliary model/process work, not extra worker action turns. The scored repair7 run used the earlier conditional-auto implementation; its sealed configuration and result are not retroactively relabeled as a default-off run.

The model supplies data: one public JavaScript module/export, bounded fixture descriptions and arguments, and a JSON equality or throw expectation derived from the public contract. It does not supply shell commands or executable assertion source. Fixed controller code constructs the fixture, witnesses its shape and callable export, then asserts the API result in the existing offline copied-input sandbox. Source/input/specification/stage/output hashes bind the receipt to the current audit and source generation; a cached projection or printed success label cannot certify it. The Datalog projection is recomputed from measured stages.

A passing station supplies only focused execution. The controller must then run the configured project verifier on that same generation and retain its actual receipt inside the station; an older or unrelated same-turn green result cannot stand in for this order. The selected read-only verification profile is checked. Failed or unavailable stations remain nonpasses, and the independent manual focused-recovery route remains available. Explicit worker `done`, all other completion checks, and the original turn/time limits remain unchanged.

This machinery is deliberately narrow: synchronous JavaScript public APIs with JSON-compatible results or expected throws, not async/streaming APIs or arbitrary runtime objects. A model-designed expected result can still be wrong. One executable case is neither complete contract coverage nor an independent correctness oracle; a reported assertion failure must be checked against the public requirement before changing product code.

Final pre-run validation passed **3,719 tests, zero failures, 40 opt-in skips** (3,759 total, 74.025 seconds). The explicitly enabled live Docker group passed **41/41 with no skips** in 12.037 seconds; the parent integration group passed **29 tests with one live opt-in skip**. Local logs are `/tmp/bantam-tiel-repair7-full.log` and `/tmp/bantam-tiel-repair7-live.log`; they are transient operator paths, not bundled evidence. These implementation tests are not evidence of improved Tiel completion, lower cost or readiness for default promotion.

### Repair7 completed Snapshot result

The fresh Snapshot-only run settled **OUTPUT_ONLY**: accepted artifact, **5/5 independent groups and 15/15 public tests**, but no accepted completion. Its 60-action budget ended after **33 rejected `done` actions**, beginning at zero-based index23. The process exited zero without timeout, interruption or a controller-stop receipt. Final configured verification passed read-only; that `run.json` verification PASS is not a completion verdict. Protected-file checks were clean, with no operator candidate intervention.

| Contender seconds | Grading seconds | Measured calls | Input | Cached input | Fresh input | Output |
|---:|---:|---:|---:|---:|---:|---:|
| 179.896 | 1.666 | 73/73 | 1,668,168 | 1,371,403 | 296,765 | 17,311 |

Contender plus grading took **181.562 seconds**; prefix reuse was **82.2101%**. Primary wire usage is complete and reconciles with full run usage: 11 reasoning, 60 action, one audit and one assertion-planning call. The audit's 328 and station's 28 output tokens explain the difference from the legacy 16,955-token counter. The legacy `cacheMissTokens:0` field is not a measurement of zero fresh input. Supplementary global counters report 1,668,170 input / 1,371,400 cached / 296,770 fresh / 17,311 output; their small input/cache differences remain visible rather than replacing wire totals or proving exclusive access.

At index6 the API audit found root validation already correct and explicitly reported no counterexamples. The station planner copied the prompt's blank `fixtures:[]`, `args:[]`, `expect:{kind:"equals",value:null}` example while selecting the real `createManifest` export. This called `createManifest()` with no root and incorrectly expected null. The fixed assertion procedure correctly failed: the API threw, as the public contract requires. At index7 the worker explicitly identified the expectation as wrong and declined to corrupt the implementation to satisfy it. A structurally valid model-written case was not a valid correctness oracle.

The remaining failure was not simply an absence of real assertions. Earlier launches at indices15, 18, 22 and24 appended status echoes and correctly remained unverified. Later index33 ran `cd ABS_WORKSPACE && node --test test/edge.test.js` with **12/12 passing assertions**, and index34 ran `cd ABS_WORKSPACE && npm test` with **15/15 passing tests**. Both have typed execution PASS receipts. The focused-recovery recognizer nevertheless rejected the compound `cd`-prefixed launch form, so it did not credit the focused-then-project sequence. Subsequent `done` requests remained blocked; a repeated check at index51 was deduplicated rather than executed. This is a concrete remaining launcher-recognition integration gap, not evidence that those later tests failed or merely printed success.

Before releasing the run's source freeze, an independent read-only audit rehashed **all 410 runtime source files and all 23 kit files**, with zero mismatches. A separate audit validated all 73 wire/model-call bindings, 162 factory blobs and the journal/traveler chains. The station's recomputed Datalog outcome remains failed (setup0, witness0, check1), with no post-station project receipt. The completed evidence is `factory-c72000-s1-mtp1-repair7/manifest.json` and `factory-c72000-s1-mtp1-repair7/repeat-1/snapshot-drift/bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-repair7/{result.json,run.json,public.stdout.log,wire/}` beneath the local provenance root. Original tasks, candidates, receipts and grades remain immutable. This one adaptive rerun does not establish lower cost, stronger reliability or improved accepted completion.

After that sealed run, shipping guards changed separately: station default off, explicit current action-policy/budget checks, and conservative receipt formatting. The local variant runner now requires its explicit **`--contract-assertion-station`** switch for an experimental replay and records the selection in the manifest. Its clean environment strips ambient BANTAM variables, so an environment prefix alone is not a reproduction recipe. Combine that switch with `--verify-workspace-read-only` for the selected read-only profile and use a new output directory; it is a new-source experiment, not an exact replay of the sealed repair7 source. Final post-run validation passed **3,722 tests, zero failures, 40 opt-in skips** (3,762 total, 77.300 seconds; `/tmp/bantam-tiel-repair7-final-full.log`). Live Docker qualification passed **42/42 with no skips** in 11.267 seconds (`/tmp/bantam-tiel-repair7-final-live.log`). These post-run guards have not been model-qualified by the historical run above.

## Repair8: bind focused launcher recognition to measured workspace

The repair7 `cd ABS_WORKSPACE && DIRECT_CHECK` mismatch is fixed without rewriting or rerunning shell commands. Both shell and verification receipts retain the executor's real working directory. Recovery recognizes exactly one literal absolute-workspace `cd` followed by `&&` and a direct check only when the current workspace, measured directory and full requested/executed/status command bindings agree. Other directories, relative paths, expansions, backslash ambiguities, extra setup, pipes and status masks remain excluded. Existing failure, generation, nonzero named-case and subsequent-project-verification checks remain in force. Historical receipts without the required directory binding are not retrospectively enriched or rescored.

Validation: **3,729 tests passed, zero failed, 40 opt-in skips** (3,769 total, 77.935 seconds). The selected live integration group passed **11/11** in 10.546 seconds. The new end-to-end test executes the actual prefixed focused check and subsequent project suite, reaches accepted `done`, and verifies that directory/command evidence survives artifact and checkpoint serialization. It runs on the host in the full suite and in Docker with read-only configured verification when explicitly enabled. Logs: `/tmp/bantam-tiel-repair8-full.log` and `/tmp/bantam-tiel-repair8-live.log` (local transient evidence, not bundled).

The fresh BANTAM/Tiel-only Snapshot run at `factory-c72000-s1-mtp1-repair8/` achieved **PASS**, with **5/5 independent groups, 3/3 public tests and accepted completion at turn index29**. Contender time was **93.738 seconds**; independent grading added **2.424 seconds**, totaling **96.162 seconds**. All **39 model calls** have measured wire usage: **569,046 input; 516,918 cached; 52,128 fresh; 8,392 output tokens**, or **90.8394% prefix reuse**. All 410 runtime and 23 kit files matched their launch seals; protected files were unchanged and no operator candidate repair occurred. Original failed runs remain unchanged.

Scope matters: the assertion station was off, matching the shipping default, and no collection-audit reports were emitted in this sample. The implementation landed through shell actions. The live run therefore did **not** exercise the new audit-recovery prefix branch and does not show that all audit paths cover shell-authored work. Its PASS establishes successful completion of this sample, not causal attribution of the lower time to the new recognizer, reliable audit coverage, or general Tiel qualification. The specific launcher fix is demonstrated by the host/Docker regressions, not by relabeling this benchmark's execution path.

## Decision and remaining qualification

Keep the 27B as the established comparison baseline and Tiel as an experimental worker, not a default replacement. The focused-launch mismatch is now regression-tested, and repair8 achieved one clean Snapshot completion, but reliable audit coverage and repeated multi-card qualification remain open. Keep the assertion station opt-in. Compare the same patched harness on both models under confirmed exclusive service, with fresh repeats and unfamiliar work before ranking models. The historical 27B 3/3 does not qualify every later harness revision. Version any future coverage expansion separately: do not retroactively repair scored candidates or relax/rewrite their grades. A separate matched MTP-off/MTP1/MTP3 experiment is needed before attributing speed to speculation settings.

Multi-worker/short-context scheduling remains promising but untested here. The installed qwen35moe MTP implementation supports multiple sequences; that does not establish their memory footprint or service quality on this GPU. With non-unified KV, total context is divided among slots; recurrent state and speculative rollback storage also grow with sequence count and draft length. A shared model process avoids duplicating weights. An 8GB-VRAM deployment would need weights partly offloaded to sufficient system RAM; neither its fit nor its performance was measured here. No CPU-only, 8GB, concurrent-agent or production-default qualification follows from this series.
