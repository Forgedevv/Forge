import type { NextApiRequest, NextApiResponse } from 'next';
import { onchainConfig, siteConfig } from '@/forge/config';
import { solNumberToLamports } from '@/forge/create/amounts';
import { createLaunchBuilder } from '@/forge/create/launch-builder';
import { launchPlatformFeeWallet } from '@/forge/create/platform-fee';
import { createPrepareHandler } from '@/forge/create/prepare-handler';
import { createUploadClient, resolveForgeApiBase } from '@/forge/create/upload-client';
import { currentMode, rejectIfNotLive } from '@/forge/mode-guard';
import { resolveRelayUrl } from '@/forge/relay';
import { createServerRelayConnection, serverRelayHeaders } from '@/forge/server-relay';

/**
 * Coin preparation (`POST /api/upload`, contract in `src/forge/create/api.ts`). All the logic is in
 * the locked zone (`src/forge/create/prepare-handler.ts`). This route holds no secret: chain reads
 * go through the FORGE RPC relay and files through the FORGE upload endpoint. When either is not
 * configured it answers 503 and stores nothing. Both calls carry the per-launchpad server token
 * (`FORGE_RPC_RELAY_TOKEN`, server-only) when it is set.
 */

// The body is read by the handler with its own size cap (2 MB image as base64).
export const config = { api: { bodyParser: false } };

function readPublicBaseUrl(): string | null {
  const raw = process.env.R2_PUBLIC_URL || process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function launchpadFeeLamports(): bigint | undefined {
  const fee = onchainConfig?.poolCreationFeeSol;
  return fee === undefined ? undefined : solNumberToLamports(fee);
}

let handler: ReturnType<typeof createPrepareHandler> | null = null;

// Built lazily so that `next build` works without any environment variable.
function getHandler(): ReturnType<typeof createPrepareHandler> {
  if (handler) return handler;
  const relay = resolveRelayUrl(process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL);
  const apiBase = resolveForgeApiBase(
    process.env.NEXT_PUBLIC_FORGE_API_URL,
    process.env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL,
  );
  const launchpadConfig = onchainConfig?.launchpadConfig;
  const poolCreationFeeLamports = launchpadFeeLamports();
  // Same public value the browser verifies the first-buy platform fee against.
  const platformFeeWallet = launchPlatformFeeWallet();
  handler = createPrepareHandler({
    mode: currentMode(),
    slug: siteConfig.slug,
    launchpadConfig,
    poolCreationFeeLamports,
    platformFeeWallet,
    launchBuilder:
      relay && launchpadConfig && poolCreationFeeLamports !== undefined
        ? createLaunchBuilder({
            connection: createServerRelayConnection(relay),
            launchpadConfig,
            poolCreationFeeLamports,
            ownerWallet: onchainConfig?.ownerWallet,
            platformFeeWallet,
          })
        : null,
    uploadClient: apiBase
      ? createUploadClient({
          apiBase,
          slug: siteConfig.slug,
          publicBaseUrl: readPublicBaseUrl(),
          forgeHeaders: serverRelayHeaders(),
        })
      : null,
  });
  return handler;
}

export default async function upload(req: NextApiRequest, res: NextApiResponse) {
  if (rejectIfNotLive(req, res)) return;
  await getHandler()(req, res);
}
