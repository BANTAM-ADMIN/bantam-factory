#!/bin/bash
# Create GitHub release v1.5.0 using the gh CLI.
# Requires: gh auth login, a release commit on main, and the v1.5.0 tag.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
git push origin main
git push origin v1.5.0
gh release create v1.5.0 \
  --verify-tag \
  --title "Bantam Factory 1.5.0" \
  --notes-file release-notes-1.5.0.md \
  --target main

echo "Release v1.5.0 created successfully!"
