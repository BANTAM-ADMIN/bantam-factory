# arena — the TB2 harness tooling, version-controlled

These files RUN from `../TB2_ARENA/`, which sits outside this repo alongside the
task images, job artifacts and multi-GB tarballs that must not be committed.
That left every one of them untracked: the adapter, the sequencer, and five
gauges built on 2026-08-21, each encoding a defect that cost real runs to find.
This directory is the versioned copy.

**Edit `../TB2_ARENA/<file>` (that is what executes), then copy the change here.**

| file | what it is | the defect it encodes |
|---|---|---|
| `bantam_agent.py` | harbor adapter: installs bantam into the task container | keeps the IMAGE's python when it has one (the unconditional symlink overwrote `/usr/local/bin/python3` in 36 of 79 images); pip wrapper that links console scripts onto PATH (`pytest: command not found` broke the GRADER) |
| `sequencer.sh` | THE single controller, one task at a time | auto-resumes a run the clock cut; `@resume` stages that task's OWN most-complete artifact, not whatever was lying in `resume-run.json` |
| `controls.sh` | re-runs already-PASSING tasks | `sequencer.sh` skips them by design; a regression check must not |
| `preflight.py` | runs each task's real `test.sh` with no agent work | a written verdict is the discriminator — `ModuleNotFoundError` for the thing the agent was meant to install is a HEALTHY grader; pulls the image off the clock, or it invents defects |
| `redscan.py` | classifies every red | ATTEMPTED vs OUT-OF-BUDGET vs NO-START vs GATE-STOPPED. A reward of 0 is not a verdict; `largest-eigenval` sat in the red list as a clock kill |
| `watchdog.py` | live supervision, 45s cadence | reads memory from the HOST before shelling in, because a container at its ceiling cannot spawn a shell — the check used to sit behind that hang |
| `pack-head.sh` | packs `bantam.tgz` from a clean HEAD | REFUSES a tgz whose `agent.js` cannot import. An ad-hoc `tar czf` once shipped a tree importing two files HEAD did not contain; every container died at launch and two tasks were recorded as failures having never run |
| `pack-python.sh` | rebuilds the portable python | verifies imports AND relocation into a fresh container before replacing the artifact |
| `restart-llama-8085.sh` | restarts llama-server | certified `--ctx-checkpoints 32 --batch-size 8192 --parallel 1`; every argument shell-quoted, because an unquoted `--chat-template-kwargs {...}` is mangled before the server sees it |
| `integrity.py` | audits every PASSING run for downloaded answers | network is ON by default (pip/apt/HF need it), so a reimplement-from-scratch task could in principle be passed by fetching a published reference — regex-chess is Carlini's and public. A gauge, not a block: blocking network breaks legitimate installs. First run: 31 clean, 0 suspect |

The recurring lesson, five times over in one day: **a gauge fails in exactly the
condition it exists to detect.** Each fix is recorded in its own file's header.
See `docs/PREFIX-CACHE-IS-A-DELIBERATE-TRADE.md` for the throughput decision.
