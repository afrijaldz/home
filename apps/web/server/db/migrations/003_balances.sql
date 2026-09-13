create table if not exists balance_snapshots (
  chain_id     integer not null,
  address      text not null check (address ~ '^0x[0-9a-f]{40}$'),
  block_number    bigint not null,
  block_hash      text not null,
  block_timestamp bigint not null,
  observed_at  timestamptz not null,
  stale_at     timestamptz,
  hot_until    timestamptz,
  enumeration_cursor text,
  holdings     jsonb not null,
  coverage     jsonb not null,
  primary key (chain_id, address)
);

create table if not exists webhook_subscriptions (
  subscription_id text primary key,
  secret text not null,
  target text not null,
  event_type text not null,
  created_at timestamptz not null default now()
);
