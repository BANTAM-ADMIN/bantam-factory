# Repair a retry-budget controller

Repair the exported ES-module function `nextRetry(options)` and implement its
CLI in retry-budget.js. The pure function decides when a worker can retry
after a failure; it must not sleep, read the clock, or make network requests.

Options must be a non-null, non-array object with all these required fields:
`attempt` is a positive safe integer (1 means the first retry after failure);
`elapsedMs`, `baseMs`, `maxDelayMs`, and `budgetMs` are nonnegative safe integers;
`retryAfterMs` is null or a nonnegative safe integer; `retryable` is a boolean.
Extra fields are ignored. Validate every field even if retryable is false.
Invalid input throws an Error. Do not mutate input; frozen objects must work.

If retryable is false, return exactly
`{retry:false,delayMs:null,reason:'non-retryable'}`.
Otherwise compute exponential delay `baseMs * 2 ** (attempt - 1)`, capped at
maxDelayMs. This must work for every valid safe-integer attempt, including huge
attempts, without loops proportional to attempt or overflow bugs. A zero base
means zero exponential delay even for a huge attempt.

If retryAfterMs is not null, it is a minimum server-requested wait: take the
maximum of the capped exponential delay and retryAfterMs. The server hint is
NOT capped by maxDelayMs. If elapsedMs already exceeds budgetMs, or the wait
exceeds `budgetMs - elapsedMs`, return exactly
`{retry:false,delayMs:null,reason:'budget-exhausted'}`. Equality is allowed:
scheduling the retry exactly at the budget boundary is valid for this API.
Otherwise return exactly `{retry:true,delayMs:WAIT,reason:'scheduled'}`.

CLI: `node retry-budget.js INPUT_JSON_FILE`. Require exactly one argument.
The JSON value is the options object. Success prints exactly the API result
as one JSON value followed by newline, exits 0, and has no stderr. A valid
decision not to retry is still success. Invalid arguments/files/JSON/API input
exit 2 with nonempty stderr and no stdout. Importing must not run the CLI.

Do not add dependencies or change package.json or existing public tests. You
may add tests. Verification uses a read-only workspace: temporary fixtures go
in os.tmpdir() and must be cleaned up. Run npm test before finishing.
Independent checks vary values, not this public contract.
