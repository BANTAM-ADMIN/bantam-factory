#!/usr/bin/env bash
# controls.sh — re-run tasks that ALREADY PASS, to prove a harness change did not
# break them. sequencer.sh deliberately skips passing tasks; a control run must not.
#
# Why this exists: on 2026-08-21 the adapter stopped installing the portable
# python over the image's own interpreter (it was overwriting /usr/local/bin/python3
# in 36 of 79 images and changing the subject of tasks like build-cython-ext).
# That is the right fix, and it also REMOVES a numpy/PIL/scipy that 22 passing
# tasks used to get for free. Most never needed it; pytorch-model-cli,
# pytorch-model-recovery and count-dataset-tokens are ML tasks whose images ship
# python3 with no numpy at all. The module-missing steer plus network should cover
# it — but "should" is not a measurement.
#
# Results go to a separate progress file so a control never pollutes the sweep.
set -uo pipefail

TB=
CAT=./terminal-bench
QUEUE="${1:?usage: controls.sh <queue-file> [tag]}"
TAG="${2:-ctl}"
PROGRESS=/tmp/controls-$TAG.progress
LOG=/tmp/controls-$TAG.log
cd "$TB"

while pgrep -f "[h]arbor run" >/dev/null 2>&1; do sleep 30; done

while read -r task; do
  [ -z "$task" ] && continue
  case "$task" in \#*) continue;; esac
  job="${TAG}-${task}"
  rm -rf "$TB/jobs/$job"
  PYTHONPATH=$TB BANTAM_MAX_TURNS=200  run \
    --agent bantam_agent:BantamAgent -m local/bantam-27b -p "$CAT" -i "$task" \
    --artifact /tmp/bantam-evidence \
    --agent-timeout-multiplier 4.0 --timeout-multiplier 4.0 \
    --n-concurrent 1 -o "$TB/jobs" --job-name "$job" -y >> "$LOG" 2>&1
  r=$(cat "$TB/jobs/$job"/*/verifier/reward.txt 2>/dev/null || echo ERR)
  # A control that goes 1 -> 0 is a REGRESSION and the loudest signal here.
  [ "$r" = "1" ] && verdict="held" || verdict="REGRESSED"
  echo "$task $r $verdict" >> "$PROGRESS"
done < "$QUEUE"

echo "ALL DONE" >> "$PROGRESS"
