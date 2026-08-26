#!/usr/bin/env bash
# BANTAM certified local-model launch profile (measured, 2026-08).
#
# Every flag below was measured on a 24 GB card with the stock Qwen 3.8 27B
# Q4_K_M — the same weights the bench record in docs/fights was fought on.
# The WHY comments are the product; change flags only with a measurement.
#
# Usage:
#   MODEL=~/models/Qwen3.8-27B-Q4_K_M.gguf ./local-gguf.sh [--port N] [--ctx N] [--fg]
# Optional companions (auto-detected next to MODEL, or set explicitly):
#   MMPROJ=...gguf   vision input (screenshots); CPU by default
#   MTP=...gguf      speculative decoding sidecar (measured ~2x generation
#                    on supported builds; harmless to omit)
# LLAMA_SERVER overrides the binary (default: PATH, then ~/.bantam/addons/llama-cpp).
set -euo pipefail

MODEL="${MODEL:?set MODEL=/path/to/model.gguf}"
DIR="$(cd "$(dirname "$MODEL")" && pwd)"
STEM="$(basename "$MODEL" .gguf)"; BASE="${STEM%-Q*}"
PORT=8085; CTX=72000; FOREGROUND=0
while [ $# -gt 0 ]; do case "$1" in
  --port) PORT="$2"; shift;; --ctx) CTX="$2"; shift;; --fg) FOREGROUND=1;;
  *) echo "unknown flag: $1"; exit 2;; esac; shift; done

SERVER="${LLAMA_SERVER:-$(command -v llama-server || true)}"
[ -z "$SERVER" ] && SERVER="$(ls "$HOME/.bantam/addons/llama-cpp/"*/llama-server 2>/dev/null | head -1 || true)"
[ -z "$SERVER" ] && { echo "llama-server not found — run: bantam doctor --setup"; exit 1; }

# Auto-detect optional companions downloaded beside the model.
MMPROJ="${MMPROJ:-$(ls "$DIR/mmproj-$BASE"*.gguf 2>/dev/null | head -1 || true)}"
MTP="${MTP:-$(ls "$DIR/mtp-$BASE"*.gguf 2>/dev/null | head -1 || true)}"
VISION_ARGS=(); [ -n "$MMPROJ" ] && VISION_ARGS=(--mmproj "$MMPROJ" --no-mmproj-offload)
SPEC_ARGS=(); [ -n "$MTP" ] && SPEC_ARGS=(--spec-type draft-mtp --spec-draft-n-max 3 -md "$MTP")

# Idempotent for boot use: a healthy server on the port is success, not error.
if curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "already healthy on :${PORT} — nothing to do"; exit 0; fi

ARGS=(
  -m "$MODEL" "${VISION_ARGS[@]}"
  --host 127.0.0.1 --port "$PORT"
  --ctx-size "$CTX"
  --n-gpu-layers 99
  # --parallel 1 IS LOAD-BEARING. This model family's prefix reuse is
  # checkpoint-or-nothing; a multi-slot server scatters one agent's turns
  # across cold slots and every turn re-prefills the whole context (measured:
  # cache_n=0 and an agent timing out on a task it could do).
  --parallel 1
  --ctx-checkpoints 32
  --cache-ram 8000
  --jinja --reasoning on
  --cache-type-k q8_0 --cache-type-v q8_0
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0
  --presence-penalty 0.0 --repeat-penalty 1.0
  --keep 4096
  # ubatch sets the PREFIX-CACHE SAFE WINDOW, not just batching: llama.cpp
  # places a prompt checkpoint n_ubatch+4 tokens before the end, and an edit
  # further back reprocesses EVERYTHING. Replaying a real 13-turn agent run
  # through 2048/3072/4096: 3072 gave 64.1% reuse vs 51.5%/59.4% — the
  # smallest window that covers the live-files panel plus a turn's content.
  --batch-size 8192 --ubatch-size 3072
  "${SPEC_ARGS[@]}"
  --perf --metrics
)

LOG="${BANTAM_SERVER_LOG:-$HOME/.bantam/llama-server-${PORT}.log}"
mkdir -p "$(dirname "$LOG")"
echo "launching local model on :${PORT} (ctx ${CTX}${MMPROJ:+, vision}${MTP:+, mtp}) — log: $LOG"
if [ "$FOREGROUND" = 1 ]; then exec "$SERVER" "${ARGS[@]}"; fi
setsid nohup "$SERVER" "${ARGS[@]}" >> "$LOG" 2>&1 < /dev/null &
for i in $(seq 1 120); do
  curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && { echo "healthy on :${PORT} after ~${i}s"; exit 0; }
  sleep 1
done
echo "server did not become healthy within 120s — check $LOG"; exit 1
