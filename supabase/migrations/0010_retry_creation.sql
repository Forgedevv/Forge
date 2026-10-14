-- Start again (apps/web POST /api/launchpads/:id/retry): a draft whose creation job was refunded
-- gets a NEW `create_launchpad` job, built from the same stored spec, so the owner keeps the name
-- and the subdomain. 0005 allowed exactly one creation job per launchpad; this replaces it with:
-- at most one creation job that is not refunded per launchpad.
--
-- What the index guarantees, whatever the application does:
--   - a double confirmation (or a double "start again") still never creates two open creation
--     jobs: the second insert fails with a unique violation (23505) and the winner is read back;
--   - no new creation job while another one is in progress, live, or `failed` (a build retry or a
--     refund still pending, or a failure after approval left to manual handling, D18): only
--     `refunded` creation jobs, whose payment went back to the owner, step aside;
--   - a refunded job can never be moved back to another status while a newer one exists.
--
-- Rows written before this migration hold at most one creation job per launchpad, so the new
-- index always builds. Idempotent and forward-only; the migration script runs each file in a
-- transaction, so no insert can slip between the two statements.

drop index if exists public.jobs_one_create_per_launchpad_idx;

create unique index if not exists jobs_one_open_create_per_launchpad_idx
  on public.jobs (launchpad_id)
  where type = 'create_launchpad' and status <> 'refunded';
