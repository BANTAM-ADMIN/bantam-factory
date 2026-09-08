# Build a glob path selector with decision receipts

Implement `selectPaths(paths, patterns)` in `glob-select.js`, exported as an
ES module, and its CLI. This is a deterministic path filter. Patterns are glob
syntax, never regular expressions.

`paths` must be a dense array of unique nonempty strings. Each path is relative
and POSIX-style: `/` separates segments, and no path may start or end with `/`,
contain an empty segment, contain a `.` or `..` segment, or contain a NUL.
`patterns` must be a dense array of nonempty strings. Validate everything before
matching, even when either array is empty.

A pattern whose first character is `!` is a negation; the `!` is removed and the
rest is the pattern body, which must be nonempty. Match each path against every
pattern in order. The LAST pattern that matches decides: a negation excludes the
path, any other match includes it. A path no pattern matches is excluded.

Glob syntax, applied per segment:

- `?` matches exactly one character.
- `*` matches zero or more characters within one segment. Consecutive `*` in a
  segment that is not exactly `**` behave as a single `*`.
- A segment that is exactly `**` matches zero or more whole segments, so
  `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`.
- `[...]` matches exactly one character. A leading `!` or `^` after `[` negates
  the class. A `]` in the first position is literal. `a-z` is a range. A `-`
  first or last is literal. An unclosed `[` is an error.
- `\` escapes the next character so it is literal. Only `\ * ? [ ] ! -` may be
  escaped; any other escape, or a trailing lone `\`, is an error. `/` is
  structural and can never be escaped.

Return exactly `{selected, decisions}`. `decisions` has one entry per input
path, in input order, exactly `{path, included, pattern}`, where `pattern` is
the zero-based index of the deciding pattern or `-1` when none matched.
`selected` lists the included paths in input order. Do not mutate either input;
frozen inputs must work. Invalid inputs throw an Error.

Example: paths `['a.js','b.js','x/c.js']`, patterns `['**/*.js','!b.js']`
selects `['a.js','x/c.js']` with decisions
`[{path:'a.js',included:true,pattern:0},{path:'b.js',included:false,pattern:1},
{path:'x/c.js',included:true,pattern:0}]`.

CLI: `node glob-select.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{paths,patterns}`; extra fields are
ignored. Success prints exactly the API result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
