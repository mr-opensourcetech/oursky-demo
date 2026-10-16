#!/usr/bin/env bash
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SOCIAL_APP_DIR:-$DEMO_DIR/../social-app}"
while [ ! -f "$DEMO_DIR/state/runtime.env" ]; do sleep 1; done
set -a
source "$DEMO_DIR/state/runtime.env"
set +a
exec pnpm web --port 8081 --host lan
