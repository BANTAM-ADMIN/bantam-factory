#!/usr/bin/env python3
"""preflight — prove the GRADER works before blaming the run.

Every failure investigated so far has been context, and twice the broken context
was on the grader's side, where no amount of model skill could reach it:

  kv-store-grpc     tests/test.sh does `pip install pytest…` then runs `pytest`.
                    Our adapter points pip at /opt/python, whose bin is NOT on
                    PATH, so the grader died with "pytest: command not found" and
                    wrote reward 0 no matter what BANTAM had built.
  largest-eigenval  "/usr/local/bin/pip: exec: /usr/local/bin/python3.11: not
                    found" — our own broken pip symlink, again inside the grader.

Both were invisible in the scoreboard: a corrupted grader and a wrong answer
both write `0`. This runs each task's REAL tests/test.sh inside the REAL task
image with the adapter's container mutations applied, and no agent work at all.

A healthy task should FAIL its tests here (nothing has been solved) while the
harness itself runs cleanly: test.sh executes, and it writes a reward file. What
we are looking for is the other thing — a grader that cannot run.

Usage:  ./preflight.py <task> [task…]      or  ./preflight.py --all
"""
import os
import re
import subprocess
import sys

TB = os.path.dirname(os.path.abspath(__file__))
CATALOG = "./terminal-bench"

# Exactly the container mutations bantam_agent.py performs, and nothing else.
# If preflight and the adapter ever drift, preflight stops being evidence.
def adapter_mutations():
    """Exactly the container mutations bantam_agent.py performs, and nothing else.
    If preflight and the adapter ever drift, preflight stops being evidence.

    Mirrors the adapter's CONDITIONAL python install (2026-08-21): the image's own
    python3 is kept when it exists with a working pip (PEP 668 images get
    /etc/pip.conf break-system-packages); the portable python is installed and
    symlinked only when there is none. The old unconditional version overwrote
    /usr/local/bin/python3 in 36 of 79 images and changed the subject of the task.
    """
    agent = open(os.path.join(TB, "bantam_agent.py")).read()
    b64 = re.search(r"echo ([A-Za-z0-9+/=]{40,}) \| base64 -d > /usr/local/bin/pip", agent)
    if not b64:
        raise SystemExit("preflight: could not find the pip wrapper in bantam_agent.py — adapter changed shape")
    portable = (
        "mkdir -p /opt/python && tar xzf /tmp/p.tgz -C /opt/python --strip-components=1 && "
        "ln -sf /opt/python/bin/python3 /usr/local/bin/python3 && "
        "ln -sf /opt/python/bin/python3 /usr/local/bin/python && "
        "ln -sf /opt/python/bin/python3.11 /usr/local/bin/python3.11 && "
        f"echo {b64.group(1)} | base64 -d > /usr/local/bin/pip.new && "
        "chmod +x /usr/local/bin/pip.new && rm -f /usr/local/bin/pip /usr/local/bin/pip3 && "
        "cp /usr/local/bin/pip.new /usr/local/bin/pip && cp /usr/local/bin/pip.new /usr/local/bin/pip3 && "
        "rm -f /usr/local/bin/pip.new"
    )
    return (
        # HAVING python3 is the whole test — mirroring the adapter. Requiring pip
        # too replaced mailman's interpreter (python 3.12.3, mailman importable,
        # no pip, no ensurepip) and broke `import mailman`.
        "if command -v python3 >/dev/null 2>&1; then "
        "echo \"python: keeping the image's own $(command -v python3)\"; "
        "if ls /usr/lib/python3*/EXTERNALLY-MANAGED >/dev/null 2>&1; then "
        "printf '[global]\\nbreak-system-packages = true\\n' > /etc/pip.conf; fi; "
        "if ! python3 -m pip --version >/dev/null 2>&1; then "
        "python3 -m ensurepip --default-pip >/dev/null 2>&1 "
        "|| (apt-get update >/dev/null 2>&1 && apt-get install -y python3-pip >/dev/null 2>&1) || true; fi; "
        "else " + portable + "; fi && "
    )


