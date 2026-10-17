-- Kill switch of the signer's fee conversion to SOL (apps/signer/src/jobs/convert.ts).
-- The job fails closed: without this row it stays paused and alerts.
alter table flags drop constraint flags_key_check;
alter table flags add constraint flags_key_check check (key in (
  'deploys_paused', 'buyback_paused', 'signups_paused',
  'claims_paused', 'cashbox_sweep_paused', 'refunds_paused',
  'jupiter_claims_paused', 'convert_paused'
));
insert into flags (key, value) values ('convert_paused', false)
on conflict (key) do nothing;
