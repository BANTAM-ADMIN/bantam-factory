#!/usr/bin/env python3
"""E8 — replay one real run's prompts through a server, deterministically.

Agent runs take a different path every time, so an end-to-end A/B of a server
setting is noise. Replaying the SAME captured prompts in the SAME order removes
every model variable: only the server config differs, so the prefill work is
directly comparable.
"""
import glob, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import post

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
LOGDIR = sys.argv[2]
TAG = sys.argv[3] if len(sys.argv) > 3 else "cfg"

files = sorted(glob.glob(os.path.join(LOGDIR, "*.txt")), key=os.path.getmtime)
prompts = [open(f, encoding="utf-8", errors="replace").read() for f in files if os.path.getsize(f) > 1000]

# Clear the slot so no configuration inherits another's cache.
post(EP, "/completion", {"prompt": "reset " * 500, "n_predict": 4, "cache_prompt": True,
                         "temperature": 0, "ignore_eos": True})

proc = cache = 0
pref_ms = 0.0
hits = 0
t0 = time.time()
for p in prompts:
    r = post(EP, "/completion", {"prompt": p, "n_predict": 4, "cache_prompt": True,
                                 "temperature": 0, "ignore_eos": True})
    t = r["timings"]
    proc += t["prompt_n"]; cache += t["cache_n"]; pref_ms += t["prompt_ms"]
    if t["cache_n"] > 1: hits += 1
wall = time.time() - t0
total = proc + cache
print(json.dumps({"cfg": TAG, "prompts": len(prompts), "prompt_tokens": total,
                  "processed": proc, "reused": cache,
                  "reuse_pct": round(100.0 * cache / total, 1) if total else 0,
                  "turns_hitting_cache": hits,
                  "prefill_ms": round(pref_ms), "wall_ms": round(wall * 1000)}))
