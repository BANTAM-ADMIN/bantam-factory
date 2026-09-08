# Comparing BANTAM operating modes

These are different treatments, not interchangeable names for the same system.
Use selective cards to discover when extra machinery pays for itself. Do not
infer a benefit from a mode being enabled or an isolated passing attempt.

| Treatment | Who does the work? | What must be charged to the attempt? |
|---|---|---|
| Local BANTAM | Selected local model inside the factory | All local requests, cache use, wall time and verification |
| BANTAM-wrapped Codex | Codex model inside BANTAM's execution and completion workflow | All Codex calls plus factory/verification time; this does not imply local delegation |
| Native Codex or Claude | Provider CLI operating on the same starter | Native aggregate/response receipts, elapsed time, independent grade and protected-file checks |
| Astra foreman + local BANTAM | Astra supervises bounded jobs executed by the local factory | Supervisor and every worker, including unsuccessful jobs, queue time, integration and verification |
| Deep research | Local chat model identifies factual gaps; a governed librarian may obtain sources before the answer | Gap elicitation, source errand and final answer, including a failed or unused errand |

## Fresh coding comparisons

The `factory-controls-2026-09-07` kit adds Redaction Plan and Retry Budget:

```bash
bantamfactory cards --kit factory-controls-2026-09-07 --card all \
  --arms bantam-local-27b,bantam-codex-astra,codex-astra,claude-sonnet --live --public
```

Review the plan and approve account/endpoint use. The default remains local
BANTAM only. `--public` generates a sanitized local package, not an upload.
The work orders specify complete contracts, independent API/CLI checks and
protected public tests. Their outcomes must be recorded before claiming wins.

For a selective supervisor treatment, use the [foreman workflow](FOREMAN.md).
Keep its candidate separate and apply the same independent task grader. One
local worker slot and an optional single Codex worker slot are distinct from
the supervisor itself. When another Codex agent is already active, omit the
optional Codex worker to keep within a two-agent total. A hybrid success is not
a claim that the local model solved the whole task without frontier help.

## Deep research needs a different kind of card

The current `:deepresearch on` behavior is a pre-answer chat workflow: elicit
factual gaps, optionally dispatch the source librarian, then use its notes as
outside testimony. Simply setting `BANTAM_DEEPRESEARCH=1` on the autonomous
coding-card command does **not** demonstrate that workflow ran.

A useful research comparison asks a source-grounded question where the answer
depends on documentation or repository evidence, with an independent checklist
for factual accuracy and provenance. Freeze the question and evidence snapshot;
compare the normal answer with the research-enabled answer. Record whether an
errand actually occurred, what it supplied, and all pre-answer costs. Do not
start the clock only after research, treat retrieved text as guaranteed truth,
or present a no-gap/no-errand answer as evidence of librarian benefit.

The coding cards and foreman runs do not by themselves qualify this separate
research treatment. A future source-grounded card must identify its own data,
adapter and complete measurement scope before publication.
