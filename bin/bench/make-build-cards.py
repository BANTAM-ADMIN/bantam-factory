#!/usr/bin/env python3
"""Explode series 6 into ten filmed BUILD cards — one per brief, seven corners each.

Each corner's reel is drawn from that harness's OWN recorded output. Where a
harness stamps its lines (bantam, bantam-bridge, claude), the reel carries real
elapsed time. Where it does not (codex, opencode, hermes), the lines are in
recorded ORDER and spaced across the measured wall — the reel says so out loud
in its first line, so nobody reads a synthetic tick as a stopwatch.
"""
import json, os, re, glob, datetime

S = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(S, "..", "..", "docs", "fights")
M = json.load(open(os.path.join(F, "card31.matrix.json")))
BRIEFS = M["briefs"]
ARMS = ["bantam", "bridge-sol", "codex-cli", "claude-sonnet", "claude-opus", "opencode", "hermes"]
DIR = {"bantam": "builds/{t}", "bridge-sol": "rivals/bridge-{t}", "codex-cli": "rivals/codex-{t}",
       "claude-sonnet": "rivals/claude-sonnet-{t}", "claude-opus": "rivals/claude-opus-{t}",
       "opencode": "rivals/opencode-{t}", "hermes": "rivals/hermes-{t}"}
RUNJSON = {"bantam": "builds/{t}-run.json", "bridge-sol": "rivals/bridge-{t}-run.json"}
OUT = {"bantam": "builds/{t}.out", "bridge-sol": "rivals/bridge-{t}.out", "codex-cli": "rivals/codex-{t}.out",
       "claude-sonnet": "rivals/claude-sonnet-{t}.out", "claude-opus": "rivals/claude-opus-{t}.out",
       "opencode": "rivals/opencode-{t}.out", "hermes": "rivals/hermes-{t}.out"}
