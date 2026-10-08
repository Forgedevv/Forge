import { Connection } from '@solana/web3.js';
import { readTradeEnv, resolveRelayUrl } from './trade-config';

let cached: { url: string; connection: Connection } | null = null;

/**
 * Connection through the FORGE RPC relay. The browser never talks to an RPC provider directly
 * (CSP and docs/SECURITY.md). Websocket subscriptions are not used anywhere: confirmation is done
 * by polling `getSignatureStatuses`.
 */
export function getRelayConnection(
  rawUrl: string | undefined = readTradeEnv().relayUrl,
): Connection | null {
  const url = resolveRelayUrl(rawUrl);
  if (!url) return null;
  if (cached?.url === url) return cached.connection;
  const connection = new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  cached = { url, connection };
  return connection;
}
