Implement changed-paths.js, a small reusable building block for selecting source
files for coding-agent context from Git's machine-readable change stream.

Export parseNameStatusZ(text), accepting a UTF-8 string containing the output of
`git diff --name-status -z -M -C`. Return records in input order, each exactly
{ status, source, path }. Preserve the complete status token. For A, M, D, T,
and U, source is null. For scored renames and copies (R/C followed by one to three
decimal digits with numeric value 0..100; zero padding is allowed), source
is the original path and path is the destination. Preserve all path characters,
including spaces, tabs, newlines, Unicode, quotes, and backslashes. Empty input
returns []. Reject unknown/malformed status tokens, incomplete records, empty
paths, and a missing final NUL with an Error. This is a NUL-delimited parser, not
a parser of Git's human-readable output. Scored M rewrites, combined-merge
formats, and unknown X statuses are outside this deliberately bounded contract
and must be rejected. No third-party dependencies.

Before final verification, demonstrate the parser against a real Git-generated
rename record with a tab or newline in a path. Investigate uncertain conventions
using an isolated experiment. If the fixture-backed probe action is available,
use it; otherwise use shell with disposable fixtures. Your witness must fail
when the intended rename record is absent, and your behavior check must compare
the parsed destination to the expected path. Keep this evidence separate from
the final test suite. Do not modify package.json or existing tests. You may add
tests. Run npm test before finishing.
