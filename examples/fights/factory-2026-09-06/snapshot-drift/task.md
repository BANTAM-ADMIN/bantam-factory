# Snapshot drift: extend the supplied selected-file manifest tool

The supplied `snapshot.js` already exports synchronous `createManifest(root,
paths)`. Keep that behavior and add synchronous `verifyManifest(root, manifest)`
plus a CLI. Node.js builtins only. This is a bounded local file checker, not a
concurrent-filesystem or hostile-workload security claim.

`root` must name an existing directory and must not itself be a symlink. A
selected path is a nonempty canonical relative POSIX-style path: reject `/`
prefixes, backslashes, NUL, empty segments, `.` and `..` segments. Spaces, tabs,
newlines and Unicode are valid filename characters. Every component beneath
root must be non-symlink; intermediate components must be directories and the
final component must be a regular file. Do not follow symlinks even if they
point inside root. The checker must not modify selected files.

`createManifest(root, paths)` accepts an array of unique selected paths (empty
is allowed) and returns exactly:

```
{version: 1, files: [{path, sha256, size, mode}]}
```

Entries use JavaScript `<`/`>` string ordering, not locale ordering. SHA-256 is
64 lowercase hexadecimal characters over exact file bytes; size is byte count;
mode is the numeric permission bits `stat.mode & 0o777`. Missing, unsafe, or
invalid selections throw an Error. Preserve this existing behavior.

`verifyManifest(root, manifest)` first validates the complete manifest. It must
be a non-null non-array object with `version` exactly 1 and `files` an array.
Each entry must be a non-null non-array object, with a unique valid selected
path, a 64-character lowercase hexadecimal `sha256`, nonnegative safe-integer
`size`, and integer `mode` in 0..511. Unknown object fields are ignored.
Manifest entries need not arrive sorted. Neither API may mutate its input
arrays or objects. Invalid manifests or roots throw an
Error; do not partially report them as drift.

Return exactly:

```
{
  ok: BOOLEAN,
  unchanged: [PATH],
  changed: [{path: PATH, reasons: ['content', 'mode']}],
  missing: [PATH],
  unsafe: [PATH]
}
```

Each selected entry appears in exactly one array. If any path component is
missing, classify `missing`. If an existing component is a symlink, an
intermediate component is not a directory, or the final component is not a
regular file, classify `unsafe` (stop at that component; do not follow it).
Otherwise compare the current regular file: a different SHA-256 OR byte size
adds reason `content`; different permission bits add `mode`. Reasons contain
only the differences, always in the order `content`, then `mode`. No differences
means `unchanged`. Each array is sorted by path using JavaScript string order.
`ok` is true exactly when changed, missing, and unsafe are all empty. Unselected
files are irrelevant. Other filesystem failures (such as permission errors)
throw an Error; no concurrent filesystem mutation is tested.

CLI:

- `node snapshot.js create ROOT [PATH ...]` prints the manifest JSON and exits 0.
- `node snapshot.js verify ROOT MANIFEST_FILE` reads UTF-8 JSON, prints the
  drift report, and exits 0 for `ok: true`, 1 for drift.
- Invalid arguments, invalid JSON/manifest/root/selection, unreadable input,
  and other errors exit 2, with a nonempty stderr message and no stdout.

Successful reports are one JSON value followed by newline, with no other
stdout and no stderr. Importing the module must not run the CLI. Do not add
third-party dependencies or modify `package.json` or existing public tests.
You may add tests. Run `npm test` before finishing. All arms receive the same
fixed starter; hidden acceptance adds values, not hidden requirements.
