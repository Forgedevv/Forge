-- Payment anomalies (docs/DECISIONS.md D20): SOL that reached the cashbox from a launchpad owner
-- but could not pay for the job it was sent for, recorded for a manual refund. Written by apps/web
-- (POST /api/payments/confirm) with the service role only: RLS is on and there is no policy, so
-- anon and authenticated clients can neither read nor write the table.
--
-- A row is only written for a transaction verified on-chain: landed without error, signed by the
-- payer, with exactly one transfer from the payer to the cashbox. Reasons:
--   late                the transaction landed after its quote window;
--   amount_mismatch     the amount differs from the quote (`lamports` is null when the amount
--                       could not be read from the verification result: read it on an explorer);
--   launchpad_released  the creation draft was released (slug freed) before the payment arrived;
--   duplicate           a second payment for a job that was already paid.
--
-- `signature` is unique: confirmation retries never record the same transaction twice.
-- Ops list the open anomalies with:
--   select * from payment_anomalies where resolved_at is null order by detected_at;
-- and close one after the refund with:
--   update payment_anomalies set resolved_at = now(), note = '<refund signature>' where id = '...';

create table public.payment_anomalies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id),
  payment_id uuid references public.payments(id),
  wallet text not null
    constraint payment_anomalies_wallet_check check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signature text not null
    constraint payment_anomalies_signature_check
      check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  lamports bigint
    constraint payment_anomalies_lamports_check check (lamports is null or lamports > 0),
  reason text not null
    constraint payment_anomalies_reason_check
      check (reason in ('late', 'amount_mismatch', 'launchpad_released', 'duplicate')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  note text
    constraint payment_anomalies_note_check check (char_length(note) <= 1000),
  constraint payment_anomalies_signature_key unique (signature)
);

create index payment_anomalies_job_id_idx on public.payment_anomalies (job_id);
-- Ops read the anomalies not resolved yet, oldest first.
create index payment_anomalies_open_idx
  on public.payment_anomalies (detected_at) where resolved_at is null;

alter table public.payment_anomalies enable row level security;
revoke all on public.payment_anomalies from public, anon, authenticated;
grant select, insert, update on public.payment_anomalies to service_role;
