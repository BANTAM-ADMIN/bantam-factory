#!/usr/bin/env python3
"""watchdog — sit at the button while the run happens, not fifty minutes later.

Polling a run every twenty minutes means a stall is found twenty minutes after
it starts, and a turn-budget wall is found only once it has already been hit.
dna-insert reached turn 189 of a 200 cap before anyone looked. This tails the
live container and names a problem the moment its signature appears.

What it watches, and why each one is here:

  STALLED        no new turn, no output, and NO command executing. A dead model
                 call or a wedged container. Silence with nothing running.
  LONG-COMMAND   no new turn because a shell command the model launched is still
                 running (>20s). A slow query, a build, a sampler. Real work;
                 worth knowing about, not a stall (query-optimize: 73s in sqlite3).
  TURN-WALL      turn count crossing 80% of the cap. That is the last moment a
                 run can still be redirected; after the cap it is a truncation
                 and its work is thrown away.
  GATE-STORM     harness gate rejections climbing. Every one is OUR defect until
                 proved otherwise — three separate gates have terminated healthy
                 runs mid-work in this arena.
  LOOPING        the repetition guard firing repeatedly: the run is re-running an
                 identical action against an unchanged workspace.
  TOOL-DENIED    "command not found" / "No module named" — a tool the run reached
                 for and our environment refused. Every instance so far has been
                 context, not capability.
  SLOW-TURN      a turn taking far longer than this run's own median. The choke
                 is usually a shell command that hangs, a model call that fell
                 out of the prefix cache, or a search with no bound — and you
                 want to know WHILE it happens, not from the wreckage.
  THRASHING      output keeps growing but no turn completes: generate, get
                 rejected, generate again. Invisible to STALLED (bytes move)
                 and to SLOW-TURN (no turn finishes to time).
  MEMORY         container at >=90% of its memory limit. The limit is the TASK's
                 (harbor honours task.toml), but bantam, node and the portable
                 python all live inside it, so our footprint competes with the
                 build the task is actually trying to run.
  NO-DELIVERABLE deep into the budget with no named output file written yet.

Alerts are appended to /tmp/watchdog.alerts and printed. Read it, or tail it.

Usage:  ./watchdog.py [--interval SEC] [--max-turns N]
"""
import argparse
import re
import shlex
import subprocess
import time

ALERTS = "/tmp/watchdog.alerts"
STREAM = "/tmp/bantam-evidence/stream.log"


def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return r.stdout.strip()


def active_containers():
    """EVERY task container, not the first.

    The sweep now runs two chains concurrently (--parallel 2, two 48k slots), so
    a supervisor that returns `head -1` watches one task and is blind to the
    other — and the unwatched one is exactly where a stall or a gate storm would
    sit unnoticed. Per-container state is keyed by name throughout.
    """
    names = sh("docker ps --format '{{.Names}}'").splitlines()
    return [n.strip() for n in names
            if "env-main" in n and not any(x in n for x in ("tilde", "foundation"))]


def active_container():
    """Back-compat for callers wanting a single container (probes, one-shots)."""
    found = active_containers()
    return found[0] if found else None


def memory_pct(container):
    """Container memory as a percentage of its limit, read from the HOST.

    Deliberately NOT via `docker exec`: a container at its memory ceiling cannot
    reliably spawn a shell, so the exec hangs exactly when the reading matters.
    compile-compcert (2026-08-21) sat at 3.999GiB of a 4GiB limit and two
    successive `docker exec` probes timed out at 45s and 120s.
    """
    out = sh(f"docker stats --no-stream --format '{{{{.MemPerc}}}}' {container}")
    m = re.search(r"([\d.]+)%", out)
    return float(m.group(1)) if m else None


