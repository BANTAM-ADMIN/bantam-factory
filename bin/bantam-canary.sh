#!/bin/bash
# The canary card: a fixed, sealed, ~1-minute pulse check for the whole
# harness. Run it after any harness change. A MISS or a wall outside the band
# means the FACTORY changed, not the task — audit the harness before anything
# else. Kit: .bantam/canary (one-comparison bug; pristine suite red 1/1).
# Ledger: .bantam/canary/ledger.jsonl (build sha, wall, verdict, per-run ws).
set -u
B="$(cd "$(dirname "$0")/.." && pwd)"
BAND_MAX=${BANTAM_CANARY_BAND_S:-120}
WS=$(mktemp -d /tmp/bantam-canary-XXXXXX)
cp -r "$B/.bantam/canary/materials/." "$WS/"
cd "$B" || exit 2
export BANTAM_ENDPOINT=${BANTAM_ENDPOINT:-http://127.0.0.1:8085} BANTAM_PROMPT_TRAJECTORY=extension BANTAM_THINK_TRIM=1 BANTAM_THINK_N_PREDICT=1024
T0=$(date +%s)
timeout $((BAND_MAX + 60)) node bin/bantam.js run --task "$(cat "$B/.bantam/canary/task.txt")" --workspace "$WS" --autonomous --save-run="$WS/run.json" > "$WS/out.log" 2>&1
RC=$?; WALL=$(( $(date +%s) - T0 ))
cp "$B/.bantam/canary/holdout/holdout.test.mjs" "$WS/test/.holdout.test.mjs"
OUT=$(cd "$WS" && env -u NODE_TEST_CONTEXT -u NODE_OPTIONS npm test --silent 2>&1)
rm -f "$WS/test/.holdout.test.mjs"
PASS=$(echo "$OUT" | grep -oP '^# pass \K\d+' | head -1)
FAIL=$(echo "$OUT" | grep -oP '^# fail \K\d+' | head -1)
BUILD=$(git -C "$B" rev-parse --short HEAD 2>/dev/null || echo unknown)
V=MISS; [ "${FAIL:-1}" = "0" ] && [ -n "${PASS:-}" ] && V=EXACT
S=OK
[ "$V" != "EXACT" ] && S=FAIL
[ "$WALL" -gt "$BAND_MAX" ] && S=SLOW
printf '{"at":"%s","build":"%s","wallS":%d,"exit":%d,"verdict":"%s","tests":"pass %s fail %s","status":"%s","ws":"%s"}\n' \
  "$(date -Is)" "$BUILD" "$WALL" "$RC" "$V" "${PASS:-?}" "${FAIL:-?}" "$S" "$WS" >> "$B/.bantam/canary/ledger.jsonl"
echo "canary: $S — sealed $V in ${WALL}s (band ≤${BAND_MAX}s) build $BUILD"
echo "  ws kept for audit: $WS"
[ "$S" = "OK" ] || { echo "  ⚠ the FACTORY changed, not the task — audit prompt bytes/harness/server before anything else."; exit 1; }
