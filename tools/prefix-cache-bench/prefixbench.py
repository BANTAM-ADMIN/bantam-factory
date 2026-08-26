#!/usr/bin/env python3
"""prefixbench — measure llama.cpp prefix-cache reuse under BANTAM's prompt shapes.

The definitive gauge is timings.cache_n (tokens restored from cache), never
effective tok/s. Every request's full telemetry is recorded.
"""
import argparse, json, sys, time, urllib.request

def post(endpoint, path, body, timeout=600):
    req = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def get(endpoint, path, timeout=30):
    with urllib.request.urlopen(endpoint.rstrip("/") + path, timeout=timeout) as r:
        return json.loads(r.read())

def ntokens(endpoint, text):
    return len(post(endpoint, "/tokenize", {"content": text})["tokens"])

# ---- prompt shapes -----------------------------------------------------------
# A BANTAM prompt is: [frozen head: system + tools + skills]
#                     [history: turns]
#                     [volatile panel: <open_files>]   <- rebuild re-renders this
#                     [newest observation]
LOREM = ("The station shapes the context so the correct move is the lit button. "
         "A gauge that only reports after the run is an autopsy, not an alarm. "
         "Measure the wall clock at every station to find the next choke point. ")

def filler(approx_tokens, seed=0):
    # ~1 token per 4 chars for this tokenizer; overshoot then let callers measure.
    reps = max(1, int(approx_tokens * 4 / len(LOREM)) + 1)
    return (f"[block {seed}] " + LOREM * reps)

def build(head_tok, hist_tok, panel_tok, tail_tok, panel_seed=0, tail_seed=0, panel_scale=1.0):
    head = "<system>\n" + filler(head_tok, 1) + "\n</system>\n"
    hist = "<history>\n" + filler(hist_tok, 2) + "\n</history>\n"
    panel = "<open_files>\n" + filler(int(panel_tok * panel_scale), 100 + panel_seed) + "\n</open_files>\n"
    tail = "<observation>\n" + filler(tail_tok, 200 + tail_seed) + "\n</observation>\nAssistant:"
    return head, hist, panel, tail

# ---- one measured request ----------------------------------------------------
def measure(endpoint, prompt, reuse, n_predict, label, slot=None):
    body = {
        "prompt": prompt,
        "n_predict": n_predict,
        "cache_prompt": True,
        "temperature": 0,
        "n_cache_reuse": reuse,
        "ignore_eos": True,
    }
    if slot is not None:
        body["id_slot"] = slot
    t0 = time.time()
    r = post(endpoint, "/completion", body)
    wall = (time.time() - t0) * 1000
    t = r["timings"]
    total_prompt = t["cache_n"] + t["prompt_n"]
    return {
        "label": label,
        "reuse": reuse,
        "slot": r.get("id_slot"),
        "prompt_tokens": total_prompt,
        "cache_n": t["cache_n"],
        "prompt_n": t["prompt_n"],
        "reuse_pct": round(100.0 * t["cache_n"] / total_prompt, 1) if total_prompt else 0.0,
        "prompt_ms": round(t["prompt_ms"], 1),
        "prompt_tok_s": round(t.get("prompt_per_second") or 0, 1),
        "predicted_n": t["predicted_n"],
        "predicted_ms": round(t["predicted_ms"], 1),
        "gen_tok_s": round(t["predicted_n"] * 1000.0 / t["predicted_ms"], 1) if t.get("predicted_ms") else None,
        "draft_n": t.get("draft_n"),
        "draft_accepted": t.get("draft_n_accepted"),
        "wall_ms": round(wall, 1),
    }

HDR = f"{'trial':<34}{'reuse':>6}{'ptok':>8}{'cache_n':>9}{'proc':>8}{'reuse%':>8}{'pp_ms':>9}{'pp_t/s':>9}{'gen_t/s':>9}{'wall_ms':>9}"
def row(m):
    return (f"{m['label']:<34}{m['reuse']:>6}{m['prompt_tokens']:>8}{m['cache_n']:>9}{m['prompt_n']:>8}"
            f"{m['reuse_pct']:>7}%{m['prompt_ms']:>9}{m['prompt_tok_s']:>9}{(m['gen_tok_s'] if m['gen_tok_s'] is not None else 0):>9}{m['wall_ms']:>9}")