def probe(container):
    """One cheap exec; every counter comes back in a single round trip."""
    script = (
        f'S={STREAM}; '
        'echo "TURNS=$(grep -c \'^  →\' $S 2>/dev/null || echo 0)"; '
        'echo "GATES=$(grep -c \'verification gate\' $S 2>/dev/null || echo 0)"; '
        'echo "REPEAT=$(grep -c \'\\[repetition\\]\' $S 2>/dev/null || echo 0)"; '
        'echo "NOTFOUND=$(grep -c \'command not found\' $S 2>/dev/null || echo 0)"; '
        'echo "NOMODULE=$(grep -c \'No module named\' $S 2>/dev/null || echo 0)"; '
        'echo "TERM=$(grep -c \'gate termination\' $S 2>/dev/null || echo 0)"; '
        'echo "BYTES=$(wc -c < $S 2>/dev/null || echo 0)"; '
        # A live shell command the model launched (not bantam, not tee, not the
        # container's sleep) that has run for >20s: the run is WAITING on real
        # work — a slow query, a build, a sampler — not stalled. query-optimize
        # sat 73s inside `sqlite3 ... < sol.sql` and was reported STALLED.
        'echo "LONGCMD=$(ps -eo etimes,args --no-headers 2>/dev/null | grep -vE \'bantam.js|/opt/node|tee /tmp|sleep infinity|ps -eo\' | awk \'$1>20\' | wc -l)"'
    )
    # shlex.quote, NOT subprocess.list2cmdline — the latter is WINDOWS quoting.
    # Using it here made every counter come back 0, so this script reported a
    # healthy run (turn 33, working) as STALLED at turn 0. A gauge that
    # invents defects is worse than no gauge.
    out = sh(f"docker exec {container} sh -c {shlex.quote(script)}")
    vals = dict(re.findall(r"(\w+)=(\d+)", out))
    return {k: int(v) for k, v in vals.items()}


