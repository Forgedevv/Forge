-- Row Level Security. Clients only read; every write goes through server routes (service role).

-- Wallet of the caller, read from the JWT minted by apps/web (custom claim "wallet").
create or replace function public.request_wallet() returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'wallet', '');
$$;

revoke all on function public.request_wallet() from public;
grant execute on function public.request_wallet() to anon, authenticated, service_role;

alter table public.users enable row level security;
alter table public.launchpads enable row level security;
alter table public.jobs enable row level security;
alter table public.payments enable row level security;
alter table public.conversations enable row level security;
alter table public.chat_messages enable row level security;
alter table public.job_events enable row level security;
alter table public.flags enable row level security;

-- Privileges: nothing for clients by default, then explicit read grants.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.users, public.launchpads, public.jobs, public.payments,
  public.conversations, public.chat_messages, public.job_events to authenticated;
grant select on public.flags to anon, authenticated;

create policy users_select_own on public.users
  for select to authenticated
  using (wallet = public.request_wallet());

create policy launchpads_select_own on public.launchpads
  for select to authenticated
  using (owner_wallet = public.request_wallet());

create policy conversations_select_own on public.conversations
  for select to authenticated
  using (owner_wallet = public.request_wallet());

create policy chat_messages_select_own on public.chat_messages
  for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = chat_messages.conversation_id and c.owner_wallet = public.request_wallet()
  ));

create policy jobs_select_own on public.jobs
  for select to authenticated
  using (exists (
    select 1 from public.launchpads l
    where l.id = jobs.launchpad_id and l.owner_wallet = public.request_wallet()
  ));

create policy payments_select_own on public.payments
  for select to authenticated
  using (exists (
    select 1 from public.jobs j
    join public.launchpads l on l.id = j.launchpad_id
    where j.id = payments.job_id and l.owner_wallet = public.request_wallet()
  ));

create policy job_events_select_own on public.job_events
  for select to authenticated
  using (exists (
    select 1 from public.jobs j
    join public.launchpads l on l.id = j.launchpad_id
    where j.id = job_events.job_id and l.owner_wallet = public.request_wallet()
  ));

create policy flags_select_all on public.flags
  for select to anon, authenticated
  using (true);
