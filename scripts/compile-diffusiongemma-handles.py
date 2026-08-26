#!/usr/bin/env python3
"""Compile a deterministic rack of one-token DiffusionGemma point handles."""

import argparse
import json
import re
from pathlib import Path

from transformers import AutoTokenizer


DEFAULT_MODEL = Path(
    ""
    "diffusiongemma-26B-A4B-it-AWQ-INT4"
)
DEFAULT_OUTPUT = Path(".bantam/factory-benchmarks/diffusiongemma-handles.json")
EXCLUDED = {
    "TRUE", "FALSE", "NULL", "JSON", "HTTP", "HTML", "SYSTEM", "USER",
    "MODEL", "THINK", "TOOL", "TOOLS", "CALL", "POINT", "RECORD",
    "ERROR", "STOP", "HOLD", "REVIEW", "MONITOR", "PASS", "FAIL",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--count", type=int, default=192)
    args = parser.parse_args()
    if args.count < 1:
        raise SystemExit("--count must be positive")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    candidates = []
    for token_id in range(150_000, len(tokenizer)):
        text = tokenizer.decode([token_id], skip_special_tokens=False)
        # Consonant-only strings are less likely to inject ordinary word
        # semantics into a record while remaining easy to display and copy.
        if not re.fullmatch(r"[BCDFGHJKLMNPQRSTVWXZ]{3,6}", text) or text in EXCLUDED:
            continue
        if tokenizer(text, add_special_tokens=False)["input_ids"] != [token_id]:
            continue
        wrapped = tokenizer(f"[{text}]", add_special_tokens=False)["input_ids"]
        if token_id not in wrapped or len(wrapped) > 3:
            continue
        candidates.append({"handle": text, "tokenId": token_id, "tokens": 1})

    if len(candidates) < args.count:
        raise SystemExit(f"only {len(candidates)} qualified handles for requested {args.count}")

    # Spread selection across the eligible token-id range instead of taking a
    # semantically clustered contiguous vocabulary region.
    step = len(candidates) / args.count
    selected = [candidates[int(index * step)] for index in range(args.count)]
    report = {
        "schema": "bantam.factory.diffusiongemma-handle-rack.v1",
        "model": str(args.model),
        "tokenizerClass": type(tokenizer).__name__,
        "vocabularySize": len(tokenizer),
        "eligible": len(candidates),
        "selected": len(selected),
        "comparison": {
            "GP-0001": len(tokenizer("GP-0001", add_special_tokens=False)["input_ids"]),
            selected[0]["handle"]: 1,
        },
        "handles": selected,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("eligible", "selected", "comparison")}, indent=2))
    print(f"handle rack: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
