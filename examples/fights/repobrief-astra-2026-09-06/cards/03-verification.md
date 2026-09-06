# Card 3 — verification receipts that cannot become silently stale

Extend RepoBrief from cards 1 and 2. Keep all prior commands working; do not modify supplied tests/package configuration, add dependencies or use the network.

Add:

```text
node bin/repobrief.js verify --label LABEL [--repo PATH] -- COMMAND ARG...
node bin/repobrief.js receipts [--repo PATH] [--json]
```

The first `--` ends RepoBrief option parsing. Execute the following executable and argument array **directly, without a shell**, with cwd set to the repository root (even when `--repo` names a nested directory). Preserve argument boundaries and literal characters such as spaces, `$()`, `;` and `*`. Only short local commands are required; timeouts, interactive commands and output streaming are out of scope.

Immediately before and after the child process, calculate the same content tree digest defined in card 2. Metadata in `.repobrief` never affects either digest. Capture the child's UTF-8 stdout and stderr, forward them to the corresponding CLI streams, and persist a receipt at `.repobrief/receipts.json`. Its durable shape is `{receipts: [...]}`. Each receipt contains:

```json
{
  "id": 1,
  "label": "unit tests",
  "argv": ["node", "--test"],
  "exitCode": 0,
  "stdout": "test output\n",
  "stderr": "",
  "passed": true,
  "treeDigestBefore": "64-lowercase-hex-characters",
  "treeDigestAfter": "64-lowercase-hex-characters"
}
```

- IDs are positive integers starting at 1 and increasing by one per receipt in the repository. Repeated labels are allowed; they must not overwrite history.
- `passed` is exactly `exitCode === 0`. It describes command execution, **not** whether the result is current.
- Preserve failed runs as well as successful ones. For an executable that cannot be started, record exit code 1 and a nonempty stderr error. A child terminated by signal also maps to exit code 1. The `verify` CLI exits with the recorded code.
- A missing/empty label or an omitted executable argument after `--` is a usage error: exit 1 with nonempty stderr and do not add a receipt. This differs from supplying an executable name that cannot be started, which does create the failed receipt described above.
- `verify` stdout/stderr contain only the forwarded child output (or spawn error), not an extra JSON summary. Inspect the receipt with `receipts`.

`receipts --json` returns `{receipts: [...]}` in ascending ID order, adding a computed boolean `current` to every stored receipt. It is true exactly when:

```text
treeDigestBefore === treeDigestAfter === the current content tree digest
```

Thus an exit-0 command that changed source is `passed: true` but `current: false`, immediately and forever for that receipt. A source edit after a stable run makes its receipt stale; restoring precisely those bytes makes it current again. Ignore-only files, symlinks, metadata and mtime-only changes are governed by card 2's capture rules. A stable failed command may be `current: true` while `passed: false`.

Before any verification, `receipts --json` returns `{"receipts": []}` without error. Fresh CLI processes must read previous receipts from disk. Without `--json`, show each label with its passed/failed and current/stale state; exact formatting is free.

This is the useful handoff: a teammate can distinguish “tests once passed,” “tests passed for these exact bytes,” and “the verifier itself changed the tree.” Demonstrate that distinction with the supplied tests before finishing.
