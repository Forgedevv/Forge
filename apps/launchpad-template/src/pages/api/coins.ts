import type { NextApiRequest, NextApiResponse } from 'next';
import { createCoinsHandler } from '@/forge/data/onchain/handler';
import { createOnchainCoinService, type OnchainCoinService } from '@/forge/data/onchain/service';
import { resolveRelayUrl } from '@/forge/relay';
import { createServerRelayConnection } from '@/forge/server-relay';

/**
 * This launchpad's coins read on-chain (`GET /api/coins`, contract in
 * `src/forge/data/onchain/handler.ts`): the fallback of the Jupiter data API, and the only coin
 * data source on devnet. All the logic is in the locked zone. Chain reads go through the FORGE RPC
 * relay with the per-launchpad server token (`FORGE_RPC_RELAY_TOKEN`); without a relay the route
 * answers 503.
 */

function readStorageOrigin(): string | null {
  const raw = process.env.R2_PUBLIC_URL || process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

let service: OnchainCoinService | null | undefined;

// Built lazily so that `next build` works without any environment variable.
function getService(): OnchainCoinService | null {
  if (service !== undefined) return service;
  const relay = resolveRelayUrl(process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL);
  service = relay
    ? createOnchainCoinService({
        connection: createServerRelayConnection(relay),
        storageOrigin: readStorageOrigin(),
      })
    : null;
  return service;
}

const handler = createCoinsHandler({ service: getService });

export default async function coins(req: NextApiRequest, res: NextApiResponse) {
  await handler(req, res);
}
