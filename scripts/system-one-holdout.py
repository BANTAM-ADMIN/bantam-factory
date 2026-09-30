#!/usr/bin/env python3
"""Assemble, blind-verify and freeze BANTAM's private System One holdout.

  python3 scripts/system-one-holdout.py check  <draft_dir> <jevbench_repo>
      merge the drafts, validate every item with JevBench's own Task schema,
      and write blind.jsonl (state + question + labels only, no answers)
  python3 scripts/system-one-holdout.py freeze <draft_dir> <verdicts.jsonl> <out_dir>
      keep only items whose blind verdict matches the author's gold, write
      holdout.jsonl and a SHA-256 manifest

The holdout is for final evaluation only. Never tune a strategy on it.
"""

import datetime
import glob
import hashlib
import json
import os
import sys


def load_drafts(draft_dir):
    items = []
    for path in sorted(glob.glob(os.path.join(draft_dir, "*.jsonl"))):
        with open(path) as fh:
            for n, line in enumerate(fh, 1):
                if line.strip():
                    item = json.loads(line)
                    item["_source"] = f"{os.path.basename(path)}:{n}"
                    items.append(item)
    return items


def check(draft_dir, jevbench_repo):
    sys.path.insert(0, jevbench_repo)
    from jevbench.tasks import Task  # noqa: E402

    items = load_drafts(draft_dir)
    seen, problems, blind = set(), [], []
    for item in items:
        try:
            if item["id"] in seen:
                raise ValueError("duplicate id")
            seen.add(item["id"])
            task = Task(id=item["id"], family=item["family"], state=item["state"], question=item["question"],
                        labels=item["labels"], expected=item["expected"], split="private", group=item["id"],
                        provenance=item.get("provenance", {}))
            task.validate()
            q = item["question"]
            if q["type"] == "choice" and sorted(q["criteria"]) != sorted(item["labels"]):
                raise ValueError("choice labels must equal criteria keys")
            if q["type"] == "noul" and sorted(item["labels"]) != ["no", "yes"]:
                raise ValueError("noul labels must be yes/no")
            surface = item.get("provenance", {}).get("surface_answer")
            if surface is not None and str(surface) not in [str(label) for label in item["labels"]]:
                raise ValueError("surface_answer is not one of the labels")
        except Exception as error:  # report every bad item, not just the first
            problems.append(f"{item.get('_source')} {item.get('id')}: {error}")
            continue
        blind.append({"id": item["id"], "state": item["state"], "question": item["question"], "labels": item["labels"]})
    out = os.path.join(draft_dir, "..", "blind.jsonl")
    with open(out, "w") as fh:
        for row in blind:
            fh.write(json.dumps(row) + "\n")
    print(json.dumps({"items": len(items), "valid": len(blind), "problems": problems, "blind": os.path.abspath(out)}, indent=1))


def freeze(draft_dir, verdicts_path, out_dir):
    items = {item["id"]: item for item in load_drafts(draft_dir)}
    verdicts = {}
    with open(verdicts_path) as fh:
        for line in fh:
            if line.strip():
                row = json.loads(line)
                verdicts[row["id"]] = row
    kept, dropped = [], []
    for item_id, item in items.items():
        verdict = verdicts.get(item_id)
        gold = str(item["expected"])
        answer = None if verdict is None else str(verdict.get("answer"))
        if answer == gold and not (verdict or {}).get("ambiguous"):
            item.pop("_source", None)
            item["split"] = "private"
            item.setdefault("provenance", {})["verification"] = "blind verifier agreed with author gold"
            kept.append(item)
        else:
            dropped.append({"id": item_id, "gold": gold, "verifier": answer, "ambiguous": (verdict or {}).get("ambiguous"), "note": (verdict or {}).get("note")})
    os.makedirs(out_dir, exist_ok=True)
    body = "".join(json.dumps(item, sort_keys=True) + "\n" for item in sorted(kept, key=lambda x: x["id"]))
    with open(os.path.join(out_dir, "holdout.jsonl"), "w") as fh:
        fh.write(body)
    manifest = {
        "frozen_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": len(kept),
        "dropped": dropped,
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "families": {f: sum(1 for i in kept if i["family"] == f) for f in sorted({i["family"] for i in kept})},
        "rule": "Final evaluation only. Never tune a strategy on these items.",
    }
    with open(os.path.join(out_dir, "MANIFEST.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(json.dumps({k: v for k, v in manifest.items() if k != "dropped"} | {"dropped": len(dropped)}, indent=1))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "check":
        check(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "freeze":
        freeze(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
