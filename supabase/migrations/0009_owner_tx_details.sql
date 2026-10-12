-- Launch accounts of jobs.owner_tx (docs/INTERFACES.md sections 5 and 6): the `details` the signer
-- returned with the launch transaction (POST /v1/launch-coin/prepare), written by the builder in
-- the same update as owner_tx. apps/web pins them when it checks the stored transaction (core
-- `verifyLaunchCoinTransaction`) and hands them to the browser, instead of reading them back from
-- the transaction itself.
--
-- Shape (`JobOwnerTxDetails`, packages/shared/src/db.ts):
--   { "config": <launchpad coin config>, "pool": <pool>, "creator": <FORGE creator wallet>,
--     "nonceAccount": <durable nonce account>, "metadataUri": "https://..." }
-- Null on rows written before this migration: apps/web then falls back to the accounts found in
-- the transaction and logs `owner_tx.details_missing`.
--
-- Privileges: exactly those of owner_tx. Only the service role writes (clients have no write
-- privilege on jobs, 0002_rls.sql); the owner reads their own row through jobs_select_own (the
-- table-level select grant of 0002 covers the new column, as it covers owner_tx); anon reads
-- nothing.
--
-- Details never outlive their transaction: clearing owner_tx (to rebuild an unsigned launch
-- transaction) must clear owner_tx_details in the same update, otherwise the check below refuses
-- it.

alter table public.jobs add column owner_tx_details jsonb;

-- coalesce: a missing key makes the conditions null, and a null check would pass.
alter table public.jobs add constraint jobs_owner_tx_details_check check (
  owner_tx_details is null or coalesce(
    owner_tx is not null
    and jsonb_typeof(owner_tx_details) = 'object'
    and octet_length(owner_tx_details::text) <= 1024
    and jsonb_typeof(owner_tx_details -> 'config') = 'string'
    and (owner_tx_details ->> 'config') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    and jsonb_typeof(owner_tx_details -> 'pool') = 'string'
    and (owner_tx_details ->> 'pool') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    and jsonb_typeof(owner_tx_details -> 'creator') = 'string'
    and (owner_tx_details ->> 'creator') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    and jsonb_typeof(owner_tx_details -> 'nonceAccount') = 'string'
    and (owner_tx_details ->> 'nonceAccount') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    and jsonb_typeof(owner_tx_details -> 'metadataUri') = 'string'
    and (owner_tx_details ->> 'metadataUri') ~ '^https://[^[:space:]]{1,200}$',
    false
  )
);
