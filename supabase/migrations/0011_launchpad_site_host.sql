-- Exact production host of each client site (docs/INTERFACES.md sections 5 and 6, decision D30).
--
-- Client sites are meant to live at https://<slug>.<CLIENTS_DOMAIN>. Until that domain is
-- verified on Vercel (the devnet beta has none), a site is only reachable at a production alias
-- Vercel gave to its own project, for example https://lp-<slug>.vercel.app. Vercel URLs are never
-- trusted by pattern (anyone can create a *.vercel.app project with a look-alike name), so the
-- builder records the exact host when the site goes live (apps/builder pipeline/deploy.ts): the
-- verified <slug>.<CLIENTS_DOMAIN>, else a *.vercel.app alias that the Vercel API reports for
-- OUR project (project id checked) and our promoted production deployment. Null until recorded,
-- and null again when a release finds no such host.
--
-- Trusted by exact match only, with the launchpad's status rules (apps/web): the RPC relay
-- accepts the origin https://<site_host> (draft and live: every method; sleeping: the creator fee
-- claim only; disabled: refused), coin uploads accept auth.host = site_host, and the dashboard
-- and the coin metadata link to https://<site_host>.
--
-- Shape: a lowercase DNS name without scheme, port, path or trailing dot; under vercel.app,
-- exactly one label (the shape of Vercel's production aliases), never vercel.app itself. The
-- same rule is `isSiteHost` in packages/shared/src/db.ts. Unique: one host trusts one launchpad.
--
-- Privileges: those of the other launchpad columns. Only the service role writes (clients have no
-- write privilege on launchpads, 0002_rls.sql); the owner reads their own row through
-- launchpads_select_own (the table-level select grant of 0002 covers the new column); anon reads
-- nothing.
--
-- Operations: a client's Vercel project that is deleted (or loses its alias) must have site_host
-- cleared in the same operation: a released *.vercel.app name can be claimed by anyone.
--
-- Apply before deploying the apps/web and builder versions that read or write the column.

alter table public.launchpads add column site_host text;

alter table public.launchpads add constraint launchpads_site_host_check check (
  site_host is null or (
    octet_length(site_host) between 4 and 253
    and site_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    and site_host <> 'vercel.app'
    and (
      site_host !~ '\.vercel\.app$'
      or site_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$'
    )
  )
);

-- Nulls are distinct: any number of launchpads may have no recorded host yet.
alter table public.launchpads add constraint launchpads_site_host_key unique (site_host);
