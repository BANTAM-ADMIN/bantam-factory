#!/usr/bin/env python3
"""E5 — explicit prefix points: /slots/{id}?action=save|restore|erase."""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import build, post

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
h, hi, p, t = build(2000, 6000, 1500, 500)
WARM = h + hi + p + t
h2, hi2, p2, t2 = build(1200, 2500, 400, 300, panel_seed=42, tail_seed=42)
OTHER = h2 + hi2 + p2 + t2

def run(prompt, label, n_predict=8):
    t0 = time.time()
    r = post(EP, "/completion", {"prompt": prompt, "n_predict": n_predict, "cache_prompt": True,
                                 "temperature": 0, "ignore_eos": True, "id_slot": 0})
    wall = (time.time() - t0) * 1000
    ti = r["timings"]; total = ti["cache_n"] + ti["prompt_n"]
    print(f"{label:<46}{total:>8}{ti['cache_n']:>9}{round(100.0*ti['cache_n']/total,1) if total else 0:>7}%"
          f"{round(ti['prompt_ms'],1):>10}{round(wall,1):>10}")
    return ti["cache_n"]

print(f"{'step':<46}{'ptok':>8}{'cache_n':>9}{'reuse%':>8}{'pp_ms':>10}{'wall_ms':>10}")
run(WARM, "1. warm slot 0 with the target prefix")
try:
    t0 = time.time()
    r = post(EP, "/slots/0?action=save", {"filename": "bantam-warm-prefix.bin"})
    print(f"   -> save: {json.dumps(r)[:150]}  ({round((time.time()-t0)*1000)}ms)")
except Exception as e:
    print(f"   -> save FAILED: {e} :: {getattr(e, 'read', lambda: b'')().decode()[:200]}"); sys.exit(1)
run(OTHER, "2. a different prompt destroys the cache")
run(WARM,  "3. target prefix WITHOUT restore (control)")
run(OTHER, "4. destroy it again")
try:
    t0 = time.time()
    r = post(EP, "/slots/0?action=restore", {"filename": "bantam-warm-prefix.bin"})
    print(f"   -> restore: {json.dumps(r)[:150]}  ({round((time.time()-t0)*1000)}ms)")
except Exception as e:
    print(f"   -> restore FAILED: {e} :: {getattr(e, 'read', lambda: b'')().decode()[:200]}")
run(WARM,  "5. target prefix AFTER restore  <-- THE TEST")
