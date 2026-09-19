#!/bin/bash
# Run this with your GitHub token to create the v1.5.0 release
# Usage: GITHUB_TOKEN=ghp_xxx ./create-release.sh

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: Set GITHUB_TOKEN environment variable"
  echo "Example: GITHUB_TOKEN=ghp_xxx ./create-release.sh"
  exit 1
fi

curl -s -X POST https://api.github.com/repos/BANTAM-ADMIN/bantam-factory/releases \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d @release.json | jq .html_url
