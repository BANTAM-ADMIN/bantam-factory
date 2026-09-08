# Repair a semantic-version precedence and range checker

Repair the exported ES-module functions `compareVersions(a, b)` and
`satisfies(version, range)` in `semver-range.js`, and implement its CLI. These
are pure string comparisons: no clock, no network, no filesystem.

A version is `MAJOR.MINOR.PATCH`, each a nonnegative integer with no leading
zero, optionally followed by `-PRERELEASE` and/or `+BUILD`. Both PRERELEASE and
BUILD are dot-separated nonempty identifiers of ASCII alphanumerics and `-`.
A purely numeric prerelease identifier must not have a leading zero. Anything
else throws an Error.

`compareVersions` returns `-1`, `0` or `1` by precedence:

- Compare major, then minor, then patch numerically.
- Build metadata is ignored entirely, so `1.0.0+a` and `1.0.0+b` are equal.
- A version WITH a prerelease has LOWER precedence than the same version
  without one, so `1.0.0-rc` is below `1.0.0`.
- Otherwise compare prerelease identifiers left to right. Two numeric
  identifiers compare numerically, so `9` is below `10`. Two non-numeric
  identifiers compare by ASCII order. A numeric identifier is always below a
  non-numeric one. If every shared identifier is equal, the shorter list has
  LOWER precedence, so `1.0.0-a` is below `1.0.0-a.1`.

`satisfies` returns a boolean. A range is one or more clauses separated by
`||`; the range holds when any clause holds. A clause is one or more
whitespace-separated comparators that must ALL hold. A comparator is an
optional operator `=`, `<`, `<=`, `>` or `>=` (default `=`) followed by a
version. Comparators use the same precedence rules.

A version WITH a prerelease satisfies a clause only when the clause also
contains at least one comparator whose version has a prerelease and the same
major, minor and patch. So `1.2.3-rc.1` does not satisfy `>=1.0.0 <2.0.0`, but
it does satisfy `>=1.2.3-rc.0 <2.0.0`. Versions without a prerelease are
unaffected by this rule.

Do not mutate inputs; frozen inputs must work. Invalid versions or ranges throw
an Error.

CLI: `node semver-range.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{versions,range}` where `versions` is
a dense array of version strings and `range` is a range string; extra fields are
ignored. Print exactly `{sorted,satisfying}` as one JSON value followed by
newline, exit 0, and write no stderr. `sorted` lists every input version in
ascending precedence, keeping input order among equals; `satisfying` lists those
that satisfy the range, in the same order as `sorted`. Validate `range` on every
invocation, including when `versions` is empty and no version is ever tested
against it. Invalid arguments/files/JSON/API input exit 2, with nonempty stderr
and no stdout.
Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
