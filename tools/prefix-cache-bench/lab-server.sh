#!/usr/bin/env bash
# lab-server.sh — the experiment rig. Mirrors the certified solo stack but makes
# every cache-related knob settable. NEVER edits the operator's launch scripts.
set -euo pipefail
DIR=
SERVER="${LAB_SERVER_BIN:-"
MODEL="$DIR/Qwen3.8-27B-BANTAM-Q4_K_P.gguf"
MMPROJ="$DIR/mmproj-Qwen3.8-27B-BANTAM-BF16.gguf"

PORT=8085; CTX=32768; PARALLEL=1; UBATCH=512; BATCH=8192
CKPTS=32; MINSTEP=256; CACHERAM=8000; REUSE=0; VISION=1; UNIFIED=0
MTP=1; SLOTSAVE=""; SLEEPIDLE=""; LABEL="lab"; PROMPTLOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift;;      --ctx) CTX="$2"; shift;;
    --parallel) PARALLEL="$2"; shift;;  --ubatch) UBATCH="$2"; shift;;
    --batch) BATCH="$2"; shift;;    --ckpts) CKPTS="$2"; shift;;
    --minstep) MINSTEP="$2"; shift;;    --cacheram) CACHERAM="$2"; shift;;
    --reuse) REUSE="$2"; shift;;    --no-vision) VISION=0;;
    --unified) UNIFIED=1;;          --no-mtp) MTP=0;;
    --slot-save) SLOTSAVE="$2"; shift;; --sleep-idle) SLEEPIDLE="$2"; shift;;
    --label) LABEL="$2"; shift;;
    --log-prompts) PROMPTLOG="$2"; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
  shift
done

# Free the port first, and wait for it.
fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || break; sleep 1; done

ARGS=( -m "$MODEL" --host 127.0.0.1 --port "$PORT" --ctx-size "$CTX" --n-gpu-layers 99
       --parallel "$PARALLEL" --ctx-checkpoints "$CKPTS" --checkpoint-min-step "$MINSTEP"
       --cache-ram "$CACHERAM" --cache-reuse "$REUSE" --jinja
       --cache-type-k q8_0 --cache-type-v q8_0 --reasoning on
       --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0 --keep 4096
       --batch-size "$BATCH" --ubatch-size "$UBATCH" --perf --metrics )
[ "$VISION" = "1" ] && ARGS+=( --mmproj "$MMPROJ" --no-mmproj-offload )
[ "$UNIFIED" = "1" ] && ARGS+=( --kv-unified )
[ "$MTP" = "1" ] && ARGS+=( --spec-type draft-mtp --spec-draft-n-max 3 )
[ -n "$SLOTSAVE" ] && { mkdir -p "$SLOTSAVE"; ARGS+=( --slot-save-path "$SLOTSAVE" ); }
[ -n "$SLEEPIDLE" ] && ARGS+=( --sleep-idle-seconds "$SLEEPIDLE" )
[ -n "$PROMPTLOG" ] && { mkdir -p "$PROMPTLOG"; ARGS+=( --log-prompts-dir "$PROMPTLOG" ); }

LOG="$(dirname "$0")/lab-${LABEL}.log"
: > "$LOG"
echo "[lab] $LABEL: ctx=$CTX parallel=$PARALLEL ubatch=$UBATCH ckpts=$CKPTS minstep=$MINSTEP cacheram=$CACHERAM reuse=$REUSE vision=$VISION unified=$UNIFIED mtp=$MTP"
setsid nohup "$SERVER" "${ARGS[@]}" >> "$LOG" 2>&1 < /dev/null &
disown
for i in $(seq 1 180); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[lab] healthy after ~${i}s — log $LOG"; exit 0
  fi
  sleep 1
done
echo "[lab] FAILED to become healthy; tail of log:" >&2; tail -20 "$LOG" >&2; exit 1
