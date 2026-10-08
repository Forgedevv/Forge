import { z } from 'zod';

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Environment of the worker process. Secret values are never logged. */
const WorkerEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  BUILDER_WORKER_ID: z.string().min(1).max(64).optional(),
  BUILDER_CONCURRENCY: intFromEnv(1, 1, 8),
  BUILDER_POLL_INTERVAL_MS: intFromEnv(5_000, 500, 300_000),
  BUILDER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export function loadWorkerEnv(env: Record<string, string | undefined>): WorkerEnv {
  const parsed = WorkerEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Names of the invalid variables only, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))];
    throw new Error(`invalid worker environment: ${names.join(', ')}`);
  }
  return parsed.data;
}
