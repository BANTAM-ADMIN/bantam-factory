#!/usr/bin/env python3
"""budget-audit — is this task failing on CONTEXT, or on the CLOCK?

Every failure in this sweep has been worth chasing as a context defect, and
nearly every one turned out to be one. This gauge exists for the exception.

A task declares `expert_time_estimate_min` (what its author thinks a competent
human needs) and an `[agent] timeout_sec` (what the runner gets). Harbor runs
here with --agent-timeout-multiplier 4.0, so the real budget is 4x the declared
timeout. The RATIO between those two numbers is the question:

    median across the 79-task catalog        0.8x   (budget ~ expert estimate)
    gpt2-codegolf                           40.0x   (2400 expert-min vs 60)
    write-compressor                        24.0x   (1440 expert-min vs 60)

write-compressor is why this exists. It was cut by AgentTimeout at exactly 60
minutes, at turn 99, with its roundtrip nearly working -- and that reads as a
correctness failure until you notice the task budgets 24 expert-hours into one
agent hour. No prompt rule fixes that. The lever is resume (the sequencer
auto-resumes a failed run, which effectively doubles the budget), not a jig.

An agent is not a human and a high ratio is not proof of anything on its own --
the median task is finished well inside its estimate. But when a run is cut by
the clock while still making progress, this is the number that says whether to
look for a defect or to give it another window.

Usage:  ./budget-audit.py           whole catalog, worst ratios first
        ./budget-audit.py <task>…   just these
"""
import glob
import os
import re
import sys

CAT = "./terminal-bench"
MULTIPLIER = 4.0          # matches sequencer.sh's --agent-timeout-multiplier


def read(task_dir):
    path = os.path.join(task_dir, "task.toml")
    if not os.path.exists(path):
        return None
    s = open(path).read()
    m = re.search(r"^expert_time_estimate_min\s*=\s*([0-9.]+)", s, re.M)
    expert = float(m.group(1)) if m else None
    # the [agent] block's timeout, not the verifier's
    m = re.search(r"\[agent\][^\[]*?timeout_sec\s*=\s*([0-9.]+)", s, re.S)
    timeout = float(m.group(1)) if m else None
    if not expert or not timeout:
        return None
    return expert, timeout * MULTIPLIER / 60.0


def main():
    wanted = set(sys.argv[1:])
    rows = []
    for d in sorted(glob.glob(os.path.join(CAT, "*/"))):
        name = os.path.basename(d.rstrip("/"))
        if wanted and name not in wanted:
            continue
        got = read(d)
        if got:
            expert, budget = got
            rows.append((expert / budget, name, expert, budget))
    if not rows:
        print("no tasks matched")
        return
    rows.sort(reverse=True)
    print(f"{'ratio':>7}  {'task':<30} {'expert_min':>10} {'agent_min':>9}")
    print("-" * 62)
    for ratio, name, expert, budget in rows:
        flag = "  <-- clock-bound, not context" if ratio >= 8 else ""
        print(f"{ratio:6.1f}x  {name:<30} {expert:10.0f} {budget:9.0f}{flag}")
    med = sorted(r[0] for r in rows)[len(rows) // 2]
    print(f"\nmedian {med:.1f}x across {len(rows)} tasks."
          " A run cut by the clock on a high-ratio task wants another window, not a jig.")


if __name__ == "__main__":
    main()
