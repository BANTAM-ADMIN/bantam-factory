#!/usr/bin/env bash
# serve-vision.sh — launch the 27B with its vision projector attached.
#
# Same model, same weights, one flag pair: --mmproj loads the vision tower,
# --no-mmproj-offload keeps it in system RAM (CPU encode, zero VRAM cost;
# a ~1GB BF16 projector encodes a screenshot in seconds — fine for rare use).
# Image tokens still enter the LLM context (~1-2k per screenshot of 72k), so
# context size stays untouched until measurement says otherwise.
#
# The projector is configurable; the default is the operator's designated
# mmproj for Qwen3.8-27B (2026-08-18).
set -euo pipefail
MMPROJ="${BANTAM_MMPROJ:-"
# Flag-splice approach, learned on first live bounce (2026-08-18): parsing the
# base script for its launch line grabbed the SERVER_BIN assignment, not the
# invocation. The robust source of truth is a RUNNING server's argv — capture
# it, swap --no-mmproj for the vision flags, relaunch. If no server is running,
# set BANTAM_SERVE_ARGV to a file containing the full llama-server command.
ARGV_FILE="${BANTAM_SERVE_ARGV:-}"
if [ -z "$ARGV_FILE" ]; then
  PID=$(pgrep -f "llama-serve[r]" | head -1)
  [ -n "$PID" ] || { echo "no running llama-server to capture argv from; set BANTAM_SERVE_ARGV"; exit 1; }
  ARGV_FILE=$(mktemp)
  tr '\0' '\n' < "/proc/$PID/cmdline" > "$ARGV_FILE"
  echo "captured argv from running server pid $PID; stopping it"
  kill -TERM "$PID"; for i in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
fi
mapfile -t ARGV < "$ARGV_FILE"
OUT=()
for a in "${ARGV[@]}"; do
  if [ "$a" = "--no-mmproj" ]; then OUT+=("--mmproj" "$MMPROJ" "--no-mmproj-offload"); else OUT+=("$a"); fi
done
case " ${OUT[*]} " in *" --mmproj "*) : ;; *) OUT+=("--mmproj" "$MMPROJ" "--no-mmproj-offload");; esac
echo "launching with vision: --mmproj $MMPROJ (projector on CPU)"
exec "${OUT[@]}"
