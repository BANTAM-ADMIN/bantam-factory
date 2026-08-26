#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  run-dev.sh — boot Bantam (development build)
#
#  Usage:
#    ./bin/run-dev.sh
#    ./bin/run-dev.sh --task "make the rooster flap"
#    ./bin/run-dev.sh --task "fix the bug" --workspace ./my-project
#    ./bin/run-dev.sh self-improve --plan
#    ./bin/run-dev.sh self-improve
#    ./bin/run-dev.sh --smoke
#    ./bin/run-dev.sh --help
#
#  This script:
#    1. Checks for the two runtime deps (acorn + acorn-walk). If missing,
#       downloads them directly (no npm install needed).
#    2. Always launches this checkout's development entry point, never a
#       global `bantam` command.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NM="$ROOT/node_modules"
NODE_BIN="${BANTAM_NODE_BIN:-node}"
ENTRYPOINT="$SCRIPT_DIR/bantam.js"

# ── ensure deps ──────────────────────────────────────────────────
ensure_pkg() {
  local pkg="$1" version="$2" expected_sha512="$3"
  local dir="$NM/$pkg"
  if [ -e "$dir" ]; then
    if [ -f "$dir/package.json" ] \
      && grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"$version\"" "$dir/package.json"; then
      return 0
    fi
    echo "[run-dev] refusing incomplete or mismatched dependency: $dir (expected $pkg@$version)" >&2
    return 1
  fi

  echo "[run-dev] downloading $pkg@$version …"
  mkdir -p "$NM"
  local stage archive unpack actual_sha512
  stage="$(mktemp -d "$NM/.${pkg}.install.XXXXXX")"
  archive="$stage/package.tgz"
  unpack="$stage/unpack"
  mkdir -p "$unpack"

  local url="https://registry.npmjs.org/$pkg/-/${pkg}-${version}.tgz"
  if ! curl -fsSL "$url" -o "$archive"; then
    rm -rf "$stage"
    return 1
  fi
  if ! actual_sha512="$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)"; then
    rm -rf "$stage"
    return 1
  fi
  if [ "$actual_sha512" != "$expected_sha512" ]; then
    echo "[run-dev] integrity check failed for $pkg@$version" >&2
    rm -rf "$stage"
    return 1
  fi
  if ! tar -xzf "$archive" -C "$unpack" \
    || [ ! -f "$unpack/package/package.json" ] \
    || ! grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"$version\"" "$unpack/package/package.json"; then
    echo "[run-dev] invalid package archive for $pkg@$version" >&2
    rm -rf "$stage"
    return 1
  fi
  if ! mv "$unpack/package" "$dir"; then
    rm -rf "$stage"
    return 1
  fi
  rm -rf "$stage"
  echo "[run-dev] $pkg ready."
}

# Versions from package.json (acorn ^8.17.0, acorn-walk ^8.3.5)
ensure_pkg "acorn" "8.17.0" "xRQbDb9BnwDafYNn6Vwl839DYVjqXYb1XVGtWAZ1kcDc6iwAL4hg3B1dZlRiuENFeO2H53gFG3in621AdERVAg=="
ensure_pkg "acorn-walk" "8.3.5" "HEHNfbars9v4pgpW6SO1KSPkfoS0xVOM/9UzkJltjlsHZmJasxg8aXkuZa7SMf8vKGIBhpUsPluQSqhJFCqebw=="

# ── quick smoke-test (optional, run with --smoke flag) ───────────
if [ "${1:-}" = "--smoke" ]; then
  shift
  "$NODE_BIN" "$ENTRYPOINT" health "$@"
  echo "[run-dev] smoke OK — development Bantam is alive."
  exit 0
fi

# Preserve the documented shorthand while passing every other invocation
# through unchanged.
if [ "${1:-}" = "--task" ]; then
  set -- run "$@"
fi

# ── launch ───────────────────────────────────────────────────────
if [ ! -f "$ENTRYPOINT" ]; then
  echo "[run-dev] development entry point not found: $ENTRYPOINT" >&2
  exit 1
fi
exec "$NODE_BIN" "$ENTRYPOINT" "$@"
