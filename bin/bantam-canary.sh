#!/bin/bash
# The canary: a fixed, sealed, ~1-minute pulse check for the whole harness
# against a LIVE model. Run it after any harness change (and in CI on a
# runner that has a model). A MISS or a wall outside the band means the
# FACTORY changed, not the task — audit the harness before anything else.
#
#   BANTAM_ENDPOINT=http://127.0.0.1:8085 ./bin/bantam-canary.sh
#
# Kit: bench/canary (a one-comparison bug; the pristine suite is red 1/1 by
# design). Verdict = the corner's suite PLUS the sealed holdout, green.
# Ledger: ~/.bantam/canary-ledger.jsonl — every line carries build sha, wall,
# verdict, and (on a MISS) the failing test output, so a red bell arrives
# with its bytes attached.
set -u
B="$(cd "$(dirname "$0")/.." && pwd)"
BAND_MAX=${BANTAM_CANARY_BAND_S:-120}
EP=${BANTAM_ENDPOINT:-http://127.0.0.1:8085}
curl -sf -m 3 "$EP/health" >/dev/null 2>&1 || curl -sf -m 3 "$EP/v1/models" >/dev/null 2>&1 || {
  echo "canary: SKIP — no model at $EP (set BANTAM_ENDPOINT)"; exit 3; }
WS=$(mktemp -d "${TMPDIR:-/tmp}/bantam-canary-XXXXXX")
cp -r "$B/bench/canary/materials/." "$WS/"
cd "$B" || exit 2
export BANTAM_ENDPOINT="$EP" BANTAM_PROMPT_TRAJECTORY=extension BANTAM_THINK_TRIM=1 BANTAM_THINK_N_PREDICT=1024
T0=$(date +%s)
timeout $((BAND_MAX + 120)) node bin/bantam.js run --task "$(cat "$B/bench/canary/task.txt")" \
  --workspace "$WS" --autonomous --save-run="$WS/run.json" > "$WS/out.log" 2>&1
RC=$?; WALL=$(( $(date +%s) - T0 ))
cp "$B/bench/canary/holdout/holdout.test.mjs" "$WS/test/.holdout.test.mjs"
OUT=$(cd "$WS" && env -u NODE_TEST_CONTEXT -u NODE_OPTIONS npm test --silent 2>&1)
rm -f "$WS/test/.holdout.test.mjs"
PASS=$(echo "$OUT" | grep -oP '^# pass \K\d+' | head -1)
FAIL=$(echo "$OUT" | grep -oP '^# fail \K\d+' | head -1)
BUILD=$(git -C "$B" rev-parse --short HEAD 2>/dev/null || echo unknown)
V=MISS; [ "${FAIL:-1}" = "0" ] && [ -n "${PASS:-}" ] && V=EXACT
S=OK; [ "$V" != "EXACT" ] && S=FAIL; [ "$V" = "EXACT" ] && [ "$WALL" -gt "$BAND_MAX" ] && S=SLOW
EVIDENCE=""
[ "$V" != "EXACT" ] && EVIDENCE=$(echo "$OUT" | grep -A6 "not ok" | head -12 | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
LEDGER="${BANTAM_CANARY_LEDGER:-$HOME/.bantam/canary-ledger.jsonl}"
mkdir -p "$(dirname "$LEDGER")"
printf '{"at":"%s","build":"%s","wallS":%d,"exit":%d,"verdict":"%s","tests":"pass %s fail %s","status":"%s","ws":"%s"%s}\n' \
  "$(date -Is)" "$BUILD" "$WALL" "$RC" "$V" "${PASS:-?}" "${FAIL:-?}" "$S" "$WS" \
  "${EVIDENCE:+,\"evidence\":$EVIDENCE}" >> "$LEDGER"
echo "canary: $S — sealed $V in ${WALL}s (band ≤${BAND_MAX}s) build $BUILD"
[ "$S" = "OK" ] || { echo "  the FACTORY changed, not the task — ws kept for audit: $WS"; exit 1; }
rm -rf "$WS"
