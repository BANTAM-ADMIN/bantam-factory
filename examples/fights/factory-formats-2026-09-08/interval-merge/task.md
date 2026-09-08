# Build a half-open interval coalescer with coverage accounting

Implement `mergeIntervals(intervals)` in `interval-merge.js`, exported as an ES
module, and its CLI. This is deterministic arithmetic over half-open integer
ranges. It performs no floating-point work.

`intervals` must be a dense array of non-null, non-array objects, each with a
safe-integer `start` and a safe-integer `end` where `start < end`. An interval
with `start === end` is empty and is invalid, not skipped. Extra fields are
ignored. Validate every interval before merging any, even when the array is
empty. Negative bounds are ordinary values.

Ranges are half-open: `[start, end)` contains `start` and excludes `end`. Two
ranges overlap when one contains a value of the other. Two ranges merely touch
when one ends exactly where the next begins; touching ranges merge into one,
because the result must be the smallest set of ranges covering the same values.

Return exactly `{merged, covered, dropped}`. `merged` is the coalesced ranges
as `{start,end}` objects sorted by ascending `start`, each disjoint from and
not touching the next. `covered` is the total number of integer values covered,
computed so a span wider than a 32-bit integer is still exact. `dropped` is the
number of input intervals that did not survive as their own output range,
meaning the input length minus the merged length. Do not mutate the input;
frozen inputs and frozen intervals must work. Invalid inputs throw an Error.

Example: intervals `[{start:5,end:7},{start:1,end:3},{start:3,end:4}]` returns
`{merged:[{start:1,end:4},{start:5,end:7}], covered:5, dropped:1}`.

CLI: `node interval-merge.js INPUT_JSON_FILE`. Require exactly one file
argument. The JSON is a non-null, non-array object `{intervals}`; extra fields
are ignored. Success prints exactly the API result as one JSON value followed
by newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API
input exit 2, with nonempty stderr and no stdout. Importing the module must not
run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
