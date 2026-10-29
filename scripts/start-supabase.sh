#!/usr/bin/env bash
# Docker can restore existing containers before their health checks are ready.
# Retry only that transient Supabase status error, never arbitrary failures.
set -euo pipefail
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for attempt in $(seq 1 12); do
  if npx supabase start -x imgproxy,edge-runtime,logflare,vector,mailpit,storage-api,postgres-meta > "$log" 2>&1; then
    # Successful CLI output includes credentials; keep it out of startup logs.
    echo "Supabase started."
    exit 0
  fi
  if ! grep -q 'StatusDbNotReadyError' "$log" || [ "$attempt" = 12 ]; then
    cat "$log" >&2
    exit 1
  fi
  echo "Waiting for the existing Supabase database to become ready ($attempt/12)."
  sleep 5
done
