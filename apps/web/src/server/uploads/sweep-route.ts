import { createHash, timingSafeEqual } from 'node:crypto';
import { createR2Storage } from './storage';
import { readR2Options, UploadConfigError } from './config';
import { createServiceUploadStore } from './supabase-store';
import { sweepUploads, type SweepDeps, type SweepReport } from './sweep';

/*
 * POST /api/internal/uploads/sweep: runs one sweep of the coin uploads (sweep.ts). Called by a
 * scheduler (for example every 15 minutes), never by browsers or client sites:
 *
 *   Authorization: Bearer <FORGE_INTERNAL_CRON_SECRET>
 *
 * FORGE_INTERNAL_CRON_SECRET (at least 32 bytes) is set on the FORGE web project only. Without it
 * the route answers 503 (disabled); a missing or wrong secret is a 401. The comparison is
 * constant-time. The answer is the run report (counts only).
 */

export const MIN_CRON_SECRET_BYTES = 32;

type Env = Record<string, string | undefined>;

export interface SweepRouteDeps {
  env?: Env;
  /** Default: R2 storage and the Supabase store built from the environment. */
  sweepDeps?: () => SweepDeps;
  sweep?: (deps: SweepDeps) => Promise<SweepReport>;
  log?: (message: string) => void;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function hasCronSecret(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (\S{1,512})$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1] as string), digest(secret));
}

function defaultSweepDeps(env: Env): SweepDeps {
  const storage = createR2Storage(readR2Options(env));
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const missing: string[] = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) throw new UploadConfigError(missing);
  return { storage, store: createServiceUploadStore(url as string, key as string) };
}

export async function handleUploadSweep(
  request: Request,
  deps: SweepRouteDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message: string) => console.error(message));
  const secret = env.FORGE_INTERNAL_CRON_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_CRON_SECRET_BYTES) {
    log(
      `uploads: sweep disabled, FORGE_INTERNAL_CRON_SECRET is missing or shorter than ${MIN_CRON_SECRET_BYTES} bytes`,
    );
    return json(
      { error: { code: 'NOT_CONFIGURED', message: 'The sweep is not configured.' } },
      503,
    );
  }
  if (!hasCronSecret(request, secret)) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong cron secret.' } }, 401);
  }

  let sweepDeps: SweepDeps;
  try {
    sweepDeps = deps.sweepDeps ? deps.sweepDeps() : defaultSweepDeps(env);
  } catch (error) {
    if (!(error instanceof UploadConfigError)) throw error;
    log(`uploads: sweep configuration error: ${error.message}`);
    return json(
      { error: { code: 'NOT_CONFIGURED', message: 'The sweep is not configured.' } },
      503,
    );
  }
  try {
    const report = await (deps.sweep ?? sweepUploads)({ ...sweepDeps, log });
    if (report.failed > 0) log(`uploads: sweep left ${report.failed} upload(s) for the next run`);
    return json(report, 200);
  } catch (error) {
    log(`uploads: sweep failed (${error instanceof Error ? error.name : 'error'})`);
    return json({ error: { code: 'SERVER_ERROR', message: 'The sweep failed.' } }, 500);
  }
}
