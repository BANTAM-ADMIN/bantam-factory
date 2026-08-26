#!/usr/bin/env python3
"""E4 — does a busy sibling slot evict an idle slot's KV? (unified vs split)

The claim under test, read from server-context.cpp: under --kv-unified an idle
slot's KV is copied to the RAM prompt cache and CLEARED from VRAM when a new
task starts; under split KV it is retained. If true, a worker's pre-warmed
prefix survives attendant chatter on duo/solo and does not on crew.
"""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import build, post

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
TAG = sys.argv[2] if len(sys.argv) > 2 else "cfg"
OUT = sys.argv[3] if len(sys.argv) > 3 else "e4.jsonl"

h, hi, p, t = build(2000, 6000, 1500, 500)
WORKER = h + hi + p + t                                  # the pre-warmed worker prompt
h2, hi2, p2, t2 = build(1200, 2500, 400, 300, panel_seed=42, tail_seed=42)
CHATTER = h2 + hi2 + p2 + t2                             # the attendant's unrelated prompt

def run(prompt, slot, label, n_predict=16):
    t0 = time.time()
    r = post(EP, "/completion", {"prompt": prompt, "n_predict": n_predict, "cache_prompt": True,
                                 "temperature": 0, "ignore_eos": True, "id_slot": slot})
    wall = (time.time() - t0) * 1000
    ti = r["timings"]; total = ti["cache_n"] + ti["prompt_n"]
    return {"cfg": TAG, "label": label, "slot": r.get("id_slot"), "prompt_tokens": total,
            "cache_n": ti["cache_n"], "prompt_n": ti["prompt_n"],
            "reuse_pct": round(100.0 * ti["cache_n"] / total, 1) if total else 0.0,
            "prompt_ms": round(ti["prompt_ms"], 1), "wall_ms": round(wall, 1)}

steps = []
steps.append(run(WORKER, 0, "1. worker warms slot 0"))
steps.append(run(WORKER, 0, "2. worker repeats (control: is it warm?)"))
steps.append(run(CHATTER, 1, "3. attendant works on slot 1"))
steps.append(run(WORKER, 0, "4. worker returns to slot 0  <-- THE TEST"))
steps.append(run(CHATTER, 1, "5. attendant repeats on slot 1"))
steps.append(run(WORKER, 0, "6. worker returns again"))

print(f"{'step':<44}{'slot':>5}{'ptok':>8}{'cache_n':>9}{'reuse%':>8}{'pp_ms':>9}{'wall_ms':>9}")
with open(OUT, "a") as fh:
    for m in steps:
        fh.write(json.dumps(m) + "\n")
        print(f"{m['label']:<44}{str(m['slot']):>5}{m['prompt_tokens']:>8}{m['cache_n']:>9}"
              f"{m['reuse_pct']:>7}%{m['prompt_ms']:>9}{m['wall_ms']:>9}")
