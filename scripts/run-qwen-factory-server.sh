#!/usr/bin/env bash
# Experimental multi-slot Qwen server for BANTAMFACTORY capacity measurements.
# The context value is the total KV budget. With fixed KV it is divided evenly;
# unified KV lets active sequences draw from the same total pool.

set -euo pipefail

ROOT=""
LLAMA_DIR="${LLAMA_DIR:-$ROOT/llama.cpp}"
SERVER_BIN="${SERVER_BIN:-$LLAMA_DIR/build/bin/llama-server}"
MODEL="${MODEL:-$ROOT/models/qwen_36_27b_k_s/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-Q4_K_M.gguf}"
PORT="${PORT:-8085}"
CTX="${CTX:-65536}"
SLOTS="${SLOTS:-8}"
KV_MODE="${KV_MODE:-unified}"
CACHE_RAM="${CACHE_RAM:-8192}"
CTX_CHECKPOINTS="${CTX_CHECKPOINTS:-2}"
SPEC_MODE="${SPEC_MODE:-mtp}"

case "$KV_MODE" in
  unified) KV_ARGS=(--kv-unified) ;;
  fixed) KV_ARGS=(--no-kv-unified) ;;
  *) echo "KV_MODE must be unified or fixed" >&2; exit 2 ;;
esac
case "$SPEC_MODE" in
  mtp) SPEC_ARGS=(--spec-type draft-mtp --spec-draft-n-max 3) ;;
  none) SPEC_ARGS=(--spec-type none) ;;
  *) echo "SPEC_MODE must be mtp or none" >&2; exit 2 ;;
esac

exec "$SERVER_BIN" \
  -m "$MODEL" \
  --no-mmproj \
  --host 127.0.0.1 \
  --port "$PORT" \
  --ctx-size "$CTX" \
  --n-gpu-layers 99 \
  --parallel "$SLOTS" \
  "${KV_ARGS[@]}" \
  --ctx-checkpoints "$CTX_CHECKPOINTS" \
  --cache-ram "$CACHE_RAM" \
  --jinja \
  --chat-template-kwargs '{"preserve_thinking":true}' \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --reasoning on \
  --temp 0.6 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0.0 \
  --presence-penalty 0.0 \
  --repeat-penalty 1.0 \
  --flash-attn on \
  --keep 4096 \
  --batch-size 8192 \
  --ubatch-size 512 \
  "${SPEC_ARGS[@]}" \
  --perf \
  --metrics