NOSTAMP = {"codex-cli", "opencode", "hermes"}
ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\[0m")
clip = lambda s, n=380: (s[:n-1] + "…") if len(s) > n else s

def iso(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def reel_bantam(path, wall_ms):
    """bantam/bridge: modelCalls carry startedAt/completedAt — real elapsed time."""
    d = json.load(open(path))
    calls = {c["index"]: c for c in d.get("modelCalls", [])}
    t0 = min((iso(c["startedAt"]) for c in calls.values() if c.get("startedAt")), default=None)
    if t0 is None: return []
    ev = []
    for tn in d.get("turns", []):
        c = calls.get(tn.get("modelCallIndex"))
        if not c or not c.get("startedAt"): continue
        at = int((iso(c["startedAt"]) - t0) * 1000)
        end = int((iso(c.get("completedAt") or c["startedAt"]) - t0) * 1000)
        r = (tn.get("reasoning") or "").strip()
        if r: ev.append((at, "🤔 " + clip(" ".join(r.split()), 300)))
        act = tn.get("parsedAction") or {}
        if isinstance(act, str):
            try: act = json.loads(act.replace("'", '"'))
            except Exception: act = {}
        a, p = act.get("a"), act.get("p")
        if a: ev.append((end, f"→ {a}" + (f" {p}" if p else "")))
        ob = (tn.get("observation") or "").strip()
        if ob: ev.append((end + 1, "  " + clip(" ".join(ob.split()), 240)))
    return [(min(t, wall_ms), x) for t, x in ev if t >= 0]

def reel_claude(path, wall_ms):
    """claude CLI --output-format json: every event carries a timestamp."""
    d = json.load(open(path))
    stamps = [iso(e["timestamp"]) for e in d if e.get("timestamp")]
    if not stamps: return []
    t0 = min(stamps)
    ev = []
    for e in d:
        if not e.get("timestamp"): continue
        at = int((iso(e["timestamp"]) - t0) * 1000)
        msg = e.get("message") or {}
        for blk in (msg.get("content") or []) if isinstance(msg.get("content"), list) else []:
            if blk.get("type") == "text" and blk.get("text", "").strip():
                ev.append((at, clip(" ".join(blk["text"].split()), 320)))
            elif blk.get("type") == "thinking" and blk.get("thinking", "").strip():
                ev.append((at, "🤔 " + clip(" ".join(blk["thinking"].split()), 300)))
            elif blk.get("type") == "tool_use":
                inp = blk.get("input") or {}
                arg = inp.get("file_path") or inp.get("path") or inp.get("command") or inp.get("pattern") or ""
                ev.append((at, f"→ {blk.get('name')} {clip(' '.join(str(arg).split()), 150)}".rstrip()))
    return [(min(t, wall_ms), x) for t, x in ev if t >= 0]

def reel_lines(path, wall_ms, arm):
    """No timestamps in this harness's output: recorded ORDER, evenly spaced."""
    raw = open(path, errors="replace").read()
    lines = [ANSI.sub("", l).rstrip() for l in raw.split("\n")]
    keep = [l for l in lines if l.strip() and not l.strip().startswith(("---", "===", "___"))]
    keep = keep[:120]
    if not keep: return []
    step = max(1, wall_ms // (len(keep) + 1))
    return [(min(wall_ms, (i + 1) * step), clip(" ".join(l.split()), 300)) for i, l in enumerate(keep)]

def artifacts(d):
    out = []
    for f in sorted(glob.glob(os.path.join(d, "**", "*"), recursive=True)):
        b = os.path.basename(f)
        if os.path.isdir(f) or "__pycache__" in f or b.startswith("."): continue
        out.append({"path": os.path.relpath(f, d), "bytes": os.path.getsize(f)})
    return out[:12]

JUDGE = {"COMPLETE": "WIN", "INCOMPLETE": "INCOMPLETE", "NO-BUILD": "NO-BUILD",
         "OWN-RED": "OWN-RED", "BENCH-FAULT": "BENCH-FAULT", "PROBE-MISS": "MISS"}
filed = []
for t, tool in sorted(BRIEFS.items(), key=lambda kv: int(kv[0][1:])):
    n = int(t[1:])
    brief = open(glob.glob(os.path.join(S, "tasks", f"{t}-*.txt"))[0]).read().strip()
    corners, verdicts, truth, events = [], {}, {}, []
    for arm in ARMS:
        r = M["perArm"].get(arm, {}).get(t)
        if not r: continue
        wall = int(r["wallS"] * 1000)
        d = os.path.join(S, DIR[arm].format(t=t))
        corners.append({"arm": arm, "wallMs": wall, "exitCode": r.get("exit", 0),
                        "artifacts": artifacts(d) if os.path.isdir(d) else [],
                        "usage": {"source": "series6", "turns": None, "ownTests": r.get("ownTests")}})
        p, tot = r["probes"]
        oc = r["outcome"]
        good = oc == "COMPLETE" and p == tot
        verdicts[arm] = {"outcome": JUDGE.get(oc, oc) if not good else "WIN",
                         "reason": (f"built it and passed every sealed probe ({p}/{tot})" if good else
                                    {"INCOMPLETE": f"hit the 900s wall still working — probes {p}/{tot} on what existed",
                                     "NO-BUILD": "asked a clarifying question and built nothing in the window",
                                     "OWN-RED": f"shipped with its own tests red — probes {p}/{tot}",
                                     }.get(oc, f"sealed probes {p}/{tot}")),
                         "tests": (f"{r['ownTests']} tests it wrote itself" if r.get("ownTests") else "wrote no tests")}
        truth[arm] = {"verdict": "EXACT" if good else "MISS", "tests": f"probes {p}/{tot}"}
        # ---- the reel
        ev = []
        rj = RUNJSON.get(arm)
        if rj and os.path.exists(os.path.join(S, rj.format(t=t))):
            ev = reel_bantam(os.path.join(S, rj.format(t=t)), wall)
        op = os.path.join(S, OUT[arm].format(t=t))
        if not ev and os.path.exists(op):
            ev = reel_claude(op, wall) if arm.startswith("claude") else reel_lines(op, wall, arm)
        events.append({"arm": arm, "kind": "status", "t": 0, "text": "building" + (
            " — this harness stamps no times, so its lines below are in recorded order, spread across its measured wall"
            if arm in NOSTAMP else "")})
        if not ev:
            # A silent lane is not a broken lane: some harnesses only print when
            # they finish, so a run killed at the wall leaves no visible trail.
            why = ("this harness prints only when it finishes — it was still working when the 900s window closed, "
                   "so it left no trail to replay" if oc == "INCOMPLETE" else
                   "this harness left no readable transcript for this brief")
            events.append({"arm": arm, "kind": "line", "t": max(1, wall // 2), "text": why})
        for at, x in ev: events.append({"arm": arm, "kind": "line", "t": int(at), "text": x})
        events.append({"arm": arm, "kind": "status", "t": wall,
                       "text": f"finished — {r['wallS']}s, {'probes ' + str(p) + '/' + str(tot)}" +
                               ("" if good else f" · {oc}")})
    events.sort(key=lambda e: e["t"])
    card = {"task": brief, "corners": corners, "build": "series-6",
            "verdicts": verdicts,
            "provenance": {
              "sealed": ("the brief, the rubric and the independent probe suite were hashed into SEALED.sha256 BEFORE any "
                         "corner ran (12 hashes). No harness ever saw the probes; they are not the tests the model wrote."),
              "field": ("seven harnesses, one brief, same 900s window. BANTAM, OPENCODE and HERMES drive the IDENTICAL local "
                        "27B weights — the seconds between them are harness, not model. BANTAM×SOL and CODEX CLI both drive "
                        "gpt-5.6-sol; CLAUDE runs sonnet and opus through the Claude Code CLI."),
              "reels": ("bantam, bantam×sol and both claude corners recorded per-event timestamps, so their feeds carry real "
                        "elapsed time. codex, opencode and hermes print no timestamps: their lines are in recorded order, "
                        "evenly spaced across the wall the stopwatch actually measured."),
            }}
    json.dump(card, open(os.path.join(F, f"cardb{n}.json"), "w"), indent=1)
    json.dump({"truth": f"series-6 build {n} ({tool}): sealed independent probes, hashed before the bell",
               "truthCheck": truth}, open(os.path.join(F, f"cardb{n}.truth.json"), "w"), indent=1)
    with open(os.path.join(F, f"cardb{n}.events.ndjson"), "w") as fh:
        for e in events: fh.write(json.dumps(e) + "\n")
    filed.append(f"b{n} {tool:12} {len(corners)} corners  {len(events):4} events  "
                 f"{sum(1 for v in truth.values() if v['verdict']=='EXACT')}/{len(truth)} sealed EXACT")
print("\n".join(filed))
