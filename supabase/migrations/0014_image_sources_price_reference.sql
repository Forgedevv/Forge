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
