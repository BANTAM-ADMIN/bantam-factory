#!/usr/bin/env python3
"""E7 — replay a REAL BANTAM run down both paths and compare prefill work.

Path A: /completion with the rendered prompt string — what BANTAM does today.
Path B: /v1/chat/completions with the same content split back into messages at
        its own <|im_start|> boundaries — what it would do on the chat path.

Same server, same order, same content. The only variable is the endpoint.
"""
import json, re, sys, os, time, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import post

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
LOGDIR = sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else "results/e7.jsonl"

TURN = re.compile(r"<\|im_start\|>(\w+)\n(.*?)<\|im_end\|>", re.S)

def to_messages(rendered):
    msgs = [{"role": r, "content": c} for r, c in TURN.findall(rendered)]
    # A trailing "<|im_start|>assistant\n" with no im_end is the generation cue.
    return msgs

def run_raw(prompt, n_predict=8):
    t0 = time.time()
    r = post(EP, "/completion", {"prompt": prompt, "n_predict": n_predict,
                                 "cache_prompt": True, "temperature": 0, "ignore_eos": True})
    return r["timings"], (time.time() - t0) * 1000

def run_chat(messages, n_predict=8):
    t0 = time.time()
    r = post(EP, "/v1/chat/completions", {"messages": messages, "max_tokens": n_predict,
                                          "temperature": 0})
    return r["timings"], (time.time() - t0) * 1000

files = sorted(glob.glob(os.path.join(LOGDIR, "*.txt")), key=os.path.getmtime)
prompts = [open(f, encoding="utf-8", errors="replace").read() for f in files]
prompts = [p for p in prompts if len(p) > 1000]
print(f"replaying {len(prompts)} real BANTAM prompts down both paths\n")

def replay(label, fn, payloads):
    # Cold start: a throwaway prompt clears the slot so neither path inherits
    # the other's cache.
    post(EP, "/completion", {"prompt": "reset " * 400, "n_predict": 4, "cache_prompt": True,
                             "temperature": 0, "ignore_eos": True})
    rows, tot_proc, tot_cache, tot_wall = [], 0, 0, 0.0
    print(f"  {label}")
    print(f"    {'turn':>4}{'ptok':>8}{'cache_n':>9}{'proc':>8}{'reuse%':>8}{'pp_ms':>9}{'wall_ms':>9}")
    for i, pay in enumerate(payloads):
        t, wall = fn(pay)
        tot = t["cache_n"] + t["prompt_n"]
        tot_proc += t["prompt_n"]; tot_cache += t["cache_n"]; tot_wall += wall
        rows.append({"path": label, "turn": i, "prompt_tokens": tot, "cache_n": t["cache_n"],
                     "prompt_n": t["prompt_n"], "prompt_ms": round(t["prompt_ms"], 1),
                     "wall_ms": round(wall, 1)})
        print(f"    {i:>4}{tot:>8}{t['cache_n']:>9}{t['prompt_n']:>8}"
              f"{(100.0*t['cache_n']/tot if tot else 0):>7.1f}%{round(t['prompt_ms'],1):>9}{round(wall):>9}")
    print(f"    TOTAL prompt tokens processed: {tot_proc}   reused: {tot_cache}   wall {tot_wall/1000:.1f}s\n")
    return rows, tot_proc, tot_wall

with open(OUT, "w") as fh:
    a_rows, a_proc, a_wall = replay("A  /completion (rendered)", run_raw, prompts)
    msgs = [to_messages(p) for p in prompts]
    print(f"  (messages parsed per turn: {[len(m) for m in msgs]})\n")
    b_rows, b_proc, b_wall = replay("B  /v1/chat/completions (messages)", run_chat, msgs)
    for r in a_rows + b_rows: fh.write(json.dumps(r) + "\n")

print(f"  prompt tokens PROCESSED   A {a_proc:>7}   B {b_proc:>7}   "
      f"{'B saves ' + str(a_proc-b_proc) if b_proc < a_proc else 'A saves ' + str(b_proc-a_proc)} "
      f"({100.0*(a_proc-b_proc)/a_proc:+.1f}% vs A)")
print(f"  wall clock                A {a_wall/1000:>6.1f}s   B {b_wall/1000:>6.1f}s")
