#!/usr/bin/env python3
"""E6 — aggregate throughput under N concurrent streams (split vs unified KV).

crew was certified on the claim that a unified pool buys ~3.16x aggregate
batching. Batching happens across slots either way; unification changes KV
POOLING, not the batch. This measures whether split gives up any of it.
"""
import json, sys, os, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import post, LOREM

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
TAG = sys.argv[2] if len(sys.argv) > 2 else "cfg"
N = int(sys.argv[3]) if len(sys.argv) > 3 else 4
NPRED = int(sys.argv[4]) if len(sys.argv) > 4 else 128

def filler(n_tok, seed):
    reps = max(1, int(n_tok * 4 / len(LOREM)) + 1)
    return f"[stream {seed}] " + LOREM * reps

results = [None] * N
def worker(i):
    prompt = filler(1800, i) + f"\n<observation>stream {i}</observation>\nAssistant:"
    t0 = time.time()
    r = post(EP, "/completion", {"prompt": prompt, "n_predict": NPRED, "cache_prompt": True,
                                 "temperature": 0, "ignore_eos": True, "id_slot": i})
    results[i] = (r["timings"], (time.time() - t0) * 1000)

# solo baseline first (one stream alone)
worker(0)
solo_t, solo_wall = results[0]
solo_gen = solo_t["predicted_n"] * 1000.0 / solo_t["predicted_ms"]

threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
t0 = time.time()
for t in threads: t.start()
for t in threads: t.join()
wall = time.time() - t0

total_gen = sum(r[0]["predicted_n"] for r in results if r)
agg = total_gen / wall
per = [round(r[0]["predicted_n"] * 1000.0 / r[0]["predicted_ms"], 1) for r in results if r]
print(f"{TAG:<10} solo {solo_gen:6.1f} tok/s | {N}-way aggregate {agg:6.1f} tok/s "
      f"({agg/solo_gen:4.2f}x solo) | per-stream {per} | wall {wall*1000:.0f}ms")
print(json.dumps({"cfg": TAG, "solo_tok_s": round(solo_gen,1), "n": N,
                  "aggregate_tok_s": round(agg,1), "speedup_vs_solo": round(agg/solo_gen,2),
                  "per_stream_tok_s": per, "wall_ms": round(wall*1000)}))
