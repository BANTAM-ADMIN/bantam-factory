#!/usr/bin/env python3
"""E3 — do user-message boundaries create usable checkpoints?

The BANTAM question underneath: rebuild mode changes two things each turn — the
volatile <open_files> panel (inside the NEWEST user message) and superseded file
bodies (inside OLDER messages). If the server checkpoints at user-message starts,
those two edits have very different costs.
"""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import post, LOREM

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
OUT = sys.argv[2] if len(sys.argv) > 2 else "e3.jsonl"

def filler(n_tok, seed):
    reps = max(1, int(n_tok * 4 / len(LOREM)) + 1)
    return f"[seg {seed}] " + LOREM * reps

def convo(panel_seed=0, hist_seed=0, n_turns=6):
    msgs = [{"role": "system", "content": filler(1500, 1)}]
    for i in range(n_turns):
        # One older turn carries the "superseded file body" that rebuild rewrites.
        body = filler(700, 50 + i) if i != 2 else filler(700, 900 + hist_seed)
        msgs.append({"role": "user", "content": f"turn {i} request\n" + body})
        msgs.append({"role": "assistant", "content": f"turn {i} reply. " + filler(120, 60 + i)})
    # The newest user message: volatile panel + newest observation, as extension mode folds it.
    msgs.append({"role": "user", "content":
                 "<open_files>\n" + filler(1400, 300 + panel_seed) + "\n</open_files>\n"
                 "<observation>\n" + filler(300, 7) + "\n</observation>"})
    return msgs

def run(msgs, label):
    t0 = time.time()
    r = post(EP, "/v1/chat/completions",
             {"messages": msgs, "max_tokens": 24, "temperature": 0})
    wall = (time.time() - t0) * 1000
    t = r["timings"]
    total = t["cache_n"] + t["prompt_n"]
    return {"label": label, "prompt_tokens": total, "cache_n": t["cache_n"], "prompt_n": t["prompt_n"],
            "reuse_pct": round(100.0 * t["cache_n"] / total, 1) if total else 0.0,
            "prompt_ms": round(t["prompt_ms"], 1),
            "prompt_tok_s": round(t.get("prompt_per_second") or 0, 1),
            "gen_tok_s": round(t["predicted_n"] * 1000.0 / t["predicted_ms"], 1) if t.get("predicted_ms") else None,
            "wall_ms": round(wall, 1)}

CASES = [
    ("identical resend",                    dict(panel_seed=0, hist_seed=0)),
    ("panel edited (newest user message)",  dict(panel_seed=5, hist_seed=0)),
    ("history edited (turn 2, mid-convo)",  dict(panel_seed=0, hist_seed=5)),
    ("both edited",                         dict(panel_seed=6, hist_seed=6)),
]

hdr = f"{'case':<38}{'ptok':>8}{'cache_n':>9}{'proc':>8}{'reuse%':>8}{'pp_ms':>9}{'pp_t/s':>9}{'wall_ms':>9}"
print(f"endpoint {EP}")
print(hdr)
with open(OUT, "w") as fh:
    for label, kw in CASES:
        run(convo(), "prime")                       # always re-establish the same base
        m = run(convo(**kw), label)
        fh.write(json.dumps(m) + "\n"); fh.flush()
        print(f"{m['label']:<38}{m['prompt_tokens']:>8}{m['cache_n']:>9}{m['prompt_n']:>8}"
              f"{m['reuse_pct']:>7}%{m['prompt_ms']:>9}{m['prompt_tok_s']:>9}{m['wall_ms']:>9}")
