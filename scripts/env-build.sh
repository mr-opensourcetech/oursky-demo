#!/usr/bin/env bash
# Runs once when Replit builds the environment: installs everything so that
# starting the environment is fast. Expects the three repos in /root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl git ca-certificates build-essential python3 \
  postgresql redis-server docker.io fontconfig fonts-dejavu-core
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
corepack enable

# The environment spec uses shallow public clones to bootstrap. Retain full
# history for the cloned branches so developers can inspect, rebase, and PR.
bash /root/bluesky-demo/scripts/prepare-git-history.sh \
  /root/bluesky-demo /root/social-app /root/atproto

(cd /root/atproto && pnpm install --frozen-lockfile && pnpm build)
(cd /root/social-app && pnpm install --frozen-lockfile)
(cd /root/bluesky-demo/supabase-chat && npm ci)

# Pre-download the Supabase images. Best effort: if Docker cannot run during
# the build, the first start downloads them instead.
(
  dockerd > /tmp/build-dockerd.log 2>&1 &
  for _ in $(seq 1 30); do docker info > /dev/null 2>&1 && break; sleep 1; done
  cd /root/bluesky-demo/supabase-chat
  npx supabase start -x imgproxy,edge-runtime,logflare,vector,mailpit,storage-api,postgres-meta
  npx supabase stop
  pkill dockerd || true
) || echo "Supabase image pre-download skipped; first start will download them"
