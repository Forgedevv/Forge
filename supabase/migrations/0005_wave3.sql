-- Wave 3 follow-ups: signer kill switches, one creation job per launchpad, chat state columns.

-- Kill switches for the signer jobs (claims, cashbox sweep, refunds).
alter table flags drop constraint flags_key_check;
alter table flags add constraint flags_key_check check (key in (
  'deploys_paused', 'buyback_paused', 'signups_paused',
  'claims_paused', 'cashbox_sweep_paused', 'refunds_paused'
));
insert into flags (key, value) values
  ('claims_paused', false),
  ('cashbox_sweep_paused', false),
  ('refunds_paused', false)
on conflict (key) do nothing;

-- A launchpad has exactly one creation job: a double confirmation can never create a second one.
create unique index jobs_one_create_per_launchpad_idx
  on jobs (launchpad_id) where type = 'create_launchpad';

-- Chat state: current draft spec and accumulated model cost per conversation.
alter table conversations add column spec jsonb;
alter table conversations add column cost_usd numeric(12, 6) not null default 0;
