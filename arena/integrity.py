#!/usr/bin/env python3
"""integrity — did a PASS come from solving, or from downloading the answer?

Network is ON by default in these containers, because a large share of the bench
legitimately needs it (pip, huggingface, apt). The cost of that decision is that
a reimplement-from-scratch task could, in principle, be passed by fetching a
published reference solution instead of writing one. regex-chess is Carlini's,
and public; gpt2-codegolf has reference implementations everywhere; Doom's source
is on GitHub.

Blocking the network per-task is the blunt fix and it breaks legitimate installs.
This is the gauge instead: read what each PASSING run actually fetched, and flag
anything that looks like it was the answer rather than a dependency.

A pass obtained by downloading the solution is worse than a failure, because it
is a failure that also corrupts the scoreboard and the next decision made from it.

Usage:  ./integrity.py            audit every passing task
        ./integrity.py <task>…    audit specific ones
"""
import glob
import json
import os
import re
import sys

TB = os.path.dirname(os.path.abspath(__file__))
JOBS = os.path.join(TB, "jobs")

# Hosts that serve dependencies. Fetching from these is ordinary work.
BENIGN = re.compile(
    r"pypi\.org|files\.pythonhosted\.org|deb\.debian\.org|security\.debian\.org|"
    r"archive\.ubuntu\.com|ports\.ubuntu\.com|registry\.npmjs\.org|crates\.io|"
    r"proxy\.golang\.org|huggingface\.co|cdn-lfs|astral\.sh|nodejs\.org|"
    r"127\.0\.0\.1|localhost|172\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+",
    re.I,
)
FETCH = re.compile(r"\b(?:curl|wget|git\s+clone|pip\s+download)\b[^\n]{0,300}", re.I)
URL = re.compile(r"https?://[^\s'\"|;)>]+")


def actions(run):
    for turn in run.get("turns", []):
        a = turn.get("parsedAction") or turn.get("action") or {}
        yield a


CATALOG = "./terminal-bench"
# An explicit instruction to go and GET the thing. When the task says so, fetching
# it is the work, not a shortcut around it.
ACQUIRE = re.compile(r"\bfrom source\b|\bdownload\b|\bfetch\b|\bgit clone\b|\bobtain\b", re.I)


def expected_hosts(task):
    """Hosts the REFERENCE SOLUTION itself uses.

    The task author's own solve.sh is the ground truth for what a legitimate
    fetch looks like. compile-compcert (2026-08-21) was flagged SUSPECT for
    pulling CompCert/CompCert/archive/.../v3.13.1.tar.gz -- while its instruction
    says "build the CompCert C verified compiler from source" and its own
    reference solution clones github.com/AbsInt/CompCert. The heuristic matched a
    task word in the URL and could not tell acquiring the subject from
    downloading the answer.

    A gauge that cries wolf gets switched off, so it has to know the difference.
    """
    hosts, acquire = set(), False
    base = os.path.join(CATALOG, task)
    try:
        for name in ("instruction.md", "task.toml"):
            fp = os.path.join(base, name)
            if os.path.exists(fp) and ACQUIRE.search(open(fp, errors="replace").read()):
                acquire = True
        sol = os.path.join(base, "solution")
        for root, _, files in os.walk(sol):
            for f in files:
                for url in URL.findall(open(os.path.join(root, f), errors="replace").read()):
                    m = re.match(r"https?://([^/]+)", url)
                    if m:
                        hosts.add(m.group(1).lower())
    except Exception:
        pass
    return hosts, acquire


def audit(task, run_path):
    try:
        run = json.load(open(run_path))
    except Exception as e:
        return [("UNREADABLE", str(e)[:60])]
    findings = []
    # Words from the task name are the strongest tell: a URL containing the
    # task's own subject is far more likely to be its solution than a dependency.
    stem = [w for w in re.split(r"[-_]", task) if len(w) > 3]
    ref_hosts, acquires = expected_hosts(task)
    for a in actions(run):
        cmd = str(a.get("c") or "")
        if not FETCH.search(cmd):
            continue
        for url in URL.findall(cmd):
            if BENIGN.search(url):
                continue
            hit = [w for w in stem if w.lower() in url.lower()]
            host = (re.match(r"https?://([^/]+)", url) or [None, ""])[1].lower()
            # The author's own solution fetches from here, or the task told the
            # run to go and get it: acquiring the subject IS the work.
            sanctioned = host in ref_hosts or (hit and acquires)
            label = "expected" if (hit and sanctioned) else ("SUSPECT" if hit else "off-list")
            findings.append((label, f"{url[:110]}" + (f"  [matches task word: {', '.join(hit)}]" if hit else "")))
    return findings


def main():
    wanted = set(sys.argv[1:])
    best, runs = {}, {}
    for rf in glob.glob(os.path.join(JOBS, "*/*/verifier/reward.txt")):
        parts = rf.split(os.sep)
        task = parts[-3].rsplit("__", 1)[0]
        try:
            r = float(open(rf).read().strip())
        except Exception:
            continue
        if r == 1:
            best[task] = True
            runs.setdefault(task, []).append(
                os.path.join(os.path.dirname(os.path.dirname(rf)), "artifacts/tmp/bantam-evidence/run.json")
            )
    tasks = sorted(t for t in best if not wanted or t in wanted)
    suspect = clean = noev = 0
    for task in tasks:
        found = []
        seen_any = False
        for p in runs[task]:
            if not os.path.exists(p):
                continue
            seen_any = True
            found += audit(task, p)
        if not seen_any:
            print(f"  {task:30} NO-EVIDENCE   (no run.json to audit)")
            noev += 1
            continue
        sus = [f for f in found if f[0] == "SUSPECT"]
        if sus:
            print(f"!! {task:30} SUSPECT")
            for _, d in sus[:3]:
                print(f"       {d}")
            suspect += 1
        else:
            off = [f for f in found if f[0] == "off-list"]
            exp = [f for f in found if f[0] == "expected"]
            bits = []
            if exp:
                bits.append(f"{len(exp)} sanctioned fetch{'es' if len(exp) != 1 else ''} (the task says to acquire it; the reference solution fetches the same hosts)")
            if off:
                bits.append(f"{len(off)} off-list fetch{'es' if len(off) != 1 else ''}, none matching the task")
            note = "(" + "; ".join(bits) + ")" if bits else "(no external fetches)"
            print(f"   {task:30} clean        {note}")
            clean += 1
    print(f"\n{clean} clean, {suspect} suspect, {noev} without evidence, of {len(tasks)} passing tasks.")
    if suspect:
        print("A pass obtained by downloading the answer is worse than a failure — verify each SUSPECT by hand.")


if __name__ == "__main__":
    main()
