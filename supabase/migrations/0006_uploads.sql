-- Coin image upload tickets for client sites (apps/web POST /api/launchpads/:id/uploads,
-- contract v1). Written and read by apps/web with the service role only: RLS is on and there is
-- no policy, so anon and authenticated clients can neither read nor write the table.
--
-- Single use is enforced here, so it holds across server instances:
--   (wallet, nonce)  a signed wallet authorization issues at most one ticket;
--   mint             a coin mint gets at most one ticket (and one staging / image / metadata key).
--
-- The presigned PUT writes the staging key (`pending/...`); apps/web writes the public image key
-- itself once the staged bytes are verified. The sweep (POST /api/internal/uploads/sweep) marks
-- tickets never completed as `expired` and records in `swept_at` that their leftover objects
-- were deleted.

create table public.upload_tickets (
  id text primary key
    constraint upload_tickets_id_check check (id ~ '^[A-Za-z0-9_-]{22}$'),
  launchpad_id uuid not null references public.launchpads(id),
  wallet text not null
    constraint upload_tickets_wallet_check check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  nonce text not null
    constraint upload_tickets_nonce_check check (nonce ~ '^[0-9a-f]{32}$'),
  -- SHA-256 of the canonical request: an identical retry gets the same ticket back.
  request_sha256 text not null
    constraint upload_tickets_request_sha256_check check (request_sha256 ~ '^[0-9a-f]{64}$'),
  mint text not null
    constraint upload_tickets_mint_check check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  host text not null
    constraint upload_tickets_host_check check (char_length(host) between 1 and 253),
  content_type text not null
    constraint upload_tickets_content_type_check
      check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  image_size integer not null
    constraint upload_tickets_image_size_check check (image_size between 1 and 2097152),
  image_sha256 text not null
    constraint upload_tickets_image_sha256_check check (image_sha256 ~ '^[0-9a-f]{64}$'),
  upload_key text not null
    constraint upload_tickets_upload_key_check check (upload_key like 'pending/%'),
  image_key text not null,
  metadata_key text not null,
  coin_name text not null
    constraint upload_tickets_coin_name_check check (char_length(coin_name) between 1 and 32),
  coin_symbol text not null
    constraint upload_tickets_coin_symbol_check check (char_length(coin_symbol) between 1 and 10),
  coin_description text not null
    constraint upload_tickets_coin_description_check check (char_length(coin_description) <= 500),
  first_buy_lamports text not null
    constraint upload_tickets_first_buy_check check (first_buy_lamports ~ '^[0-9]{1,20}$'),
  status text not null default 'issued'
    constraint upload_tickets_status_check
      check (status in ('issued', 'completed', 'rejected', 'expired')),
  rejection text,
  metadata_sha256 text
    constraint upload_tickets_metadata_sha256_check check (metadata_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  swept_at timestamptz,
  created_at timestamptz not null default now(),
  constraint upload_tickets_wallet_nonce_key unique (wallet, nonce),
  constraint upload_tickets_mint_key unique (mint),
  constraint upload_tickets_completed_check
    check (status <> 'completed' or (metadata_sha256 is not null and completed_at is not null))
);

-- Durable rate limits count recent tickets per wallet and per launchpad.
create index upload_tickets_wallet_issued_at_idx on public.upload_tickets (wallet, issued_at);
create index upload_tickets_launchpad_issued_at_idx
  on public.upload_tickets (launchpad_id, issued_at);
-- The sweep reads the tickets not swept yet, oldest first.
create index upload_tickets_unswept_idx
  on public.upload_tickets (issued_at) where swept_at is null;

alter table public.upload_tickets enable row level security;
revoke all on public.upload_tickets from public, anon, authenticated;
grant select, insert, update on public.upload_tickets to service_role;
