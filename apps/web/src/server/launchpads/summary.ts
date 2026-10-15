import type { LaunchpadDetail, LaunchpadSpecDraft, LaunchpadSummary } from '@forge/shared';
import { PublicKey } from '@solana/web3.js';
import { RouteError, NOT_FOUND_MESSAGES } from '../jobs/http';
import { errorName, type RoutesLogger } from '../jobs/log';
import type { JobRecord, LaunchpadRecord, RefundRecord, RoutesStore } from '../jobs/store';
import { toJobView } from '../jobs/views';
import type { ClaimsChain } from './chain';
import {
  byNewest,
  isOpenJob,
  launchpadQuotas,
  walletQuotas,
  type LaunchpadQuotas,
  type WalletQuotas,
} from './quotas';
import { canStartAgain } from './retry';

/*
 * Dashboard reads (docs/frontend/SCREENS.md A8 / A9), owner only. Database rows come from the
 * owner-scoped store; on-chain figures (coins, partner fees to claim) from @forge/core reads.
 * When the chain cannot be read the page still loads: the figures are 0 and `onchainAvailable`
 * says they are not known (never presented as a real zero by the server).
 */

export interface LaunchpadSummaryView extends LaunchpadSummary {
  /** False when the on-chain figures could not be read (they are then 0). */
  onchainAvailable: boolean;
}

export interface LaunchpadDetailView extends LaunchpadDetail {
  onchainAvailable: boolean;
  quotas: LaunchpadQuotas;
}

export interface LaunchpadListView {
  launchpads: LaunchpadSummaryView[];
  quotas: WalletQuotas;
}

export interface LaunchpadReadsDeps {
  store: RoutesStore;
  chain: ClaimsChain;
  logger: RoutesLogger;
  /**
   * CLIENTS_DOMAIN: client sites are served at https://<slug>.<domain>, unless the builder recorded
   * the exact host of the site (`launchpads.site_host`), which wins.
   */
  clientsDomain: string | null;
}

export interface LaunchpadReads {
  list(input: { wallet: string }): Promise<LaunchpadListView>;
  detail(input: { wallet: string; launchpadId: string }): Promise<LaunchpadDetailView>;
}

interface OnchainFigures {
  available: boolean;
  coinsCount: number;
  claimablePartnerFeesLamports: bigint;
}

interface CoinSpec {
  name: string;
  symbol: string;
  imageUrl: string;
}

function specRecord(spec: unknown): Record<string, unknown> {
  return spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : {};
}

function coinOf(spec: unknown): CoinSpec {
  const coin = specRecord(specRecord(spec).launchpadCoin);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { name: str(coin.name), symbol: str(coin.symbol), imageUrl: str(coin.imageUrl) };
}

function parseKey(value: string | null): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

export function createLaunchpadReads(deps: LaunchpadReadsDeps): LaunchpadReads {
  const { store, chain, logger, clientsDomain } = deps;

  /** Where the site really is: its recorded host, else its subdomain (live or sleeping only). */
  function siteUrl(launchpad: LaunchpadRecord): string | null {
    if (launchpad.status !== 'live' && launchpad.status !== 'sleeping') return null;
    if (launchpad.siteHost !== null) return `https://${launchpad.siteHost}`;
    if (!clientsDomain) return null;
    return `https://${launchpad.slug}.${clientsDomain}`;
  }

  async function onchain(launchpad: LaunchpadRecord): Promise<OnchainFigures> {
    const launchpadConfig = parseKey(launchpad.launchpadConfig);
    const coinConfig = parseKey(launchpad.launchpadCoinConfig);
    if (!launchpadConfig && !coinConfig) {
      return { available: true, coinsCount: 0, claimablePartnerFeesLamports: 0n };
    }
    try {
      await chain.assertCluster();
      const [coins, launchCoins] = await Promise.all([
        launchpadConfig ? chain.listCoins(launchpadConfig) : Promise.resolve([]),
        coinConfig ? chain.listCoins(coinConfig) : Promise.resolve([]),
      ]);
      let claimable = 0n;
      for (const coin of [...coins, ...launchCoins]) claimable += coin.fees.claimable.partner.quote;
      return { available: true, coinsCount: coins.length, claimablePartnerFeesLamports: claimable };
    } catch (error) {
      logger.log('warn', 'onchain.read_failed', {
        launchpadId: launchpad.id,
        error: errorName(error),
      });
      return { available: false, coinsCount: 0, claimablePartnerFeesLamports: 0n };
    }
  }

  function summaryOf(
    launchpad: LaunchpadRecord,
    jobs: readonly JobRecord[],
    figures: OnchainFigures,
  ): LaunchpadSummaryView {
    const spec = specRecord(launchpad.spec);
    const active = jobs
      .filter((j) => j.launchpadId === launchpad.id && isOpenJob(j))
      .sort(byNewest)[0];
    return {
      id: launchpad.id,
      name: typeof spec.name === 'string' ? spec.name : launchpad.slug,
      slug: launchpad.slug,
      siteUrl: siteUrl(launchpad),
      status: launchpad.status,
      coin: { ...coinOf(launchpad.spec), mint: launchpad.launchpadCoinMint },
      coinsCount: figures.coinsCount,
      claimablePartnerFeesLamports: figures.claimablePartnerFeesLamports.toString(),
      includedModificationsLeft: Math.max(0, launchpad.includedModificationsLeft),
      activeJobId: active?.id ?? null,
      activeJobStatus: active?.status ?? null,
      canStartAgain: canStartAgain(launchpad, jobs),
      onchainAvailable: figures.available,
    };
  }

  async function list(input: { wallet: string }): Promise<LaunchpadListView> {
    const launchpads = await store.listOwnedLaunchpads(input.wallet);
    const jobs = await store.listOwnedJobs(
      input.wallet,
      launchpads.map((l) => l.id),
    );
    const figures = await Promise.all(launchpads.map(onchain));
    return {
      launchpads: launchpads.map((l, i) => summaryOf(l, jobs, figures[i]!)),
      quotas: walletQuotas(launchpads),
    };
  }

  async function detail(input: {
    wallet: string;
    launchpadId: string;
  }): Promise<LaunchpadDetailView> {
    const launchpad = await store.getOwnedLaunchpad(input.launchpadId, input.wallet);
    if (!launchpad) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.launchpad);
    const jobs = (await store.listOwnedJobs(input.wallet, [launchpad.id])).sort(byNewest);
    const refundedIds = jobs.filter((j) => j.status === 'refunded').map((j) => j.id);
    const refunds =
      refundedIds.length > 0 ? await store.listRefunds(input.wallet, refundedIds) : [];
    const refundOf = new Map<string, RefundRecord>(refunds.map((r) => [r.jobId, r]));
    const figures = await onchain(launchpad);
    return {
      ...summaryOf(launchpad, jobs, figures),
      spec: specRecord(launchpad.spec) as LaunchpadSpecDraft,
      onchain: {
        launchpadConfig: launchpad.launchpadConfig,
        launchpadCoinConfig: launchpad.launchpadCoinConfig,
        launchpadCoinMint: launchpad.launchpadCoinMint,
      },
      versions: jobs
        .filter((j) => j.status === 'live')
        .map((j) => ({
          jobId: j.id,
          createdAt: j.createdAt,
          request: j.request,
          previewUrl: j.previewUrl,
        })),
      jobs: jobs.map((j) => toJobView(j, refundOf.get(j.id) ?? null)),
      quotas: launchpadQuotas(launchpad, jobs),
    };
  }

  return { list, detail };
}
