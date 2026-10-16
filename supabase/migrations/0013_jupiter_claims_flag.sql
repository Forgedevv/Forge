-- Kill switch of the signer's daily Jupiter referral claims (apps/signer/src/jobs/jupiter-claims.ts).
-- The job fails closed: without this row it stays paused and alerts.
alter table flags drop constraint flags_key_check;
alter table flags add constraint flags_key_check check (key in (
  'deploys_paused', 'buyback_paused', 'signups_paused',
  'claims_paused', 'cashbox_sweep_paused', 'refunds_paused',
  'jupiter_claims_paused'
));
insert into flags (key, value) values ('jupiter_claims_paused', false)
on conflict (key) do nothing;
