/*
 * On-chain check that a coin mint is fresh: a client site generates a new mint keypair for every
 * coin, so an address that already holds an account is refused. One read-only JSON-RPC call
 * (`getAccountInfo`) to the server RPC; the URL is never logged (it carries the provider key).
 */

export interface MintChecker {
  /** True when an account already exists at `address`. Throws when the chain cannot be read. */
  accountExists(address: string): Promise<boolean>;
}

export class ChainReadError extends Error {
  constructor() {
    super('could not read the chain');
    this.name = 'ChainReadError';
  }
}

export interface RpcMintCheckerOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRpcMintChecker(options: RpcMintCheckerOptions): MintChecker {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 8_000;
  return {
    async accountExists(address) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          address,
          { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
        ],
      });
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
        try {
          const res = await doFetch(options.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) continue;
          const payload = (await res.json()) as {
            result?: { value?: unknown };
            error?: unknown;
          };
          if (payload.error !== undefined || payload.result === undefined) continue;
          return payload.result.value !== null && payload.result.value !== undefined;
        } catch {
          // Network error or invalid JSON: retry.
        }
      }
      throw new ChainReadError();
    },
  };
}
