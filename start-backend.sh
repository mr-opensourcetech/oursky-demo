#!/usr/bin/env bash
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
: "${DEMO_ORIGIN:?Set DEMO_ORIGIN to the sandbox HTTPS origin}"
export DB_POSTGRES_URL="${DB_POSTGRES_URL:-postgresql:///bluesky_demo?host=/var/run/postgresql&user=root}"
export REDIS_HOST="${REDIS_HOST:-127.0.0.1:6379}"
export LOG_ENABLED=false
pg_isready -q
redis-cli ping | grep -qx PONG
exec node "$DEMO_DIR/server.mjs"
