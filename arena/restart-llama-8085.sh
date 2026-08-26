#!/usr/bin/env bash
# Captured 2026-08-21. --parallel corrected 2 -> 1 (the certified value): with
# --ctx-size 96000, --parallel 2 gave each slot only 48k of context. tune-mjcf
# hit that wall at turn 76 with a 47.8k prompt and every generation was silently
# cut after a few hundred tokens (server log: "truncated = 1"). Every argument is shell-quoted: --chat-template-kwargs
# takes a JSON object, and an unquoted {"a":true} is mangled by the shell before
# llama-server ever sees it ("parse error at line 1, column 1").
exec \
   \
  -m \
   \
  --mmproj \
   \
  --no-mmproj-offload \
  --host \
  0.0.0.0 \
  --port \
  8085 \
  --ctx-size \
  96000 \
  --n-gpu-layers \
  99 \
  --parallel \
  1 \
  --ctx-checkpoints \
  32 \
  --cache-ram \
  8000 \
  --jinja \
  --chat-template-kwargs \
  '{"preserve_thinking":true,"reasoning_effort":"xhigh"}' \
  --cache-type-k \
  q8_0 \
  --cache-type-v \
  q8_0 \
  --reasoning \
  on \
  --temp \
  1.0 \
  --top-p \
  0.95 \
  --top-k \
  20 \
  --min-p \
  0.0 \
  --presence-penalty \
  0.0 \
  --repeat-penalty \
  1.0 \
  --keep \
  4096 \
  --batch-size \
  8192 \
  --ubatch-size \
  512 \
  --perf \
  --metrics \
  --spec-type \
  draft-mtp \
  --spec-draft-n-max \
  3
