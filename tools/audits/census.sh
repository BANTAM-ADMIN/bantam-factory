#!/usr/bin/env bash
# Audit card: census regeneration. Re-runs the declared test command and diffs
# reality against .bantam/known-failures.json. The scheduled form of the check
# that caught the environment campaign's survivorship gap (2026-08-18): the
# manifest is a denominator-counter, and it only counts if someone pulls it.
set -u
out=$(node tools/known-failures.cjs --check --cmd "npm test" 2>&1); code=$?
printf '%s\n' "$out"
if [ "$code" -eq 0 ]; then echo "✓ census: no new failures beyond the declared manifest"
else echo "⚠ census: reality diverges from the manifest (see above)"; fi
exit "$code"
