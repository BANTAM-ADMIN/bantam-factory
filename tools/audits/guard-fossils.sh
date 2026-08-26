#!/usr/bin/env bash
# Audit card: guard-naming sweep. Lists done-gates that no test NAMES — by
# snake_case, kebab-case, camelCase, or <camel>Objection token under test/.
#
# Verdict semantics, learned on first fire (2026-08-18): "unnamed" is a
# work-list fact, NOT a fossil verdict. v1 flagged 10 gates and 4+ were
# instrument misses (tests name functions in camelCase; immutable_file is
# covered behaviorally by immutable-edit-gate.test.js without ever writing
# "immutable_file"). Looser stem-matching blessed coincidences instead. The
# instrument that can actually rule fossil-vs-alive is gate ENGAGEMENT data
# (src/logic/gate-engagement.js: evaluated-and-silent vs never-evaluated,
# built 2026-07-30) run over an artifact corpus — that is this card's
# promotion path. Until then this sweep hands the desk a review list.
set -u
unnamed=0
for gate in $(grep -o 'name: "[a-z_]*"' src/done-gates.js | cut -d'"' -f2 | sort -u); do
  camel=$(printf '%s' "$gate" | sed -E 's/_(.)/\U\1/g')
  kebab=${gate//_/-}
  alias=$(awk -v g="$gate" '$1 == g { print $2 }' tools/audits/gate-aliases.txt 2>/dev/null | head -1)
  pattern="$gate|$kebab|$camel"
  [ -n "$alias" ] && pattern="$pattern|$alias"
  if ! grep -rqE -- "$pattern" test/ && ! ls test/ | grep -qE -- "$pattern"; then
    echo "unnamed by tests: gate '$gate'"
    unnamed=$((unnamed + 1))
  fi
done
if [ "$unnamed" -eq 0 ]; then echo "✓ guard-naming: every gate is named by at least one test"; exit 0
else echo "⚠ guard-naming: $unnamed gate(s) never named under test/ — review list for the desk, not a fossil verdict"; exit 1; fi
