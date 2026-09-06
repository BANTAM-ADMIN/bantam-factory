# Factory machinery fight cards, 2026-09-06

Three fresh, bounded Node.js builtin-only assignments. They exercise useful
factory building blocks without changing BANTAM itself or relying on a model's
self-reported completion. These are development comparisons, not proof of
general capability, hostile-code containment, or production qualification.

| Card | Work shape | Deliverable |
| --- | --- | --- |
| `receipt-reducer` | Fresh implementation | Reconstruct job attempts from unordered JSONL receipts |
| `snapshot-drift` | Extend a fixed, working starter | Check selected source files against a byte/mode manifest |
| `job-planner` | Repair a deliberately flawed starter | Plan dependencies and propagate failure causes |

For every contender, copy only that card's `starter/` into a new workspace and
deliver the exact `task.md`. Never deliver `grader.mjs`, `grader-support.mjs`, or
`reviewer/`. The reviewer implementations qualify the gauges; they are not
contender results. Starters do not come from earlier contender runs. Freeze and
hash the complete kit before execution and retain every attempt.

Protected files are `package.json` and every initially supplied `test/` file.
The controller must compare their bytes against the starter after the run. New
tests are allowed. Run public tests and the independent grader offline in a
read-only Docker candidate workspace, not on the host. Grader invocation:

```
node /absolute/kit/CARD/grader.mjs /absolute/candidate
```

Mount the chosen grader and the sibling `grader-support.mjs` read-only. Each
grader emits one JSON summary with named groups and exits nonzero unless every
group passes. Public tests, protected-file integrity, independent groups, and
the contender's actual termination status are separate evidence. No score
should be inferred from candidate prose. `test/factory-fight-kit.test.js`
qualifies the graders with reviewer references and intentionally wrong variants
in offline read-only Docker. Hidden checks use only requirements published in
the work orders; they vary values and combinations, not the contract.

Task success is whole-card success, with group outcomes retained for diagnosis.
Do not send hidden failures back for repairs within the same scored attempt.
If the kit or harness changes, preserve the old result and start a new revision.
These tools are benchmark artifacts until separately reviewed and integrated
into an actual BANTAM consumer.
