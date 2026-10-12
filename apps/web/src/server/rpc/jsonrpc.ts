import { isAllowedMethod, METHODS } from './methods';

/*
 * JSON-RPC 2.0 envelope handling of the relay: parsing of a single call or a small batch, per-call
 * validation (allowlist, params) and error objects. Messages are fixed strings: nothing from the
 * upstream provider or the environment ends up in them.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export const RPC_ERRORS = {
  parse: { code: -32700, message: 'Parse error' },
  invalidRequest: { code: -32600, message: 'Invalid request' },
  methodNotAllowed: { code: -32601, message: 'Method not allowed by the FORGE relay' },
  invalidParams: { code: -32602, message: 'Invalid params' },
  internal: { code: -32603, message: 'Internal error' },
  // Relay-specific server errors (-32000..-32099 is reserved for implementations; Solana uses the
  // low end of it, the relay uses the high end).
  forbidden: { code: -32098, message: 'Caller not allowed by the FORGE relay' },
  unauthorized: { code: -32097, message: 'Invalid relay token' },
  rateLimited: { code: -32005, message: 'Too many requests' },
  upstreamUnavailable: { code: -32603, message: 'RPC upstream unavailable' },
  upstreamTimeout: { code: -32603, message: 'RPC upstream timeout' },
  upstreamBusy: { code: -32005, message: 'RPC upstream busy, retry shortly' },
  responseTooLarge: { code: -32603, message: 'RPC response too large (use dataSlice)' },
} as const satisfies Record<string, JsonRpcError>;

export const MAX_BATCH_SIZE = 10;
export const MAX_ID_LENGTH = 128;

/** A validated call, ready to forward. `params` is always an array once validated. */
export interface ValidCall {
  ok: true;
  index: number;
  id: JsonRpcId;
  method: string;
  params: unknown[];
}

export interface InvalidCall {
  ok: false;
  index: number;
  id: JsonRpcId;
  /** Method name when it was a string (for logs only). */
  method: string | null;
  error: JsonRpcError;
}

export type CheckedCall = ValidCall | InvalidCall;

export type ParsedBody =
  | { ok: true; batch: boolean; calls: CheckedCall[] }
  | { ok: false; status: number; error: JsonRpcError };

function readId(raw: Record<string, unknown>): { ok: true; id: JsonRpcId } | { ok: false } {
  if (!('id' in raw)) return { ok: false }; // notifications are not supported
  const id = raw.id;
  if (id === null) return { ok: true, id };
  if (typeof id === 'string' && id.length <= MAX_ID_LENGTH) return { ok: true, id };
  if (typeof id === 'number' && Number.isSafeInteger(id)) return { ok: true, id };
  return { ok: false };
}

const ENVELOPE_KEYS = new Set(['jsonrpc', 'id', 'method', 'params']);

/** Validates one call of the request (envelope, allowlist, params). */
export function checkCall(raw: unknown, index: number): CheckedCall {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, index, id: null, method: null, error: RPC_ERRORS.invalidRequest };
  }
  const obj = raw as Record<string, unknown>;
  const idResult = readId(obj);
  const id = idResult.ok ? idResult.id : null;
  const method = typeof obj.method === 'string' ? obj.method : null;
  const invalid = (error: JsonRpcError): InvalidCall => ({ ok: false, index, id, method, error });
  if (
    !idResult.ok ||
    obj.jsonrpc !== '2.0' ||
    method === null ||
    Object.keys(obj).some((k) => !ENVELOPE_KEYS.has(k))
  ) {
    return invalid(RPC_ERRORS.invalidRequest);
  }
  if (!isAllowedMethod(method)) return invalid(RPC_ERRORS.methodNotAllowed);
  const spec = METHODS[method];
  const reason = spec ? spec.validate(obj.params) : 'unknown method';
  if (reason !== null) {
    // A method allowed in one narrow shape is refused like any other method outside of it.
    if (spec?.narrow) return invalid(RPC_ERRORS.methodNotAllowed);
    return invalid({ ...RPC_ERRORS.invalidParams, data: { reason } });
  }
  const params = Array.isArray(obj.params) ? (obj.params as unknown[]) : [];
  return { ok: true, index, id, method, params };
}

/** Parses the raw request text into checked calls. */
export function parseBody(text: string): ParsedBody {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: RPC_ERRORS.parse };
  }
  if (Array.isArray(json)) {
    if (json.length === 0) return { ok: false, status: 400, error: RPC_ERRORS.invalidRequest };
    if (json.length > MAX_BATCH_SIZE) {
      return {
        ok: false,
        status: 400,
        error: { ...RPC_ERRORS.invalidRequest, data: { reason: `batch over ${MAX_BATCH_SIZE}` } },
      };
    }
    return { ok: true, batch: true, calls: json.map((raw, i) => checkCall(raw, i)) };
  }
  return { ok: true, batch: false, calls: [checkCall(json, 0)] };
}

export function errorResponse(id: JsonRpcId, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error };
}

/** One error per call (batch) or a single error object, mirroring the request shape. */
export function errorForAll(
  calls: readonly CheckedCall[] | null,
  batch: boolean,
  error: JsonRpcError,
): JsonRpcResponse | JsonRpcResponse[] {
  if (!calls || calls.length === 0) return errorResponse(null, error);
  const responses = calls.map((c) => errorResponse(c.id, error));
  return batch ? responses : (responses[0] ?? errorResponse(null, error));
}
