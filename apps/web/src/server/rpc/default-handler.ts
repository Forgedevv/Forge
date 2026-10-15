import { createClient } from '@supabase/supabase-js';
import { readRelayConfig, RelayConfigError, upstreamSelectionLog } from './config';
import { createRelayHandler, type RelayHandler } from './handler';
import { errorResponse, RPC_ERRORS } from './jsonrpc';
import { MemoryRateLimitStore } from './limits';
import { consoleLogger, errorName } from './log';
import { CachedLaunchpadDirectory } from './origins';
import { secretFragments } from './redact';
import { createSupabaseSnapshotLoader } from './supabase-directory';
import { createUpstream } from './upstream';

/*
 * Production wiring of the relay, built from the environment at the first request. A configuration
 * error is answered with a 503 (no detail) and retried at the next request; the log line names the
 * variable, never its value.
 */

let handler: RelayHandler | null = null;

function build(): RelayHandler {
  const config = readRelayConfig();
  // Once per instance (the handler is built once): which variable the upstream comes from.
  const selection = upstreamSelectionLog(config);
  consoleLogger.log(selection.level, selection.event, selection.fields);
  const directory = config.supabase
    ? new CachedLaunchpadDirectory(
        createSupabaseSnapshotLoader(
          createClient(config.supabase.url, config.supabase.serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          }),
          { clientsDomain: config.clientsDomain },
        ),
        {
          onError: (error) =>
            consoleLogger.log('error', 'directory_load_failed', { error: errorName(error) }),
        },
      )
    : null;
  if (!config.supabase) {
    consoleLogger.log('warn', 'directory_unconfigured', {
      effect: 'client-site origins and server tokens are refused',
    });
  }
  const upstream = createUpstream({
    url: config.upstreamUrl,
    cluster: config.cluster,
    secretFragments: secretFragments(config.upstreamUrl),
    onClusterMismatch: () =>
      consoleLogger.log('error', 'wrong_cluster', { expected: config.cluster }),
  });
  return createRelayHandler({
    config,
    directory,
    limiter: new MemoryRateLimitStore(),
    upstream,
    logger: consoleLogger,
  });
}

function getHandler(): RelayHandler | Response {
  if (handler) return handler;
  try {
    handler = build();
    return handler;
  } catch (error) {
    consoleLogger.log('error', 'config_error', {
      error: errorName(error),
      // RelayConfigError messages name variables only.
      detail: error instanceof RelayConfigError ? error.message : undefined,
    });
    return new Response(JSON.stringify(errorResponse(null, RPC_ERRORS.upstreamUnavailable)), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

function unexpected(error: unknown): Response {
  consoleLogger.log('error', 'unexpected_error', { error: errorName(error) });
  return new Response(JSON.stringify(errorResponse(null, RPC_ERRORS.internal)), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** POST /api/rpc */
export async function handleRpcPost(request: Request): Promise<Response> {
  const h = getHandler();
  if (h instanceof Response) return h;
  try {
    return await h.post(request);
  } catch (error) {
    return unexpected(error);
  }
}

/** OPTIONS /api/rpc (CORS preflight) */
export async function handleRpcOptions(request: Request): Promise<Response> {
  const h = getHandler();
  if (h instanceof Response) return new Response(null, { status: 503 });
  try {
    return await h.options(request);
  } catch (error) {
    return unexpected(error);
  }
}
