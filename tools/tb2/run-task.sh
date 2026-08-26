#!/usr/bin/env bash
# run-task.sh — launch ONE terminal-bench task, with the traps closed.
#
# Both of these fired on 2026-08-22 launching log-summary-date-ranges by hand:
#
# 1. `-t <name>` is ACCEPTED AND IGNORED for a local `-p` dataset. harbor's
#    --task is for registry tasks (org/name); with a local path it silently
#    does nothing and the run becomes a FULL 79-task sweep. It started
#    gpt2-codegolf and had created four task dirs before it was noticed. The
#    correct filter is -i/--include-task-name. This script only ever emits -i,
#    plus -l 1 as an independent second limit, and REFUSES a bare -t.
#
# 2. bantam.tgz is a SNAPSHOT. It was 18 hours stale, so the run would have
#    measured yesterday's code and reported it as today's. That exact gap
#    recorded reshard-c4-data and raman-fitting as failures for runs that never
#    existed. This script repacks from HEAD whenever the tgz is older than the
#    HEAD commit, using the load-checked packer.
#
# And it verifies the FILTER TOOK EFFECT before letting the run continue —
# checking that the job dir created matches the task asked for, which is the
# only thing that caught (1).
set -euo pipefail

TB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=.
CATALOG="$REPO/terminal-bench"
HARBOR=
ENDPOINT="${BANTAM_ENDPOINT:-http://127.0.0.1:8085}"

TASK=""; JOB=""; MULT=2.0
while [ $# -gt 0 ]; do
  case "$1" in
    -t|--task) echo "refusing -t: it is silently ignored for a local dataset and turns this into a full sweep. Just pass the task name." >&2; exit 2 ;;
    --job-name) JOB="$2"; shift ;;
    --multiplier) MULT="$2"; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) TASK="$1" ;;
  esac
  shift
done
[ -n "$TASK" ] || { echo "usage: run-task.sh <task-name> [--job-name NAME] [--multiplier N]" >&2; exit 2; }
JOB="${JOB:-$TASK}"

# --- gate 1: the task is really in the local catalog -------------------------
if [ ! -d "$CATALOG/$TASK" ]; then
  echo "no such task: $TASK" >&2
  echo "did you mean:" >&2
  find "$CATALOG" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -i -- "${TASK:0:6}" | head -5 | sed 's/^/  /' >&2
  exit 2
fi

# --- gate 2: single controller ----------------------------------------------
# pgrep exits 1 when nothing matches, which under `set -euo pipefail` kills this
# script silently in the case where everything is FINE. Every probe here is
# wrapped so a clean machine is not mistaken for an error.
RUNNING=$(pgrep -f '[h]arbor run' | wc -l || true)
if [ "${RUNNING:-0}" -ne 0 ]; then
  echo "a harbor controller is already running (pids: $(pgrep -f '[h]arbor run' | tr '\n' ' ' || true)). Stop it first." >&2
  exit 2
fi

# --- gate 3: the packed artifact is not older than HEAD ----------------------
HEAD_EPOCH=$(git -C "$REPO" log -1 --format=%ct)
TGZ_EPOCH=$(stat -c %Y "$TB/bantam.tgz" 2>/dev/null || echo 0)
if [ "$TGZ_EPOCH" -lt "$HEAD_EPOCH" ]; then
  echo "bantam.tgz ($(date -d @"$TGZ_EPOCH" '+%F %H:%M')) is older than HEAD ($(date -d @"$HEAD_EPOCH" '+%F %H:%M')) — repacking"
  "$TB/pack-head.sh"
else
  echo "bantam.tgz is current with HEAD $(git -C "$REPO" rev-parse --short HEAD)"
fi

# --- gate 4: a model is actually RESIDENT, not merely answering --------------
curl -sf -m 3 "$ENDPOINT/health" >/dev/null 2>&1 || { echo "no model server at $ENDPOINT" >&2; exit 2; }
if curl -s -m 3 "$ENDPOINT/props" | grep -q '"is_sleeping": *true'; then
  echo "the server is asleep — /health answers but no model is in VRAM" >&2; exit 2
fi
for f in /tmp/bantam-model-locks/*.lock; do
  [ -f "$f" ] || continue
  P=$(python3 -c "import json;print(json.load(open('$f')).get('pid'))" 2>/dev/null || echo "")
  [ -n "$P" ] && kill -0 "$P" 2>/dev/null && { echo "the model lock is held by pid $P — a run or an interactive session is using it." >&2; exit 2; }
done

# --- launch ------------------------------------------------------------------
rm -rf "$TB/jobs/$JOB"
echo "launching $TASK (job $JOB, multiplier $MULT)"
setsid env PYTHONPATH="$TB" "$HARBOR" run \
  --agent bantam_agent:BantamAgent -m local/bantam-27b \
  -p "$CATALOG" \
  -i "$TASK" -l 1 \
  --n-concurrent 1 --artifact /tmp/bantam-evidence \
  --agent-timeout-multiplier "$MULT" \
  -o "$TB/jobs" --job-name "$JOB" -y \
  > "$TB/$JOB.log" 2>&1 < /dev/null &

# --- gate 5: the filter actually took effect ---------------------------------
# This is the check that caught the -t trap. A run that starts the wrong task is
# worse than one that fails to start, because it looks like it is working.
for _ in $(seq 1 40); do
  sleep 3
  CREATED=$(ls "$TB/jobs/$JOB" 2>/dev/null | grep -vE '^(config\.json|job\.log|lock\.json|result\.json)$' || true)
  [ -n "$CREATED" ] && break
done
WRONG=$(echo "$CREATED" | grep -v "^${TASK}__" || true)
if [ -n "$WRONG" ]; then
  echo "FILTER DID NOT TAKE: expected only ${TASK}__*, got:" >&2
  echo "$CREATED" | sed 's/^/  /' >&2
  for p in $(pgrep -f '[h]arbor run' || true); do kill -KILL "$p" 2>/dev/null || true; done
  docker ps --format '{{.Names}}' | grep '__env' | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$TB/jobs/$JOB"
  echo "killed the run and cleaned up." >&2
  exit 1
fi
echo "verified: running only $CREATED"
echo "  log:    $TB/$JOB.log"
echo "  result: $TB/jobs/$JOB/result.json"
