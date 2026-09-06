# Receipt reducer: build a small run-log report tool

Implement `receipt-report.js` using Node.js builtins only. Export the synchronous
function `reduceEvents(text)` and support `node receipt-report.js LOGFILE`.

The input is a UTF-8 JSONL string. Ignore whitespace-only lines; CRLF and a
missing final newline are allowed. Each nonblank line must parse as a non-null
non-array object with these fields:

- `id` and `job`: nonempty strings (preserve their characters; do not trim).
- `attempt`: a positive safe integer, starting at 1; gaps are allowed.
- `seq`: a nonnegative safe integer.
- `type`: exactly `started`, `succeeded`, or `failed`.

Other fields are ignored, including for duplicate comparison. Reject invalid
JSON or any invalid required field with an Error. Do not coerce types.

Events may arrive in any order. Deduplicate by `id` before reducing. Repeated
IDs with identical five required fields are ignored and counted in `duplicates`
(every extra copy counts). A repeated ID with any different required field is
an error. Different events may share `seq`. For each `(job, attempt)` there must
be exactly one `started` event and at most one terminal (`succeeded` or `failed`)
event. A terminal's `seq` must be strictly greater than its start's `seq`.
Orphan terminals, repeated starts with different IDs, repeated terminals with
different IDs, and contradictory terminals are errors. Different attempts are
independent; their sequence ranges may overlap.

Return exactly:

```
{
  jobs: [{job, attempts: [{attempt, status, startedSeq, finishedSeq}]}],
  duplicates: NUMBER
}
```

Jobs are sorted by JavaScript string `<`/`>` order (UTF-16 code units, not locale
collation); attempts are sorted numerically. Status is `running` for start-only
attempts, otherwise the terminal type. `finishedSeq` is null for running
attempts. Empty input returns `{jobs: [], duplicates: 0}`. IDs such as
`__proto__` and jobs containing whitespace or Unicode are ordinary strings.

The CLI takes exactly one file argument, prints only the report as JSON followed
by a newline on stdout, and exits 0 on success. Invalid arguments, unreadable
input, or invalid events produce a nonempty stderr message, no stdout, and exit
2. Importing the module must not run the CLI. Do not add third-party dependencies
or modify `package.json` or existing public tests. You may add tests. Run
`npm test` before finishing. The same starter and contract go to every arm;
independent acceptance is separate from your tests.
