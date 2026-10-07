-- FORGE schema (docs/INTERFACES.md section 5).

create extension if not exists pgcrypto;

create table users (
  wallet text primary key,
  created_at timestamptz not null default now()
);

create table launchpads (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null references users(wallet),
  slug text unique not null,
  spec jsonb not null,
  github_repo text,
  vercel_project_id text,
  launchpad_config text,
  launchpad_coin_config text,
  launchpad_coin_mint text,
  creator_wallet_ref text,
  included_modifications_left int not null default 2,
  status text not null default 'draft'
    constraint launchpads_status_check check (status in ('draft', 'live', 'sleeping', 'disabled')),
  last_trade_at timestamptz,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  launchpad_id uuid not null references launchpads(id),
  type text not null
    constraint jobs_type_check check (type in ('create_launchpad', 'modify_launchpad')),
  status text not null
    constraint jobs_status_check check (status in (
      'spec_ready', 'paid', 'building', 'preview_ready', 'approved', 'onchain_setup',
      'awaiting_owner_signature', 'owner_signed', 'deploying', 'live', 'failed', 'refunded'
    )),
  attempts int not null default 0,
  failed_stage text
    constraint jobs_failed_stage_check check (failed_stage in ('build', 'onchain', 'deploy')),
  request text,
  preview_url text,
  owner_tx text,
  error text,
  api_cost_usd numeric not null default 0,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  payer_wallet text not null,
  kind text not null
    constraint payments_kind_check check (kind in ('creation', 'modification')),
  usd_amount numeric not null,
  lamports bigint not null,
  quote_expires_at timestamptz not null,
  tx_signature text unique,
  status text not null default 'quoted'
    constraint payments_status_check check (status in ('quoted', 'confirmed', 'expired', 'refunded')),
  refund_signature text,
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null references users(wallet),
  launchpad_id uuid references launchpads(id),
  created_at timestamptz not null default now()
);

create table chat_messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id),
  role text not null
    constraint chat_messages_role_check check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create table job_events (
  id bigserial primary key,
  job_id uuid not null references jobs(id),
  message text not null,
  created_at timestamptz not null default now()
);

create table flags (
  key text primary key
    constraint flags_key_check check (key in ('deploys_paused', 'buyback_paused', 'signups_paused')),
  value boolean not null default false
);

create index jobs_status_created_at_idx on jobs (status, created_at);
create index jobs_launchpad_id_idx on jobs (launchpad_id);
create index payments_job_id_idx on payments (job_id);
create index job_events_job_id_id_idx on job_events (job_id, id);
create index conversations_owner_wallet_idx on conversations (owner_wallet);
create index chat_messages_conversation_id_id_idx on chat_messages (conversation_id, id);
create index launchpads_owner_wallet_idx on launchpads (owner_wallet);

create function set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

insert into flags (key, value) values
  ('signups_paused', false),
  ('deploys_paused', false),
  ('buyback_paused', false);
