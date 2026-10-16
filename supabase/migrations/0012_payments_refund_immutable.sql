-- Refund records are final (apps/signer refunds job, docs/DECISIONS.md D4). The signer decides
-- whether a payment is still owed from the database's word (payments.status, refund_signature,
-- the job's state) and re-proves the client's payment on-chain, where it stays valid forever: a
-- row rewritten with the service role key (status back to 'confirmed', refund_signature cleared)
-- would present the same on-chain payment for a second refund on every run. The signer now keeps
-- a local, append-only refund ledger and scans the cashbox history for the refund memo; this
-- trigger is the database side of the same rule. Triggers run for every role, service_role
-- included (RLS does not apply to it, triggers do).
--
-- Rules, each raised as an exception (SQLSTATE 23514, check_violation):
--   - status 'refunded' is final: no update moves it to anything else;
--   - on a 'refunded' row, refund_signature never changes;
--   - a set refund_signature is never replaced by a different one. It may only be cleared, and
--     only while the row is still 'confirmed': the signer releases a signature it has PROVEN
--     unable to land (expired blockhash) that way, and the operator clears one that failed
--     on-chain (nothing moved) to let the signer retry. Both are documented in jobs/refunds.ts;
--     a signature that landed is recorded by the local ledger and refused again regardless;
--   - a row that holds a refund record (status 'refunded' or a refund_signature) is never deleted.
--
-- Idempotent: the function is replaced, the triggers dropped and recreated.

create or replace function public.payments_refund_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'refunded' or old.refund_signature is not null then
      raise exception 'payments: a row with a refund record cannot be deleted (payment %)', old.id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'refunded' then
    if new.status is distinct from 'refunded' then
      raise exception 'payments: status refunded is final (payment %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.refund_signature is distinct from old.refund_signature then
      raise exception 'payments: the refund signature of a refunded payment is final (payment %)', old.id
        using errcode = 'check_violation';
    end if;
  elsif old.refund_signature is not null
    and new.refund_signature is not null
    and new.refund_signature <> old.refund_signature then
    raise exception 'payments: a refund signature is never replaced by another one (payment %)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_refund_immutable_update on public.payments;
create trigger payments_refund_immutable_update
  before update of status, refund_signature on public.payments
  for each row execute function public.payments_refund_immutable();

drop trigger if exists payments_refund_immutable_delete on public.payments;
create trigger payments_refund_immutable_delete
  before delete on public.payments
  for each row execute function public.payments_refund_immutable();
