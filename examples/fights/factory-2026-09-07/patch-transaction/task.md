# Patch transaction: extend the fixed edit helper

The supplied module already exports working synchronous `applyEdit(source,
edit)`. Preserve it. Add synchronous `applyTransaction(source, edits)` plus a
CLI. Node.js builtins only. This is a pure string-edit planner: do not modify
files or execute a patch as code. It can later support a factory's guarded
editing workflow, but this assignment is not a production integration.

`source` must be a string. An edit is a non-null, non-array object:

```
{start: NONNEGATIVE_SAFE_INTEGER, end: NONNEGATIVE_SAFE_INTEGER,
 before: STRING, after: STRING}
```

Offsets are JavaScript UTF-16 string indexes, exactly as used by `slice`, not
UTF-8 byte positions or line numbers. Require `0 <= start <= end <=
source.length` and `source.slice(start,end) === before`. Unknown object fields
are ignored; do not coerce values. Invalid arguments or mismatched preimages
throw an Error. The existing `applyEdit` returns the edited string:

```
source.slice(0,start) + after + source.slice(end)
```

`applyTransaction` accepts an array of edits, possibly empty. Validate every
edit against the original source before applying anything. Every edit uses
original-source coordinates, not coordinates shifted by earlier replacements.
Do not mutate the input array or objects. Reject conflicts as follows:

- Two nonempty ranges conflict if their half-open intervals overlap. Adjacent
  nonempty ranges are allowed, e.g. [0,2) and [2,4).
- An insertion has `start === end` and therefore `before === ''`. It conflicts
  with another insertion at the same position, even if either inserts ''.
- An insertion conflicts with a nonempty range if its position is anywhere
  between that range's start and end, including either endpoint. Insertions
  at distinct positions outside all edited ranges are allowed.

These rules deliberately reject ambiguous insertion/replacement boundaries.
On a conflict, throw an Error; do not return partial output. Otherwise apply
all edits simultaneously and return exactly:

```
{text: RESULT_STRING, applied: NUMBER_OF_EDITS}
```

The result is independent of the order of edits in the input. Preserve all
untouched code units, CR/LF sequences, whitespace and final-newline presence.
An empty transaction returns `{text: source, applied: 0}` but still validates
that source is a string. Empty source permits one insertion at position zero.
No-op edits are valid and count toward `applied` subject to the same rules.

CLI: `node patch-transaction.js INPUT_JSON_FILE`. The UTF-8 JSON file contains
`{source, edits}`; extra fields are ignored. Exactly one argument is required.
Success prints one result JSON followed by newline, exits 0 and has no stderr.
Invalid arguments, unreadable files, invalid JSON or invalid transactions exit
2, with nonempty stderr and no stdout. Importing must not run the CLI.

Do not add dependencies or edit `package.json` or existing public tests. You
may add tests. Verification uses a read-only candidate workspace: put any
fixture files in `os.tmpdir()` and clean them up. Run `npm test` before
finishing. Hidden acceptance tests the published contract with other values.
