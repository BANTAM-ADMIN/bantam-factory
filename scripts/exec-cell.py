"""BANTAM execution cell: runs short Python snippets for the execution gauge.

Runs inside a sealed container (no network, read-only filesystem, memory and
pid limits, no capabilities; see src/factory/exec-gauge.js). Reads one JSON job
per line on stdin and writes one JSON result per line on stdout:

  job:    {"id": 1, "code": "def f(x): ...", "call": "f('a', 2)", "candidates": ["'a'", "3"]}
  result: {"id": 1, "ok": true, "value": "'aa'", "matches": [0]}

A job with "json": true returns the value as JSON text instead (for gauges
that compute structured facts, e.g. the chess move-facts gauge).

Each job runs in a forked child with CPU, memory and file-size limits and a
wall-clock timeout, so a runaway snippet cannot stall the cell. `matches` lists
the candidates whose Python literal equals the value.
"""
import ast
import json
import os
import resource
import signal
import sys

WALL_SECONDS = 3
CPU_SECONDS = 2
MEMORY_BYTES = 256 * 1024 * 1024


def same(value, literal):
    try:
        other = ast.literal_eval(literal)
    except Exception:
        return False
    try:
        return type(value) is type(other) and value == other
    except Exception:
        return False


def child(job, write_fd):
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    out = {"id": job["id"]}
    try:
        scope = {"__name__": "__cell__"}
        exec(compile(job["code"], "<gauge>", "exec"), scope)
        value = eval(compile(job["call"], "<call>", "eval"), scope)
        if job.get("json"):
            out.update(ok=True, value=json.dumps(value)[:200000])
        else:
            out.update(ok=True, value=repr(value)[:2000], matches=[i for i, c in enumerate(job.get("candidates", [])) if same(value, c)])
    except BaseException as error:  # noqa: BLE001 - every failure is a result, never a crash
        out.update(ok=False, error=f"{type(error).__name__}: {error}"[:300])
    os.write(write_fd, json.dumps(out).encode())
    os._exit(0)


def run(job):
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        child(job, write_fd)
    os.close(write_fd)
    signal.signal(signal.SIGALRM, lambda *_: os.kill(pid, signal.SIGKILL))
    signal.alarm(WALL_SECONDS)
    chunks = []
    while True:
        chunk = os.read(read_fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.waitpid(pid, 0)
    signal.alarm(0)
    os.close(read_fd)
    try:
        return json.loads(b"".join(chunks))
    except Exception:
        return {"id": job["id"], "ok": False, "error": "timeout or crash"}


for line in sys.stdin:
    if not line.strip():
        continue
    try:
        job = json.loads(line)
    except Exception:
        continue
    sys.stdout.write(json.dumps(run(job)) + "\n")
    sys.stdout.flush()
