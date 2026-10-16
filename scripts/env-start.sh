#!/usr/bin/env bash
# Runs every time the environment starts: brings up PostgreSQL, Redis, Docker,
# Supabase, then the demo. The demo's public address is derived from this
# sandbox's own address, so nothing needs to be configured.
set -euo pipefail
DEMO_DIR=/root/bluesky-demo

sandbox_id="${REPLIT_DOMAINS%%-00-*}"
export DEMO_ORIGIN="${DEMO_ORIGIN:-https://bluesky--${sandbox_id//_/-}.${REPLIT_DOMAINS#*.}}"
echo "Demo address: $DEMO_ORIGIN"

# Pull the latest merged code so merged PRs show up on the next start.
# A repo with uncommitted local changes is left alone.
update_repo() {
  local dir=$1 branch=$2 before after
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    echo "$dir has local changes; using the code already here"
    return 1
  fi
  before=$(git -C "$dir" rev-parse HEAD)
  if ! git -C "$dir" fetch --depth 1 origin "$branch" 2>/dev/null; then
    echo "Could not reach GitHub for $dir; using the code already here"
    return 1
  fi
  git -C "$dir" reset --hard FETCH_HEAD > /dev/null
  after=$(git -C "$dir" rev-parse HEAD)
  [ "$before" != "$after" ] && echo "Updated $dir to ${after:0:7}"
}

# dev follows the main branch of every repo. prod (DEMO_ENV=prod) follows only
# the release branch of oursky-demo; the Bluesky app and backend stay as built.
if [ "${DEMO_ENV:-dev}" != prod ]; then
  if update_repo /root/atproto main; then
    (cd /root/atproto && pnpm install --frozen-lockfile && pnpm build) || echo "atproto rebuild failed"
  fi
  if update_repo /root/social-app demo/local-services; then
    (cd /root/social-app && pnpm install --frozen-lockfile) || echo "social-app install failed"
  fi
fi
if update_repo "$DEMO_DIR" "${DEMO_BRANCH:-main}"; then
  (cd "$DEMO_DIR/supabase-chat" && npm ci) || echo "supabase CLI install failed"
fi

install -d -o postgres -g postgres -m 2775 /var/run/postgresql
service postgresql start
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
su postgres -c "psql -tAc \"select 1 from pg_roles where rolname='root'\"" | grep -q 1 \
  || su postgres -c "createuser -s root"
psql -d postgres -tAc "select 1 from pg_database where datname='bluesky_demo'" | grep -q 1 \
  || createdb bluesky_demo

redis-server --daemonize yes

pgrep dockerd > /dev/null || (dockerd > /tmp/dockerd.log 2>&1 &)
for _ in $(seq 1 60); do docker info > /dev/null 2>&1 && break; sleep 1; done

cd "$DEMO_DIR/supabase-chat"
npx supabase start -x imgproxy,edge-runtime,logflare,vector,mailpit,storage-api,postgres-meta
npx supabase migration up

cd "$DEMO_DIR"
bash start-web.sh > /tmp/bluesky-web.log 2>&1 &
exec bash start-backend.sh
