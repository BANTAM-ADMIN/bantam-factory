# RepoBrief: three cumulative build cards

A small, useful local Git handoff CLI. This directory is a task/test kit, **not an implementation**. It has no `bin/repobrief.js` solution.

## Running the comparison

1. Copy `starter/` into each isolated candidate workspace. Give both agents `cards/01-status.md` and the same original workspace bytes.
2. Run `npm test` in the candidate and the external grader below. Preserve the original tests and package configuration. Keep the grader outside the model-visible workspace.
3. If the BANTAM candidate passes both checks, its exact application files become the common starting point for card 2. Add `stage-tests/stage-2/snapshots.test.js` as `test/snapshots.test.js` to both copies. Give both agents `cards/02-snapshots.md`. Do not mix either agent's changes into the other's copy.
4. Repeat with the passing BANTAM card-2 application and `stage-tests/stage-3/verification.test.js` as `test/verification.test.js`, using `cards/03-verification.md`.
5. If a BANTAM stage fails, stop the cumulative comparison and preserve the failure; do not silently repair its application or seed the next stage with a different agent's implementation.

External, cumulative grading:

```sh
node examples/fights/repobrief-astra-2026-09-06/grader.mjs --workspace /absolute/candidate --stage 1
node examples/fights/repobrief-astra-2026-09-06/grader.mjs --workspace /absolute/candidate --stage 2
node examples/fights/repobrief-astra-2026-09-06/grader.mjs --workspace /absolute/candidate --stage 3
```

The grader starts a separate Node test process and temporary local Git repositories. It never installs dependencies or contacts a network. Node 20+ and Git are prerequisites. A missing application must fail, not skip. Each grader test has a 20-second cap and each ordinary CLI invocation a 7-second cap; these are harness safeguards, not performance scoring targets. Verify jobs in this kit are short local Node commands.

Run the grader **inside the candidate's isolated, no-network execution environment**, with this kit mounted read-only outside the model-visible workspace. The grader invokes generated candidate code; running it directly on a credential-bearing host is not a sandbox. Paths in the commands above must be paths available inside that environment. Fixture Git commands ignore inherited repository/configuration overrides, but isolation remains the outer runner's responsibility.

The public and held-out tests use different examples of the **same written contracts**. Symlinks are explicitly skipped during content capture, names have an explicit grammar, all JSON fields and digest bytes are specified, and no unstated invalid-input policy is a hidden correctness condition.

## Evidence and review rubric

Record source revision, exact starter hash per stage, task text, model/settings, public and external test results, accepted completion, actual elapsed time, actions, generated tokens and measured prompt processing/cache reuse. Do not infer cache misses from total input tokens. Preserve failed runs and refusals.

Review in this order:

1. **Correctness:** public tests and cumulative external contracts both pass. A passing command that overwrites snapshots, treats a failed verifier as passed, or presents changed-during-run proof as current is not successful.
2. **Scope/integrity:** supplied tests/package remain unchanged, changes stay in the candidate workspace, no grader access, no test-specific hardcoding, no network/dependency additions.
3. **Usability:** useful human status, actionable errors, uncomplicated command help/documentation, comprehensible code. These are qualitative judgments unless stated in a card's contract.
4. **Efficiency:** time/tokens/actions after correctness. Do not rank a fast failure above a correct result or claim statistical equivalence from one task chain.

These are practical, bounded building tasks, not an exhaustive Git implementation or a hostile-filesystem security benchmark. Large files, concurrent writes, atomic crash recovery, repository submodules, arbitrary filename encodings, Windows portability and command timeouts are out of scope. Ordinary regular files, ASCII filenames including spaces, relative/nested paths and Linux/macOS-style symlinks are in scope.

## Layout

- `cards/`: cumulative specifications; later cards retain earlier requirements except explicit additions.
- `starter/`: package configuration and public card-1 tests, no solution.
- `stage-tests/`: public tests to add for cards 2 and 3.
- `grader/`: independent examples, outside candidate workspaces.
- `grader.mjs`: cumulative external test launcher.
