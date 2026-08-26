#!/usr/bin/env bash
# pack-head.sh — pack bantam.tgz from a CLEAN worktree at HEAD, and PROVE it loads.
#
# Two things this exists to prevent, both of which happened on 2026-08-21:
#
# 1. Packing the WORKING TREE sweeps in another session's uncommitted files and
#    makes measurements depend on whatever they had open. pack-bantam.sh packs the
#    working tree; this packs HEAD, so what runs is exactly what was committed.
#
# 2. Packing by hand and skipping the load smoke. Commit a3a2e2d5 staged agent.js
#    from the working tree, dragging in imports of two files HEAD did not contain;
#    the tgz was repacked by an ad-hoc `tar czf` with no check, and every container
#    from then on died at launch —
#        node:internal/modules/esm/resolve:283
#        Cannot find module '.../src/logic/source-provenance.js'
#    — recording reshard-c4-data and raman-fitting as task failures when the run
#    had never existed. pack-bantam.sh already had a load smoke; the by-hand path
#    bypassed it. A tgz that does not load is not an artifact, it is an outage.
#
# RUN THIS for every repack. It refuses to install a tgz that cannot import.
set -euo pipefail

REPO=.
TB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT=/tmp/bantam-head-wt
CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT

git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"
git -C "$REPO" worktree add --detach "$WT" HEAD -q
cp -r "$REPO/node_modules" "$WT/node_modules"
HEAD_SHA=$(git -C "$WT" rev-parse --short HEAD)

# Pack to a staging file; the live artifact is replaced only after the smoke.
( cd "$WT" && tar czf "$TB/bantam.tgz.new" bin src examples package.json node_modules )

echo "load smoke on the packed bytes (not the source tree)…"
tar xzf "$TB/bantam.tgz.new" -C "$CHECK"
if ! ( cd "$CHECK" && node -e "import('./src/agent.js').then(()=>{console.log('  agent.js imports resolve')}).catch(e=>{console.error('  BROKEN:', e.message.split('\n')[0]); process.exit(1)})" ); then
  rm -f "$TB/bantam.tgz.new"
  echo "FATAL: packed tree does not load — bantam.tgz NOT replaced (HEAD $HEAD_SHA)"
  exit 1
fi
( cd "$CHECK" && node -e "import('./src/done-gates.js').then(m=>console.log('  done-gates:', m.DONE_GATES.length))" )

mv "$TB/bantam.tgz.new" "$TB/bantam.tgz"
echo "packed $(stat -c%s "$TB/bantam.tgz") bytes from CLEAN HEAD $HEAD_SHA — load-checked"
