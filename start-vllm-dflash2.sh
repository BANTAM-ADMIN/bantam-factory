#!/usr/bin/env bash
#
# start-vllm-dflash2.sh — bring up the fastest-unconstrained vLLM config for
# Qwen3.8-27B on one RTX 3090, and wait until it actually answers.
#
#   SPEC=dflash2   7-draft block drafter, proposed in one non-autoregressive pass
#   CTX=long       int8_per_token_head KV, TRITON_ATTN
#   MAX_LEN=106496 ~104k context
#   PREFIX_CACHE=1 reuse the KV + recurrent state of a shared prefix
#
# Measured for this box (2026-09-11, generation speed only, first token to last):
#   unconstrained  112-127 tok/s   <-- what this config is for
#   grammar-bound   28-37 tok/s    <-- vLLM's spec-decode collapses under a grammar
#   llama.cpp + MTP-3 beats it under grammar (49 tok/s), loses badly without it.
# So use this for unconstrained work (chat / a harness); use llama.cpp on :8085
# for BANTAM's grammar-constrained action loop. See
# bench/model-serving-bench-2026-09-11.md.
#
#   ./start-vllm-dflash2.sh              # up + wait for health
#   QWEN_REPO=... PORT=18020 ./start-vllm-dflash2.sh
#   WAIT_SECS=900 ./start-vllm-dflash2.sh
#
# Stop it again with the printed command (or `docker compose --profile single stop`).

set -euo pipefail

REPO="${QWEN_REPO:-/home/deveraux/Desktop/nai/novelai-api/models/q38FAST/qwen38-27b-rtx3090}"
PORT="${PORT:-18020}"
WAIT_SECS="${WAIT_SECS:-900}"
CONTAINER="qwen38-27b-rtx3090-single-1"

# The knobs this script owns. They must be written into .env rather than passed
# as a shell prefix, because docker-compose.yml injects .env wholesale via
# `env_file:` — a shell `SPEC=off docker compose up` only affects ${...}
# interpolation and leaves the container's SPEC exactly as the file had it.
CONFIG=(
  "SPEC=dflash2"
  "CTX=long"
  "MAX_LEN=106496"
  "PREFIX_CACHE=1"
  "GPU_UTIL=0.88"
  "KV_MEM=4600000000"
)

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ -d "$REPO" ] || die "serving repo not found at $REPO (override with QWEN_REPO=...)"
command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "cannot reach the docker daemon"
cd "$REPO"

# --- 1. Free the card -------------------------------------------------------
# 24 GB holds one 27B at a time. A llama.cpp server on :8085 will make vLLM's
# pool reservation fail, so it has to go first.
if pgrep -x llama-server >/dev/null 2>&1; then
  say "stopping llama.cpp (llama-server) to free the GPU ..."
  pkill -x llama-server || true
  for _ in $(seq 1 30); do pgrep -x llama-server >/dev/null 2>&1 || break; sleep 1; done
  pgrep -x llama-server >/dev/null 2>&1 && die "llama-server would not stop; kill it by hand"
  say "  llama.cpp stopped"
fi

# --- 2. Pin the config in .env ---------------------------------------------
# Everything else in .env is preserved (API key, WSL2 flags, MAX_SEQS, ...).
[ -f .env ] || : > .env
if [ ! -f .env.bak ]; then
  cp .env .env.bak
  say "backed up the previous .env to $REPO/.env.bak"
fi
for kv in "${CONFIG[@]}"; do
  key="${kv%%=*}"
  if grep -qE "^${key}=" .env; then
    awk -v pat="^${key}=" -v val="$kv" \
      'BEGIN { done = 0 } $0 ~ pat && !done { print val; done = 1; next } { print }' \
      .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s\n' "$kv" >> .env
  fi
done
say "pinned in .env: ${CONFIG[*]}"

# --- 3. Bring it up ---------------------------------------------------------
say "starting vLLM (docker compose --profile single up -d) ..."
docker compose --profile single up -d

# Compose recreates on an env_file change, but verify rather than assume: the
# failure mode is a running server quietly serving the OLD profile, which looks
# like the settings were ignored.
running_spec="$(docker inspect "$CONTAINER" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | sed -n 's/^SPEC=//p' | head -1 || true)"
if [ "$running_spec" != "dflash2" ]; then
  say "container is running SPEC=${running_spec:-<none>}; recreating with the pinned config ..."
  docker compose --profile single up -d --force-recreate
fi

# --- 4. Wait for the API, not for docker's healthcheck ----------------------
# The compose healthcheck has a 900 s start_period, so `docker ps` reports
# "health: starting" long after the endpoint is usable. Poll the endpoint.
say "waiting for http://127.0.0.1:${PORT}/v1/models (up to ${WAIT_SECS}s; first start compiles graphs) ..."
deadline=$(( $(date +%s) + WAIT_SECS ))
until curl -sf -m 3 -o /dev/null "http://127.0.0.1:${PORT}/v1/models"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "no answer after ${WAIT_SECS}s — check: docker logs $CONTAINER"
  fi
  sleep 3
done

model_id="$(curl -s -m 5 "http://127.0.0.1:${PORT}/v1/models" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"

say ""
say "ready."
say "  base URL : http://127.0.0.1:${PORT}/v1"
say "  model    : ${model_id:-unknown}"
say "  config   : SPEC=dflash2 (7 drafts) · CTX=long · max_model_len=106496 · prefix cache on"
say ""
say "  stop with: cd \"$REPO\" && docker compose --profile single stop"
say ""
say "  NOTE: --reasoning-parser qwen3 puts chain-of-thought in the \`reasoning\` field"
say "        and leaves \`message.content\` NULL, so a client that reads only content"
say "        sees empty replies. Either send:"
say "            \"chat_template_kwargs\": {\"enable_thinking\": false}"
say "        or read the reasoning field, or raise max_tokens above the thinking budget."
