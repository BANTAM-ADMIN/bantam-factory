# Card 2 — named, content-based handoff snapshots

Extend the existing RepoBrief from card 1. Preserve all previous behavior. Do not modify supplied tests/package configuration, add dependencies or use the network.

Add:

```text
node bin/repobrief.js snapshot --name NAME [--repo PATH]
node bin/repobrief.js diff --name NAME [--repo PATH] [--json]
```

`--repo` has the same default/root-resolution behavior as `status`. A valid name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; missing, invalid and already-used snapshot names exit 1 with a useful stderr error. **Never overwrite an existing snapshot**, even if the current content is identical. A diff against an unknown snapshot also exits 1.

Define the captured working tree precisely:

- Enumerate Git-tracked paths plus nonignored untracked files, individually. Include tracked files even when a later ignore rule matches them.
- Capture the current **working-tree bytes**, not the index or HEAD. A tracked path missing from disk is absent from the capture.
- Include regular files only. **Skip symbolic links without following them**, both file links and directory links. Empty files are included.
- Exclude `.git` and `.repobrief` themselves and everything beneath either, whether tracked or untracked. From this card onward, `status.changes` must also exclude `.repobrief` metadata.
- Honor Git's ignore rules for untracked files. Do not invent a separate hardcoded ignore list for application files.

For each captured path, calculate its lowercase SHA-256 hex digest. `files` is a JSON object mapping each relative path to that digest. Let `paths = Object.keys(files).sort()`. The exact tree digest is SHA-256 over UTF-8 bytes of:

```js
paths.map(p => p + '\0' + files[p] + '\n').join('')
```

The digest depends on paths and content, not mtimes, staging state or directory enumeration order.

Store each snapshot durably at `.repobrief/snapshots/NAME.json` as `{name, treeDigest, files}`. Create metadata directories as necessary. A successful `snapshot` prints that same parseable JSON shape on stdout and exits 0. Do not modify any application files to create a snapshot.

`diff --json` returns:

```json
{ "name": "handoff", "added": ["new.txt"], "modified": ["changed.txt"], "deleted": ["gone.txt"], "current": false }
```

Compare against the named snapshot: added/deleted are path presence differences, modified means the same path has different content hashes. All three arrays are sorted by normal JavaScript string ordering. `current` is true exactly when all arrays are empty. Touching a file or rewriting identical bytes does not count as modification; changing bytes with the old mtime restored does. Without `--json`, give a readable added/modified/deleted summary; exact prose is not prescribed.

Keep the implementation local and straightforward. Large files, concurrent mutation and crash-atomic storage are not part of this card. Test snapshot persistence, ignore/symlink behavior, safe names and actual content changes before finishing.
