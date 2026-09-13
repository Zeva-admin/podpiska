create extension if not exists pgcrypto;

create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references admin_users(id) on delete cascade,
  csrf_token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  name varchar(25) not null,
  description varchar(200) not null default '',
  status text not null default 'active' check (status in ('active', 'disabled', 'expired')),
  traffic_limit_bytes bigint not null default 0,
  expires_at timestamptz,
  device_limit integer not null default 0,
  ip_limit integer not null default 0,
  reset_period text not null default 'never' check (reset_period in ('never', 'daily', 'weekly', 'monthly')),
  support_url text not null default '',
  public_token_hash text not null unique,
  public_token_preview varchar(12) not null,
  public_token_ciphertext text not null,
  install_code varchar(32),
  install_id bigint,
  three_xui_email text unique,
  three_xui_sub_id text,
  three_xui_subscription_url text not null default '',
  used_upload_bytes bigint not null default 0,
  used_download_bytes bigint not null default 0,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscription_devices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  hwid text not null,
  os text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active boolean not null default true,
  unique(subscription_id, hwid)
);

create table if not exists subscription_clients (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  panel_email text not null,
  inbound_ids jsonb not null default '[]'::jsonb,
  client_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(subscription_id, panel_email)
);

create table if not exists audit_logs (
  id bigserial primary key,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_status_idx on subscriptions(status);
create index if not exists subscription_devices_subscription_idx on subscription_devices(subscription_id);
create index if not exists sessions_expiry_idx on sessions(expires_at);
