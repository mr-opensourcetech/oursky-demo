-- Direct-message storage for the Bluesky demo, managed by Supabase.
create schema if not exists chat;

create table chat.convos (
  id text primary key,
  rev text not null
);

create table chat.members (
  convo_id text references chat.convos(id) on delete cascade,
  did text,
  muted boolean default false,
  accepted boolean default true,
  left_convo boolean default false,
  last_read bigint default 0,
  primary key (convo_id, did)
);

create table chat.messages (
  n bigserial primary key,
  id text unique,
  convo_id text references chat.convos(id) on delete cascade,
  sender text,
  body text,
  facets jsonb,
  reply_to text,
  sent_at timestamptz,
  rev text,
  hidden_for text[] default '{}'
);
create index on chat.messages (convo_id, n);

create table chat.reactions (
  message_id text,
  sender text,
  value text,
  created_at timestamptz default now(),
  primary key (message_id, sender, value)
);

create table chat.events (
  n bigserial primary key,
  rev text,
  convo_id text,
  audience text[],
  payload jsonb
);
create index on chat.events (rev);

-- The demo's chat service connects as the database owner; anon/authenticated
-- API access stays closed until policies are added.
alter table chat.convos enable row level security;
alter table chat.members enable row level security;
alter table chat.messages enable row level security;
alter table chat.reactions enable row level security;
alter table chat.events enable row level security;

-- Let Supabase Realtime stream new messages.
alter publication supabase_realtime add table chat.messages;
