import {
  MAX_COMPLETE_BODY_BYTES,
  MAX_TICKET_BODY_BYTES,
  UploadHttpError,
  uploadErrorResponse,
} from './contract';
import { getDefaultUploadService } from './config';
import { toUploadHttpError, type UploadService } from './service';

/*
 * HTTP side of the upload routes (kept out of the route files so it is testable without Next).
 * Callers are client-site servers, not browsers: no cookie, no CORS. Bodies are small strict
 * JSON documents; the image itself goes straight to storage through the presigned URL.
 */

export interface UploadHandlerDeps {
  /** Default: built from the environment on first use. */
  service?: () => UploadService;
  log?: (message: string) => void;
}

const defaultLog = (message: string) => console.error(message);

async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new UploadHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request must be JSON.');
  }
  const tooLarge = () =>
    new UploadHttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) throw new UploadHttpError(400, 'BAD_REQUEST', 'The request body is empty.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new UploadHttpError(400, 'BAD_REQUEST', 'The request is not valid JSON.');
  }
}

function ok(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

export function createUploadHandlers(deps: UploadHandlerDeps = {}) {
  const log = deps.log ?? defaultLog;
  const service = deps.service ?? getDefaultUploadService;

  async function run(work: () => Promise<unknown>): Promise<Response> {
    try {
      return ok(await work());
    } catch (error) {
      return uploadErrorResponse(toUploadHttpError(error, log));
    }
  }

  return {
    /** POST /api/launchpads/{id}/uploads */
    createUpload(request: Request, launchpadParam: string): Promise<Response> {
      return run(async () => {
        const body = await readJson(request, MAX_TICKET_BODY_BYTES);
        return service().issue(launchpadParam, body);
      });
    },

    /** POST /api/launchpads/{id}/uploads/{uploadId}/complete */
    completeUpload(request: Request, launchpadParam: string, uploadId: string): Promise<Response> {
      return run(async () => {
        const body = await readJson(request, MAX_COMPLETE_BODY_BYTES);
        return service().complete(launchpadParam, uploadId, body);
      });
    },
  };
}

const defaults = createUploadHandlers();

export const handleCreateUpload = defaults.createUpload;
export const handleCompleteUpload = defaults.completeUpload;
