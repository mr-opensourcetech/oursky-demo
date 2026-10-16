# Bluesky sales-demo sandbox

This setup runs the real `bluesky-social/social-app` web client against
the real AT Protocol development network in `bluesky-social/atproto`.
It is a development fixture, not a production deployment or a public federation.

## Current source pins

- social-app: `e1fa8a3fcd3c668a386ae8e9afd1458ac44d810f`
- atproto: `388dac9f7fdfa5ba8e4af08217b4afdc30d993ee`
- Node: 24.22.0
- social-app pnpm: 11.28.5
- atproto pnpm: 11.11.0 (must also be first on PATH for nested build scripts)
- PostgreSQL 18, Redis 8, compiler toolchain, fontconfig, and DejaVu fonts

The frontend adaptations add `EXPO_PUBLIC_SERVICE_URL`
configuration to local/default/public Bluesky API URLs and use the local
AppView's supported full-size avatar preset instead of the production-only
avatar thumbnail preset. A development-only test-user panel in the main
web shell signs into Alex Morgan (`alex.test`) in one click, without passwords
or a separate launcher page. The changes are local
on branch `demo/local-services`; no upstream repository was modified.

## Services

- Browser gateway: port 3000; open `/` and select "Sign in as test user".
- Optional account picker: `/demo`, for switching among the 15 seeded accounts.
- Expo/Metro: 8081 (proxied through the gateway).
- PDS/account service: 2583.
- AppView/feed service: 2584.
- Local identity directory: 2582.
- Ozone/moderation: 2587.
- PostgreSQL: local Unix socket / port 5432.
- Redis: loopback 6379.

The gateway does not expose administrative XRPC methods. Demo sign-in
accepts same-origin POSTs and authenticates through the normal PDS session API.
Passwords are generated in memory at startup. No real credentials are required.

## Seed data and reset semantics

Startup creates a new isolated database schema set with Alex Morgan as the
one-click test account and 14 historical role-play accounts. All historical
figures died before 1900. Their 100 original imagined posts, 14 conversations
with 42 connected replies, 300 likes, and follow graph are defined in
`history-data.mjs`. Every reply author is alive and an adult in the thread's
stated historical year. These conversations are fiction, not real exchanges
or authentic quotations.

All 15 profile images are AI-generated artistic portraits. Optimized JPEGs
live in `portraits/`; they are loaded and uploaded through the normal PDS API.
Historical years appear in post text; database timestamps are recent demo
activity so the feed remains useful. Profiles, the launcher, and the web UI
disclose the historical-fiction and AI-image status.

Each account has a synthetic adult account birthdate in its normal preferences,
separate from the historical lifetime listed in its biography. Session records
and avatars use real local services.

Demo writes survive page reloads and account switches while the backend runs.
Restarting the backend creates a fresh community and invalidates old sessions.
If an old session reaches the account-loading error screen, use its local-only
"Reconnect test user" action. It obtains a fresh Alex session and removes stale
local account sessions/query caches without clearing unrelated browser settings
or accounts on other servers. The ordinary one-click login uses the same helper.
Old SQL schemas may remain;
this reset is not a production backup/restore mechanism.

The local Explore page reads real profiles through the AppView's account-search
API instead of calling hosted recommendation services that are not configured.
Topic shortcuts and basic post searches use the supported local text-search
endpoint; advanced unsupported filters report a clear limitation rather than
being silently ignored.

The AT Protocol test harness uses development identity/handle resolution and
temporary PDS storage; it is not production federation. Direct messages,
public search/feed generators, push notifications, and external embeds are not
configured. The browser uses Bluesky's real read-only IP geolocation endpoint
for the client's regional age-policy calculation; no social data is sent there.

## Start

Run PostgreSQL and Redis as supervised foreground processes. The local database
`bluesky_demo` must exist and peer authentication must allow the running OS user.
Set `DB_POSTGRES_URL` if your username or database location differs.

Set `DEMO_ORIGIN` to the exact HTTPS sandbox endpoint origin (no path). Run
`bash start-backend.sh`. After it generates `state/runtime.env`, run
`bash start-web.sh` in a separate supervised process.

If checkouts are not siblings of this directory, set `ATPROTO_DIR` and
`SOCIAL_APP_DIR` explicitly. Open `/` once logs say `DEMO_READY`.

## Saving this environment

The current sandbox is working storage, not a saved environment definition.
Before a reusable environment can be built, publish the demo scripts and
frontend configuration change to an approved source repository. Do not patch
source during an environment image build. Build images should prepare
dependencies/compiled artifacts; startup should launch services and seed data.
Verify a fresh sandbox from the saved image, not only this working machine.

## Team workflow

- Everything changes through pull requests. `main` requires one approval from
  someone other than the author and a passing **Demo CI** run.
- Demo CI starts PostgreSQL, Redis and Supabase, runs the full demo, and
  executes `scripts/smoke-test.mjs` (seed counts, sign-in, search, direct
  messages). Run the same check locally with
  `DEMO_ORIGIN=<backend https origin> node scripts/smoke-test.mjs`.
- Content lives in plain files: `history-data.mjs` (people, posts, threads),
  `dms-data.mjs` (direct messages), `portraits/` (profile images).
- Direct messages: `chat.mjs` implements the chat API; its tables are the
  Supabase migration in `supabase-chat/supabase/migrations/`.


