# Extension context delivery: repair and acceptance

## Findings

The current-mode pilot on commit `70ccba9` passed all 16 final candidates on two
explicit-contract tasks and two seeds. Plain extension used 69.438 seconds and
78.2% prefix reuse versus rebuild's 147.670 seconds and 41.4%. These small fixtures
do not establish general equivalence or long-context reliability.

The optional decision snapshot counter increased in four runs, but only two
actually delivered that snapshot. A 4,000-character observation limit and a
700-character controller-block limit silently removed the other two before
the model request. Separately, stale-edit recovery referred to a current-file
panel that ordinary extension does not render.

## Implemented changes

1. Trusted disk snapshots are typed `contextUpdates`, separate from ordinary
   command-output strings. Prompt assembly renders them after observation
   clipping, inside the original turn's frozen fragment. Raw output containing
   `[review]` does not gain privileged treatment.
2. Snapshot collection is bounded to 3,000 characters, four files and 256 KiB of
   total disk reads. Views retain line numbers, identify generation and paths,
   explicitly disclose omissions, and refuse escaping/symlink/nonregular paths.
   A snapshot supplies context, not passing verification or permission to replace
   unseen source. At most two validated records render per turn.
3. An actual stale-anchor failure in extension receives a fresh view of the
   relevant path, once per path/generation. Recovery instructions require a
   targeted read when the needed range is omitted; they no longer promise an
   absent panel. Successful ordinary extension work incurs no recovery snapshot.
4. Snapshots count toward history budgeting and survive final artifacts,
   checkpoints, post-seal annotations and resumed runs without aliasing.
   Invalid restored records cannot suppress a valid fresh snapshot.
5. `metrics.contextUpdatePromptReceipts` records exact rendered-block inclusion
   and prepared-prompt SHA256, kind, generation and request cursor. This is
   explicitly a **prepared-prompt** boundary, not proof that a server accepted
   or attended to it. Acceptance independently inspects raw outgoing requests.

No context-mode default is changed. The user's remembered extension preference
remains; rebuild and immutable remain selectable. Decision snapshots remain
opt-in via `BANTAM_DECISION_SNAPSHOT=1`; the working-set experiment is unchanged.

## Verification plan

- Test the actual model callback with oversized annotated observations and
  late source markers, not merely a snapshot counter or saved observation.
- Check snapshot bounds, escaping, stale-anchor recovery, deduplication,
  prefix stability, history cost and malformed checkpoint recovery.
- Run the full repository suite.
- Re-run plain extension and extension+snapshot on the same two explicit tasks
  and two seeds, with the same local 27B and original task budgets. No hidden
  answers or implementation changes are supplied to the model. Compare actual
  request delivery, final checks, protocol recovery, time and cache reuse.
- Retain raw evidence locally; commit source, regressions and this write-up only.

## Final-source acceptance

Completed September 5, 2026 (Denver; September 6 UTC), with the same local
Qwen3.8-27B-BANTAM-Q4_K_P model and no server-setting changes. A SHA256 manifest
captured before testing covered all 395 production files under `src/` and
`bin/`; every file still matched after the last live request.

The full local suite passed: **3,297 passed, 0 failed, 4 skipped** (3,301 total),
including 29 new tests. The run used
`node --test --test-concurrency=8 test/*.test.js` and took 63.744 seconds.

Fresh live acceptance ran `channel-filter-explicit` and `ordered-map` with
seeds 20260905 and 20260906, in each of the two extension configurations.
Original turn budgets, fixtures and graders were unchanged. All eight runs
passed supplied and held-out checks, accepted completion and strict protocol
checks, with no invalid actions, scope violations, transport retries or
request/response checksum mismatches.

| Configuration | Final passes | Total agent time | Prefix reuse | Fresh prompt tokens |
| --- | ---: | ---: | ---: | ---: |
| Extension | 4/4 | 75.519 s | 76.678% | 27,774 |
| Extension + optional decision snapshots | 4/4 | 76.444 s | 69.021% | 38,414 |

The delivery improvement is directly observed: **all five generated snapshot
records appeared whole in actual outgoing requests**, across all four snapshot
runs, and those requests received successful HTTP responses. The prior pilot
delivered snapshots in only two of four runs. Independent reconstruction also
matched all five source-bound IDs, generations and prepared-prompt receipts.
No snapshot was omitted. Plain extension needed no source updates in this cohort.

These results establish the delivery repair, not a general capability gain:

- Both configurations already passed these small tasks; this sample cannot
  establish equal reliability on long or difficult repairs.
- One snapshot prompted an unnecessary post-green edit: the model incorrectly
  claimed `for...of` skips sparse-array holes. The existing string validation
  already rejected the yielded `undefined` values. The final candidate still
  passed, but the extra edit is not evidence of improved correctness.
- No stale-anchor failure occurred in these eight live trials. Its fresh-source
  recovery, deduplication and real prompt delivery are covered by deterministic
  model-callback regression tests, not a claimed live repair success rate.
- Timing and cache figures describe this cohort, not a controlled speedup over
  the earlier four-arm pilot; ordering, warm state and trajectories differ.

The practical recommendation remains **extension for this user's default,
with decision snapshots optional**. The new automatic stale-edit recovery is
available when needed, without adding snapshots to successful ordinary work.
The repository fallback remains rebuild; saved preferences still take priority.

Raw requests, films, full test output, source manifest and independent delivery
audit are retained locally under the ignored directory
`.bantam/acceptance/2026-09-05/context-delivery-fix-0EI20l/`.
The preceding pilot remains under
`.bantam/acceptance/2026-09-05/cache-mode-pilot-IJnF4t/`.
Neither raw-evidence directory is included in the commit or upload.
