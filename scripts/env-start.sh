#!/usr/bin/env bash
# Runs every time the environment starts: brings up PostgreSQL, Redis, Docker,
# Supabase, then the demo. The demo's public address is derived from this
# sandbox's own address, so nothing needs to be configured.
set -euo pipefail
DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$DEMO_DIR/scripts/assert-fixture.mjs"

if [ -z "${DEMO_ORIGIN:-}" ]; then
  : "${REPLIT_DOMAINS:?Set DEMO_ORIGIN when running outside Replit}"
  sandbox_id="${REPLIT_DOMAINS%%-00-*}"
  DEMO_ORIGIN="https://bluesky--${sandbox_id//_/-}.${REPLIT_DOMAINS#*.}"
fi
export DEMO_ORIGIN
echo "Demo address: $DEMO_ORIGIN"

# Startup never fetches, switches, resets, or installs over a developer's work.
# Update branches and dependencies explicitly; fresh builds fetch current code.
echo "Starting checked-out code without changing Git state."

install -d -o postgres -g postgres -m 2775 /var/run/postgresql
service postgresql start
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready -q
su postgres -c "psql -tAc \"select 1 from pg_roles where rolname='root'\"" | grep -q 1 \
  || su postgres -c "createuser -s root"
psql -d postgres -tAc "select 1 from pg_database where datname='bluesky_demo'" | grep -q 1 \
  || createdb bluesky_demo

redis-server --daemonize yes

pgrep dockerd > /dev/null || (dockerd > /tmp/dockerd.log 2>&1 &)
for _ in $(seq 1 60); do docker info > /dev/null 2>&1 && break; sleep 1; done
docker info > /dev/null 2>&1

cd "$DEMO_DIR/supabase-chat"
bash "$DEMO_DIR/scripts/start-supabase.sh"
npx supabase migration up

cd "$DEMO_DIR"
bash start-web.sh > /tmp/bluesky-web.log 2>&1 &
exec bash start-backend.sh
