#!/usr/bin/env bash
# audit-gate — make "read the running context" the lit button instead of a
# discipline I have to remember.
#
# 2026-08-21, the operator, after saying it every single turn:
#
#   "You keep stopping, fucking around, not following up, not looking at
#    context, and EVERY TIME you look, you find an issue. EVERY TIME."
#
# He was right, and the hit rate never dropped: 23 context defects in one
# session, one per deliberate look. The failure was never the looking — it was
# that looking was OPTIONAL and reporting was free. So this is the same fix this
# factory applies to every other station: a rule advises, a GATE enforces.
#
# The gate: while a terminal-bench task container is alive, a turn may not end
# unless that turn actually read the run's stream — not a turn count, not
# `docker ps`, the stream. Anything else is a status report, which is the exact
# move that cost this session its afternoons.
#
# Three hooks share one script so the state machine lives in a single place:
#   turn   UserPromptSubmit — new turn, clear the evidence
#   mark   PreToolUse/Bash  — this command read a run's context; record it
#   gate   Stop             — refuse to stop if a run is live and unread
#
# Fails OPEN everywhere. A gate that wedges the session it was meant to sharpen
# is worse than no gate — same reason shell-syntax-guard swallows its own errors.

set -uo pipefail

STATE_ROOT=/tmp/bantam-audit-gate

# Terminal-bench containers are named <task>__<trialhash>__env-main-N by harbor.
# Anchoring on that shape keeps the operator's OWN long-lived stacks
# (tilde-deploy-*, foundation_static_v2-*) from ever tripping the gate.
BENCH_RE='__[A-Za-z0-9]+__env'

# What counts as having looked. The stream is the definitive gauge; run.json and
# the evidence dir are the same evidence by another path.
AUDIT_RE='stream\.log|bantam-evidence|run\.json'

session_dir() {
  local payload="${1-}" sid
  sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
  [ -n "$sid" ] || sid=default
  # A session id is opaque; keep it to characters that cannot escape the path.
  sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')
  printf '%s/%s' "$STATE_ROOT" "$sid"
}

live_containers() {
  timeout 10 docker ps --format '{{.Names}}' 2>/dev/null | grep -E "$BENCH_RE" || true
}

payload=$(cat 2>/dev/null || true)
dir=$(session_dir "$payload")
mkdir -p "$dir" 2>/dev/null || exit 0

case "${1-}" in
  turn)
    # A new prompt is a new turn: the previous turn's audit does not count for
    # this one, and the once-per-turn block budget resets.
    rm -f "$dir/audited" "$dir/blocked" 2>/dev/null
    : > "$dir/turn"
    ;;

  mark)
    cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
    if printf '%s' "$cmd" | grep -Eq "$AUDIT_RE"; then
      : > "$dir/audited"
    fi
    ;;

  gate)
    names=$(live_containers)
    [ -n "$names" ] || exit 0                       # nothing running: nothing to audit
    [ -f "$dir/audited" ] && exit 0                 # already looked this turn
    [ -f "$dir/blocked" ] && exit 0                 # block once per turn, never wedge

    : > "$dir/blocked"
    one=$(printf '%s' "$names" | head -1)
    count=$(printf '%s\n' "$names" | grep -c . )
    reason=$(cat <<EOF
AUDIT GATE: ${count} terminal-bench container(s) are running and you have not read what any of them is DOING this turn.

  $(printf '%s' "$names" | sed 's/^/  /')

A turn count is not evidence and "it is still running" is not a status. Before you end this turn, read the stream and the signal counts:

  docker exec ${one} tail -c 2500 /tmp/bantam-evidence/stream.log
  docker exec ${one} sh -c 'L=/tmp/bantam-evidence/stream.log; for p in "\[gate" invalid repetition "No module named" "command not found" "\[timeout\]"; do printf "%-22s %s\n" "\$p" "\$(grep -c -- "\$p" \$L)"; done'

stream.log carries ACTIONS and one-line results, never observations -- so gate steers ([churn], [bulk-edit], anything appended to result.observation) do NOT appear there. For those, read /tmp/bantam-evidence/run.json instead; grepping the stream for them returns 0 on a run where they fired.

Then look for the workaround tells that are invisible in a status line: an explicit interpreter path where a plain one should work (/usr/bin/python3 vs python3), the same probe re-run with a different flag, a rewritten command. Those mean OUR context is broken, not the model.

Every single look in this session found a defect. Not looking is the defect.
EOF
)
    jq -n --arg r "$reason" '{decision:"block", reason:$r}' 2>/dev/null \
      || printf '{"decision":"block","reason":"AUDIT GATE: a terminal-bench container is running and you have not read its stream.log this turn."}\n'
    ;;
esac

exit 0
