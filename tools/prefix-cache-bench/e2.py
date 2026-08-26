#!/usr/bin/env python3
"""E2 — how late must a change be to survive? Token-exact divergence sweep.

Prompts are sent as TOKEN ARRAYS so the divergence position is exact, not
approximate. Prime, then diverge d tokens from the end, and read cache_n.
"""
import json, sys, os, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import build, post, HDR, row

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
OUT = sys.argv[2] if len(sys.argv) > 2 else "e2.jsonl"
DISTS = [int(x) for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else
         ["0", "64", "128", "256", "512", "1024", "2048", "4096"])]

h, hi, p, t = build(2000, 6000, 1500, 500)
BASE_TOK = post(EP, "/tokenize", {"content": h + hi + p + t})["tokens"]
ALT_TOK = post(EP, "/tokenize", {"content": "\n<changed>\n" + "different content here. " * 400})["tokens"]
N = len(BASE_TOK)

def run(tokens, reuse, n_predict, label):
    t0 = time.time()
    r = post(EP, "/completion", {"prompt": tokens, "n_predict": n_predict, "cache_prompt": True,
                                 "temperature": 0, "ignore_eos": True, "n_cache_reuse": reuse})
    wall = (time.time() - t0) * 1000
    ti = r["timings"]
    total = ti["cache_n"] + ti["prompt_n"]
    return {"label": label, "reuse": reuse, "slot": r.get("id_slot"), "prompt_tokens": total,
            "cache_n": ti["cache_n"], "prompt_n": ti["prompt_n"],
            "reuse_pct": round(100.0 * ti["cache_n"] / total, 1) if total else 0.0,
            "prompt_ms": round(ti["prompt_ms"], 1),
            "prompt_tok_s": round(ti.get("prompt_per_second") or 0, 1),
            "predicted_n": ti["predicted_n"], "predicted_ms": round(ti["predicted_ms"], 1),
            "gen_tok_s": round(ti["predicted_n"] * 1000.0 / ti["predicted_ms"], 1) if ti.get("predicted_ms") else None,
            "draft_n": ti.get("draft_n"), "draft_accepted": ti.get("draft_n_accepted"),
            "wall_ms": round(wall, 1)}

print(f"endpoint {EP}   base {N} tokens")
print(HDR)
with open(OUT, "w") as fh:
    for d in DISTS:
        run(BASE_TOK, 0, 32, "prime")                     # re-establish the same cached state
        keep = max(1, N - d)
        variant = BASE_TOK[:keep] + ALT_TOK[:max(1, d)]   # same length, diverges at `keep`
        m = run(variant, 0, 32, f"diverge {d} from end (@{keep})")
        m["diverge_at"] = keep
        m["dist_from_end"] = d
        fh.write(json.dumps(m) + "\n"); fh.flush()
        print(row(m))
