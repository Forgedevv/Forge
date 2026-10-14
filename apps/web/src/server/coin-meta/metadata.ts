import { FailedStage, JobStatus, LaunchpadStatus } from '@forge/shared';
import { z } from 'zod';

/*
 * Token metadata JSON of a launchpad coin (Metaplex off-chain metadata), served by the public
 * route GET /api/coin-meta/:slug. The signer writes that route's URL into the coin's on-chain
 * metadata (SIGNER_COIN_METADATA_URL = https://<site host>/api/coin-meta/{slug}), so wallets and
 * explorers read the name, symbol, description and image from here.
 *
 * The URI is immutable on-chain: the route path must stay short and stable. Only what the coin
 * displays is exposed, built from the launchpad's confirmed spec; never an internal field.
 */

/** Path prefix of the route; with a 32-byte slug the URI must fit the launch transaction. */
export const COIN_META_PATH = '/api/coin-meta/';

/** Statuses of the creation job from which the coin may exist on-chain (approved or later). */
export const APPROVED_JOB_STATUSES: readonly JobStatus[] = [
  'approved',
  'onchain_setup',
  'awaiting_owner_signature',
  'owner_signed',
  'deploying',
  'live',
];

/** A failure after approval (configs or the coin may exist): the metadata stays served. */
const FAILED_AFTER_APPROVAL: readonly FailedStage[] = ['onchain', 'deploy'];

export interface CoinMetaRecord {
  slug: string;
  status: LaunchpadStatus;
  spec: unknown;
  /** The launchpad's newest `create_launchpad` job, if any. */
  createJob: { status: JobStatus; failedStage: FailedStage | null } | null;
}

export interface CoinMetadata {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  external_url?: string;
}

/**
 * The coin of a launchpad is public once the client approved its preview: the creation job
 * reached `approved` (or later, including a failure after approval), or the launchpad is live or
 * sleeping. A disabled launchpad is cut (its site is gone too); drafts are never exposed.
 */
export function isCoinPublic(record: CoinMetaRecord): boolean {
  if (record.status === 'disabled') return false;
  if (record.status === 'live' || record.status === 'sleeping') return true;
  const job = record.createJob;
  if (!job) return false;
  if (APPROVED_JOB_STATUSES.includes(job.status)) return true;
  return (
    job.status === 'failed' &&
    job.failedStage !== null &&
    FAILED_AFTER_APPROVAL.includes(job.failedStage)
  );
}

/** Only https images reach wallets (no http, data: or javascript: URL). */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of the stored spec the metadata uses (the spec was validated at confirmation). */
const StoredCoin = z.object({
  launchpadCoin: z.object({
    name: z.string().min(1).max(64),
    symbol: z.string().regex(/^[A-Z0-9]{2,10}$/),
    description: z.string().max(500).optional(),
    imageUrl: z.unknown().optional(),
  }),
  theme: z.object({ logoUrl: z.unknown().optional() }).optional(),
});

/**
 * The metadata JSON of `record`'s coin, or null when its spec does not hold a usable coin. The
 * name and symbol are exactly those of the spec, which the signer put on-chain.
 */
export function buildCoinMetadata(
  record: CoinMetaRecord,
  clientsDomain: string | null,
): CoinMetadata | null {
  const parsed = StoredCoin.safeParse(record.spec);
  if (!parsed.success) return null;
  const { launchpadCoin, theme } = parsed.data;
  const image = httpsUrl(launchpadCoin.imageUrl) ?? httpsUrl(theme?.logoUrl);
  return {
    name: launchpadCoin.name,
    symbol: launchpadCoin.symbol,
    description: launchpadCoin.description ?? '',
    ...(image ? { image } : {}),
    ...(clientsDomain ? { external_url: `https://${record.slug}.${clientsDomain}` } : {}),
  };
}