def alert(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(ALERTS, "a") as f:
        f.write(line + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=45)
    ap.add_argument("--max-turns", type=int, default=200)
    args = ap.parse_args()

    # All per-container, keyed by name: two chains run concurrently, and one
    # task's pace or alert history must never be read as another's.
    seen = {}       # last counters
    quiet = {}      # consecutive windows with no new turn
    warned = {}     # alerts already raised (each fires once per container)
    pace = {}       # seconds-per-turn samples
    thrash = {}     # windows with output but no completed turn

    idle = [0]      # consecutive polls with a controller alive but nothing running

    while True:
        model_server(warned)
        running = active_containers()
        if not running:
            idle_stall(args, idle, warned)
            time.sleep(args.interval)
            continue
        idle[0] = 0
        for c in running:
            tick(c, args, seen, quiet, warned, pace, thrash)
        time.sleep(args.interval)


def model_server(warned):
    """The watchdog watched containers while the thing that stopped the sweep was
    the SERVER.

    2026-08-21 20:56:37, from the kernel:

        Out of memory: Killed process 3856391 (llama-server)
        total-vm:126308008kB, anon-rss:26546644kB

    Every container's install ends with a health check against $GW:8085, so once
    the model server died EVERY subsequent trial failed at setup with curl exit 7
    -- NetworkConnectionError, no reward file, ERR. Ten tasks were consumed from
    the queue and recorded as failures without ever running. Nothing alarmed:
    each container looked fine right up until it could not start.

    Two checks, then. DOWN is the emergency. RSS is the warning that precedes it,
    because the last thing the log printed before the kill was
    `saving prompt with length 35445, total state size = 1466.320 MiB` -- the
    host-side prompt cache (--cache-ram 8000) growing a gigabyte and a half at a
    time.
    """
    out = sh("curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8085/health").strip()
    if out != "200":
        if not warned.get("server_down"):
            warned["server_down"] = True
            alert(
                "MODEL SERVER DOWN: http://127.0.0.1:8085/health returned "
                f"'{out or 'nothing'}'.\n"
                "  Every trial's install ends with a health check against it, so from here on\n"
                "  each task fails at SETUP with curl exit 7 and is recorded ERR without running.\n"
                "  Restart with TB2_ARENA/restart-llama-8085.sh, then requeue every ERR task --\n"
                "  they never ran, so their results are not evidence of anything.\n"
                "  If it was OOM-killed, `journalctl -k | grep -i 'killed process'` says so outright."
            )
        return
    warned.pop("server_down", None)

    rss_kb = sh("ps -o rss= -C llama-server 2>/dev/null | head -1").strip()
    total_kb = sh("awk '/MemTotal/{print $2}' /proc/meminfo").strip()
    if not rss_kb.isdigit() or not total_kb.isdigit():
        return
    pct = 100.0 * int(rss_kb) / int(total_kb)
    # It was killed at ~26.5 GB of 62 GB, about 43%. Warn well below that so the
    # sweep can be paused rather than losing a queue of tasks to setup failures.
    if pct >= 30 and not warned.get("server_rss"):
        warned["server_rss"] = True
        alert(
            f"MODEL SERVER MEMORY: llama-server RSS is {int(rss_kb)/1048576:.1f} GB "
            f"({pct:.0f}% of host RAM).\n"
            "  It was OOM-killed at 26.5 GB on 2026-08-21, taking the whole sweep with it.\n"
            "  The growth is the host-side prompt cache (--cache-ram); lower it, or drain the\n"
            "  chains and restart the server before the kernel makes the decision."
        )


def idle_stall(args, idle, warned):
    """The gauge that only reads while work happens cannot see work STOPPING.

    2026-08-21: sequencer `qa` sat alive for 1h41m with a defunct harbor child
    it would never reap. No container, so every poll here hit `if not running:
    sleep; continue` and the watchdog reported nothing wrong — it was measuring
    containers, and the defect was the ABSENCE of one. An hour and a half of the
    sweep's throughput went missing and the only thing that noticed was a human
    reading `ps` for an unrelated reason.

    A controller that is alive but has produced no container for several polls
    is stalled, whether it is blocked on a zombie, waiting on a lock nobody will
    release, or wedged some way not yet seen.
    """
    ctrl = sh("pgrep -af 'sequencer[.]sh|controls[.]sh' 2>/dev/null | grep -v snapshot")
    if not ctrl.strip():
        idle[0] = 0
        return                      # nothing is supposed to be running: not a stall

    idle[0] += 1
    # ~10 minutes at the default 45s interval. Long enough to sit through an
    # image pull and a container build, short enough to beat an afternoon.
    windows = max(3, (10 * 60) // max(args.interval, 1))
    if idle[0] != windows:
        return                      # fire once per stall, not every poll

    zombies = sh("ps -eo stat,args --no-headers 2>/dev/null | grep -c '^Z.*harbor'").strip()
    detail = ""
    if zombies.isdigit() and int(zombies) > 0:
        detail = f" {zombies} defunct harbor child(ren) -- the controller is blocked reaping one."
    alert(
        f"IDLE STALL: a controller has been alive with NO task container for "
        f"~{idle[0] * args.interval // 60} min.{detail}\n"
        f"  {ctrl.strip().splitlines()[0][:120]}\n"
        "  The queue is not advancing. Check for a defunct harbor child (ps -eo stat,args | grep harbor),\n"
        "  a single-controller lock held by a dead run, or a sequencer that outlived its harbor."
    )


def tick(c, args, seen, quiet, warned, pace, thrash):
        """One container, one poll. State is per-container, keyed by name."""
        # HOST-SIDE FIRST. probe() shells into the container, and a container at
        # its memory ceiling cannot spawn a shell — so the original ordering put
        # this check AFTER an exec that hangs, and the watchdog bailed out at the
        # `if not now: continue` below in exactly the condition the memory alert
        # exists to catch. compile-compcert sat at 99.93% and the gauge stayed
        # silent. Anything readable from the host is read before anything is not.
        w = warned.setdefault(c, set())
        mem = memory_pct(c)
        if mem is not None and mem >= 90 and "mem" not in w:
            w.add("mem")
            alert(f"MEMORY {c}: {mem:.0f}% of the container limit — the TASK's cap, and our agent runs inside it; exec will start hanging, expect thrash then OOM")

        try:
            now = probe(c)
        except Exception:
            return
        if not now:
            # An unresponsive probe IS a signal when memory is the reason.
            if mem is not None and mem >= 90 and "memhang" not in w:
                w.add("memhang")
                alert(f"MEMORY-HANG {c}: probe timed out at {mem:.0f}% memory — the container can no longer spawn a shell")
            return

        # Per-turn wall clock, measured against this run's OWN median rather than
        # a fixed threshold — tasks legitimately differ by an order of magnitude,
        # so the only honest baseline is the run's own pace.
        stamp = time.time()
        prev = seen.get(c)
        turns = now.get("TURNS", 0)

        if prev:
            if turns == prev.get("TURNS", 0) and now.get("BYTES", 0) == prev.get("BYTES", 0):
                quiet[c] = quiet.get(c, 0) + 1
                # Turn 0 means the container is still installing node/bantam/python
                # from the artifact server, which legitimately produces no turns.
                if turns > 0 and quiet[c] == 3:
                    if now.get("LONGCMD", 0) > 0:
                        if "longcmd" not in w:
                            w.add("longcmd")
                            alert(f"LONG-COMMAND {c}: a shell command has run >{3*args.interval}s at turn {turns} — slow query/build/sampler; the {300}s cap will bound it")
                    elif "stall" not in w:
                        w.add("stall")
                        alert(f"STALLED   {c}: no new turn, no output, and NO command executing for {3*args.interval}s at turn {turns}")
            else:
                quiet[c] = 0
                dturns = turns - prev.get("TURNS", 0)
                # THRASHING: output keeps arriving but no turn completes — the
                # model is generating, being rejected, and generating again.
                # tune-mjcf sat at turn 76 for ten minutes this way, ~2.5 min per
                # rejected 8k-token attempt, and neither STALLED (bytes grew) nor
                # SLOW-TURN (no turn finished to measure) could see it.
                if dturns == 0:
                    thrash[c] = thrash.get(c, 0) + 1
                    if thrash[c] == 4 and "thrash" not in w:
                        w.add("thrash")
                        alert(f"THRASHING {c}: output growing for {4*args.interval}s with NO turn completing at turn {turns} — rejected generations; read the rejectedOutputs")
                else:
                    thrash[c] = 0
                if dturns > 0:
                    secs = (stamp - prev["_t"]) / dturns
                    hist = pace.setdefault(c, [])
                    hist.append(secs)
                    if len(hist) >= 5:
                        med = sorted(hist)[len(hist) // 2]
                        if secs > max(4 * med, 90) and "slow" not in w:
                            w.add("slow")
                            alert(f"SLOW-TURN {c}: {secs:.0f}s/turn vs median {med:.0f}s at turn {turns} — find the choke now")

            for key, label in (("GATES", "GATE-STORM"), ("REPEAT", "LOOPING"),
                               ("NOTFOUND", "TOOL-DENIED"), ("NOMODULE", "TOOL-DENIED")):
                d = now.get(key, 0) - prev.get(key, 0)
                if d > 0 and f"{key}" not in w:
                    w.add(key)
                    alert(f"{label:12} {c}: {key} +{d} (total {now.get(key,0)}) at turn {turns}")

        if now.get("TERM", 0) and "term" not in w:
            w.add("term")
            alert(f"TERMINATED {c}: a harness gate ended the run at turn {turns} — our defect until proved otherwise")

        if turns >= int(args.max_turns * 0.8) and "wall" not in w:
            w.add("wall")
            alert(f"TURN-WALL {c}: turn {turns}/{args.max_turns} — last chance to redirect before truncation")

        now["_t"] = stamp
        seen[c] = now


if __name__ == "__main__":
    main()
