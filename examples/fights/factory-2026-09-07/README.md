# Factory workshop cards, 2026-09-07

Three new Node.js builtin-only work orders for useful factory machinery. These
are separate tasks, not replacements for the frozen September 6 comparison.

| Card | Shape | Useful building block |
| --- | --- | --- |
| `context-packet` | Build | Budget complete, attributable context sections |
| `patch-transaction` | Extend | Validate a batch of original-coordinate edits before applying it |
| `stream-framer` | Repair | Decode a bounded event stream independently of transport chunks |

Copy only a card's `starter/` into a fresh contender workspace and supply the
exact `task.md`. Never supply graders or `reviewer/` implementations. The fixed
starters are controller-authored, not outputs from a previous contender.
Protected files are `package.json` and all initially supplied `test/` files.
New tests are allowed, but must use OS temporary directories rather than write
into the candidate workspace during verification.

All public requirements, including validation, error cases and CLI behavior,
are in the work orders. Hidden checks vary values and combinations, not the
requirements. Five named independent groups are retained for each card. A
whole-card pass additionally requires the public suite, protected-file
integrity and accepted harness completion; a model's prose is not a score.

Run both public tests and the independent grader in offline, read-only Docker:

```
node /absolute/kit/CARD/grader.mjs /absolute/candidate
```

Mount that grader and this directory's `grader-support.mjs` read-only. The final
JSON must have schema `bantam.factory-card-grade.v1`, the exact card ID and
complete named groups. Grader qualification uses reviewer references, untouched
starters and deliberately incorrect mutations. No candidate code is executed
on the host. This is a behavioral gauge for ordinary generated code, not a
hostile-module security boundary.

```
BANTAM_FIGHT_KIT_DOCKER_TEST=1 node --test test/factory-workshop-kit.test.js
```

Freeze the kit before model runs, preserve every attempt and record new
revisions separately. These artifacts do not become production BANTAM tools
without a separate consumer integration and review. No model runs occur while
building or qualifying the kit.
