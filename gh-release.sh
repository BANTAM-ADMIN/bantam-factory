#!/bin/bash
# Create GitHub release v1.4.0 using the gh CLI
# Requires: gh auth login

set -e

# Push main branch first
git push origin main

# Push the v1.4.0 tag
git push origin v1.4.0

# Create the release via gh CLI
gh release create v1.4.0 \
  --title "Bantam Factory 1.4.0" \
  --notes "## What's new

- **Version bump** — package.json updated to 1.4.0.

## Breaking changes

None.

## Upgrade

```bash
git pull
```" \
  --target main

echo "Release v1.4.0 created successfully!"
