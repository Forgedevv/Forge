-- 1. The owner's image URLs a launchpad was confirmed from (apps/web coin-images/sources.ts).
--
-- At confirmation (POST /api/spec/confirm) the coin image and the logo are copied into FORGE's R2
-- bucket and launchpads.spec keeps the bucket URLs. This column keeps, by spec field, the owner's
-- URL each copy was made from: {"launchpadCoin.imageUrl": "https://...", "theme.logoUrl": "..."}
-- (only the fields that were copied). Written once by the server; null for a launchpad confirmed
-- before this migration or whose images were already in the bucket.
--
-- Read by the server only, to recognise the owner's original URL without downloading it again:
-- a retried confirmation (its response was lost) is answered from the launchpad, and a
-- modification whose draft still holds the original URL does not copy it again (the source may be
-- down, or serve another image by now). Never sent to the builder or the client site.
--
-- Privileges: those of the other launchpad columns. Only the service role writes (clients have no
-- write privilege on launchpads, 0002_rls.sql); the owner reads their own row through
-- launchpads_select_own (their own URLs); anon reads nothing.
--
-- apps/web reads and writes it best effort (a warning when it cannot): apply this migration
-- before deploying, or confirmations and modifications behave as before it.

alter table public.launchpads add column image_sources jsonb;

alter table public.launchpads add constraint launchpads_image_sources_check check (
  image_sources is null or jsonb_typeof(image_sources) = 'object'
);

-- 2. The last SOL/USD rate accepted by the quote guard (apps/web payments/price-source.ts).
--
-- Every quote's rate must stay within a configured move of the last accepted one. That reference
-- lived in memory only, so a fresh server instance (cold start) accepted any rate within the
-- bounds. apps/web now writes the accepted rate here (at most once a minute per instance) and a
-- fresh instance starts from it when it is younger than one hour (PRICE_REFERENCE_MAX_AGE_MS).
-- When the table cannot be read or written, the guard works from memory as before (a warning).
--
-- One row per pair (only 'SOL/USD'). Written and read by the server with the service role only:
-- RLS is on and there is no policy, so anon and authenticated clients can neither read nor write.

create table public.price_references (
  pair text primary key
    constraint price_references_pair_check check (pair in ('SOL/USD')),
  price numeric(20, 8) not null
    constraint price_references_price_check check (price > 0),
  accepted_at timestamptz not null
);

alter table public.price_references enable row level security;
revoke all on public.price_references from public, anon, authenticated;
grant select, insert, update on public.price_references to service_role;
