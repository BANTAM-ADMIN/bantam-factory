#!/usr/bin/env python3
"""E1 — do BANTAM's three prompt shapes reuse cache, and does n_cache_reuse help?"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefixbench import build, measure, ntokens, HDR, row, get

EP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8085"
REUSES = [int(x) for x in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["0", "64", "256"])]
OUT = sys.argv[3] if len(sys.argv) > 3 else "e1.jsonl"

head, hist, panel, tail = build(2000, 6000, 1500, 500)
BASE = head + hist + panel + tail

# The four shapes, as BANTAM actually produces them.
def shape_prompt(kind):
    if kind == "identical":                       # extension mode, no new work
        return BASE
    if kind == "append":                          # extension mode, new observation
        _, _, _, t2 = build(2000, 6000, 1500, 500, tail_seed=9)
        return BASE + t2
    if kind == "panel-edit-same-size":            # rebuild: panel re-rendered
        h, hi, p2, t = build(2000, 6000, 1500, 500, panel_seed=7)
        return h + hi + p2 + t
    if kind == "panel-edit-grow":                 # rebuild: panel grows -> positions shift
        h, hi, p2, t = build(2000, 6000, 1500, 500, panel_seed=7, panel_scale=1.4)
        return h + hi + p2 + t
    raise ValueError(kind)

SHAPES = ["identical", "append", "panel-edit-same-size", "panel-edit-grow"]

print(f"endpoint {EP}   base prompt {ntokens(EP, BASE)} tokens   slots {len(get(EP, '/slots'))}")
print(HDR)
rows = []
with open(OUT, "w") as fh:
    for kind in SHAPES:
        target = shape_prompt(kind)
        for reuse in REUSES:
            # Prime: put the BASE prompt in the slot, always the same way.
            measure(EP, BASE, 0, 4, f"prime<{kind}/{reuse}>")
            m = measure(EP, target, reuse, 32, f"{kind}")
            rows.append(m); fh.write(json.dumps(m) + "\n"); fh.flush()
            print(row(m))
        print()
