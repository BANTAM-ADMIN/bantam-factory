# Card 1 — a trustworthy Git handoff status

Build **RepoBrief**, a local command-line tool that tells a teammate exactly what is in a Git working tree. Implement `bin/repobrief.js`; additional application modules and a short README are welcome. Use Node 20+ ESM and built-in modules only, with Git as the installed external executable. Do not change the supplied package configuration or tests, add dependencies, or use the network.

Invocation:

```text
node bin/repobrief.js status [--repo PATH] [--json]
```

`--repo` defaults to the caller's current directory. Resolve any directory inside a repository to its Git working-tree root, including nested directories and paths containing spaces. Invoke Git without constructing a shell command string. A non-repository directory must exit 1, write a useful nonempty error to stderr, and not print successful JSON. The CLI must not modify the repository.

With `--json`, stdout is exactly one parseable JSON object (a trailing newline is fine):

```json
{
  "root": "/absolute/real/repository/root",
  "branch": "main",
  "head": "full-current-commit-hash",
  "changes": [{ "path": "src/file with spaces.js", "index": "M", "worktree": " " }]
}
```

Requirements:

- `root` is the absolute real path of the Git root, not the supplied nested directory.
- `branch` is the current short branch name, or `null` for detached HEAD. An unborn repository still reports its branch name.
- `head` is the full HEAD commit hash, or `null` when no commit exists yet.
- `changes` reports Git porcelain status entries, including staged, unstaged and nonignored untracked files. The `index` and `worktree` strings are the two single-character porcelain status columns, preserving spaces. Untracked files use `"?"` for both.
- Paths are root-relative, slash-separated, unquoted, and preserve spaces. Ask Git to enumerate untracked files individually, not collapse a directory to one entry. Sort changes by `path` using normal JavaScript string ordering.
- For a rename, report one change at its **destination** path; do not emit the original path as another change. The status columns still come from Git.
- Ignored untracked files are absent. Tracked files are still reported even if a later ignore rule matches them.
- A clean working tree has an empty `changes` array.
- Without `--json`, print a readable summary containing the branch (or a clear detached/unborn description) and each changed path. Exact prose is not prescribed.

Keep this compact; no GUI, daemon, patch rendering or Git mutation commands. Run the supplied tests before finishing and report what actually passed.
