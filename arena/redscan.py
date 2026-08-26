#!/usr/bin/env python3
"""redscan — tell a real failure apart from a run that never got to fail.

A reward of 0 is not a verdict. It is written for at least three different
situations that look identical in the scoreboard:

  TRUNCATED   the agent clock cut the run mid-work (run.json partial: true).
              largest-eigenval sat in the red list on exactly this basis: cut at
              45 minutes (agent_timeout_multiplier 3.0) while it was still
              investigating why its solution was fast at 2x2 and slow at 4x4. Re-run
              with a 60-minute budget it passed in 23 turns. It was never a
              capability failure, and it cost real attention as a phantom defect.
  NO-START    the run produced zero turns — an install, launch, or image failure.
              The task was never attempted at all.
  ATTEMPTED   the run reached a conclusion and the verifier disagreed. Only THIS
              one is evidence about the task.

Read the classification before designing a jig for anything in the red list, and
before quoting a pass rate: a denominator full of clock kills understates the
factory and points work at the wrong station.

Usage:  ./redscan.py [jobs_dir]
"""
import glob
import json
import os
import sys
from collections import defaultdict

JOBS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs")


def classify(run_path):
    """-> (kind, turns, note). Kinds: TRUNCATED, NO-START, ATTEMPTED, NO-EVIDENCE."""
    if not os.path.exists(run_path):
        return "NO-EVIDENCE", 0, "no run.json artifact"
    try:
        d = json.load(open(run_path))
    except Exception as e:
        return "NO-EVIDENCE", 0, f"unreadable: {str(e)[:40]}"
    turns = len(d.get("turns", []))
    if d.get("partial") is True:
        return "TRUNCATED", turns, "clock cut the run mid-work"
    if turns == 0:
        return "NO-START", 0, "zero turns — install/launch/image failure"
    # A result OBJECT can be present and hollow. gcode-to-text carried
    # {"pass": null, "status": "unverified", "reachedDone": false, ...} with every
    # field None — the harness saved the artifact, bantam never concluded. An
    # earlier version of this check only asked whether `result` was ABSENT, so it
    # filed that cut run as a genuine attempt and it sat in the red list as a
    # phantom defect, exactly like largest-eigenval did.
    res = d.get("result") or {}
    concluded = d.get("done") is not None or (res and res.get("reachedDone") is True)
    if not concluded:
        # "Never concluded" has two causes that call for opposite responses, so
        # they must not share a label. A gate stopping the run is OUR defect and
        # is fixed in the harness. Running out of budget is a scoping problem —
        # more turns, or break the job into pieces small enough to finish.
        obs = "\n".join(str(x.get("observation", "")) for x in d.get("turns", []))
        if "gate termination" in obs or "Stopped by artifact verification gate" in str(res):
            return "GATE-STOPPED", turns, "a harness gate ended the run — our defect, not the task's"
        return "OUT-OF-BUDGET", turns, "ran out of turns or clock before concluding"
    return "ATTEMPTED", turns, ""


def main():
    best = {}
    trials = []
    for rf in sorted(glob.glob(os.path.join(JOBS, "*/*/verifier/reward.txt"))):
        parts = rf.split(os.sep)
        job, trial = parts[-4], parts[-3]
        task = trial.rsplit("__", 1)[0]
        try:
            reward = float(open(rf).read().strip())
        except Exception:
            continue
        best[task] = max(best.get(task, 0.0), reward)
        trials.append((task, job, trial, reward))

    reds = defaultdict(list)
    for task, job, trial, reward in trials:
        if reward != 0 or best.get(task, 0) == 1:
            continue
        run = os.path.join(JOBS, job, trial, "artifacts/tmp/bantam-evidence/run.json")
        reds[task].append((job, *classify(run)))

    if not reds:
        print("no standing reds with evidence.")
        return

    width = max(len(t) for t in reds)
    tally = defaultdict(int)
    print(f"{'task':{width}}  {'kind':10} {'turns':>5}  job / note")
    print("-" * (width + 46))
    for task in sorted(reds):
        # The most informative attempt decides the task's headline classification.
        rank = {"ATTEMPTED": 0, "OUT-OF-BUDGET": 1, "GATE-STOPPED": 2, "TRUNCATED": 3, "NO-START": 4, "NO-EVIDENCE": 5}
        rows = sorted(reds[task], key=lambda r: (rank[r[1]], -r[2]))
        tally[rows[0][1]] += 1
        for i, (job, kind, turns, note) in enumerate(rows):
            head = task if i == 0 else ""
            print(f"{head:{width}}  {kind:10} {turns:5}  {job}{'  — ' + note if note else ''}")
    print("-" * (width + 46))
    print("headline classification per task:", dict(tally))
    real = tally.get("ATTEMPTED", 0)
    print(f"\n{real} of {len(reds)} standing reds are ATTEMPTED failures — the only ones that are evidence about a task.")
    if len(reds) - real:
        print(f"{len(reds) - real} are truncations or no-starts: re-run before treating them as defects.")


if __name__ == "__main__":
    main()
