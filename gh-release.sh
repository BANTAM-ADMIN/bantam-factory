#!/bin/bash
# Create GitHub release v2.0.0 using the gh CLI.
# Requires: gh auth login, a release commit on main, and the v2.0.0 tag.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
git push origin main
git push origin v2.0.0
gh release create v2.0.0 \
  --verify-tag \
  --title "Bantam Factory 2.0.0" \
  --notes-file release-notes-2.0.0.md \
  --target main

echo "Release v2.0.0 created successfully!"
