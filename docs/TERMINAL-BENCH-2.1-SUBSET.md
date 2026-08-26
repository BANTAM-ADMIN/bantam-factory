# Terminal-Bench 2.1 curated subset

Status: **authoritative project scope**  
Last verified: **2026-08-20**

## Scope declaration

This project runs Terminal-Bench 2.1 only through the curated local catalog at
`./terminal-bench`. The catalog contains exactly **79 task directories**. Those
79 tasks constitute the entire benchmark for BANTAM development, regression
testing, scorekeeping, and completion claims in this repository.

The local catalog is intentionally smaller than other copies or historical
versions of the benchmark. An absent task is deliberately out of scope; it is
not a missing dependency, an unfinished failure, or a task to recover.

## Operating rules

1. Select tasks only from directories currently present under
   `./terminal-bench`.
2. Launch Arena/Harbor jobs with the local catalog path. Do not use a remote
   full-dataset selector for BANTAM's Terminal-Bench 2.1 work.
3. Use **79** as the denominator for full-subset reports. Label results
   “Terminal-Bench 2.1 curated 79-task subset,” not as results for a larger
   upstream corpus.
4. Do not restore, reconstruct, diagnose, grade, or create backlog entries for
   excluded tasks.
5. Do not use old job metadata, caches, Git history, or previous conversation
   transcripts to expand the current task list. They are historical evidence,
   not benchmark selection authority.
6. A failure is in scope only when its task directory exists in the current
   local catalog.

## Source-of-truth order

When sources disagree, use this order:

1. the task directories currently present in `./terminal-bench`;
2. current Arena launchers that point at that local directory;
3. this scope document and [the project instructions](../CLAUDE.md);
4. historical reports, job artifacts, caches, and conversation records.

The fourth category must never override the first.

## Verification

From the repository root:

```bash
count=$(find terminal-bench -mindepth 1 -maxdepth 1 -type d | wc -l)
test "$count" -eq 79
find terminal-bench -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
```

The first command is the scope gauge. The second prints the exact eligible set
without consulting an external registry or historical artifact.

## Change control

Changing the subset is an explicit benchmark-policy decision. If the local
catalog is intentionally changed, update the catalog, the expected count in
this document and `CLAUDE.md`, all local Arena launchers, and any score
denominators together. A remote refresh or recovered historical artifact must
not change scope implicitly.


## Launching one task: use the jig, not harbor directly

`tools/tb2/run-task.sh` is a reference copy of the launcher; the authoritative
copy lives beside the harness in `TB2_ARENA/`. Use it rather than calling
`harbor run` by hand, because two traps fired within minutes of doing that on
2026-08-22:

**`-t` is accepted and ignored.** harbor's `--task/-t` selects a task from a
*registry* (`org/name`). With a local `-p <dataset path>` it silently does
nothing — and the run becomes a full 79-task sweep. It had started
`gpt2-codegolf` and created four task directories before anyone noticed. The
correct filter for a local dataset is `-i/--include-task-name`. The jig only
ever emits `-i`, adds `-l 1` as an independent second limit, and **refuses a
bare `-t`** with an explanation.

**`bantam.tgz` is a snapshot, not the repo.** It was 18 hours stale, so the run
would have measured the previous day's code and reported it as current. That
exact gap once recorded `reshard-c4-data` and `raman-fitting` as task failures
for runs that never existed. The jig compares the tarball's mtime against the
HEAD commit time and repacks with the load-checked `pack-head.sh` when it is
behind.

The gate that actually caught the first trap is the one worth keeping: after
launching, **verify the created job directory matches the task you asked for**,
and kill the run if it does not. A run that starts the wrong task is worse than
one that fails to start, because it looks like it is working.

Other gates: the task must exist in the local catalog (near-misses are named), no
other controller may be running, the model server must be reachable **and not
asleep** (`/props is_sleeping` — `/health` answers either way), and the model
lock must be free so a benchmark cannot restart the server under an interactive
session.

One scripting note, learned the hard way inside the jig itself: `pgrep` exits 1
when nothing matches, so under `set -euo pipefail` a probe like
`RUNNING=$(pgrep -f ... | wc -l)` aborts the script silently **in the case where
everything is fine**. Every probe in the jig is wrapped with `|| true`.


## First run through the jig — 2026-08-22

Seven tasks that had never been attempted, run one at a time through
`run-task.sh` on the tuned stack (llama.cpp `build3`/`b21e4de74`, solo profile,
`ubatch 3072`). **Six passed; the seventh timed out.**

| task | difficulty | turns | reuse | wall | gen tok/s | result |
|---|---|---|---|---|---|---|
| `log-summary-date-ranges` | medium | 8 | 90% | 23 s | 93 | **1.0** (2/2) |
| `fix-git` | easy | 13 | 92% | 27 s | 96 | **1.0** |
| `openssl-selfsigned-cert` | medium | 13 | 88% | 70 s | 93 | **1.0** |
| `nginx-request-logging` | medium | 16 | 89% | 111 s | 91 | **1.0** (8/8) |
| `db-wal-recovery` | medium | 22 | 93% | 210 s | 82 | **1.0** |
| `largest-eigenval` | medium | 54 | 95% | 455 s | 75 | **1.0** |
| `write-compressor` | hard | 48 | 81% | 1764 s | 63 | 0.0 — `AgentTimeoutError` at 1800 s |

**Read this as a health check, not a score.** Seven of 79, chosen for being
well-formed and self-contained, and skewed easy/medium. The catalog also holds
`install-windows-3.11`, `make-doom-for-mips` and `regex-chess` (3600 s budget),
which this set says nothing about.

What it does establish:

- **Prefix reuse holds as runs get longer.** 95% on the 54-turn `largest-eigenval`
  — the depth at which reuse used to collapse. Mean 90% across the set, against
  37% on a pre-tuning artifact.
- **Prefill is no longer the choke.** ~17% of wall clock on the passes; the model
  spends its time generating.
- **The one miss was time, not breakage.** A clean `AgentTimeoutError`, not a
  harness fault — the adapter's 6000 s exec ceiling never bound, so the
  two-timeout confusion recorded elsewhere did not recur. Profiling it shows
  **85% of the 1764 s was generation** (1495 s) against 242 s of prefill and 5.8 s
  of harness: it was writing an 8.5 KB range coder for the whole budget, with one
  `debug.py` rather than the `dbg1..dbg22` churn the script-churn gate exists to
  catch. If that task is wanted, the lever is `--multiplier`, not code.
