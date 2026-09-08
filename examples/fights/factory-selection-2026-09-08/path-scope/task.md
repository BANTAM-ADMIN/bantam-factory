# Extend a workspace containment guard

`path-scope.js` already exports a working `normalizeSegments(input)`. Keep its
exported behavior exactly as it is, and add `resolveWithin(root, candidate)`
plus a CLI, both as ES module exports. This is a lexical decision over POSIX
path strings only. It never touches the filesystem, resolves no symlinks, and
is not a security boundary on its own.

`root` and `candidate` must be nonempty strings containing no NUL, and `root`
must start with `/`. Validate both before resolving anything.

Resolve `candidate` against `root`: a candidate starting with `/` resolves from
the filesystem root, otherwise it resolves inside `root`. Normalize the result
by dropping empty segments and `.` segments, and by removing the previous
segment for each `..`. A `..` with nothing left to remove is discarded, so a
path can never climb above `/`. `\` is an ordinary character, never a
separator, and segments such as `..foo`, `...` and `.hidden` are ordinary names.

`candidate` is inside `root` when the normalized root segments are a complete
leading run of the normalized candidate segments. Sharing a textual prefix is
not enough: with root `/a/b`, the candidate `/a/bc` is outside.

Return exactly `{inside, resolved, relative}`. `resolved` is the normalized
absolute path, always starting with `/` and never ending with `/` unless it is
exactly `/`. `relative` is the path from `root` to the candidate when inside,
`''` when they are the same location, and `null` when outside. Do not mutate
your inputs. Invalid inputs throw an Error.

Example: root `/srv/ws`, candidate `../ws/sub/../file.txt` returns
`{inside:true, resolved:'/srv/ws/file.txt', relative:'file.txt'}`, while
candidate `/srv/wsx` returns `{inside:false, resolved:'/srv/wsx', relative:null}`.

CLI: `node path-scope.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{root,candidate}`; extra fields are
ignored. Success prints exactly the API result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
