#!/usr/bin/env bash
# THE single controller. One task at a time, whole model per trial.
#
# Scattered background chainers racing manual relaunches misfired before
# (2026-08-20); this is the sole launcher. It refuses to start if another harbor
# run is alive, skips tasks that already pass anywhere in jobs/, and appends one
# line per verdict so an auditor can work the failures while the queue advances.
set -uo pipefail

TB=
CAT=./terminal-bench
QUEUE="${1:?usage: sequencer.sh <queue-file> [tag]}"
TAG="${2:-q}"
LOG=/tmp/sequencer-$TAG.log
PROGRESS=/tmp/sequencer-$TAG.progress
cd "$TB"

# Never race another controller.
while pgrep -f "[h]arbor run" >/dev/null 2>&1; do sleep 30; done

already_passing() {
  local t="$1"
  for f in "$TB"/jobs/*/"$t"__*/verifier/reward.txt; do
    [ -f "$f" ] || continue
    [ "$(cat "$f" 2>/dev/null)" = "1" ] && return 0
  done
  return 1
}

while read -r task; do
  [ -z "$task" ] && continue
  case "$task" in \#*) continue;; esac
  bare="${task% @resume}"
  if already_passing "$bare"; then
    echo "$bare SKIP already-passing" >> "$PROGRESS"
    continue
  fi
  # A queue line `task @resume` continues that task from the staged
  # resume-run.json instead of starting cold — for OUT-OF-BUDGET reds that hold
  # real progress (write-compressor: a green round-trip at 3015 bytes, 515 over
  # the cap, cut at turn 99). The staged artifact carries its own workspace.
  resume=0
  case "$task" in *" @resume") task="${task% @resume}"; resume=1;; esac
  # STAGE THIS TASK'S OWN ARTIFACT. The adapter fetches a single
  # resume-run.json, and auto-resume below writes that same path — so a
  # `@resume` entry that merely trusted whatever was lying there would resume
  # from whichever task happened to be cut most recently. That is not a wrong
  # answer, it is a run continuing SOMEONE ELSE'S dialogue.
  if [ "$resume" = "1" ]; then
    # Pick the most USEFUL prior state, not the newest. A cold re-run that died
    # at turn 15 is newer than the 99-turn artifact holding a half-built encoder,
    # and resuming from the newer one would throw the real work away — the exact
    # loss this whole mechanism exists to prevent. Rank by embedded workspace
    # files first, then turns.
    latest=$(for f in "$TB"/jobs/*/"$task"__*/artifacts/tmp/bantam-evidence/run.json; do
      [ -f "$f" ] || continue
      python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(len((d.get('workspaceSnapshot') or {}).get('files',[])), len(d.get('turns',[])), sys.argv[1])
except Exception: pass" "$f"
    done | sort -k1,1nr -k2,2nr | head -1 | awk '{print $3}')
    if [ -n "$latest" ]; then
      cp "$latest" "$TB/resume-run-$TAG.json"
      echo "$task staging-resume-from $(dirname "$(dirname "$(dirname "$(dirname "$latest")")")" | xargs basename)" >> "$PROGRESS"
    else
      echo "$task no-artifact-to-resume falling-back-to-cold" >> "$PROGRESS"
      resume=0
    fi
  fi
  job="${TAG}-${task}"
  rm -rf "$TB/jobs/$job"
  PYTHONPATH=$TB BANTAM_MAX_TURNS=200 BANTAM_RESUME=$resume BANTAM_RESUME_NAME="resume-run-$TAG.json"  run \
    --agent bantam_agent:BantamAgent -m local/bantam-27b -p "$CAT" -i "$task" \
    --artifact /tmp/bantam-evidence \
    --agent-timeout-multiplier 4.0 --timeout-multiplier 4.0 \
    --n-concurrent 1 -o "$TB/jobs" --job-name "$job" -y >> "$LOG" 2>&1
  r=$(cat "$TB/jobs/$job"/*/verifier/reward.txt 2>/dev/null || echo ERR)

  # AUTO-RESUME. A run cut by the clock or the turn cap is not a wrong answer —
  # it is unfinished work, and its files die with its container unless we carry
  # them forward. The saved artifact now embeds a workspaceSnapshot, so one
  # continuation costs a restage and re-run instead of starting from zero.
  # write-compressor held a green round-trip at 3015 bytes when it was cut at
  # turn 99; corewars was cranking a search at turn 111 of 200. Both would have
  # thrown that away.
  if [ "$r" != "1" ] && [ "$resume" != "1" ]; then
    art=$(ls "$TB/jobs/$job"/*/artifacts/tmp/bantam-evidence/run.json 2>/dev/null | head -1)
    if [ -n "$art" ] && python3 - "$art" <<'PYEOF'
import json,sys
d=json.load(open(sys.argv[1]))
res=d.get("result") or {}
concluded = d.get("done") is not None or res.get("reachedDone") is True
sys.exit(0 if (d.get("partial") is True or not concluded) else 1)
PYEOF
    then
      echo "$task $r cut-resuming" >> "$PROGRESS"
      cp "$art" "$TB/resume-run-$TAG.json"
      rm -rf "$TB/jobs/${job}-resumed"
      PYTHONPATH=$TB BANTAM_MAX_TURNS=200 BANTAM_RESUME=1 BANTAM_RESUME_NAME="resume-run-$TAG.json"  run \
        --agent bantam_agent:BantamAgent -m local/bantam-27b -p "$CAT" -i "$task" \
        --artifact /tmp/bantam-evidence \
        --agent-timeout-multiplier 4.0 --timeout-multiplier 4.0 \
        --n-concurrent 1 -o "$TB/jobs" --job-name "${job}-resumed" -y >> "$LOG" 2>&1
      r2=$(cat "$TB/jobs/${job}-resumed"/*/verifier/reward.txt 2>/dev/null || echo ERR)
      echo "$task $r2 (after resume)" >> "$PROGRESS"
      continue
    fi
  fi
  echo "$task $r" >> "$PROGRESS"
done < "$QUEUE"

echo "ALL DONE" >> "$PROGRESS"
