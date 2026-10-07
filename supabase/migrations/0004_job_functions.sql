-- Builder job pickup and stale job recovery (docs/INTERFACES.md section 5). service_role only.

-- 1. Build: newly paid job, or retry after a build failure.
create or replace function public.take_build_job(worker text) returns setof public.jobs
language sql
set search_path = ''
as $$
  update public.jobs set status = 'building', locked_by = worker, locked_at = now(),
    attempts = attempts + 1, failed_stage = null, error = null
  where id = (
    select id from public.jobs
    where (status = 'paid' or (status = 'failed' and failed_stage = 'build' and attempts < 2))
      and locked_at is null
    order by created_at limit 1 for update skip locked
  ) returning *;
$$;

-- 2. After approval: approved (creation -> onchain_setup, modification -> deploying)
--    or owner_signed (-> deploying).
create or replace function public.take_post_approval_job(worker text) returns setof public.jobs
language sql
set search_path = ''
as $$
  update public.jobs set
    status = case
      when status = 'approved' and type = 'create_launchpad' then 'onchain_setup'
      else 'deploying'
    end,
    locked_by = worker, locked_at = now()
  where id = (
    select id from public.jobs
    where status in ('approved', 'owner_signed') and locked_at is null
    order by created_at limit 1 for update skip locked
  ) returning *;
$$;

-- Crashed jobs: active status with a stale lock -> failed, failed_stage from the status, lock reset.
create or replace function public.fail_stale_jobs(stale_minutes int) returns setof public.jobs
language sql
set search_path = ''
as $$
  update public.jobs set
    failed_stage = case status
      when 'building' then 'build'
      when 'onchain_setup' then 'onchain'
      else 'deploy'
    end,
    status = 'failed',
    error = 'stale lock: worker ' || coalesce(locked_by, 'unknown') || ' stopped responding',
    locked_by = null,
    locked_at = null
  where id in (
    select id from public.jobs
    where status in ('building', 'onchain_setup', 'deploying')
      and locked_at is not null
      and locked_at < now() - make_interval(mins => stale_minutes)
    for update skip locked
  ) returning *;
$$;

revoke all on function public.take_build_job(text) from public, anon, authenticated;
revoke all on function public.take_post_approval_job(text) from public, anon, authenticated;
revoke all on function public.fail_stale_jobs(int) from public, anon, authenticated;
grant execute on function public.take_build_job(text) to service_role;
grant execute on function public.take_post_approval_job(text) to service_role;
grant execute on function public.fail_stale_jobs(int) to service_role;