BREAKAGE = [
    ("command not found", r"command not found|: not found$"),
    ("module missing", r"ModuleNotFoundError|ImportError: cannot"),
    ("pip resolve fail", r"ERROR: Could not find a version|ResolutionImpossible"),
    ("network fail", r"Could not resolve host|Temporary failure in name resolution"),
]


def image_for(task):
    toml = open(os.path.join(CATALOG, task, "task.toml")).read()
    m = re.search(r'docker_image\s*=\s*"([^"]+)"', toml)
    return m.group(1) if m else None


def preflight(task, mutations):
    tdir = os.path.join(CATALOG, task)
    image = image_for(task)
    if not image:
        return task, "NO-IMAGE", "task.toml names no docker_image"
    # PULL FIRST, on its own clock. Folding the pull into the timed run made this
    # script report NO-VERDICT for three healthy graders (sqlite-with-gcov,
    # tune-mjcf, reshard-c4-data) purely because a multi-hundred-MB image was
    # still downloading — a gauge inventing defects is worse than no gauge.
    subprocess.run(["docker", "image", "inspect", image], capture_output=True)
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode != 0:
        pull = subprocess.run(["docker", "pull", image], capture_output=True, text=True, timeout=3600)
        if pull.returncode != 0:
            return task, "NO-IMAGE", f"docker pull failed: {pull.stderr.strip().splitlines()[-1][:100] if pull.stderr.strip() else 'unknown'}"
    script = mutations + "mkdir -p /logs/verifier && bash /tests/test.sh 2>&1 | tail -80; echo \"__REWARD__=$(cat /logs/verifier/reward.txt 2>/dev/null)\"; echo \"__CTRF__=$([ -f /logs/verifier/ctrf.json ] && echo yes || echo no)\""
    try:
        r = subprocess.run(
            ["docker", "run", "--rm",
             "-v", f"{os.path.join(TB,'python.tar.gz')}:/tmp/p.tgz:ro",
             "-v", f"{os.path.join(tdir,'tests')}:/tests:ro",
             image, "sh", "-c", script],
            capture_output=True, text=True, timeout=900,
        )
    except subprocess.TimeoutExpired:
        return task, "TIMEOUT", "test.sh did not finish in 900s with no agent work"
    out = r.stdout + r.stderr
    reward = (re.search(r"__REWARD__=(\S*)", out) or [None, ""])[1]
    ctrf = "__CTRF__=yes" in out
    # A WRITTEN VERDICT is the discriminator, and it is checked first. On an
    # untouched container the tests SHOULD fail — they import the module the agent
    # was meant to install (grpc), or the extension it was meant to build
    # (pyknotid). Those ModuleNotFoundErrors are the grader working correctly, and
    # an earlier version of this script reported them as defects. What is NOT
    # healthy is test.sh producing no verdict at all: that is infrastructure, and
    # no run against it can ever score.
    if reward != "":
        return task, "OK", f"grader ran and scored (reward {reward}{', ctrf' if ctrf else ', no ctrf'} with nothing solved)"
    for name, pat in BREAKAGE:
        m = re.search(pat, out, re.M)
        if m:
            line = out[max(0, out.rfind("\n", 0, m.start()) + 1):out.find("\n", m.end())].strip()
            return task, "GRADER-BROKEN", f"no verdict; {name}: {line[:110]}"
    return task, "NO-VERDICT", "test.sh wrote no reward.txt and named no cause"


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args == ["--all"]:
        args = sorted(d for d in os.listdir(CATALOG) if os.path.isdir(os.path.join(CATALOG, d)))
    mutations = adapter_mutations()
    bad = 0
    for task in args:
        t, kind, note = preflight(task, mutations)
        flag = "  " if kind == "OK" else "!!"
        print(f"{flag} {t:28} {kind:14} {note}", flush=True)
        if kind != "OK":
            bad += 1
    print(f"\n{len(args) - bad}/{len(args)} graders healthy; {bad} need fixing before their runs mean anything.")


if __name__ == "__main__":
    main()
