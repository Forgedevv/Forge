import { ClientError } from '@forge/shared';
import type { z } from 'zod';
import { mapHttpError, networkError } from './errors';
import { emitUnauthorized } from './session-store';

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** Do not clear the stored session on a 401 (the caller handles it). */
  keepSessionOn401?: boolean;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** fetch + HTTP error mapping. Throws ClientError. */
export async function rawRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? 'GET';
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) {
    const err = mapHttpError(res.status, await readJson(res));
    if (err.code === 'UNAUTHORIZED' && !opts.keepSessionOn401) emitUnauthorized();
    throw err;
  }
  return res;
}

/** JSON request whose response is validated with a zod schema. */
export async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: RequestOptions = {},
): Promise<z.output<S>> {
  const res = await rawRequest(path, opts);
  const json = await readJson(res);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ClientError('NETWORK', 'Unexpected response from the server.');
  }
  return parsed.data;
}

/** Validates an outgoing body with a (strict) shared schema before sending it. */
export function validateBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(first ? `Invalid request: ${first.message}` : 'Invalid request.');
  }
  return parsed.data;
}

export function route(template: string, params: Record<string, string>): string {
  return template.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
}
