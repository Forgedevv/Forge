import type { ClientErrorCode } from '@forge/shared';

/*
 * Error responses of the chat and spec routes. Body shape is the ClientError one
 * `{ code, message }` read by apps/web/src/client; `message` is safe to show to the user.
 */

export type ApiErrorCode =
  ClientErrorCode | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'SERVER_ERROR';

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { code, message },
    { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } },
  );
}

export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Reads a bounded JSON body. `undefined` when too large or not valid JSON. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_JSON_BODY_BYTES) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
