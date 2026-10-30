-- Optional X (Twitter) link of a client-site coin (apps/web POST /api/launchpads/:id/uploads,
-- contract v1, optional `coin.twitter`). Kept on the ticket between `issue` and `complete`, then
-- written into the coin's metadata JSON as `"twitter"`, the key Jupiter and pump-style indexers
-- read.
--
-- Canonical form only, the same pattern as apps/web src/server/uploads/contract.ts
-- (X_URL_PATTERN) and the client sites (src/forge/socials.ts): https://x.com/<handle>, handle 1
-- to 15 letters, digits or underscore. Null for a coin without a link.
--
-- Backward compatible: apps/web only sends the column for a ticket that has a link, so uploads
-- without one keep working on a database where this migration is not applied yet. Apply it
-- before client sites start sending X links (template with the X link field).

alter table public.upload_tickets
  add column coin_twitter text
    constraint upload_tickets_coin_twitter_check
      check (coin_twitter ~ '^https://x\.com/[A-Za-z0-9_]{1,15}$');
