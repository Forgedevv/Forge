import { isSiteHost, isVercelAppHost } from '@forge/shared';
import { projectNameForSlug } from '../vercel.js';

/**
 * The canonical host of a released client site (`launchpads.site_host`, migration 0011), chosen
 * from what Vercel reports, never from a name pattern: anyone can create a `*.vercel.app` project
 * with a look-alike name, so only hosts read from the API for OUR project count.
 *
 * Order of preference:
 * 1. `<slug>.<CLIENTS_DOMAIN>` once Vercel verified it on the project (`attachSubdomain`);
 * 2. a `*.vercel.app` production alias of the project's promoted deployment
 *    (`listProductionHosts`, project and deployment checked on every alias record):
 *    `lp-<slug>.vercel.app` first (Vercel only gives it when the name is free everywhere), then
 *    the other `lp-<slug>-*` aliases (`lp-<slug>-<team>.vercel.app`), then any other one, each
 *    group shortest first, then in alphabetical order, so a re-run picks the same host;
 * 3. none (null): nothing verified serves the site yet.
 *
 * Any other host the project may hold (a custom domain added by hand) is never recorded.
 */
export interface SiteHostInput {
  slug: string;
  /** Result of `attachSubdomain`: the client subdomain and whether Vercel verified it. */
  subdomain: { domain: string; verified: boolean } | null;
  /** Production hosts of the promoted deployment of the launchpad's own project. */
  productionHosts: readonly string[];
}

function byLengthThenName(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function chooseSiteHost(input: SiteHostInput): string | null {
  const { slug, subdomain } = input;
  if (
    subdomain !== null &&
    subdomain.verified &&
    subdomain.domain.startsWith(`${slug}.`) &&
    isSiteHost(subdomain.domain) &&
    !isVercelAppHost(subdomain.domain)
  ) {
    return subdomain.domain;
  }
  const project = projectNameForSlug(slug);
  const aliases = [...new Set(input.productionHosts)].filter(isVercelAppHost);
  const exact = `${project}.vercel.app`;
  if (aliases.includes(exact)) return exact;
  const ownNamed = aliases.filter((h) => h.startsWith(`${project}-`)).sort(byLengthThenName);
  const others = aliases.filter((h) => !h.startsWith(`${project}-`)).sort(byLengthThenName);
  return ownNamed[0] ?? others[0] ?? null;
}
