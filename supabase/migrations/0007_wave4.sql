-- Wave 4 follow-up: at most one open modification job per launchpad.
create unique index jobs_one_open_modification_idx
  on jobs (launchpad_id)
  where type = 'modify_launchpad' and status not in ('live', 'failed', 'refunded');
