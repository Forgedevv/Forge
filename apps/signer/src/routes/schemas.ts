/**
 * Response schemas of the signer routes: the shared contracts (packages/shared api.ts) extended
 * with optional, non-secret fields the builder can ignore (its client strips unknown keys):
 *
 * - launch prepare: the `OwnerTransactionSummary` shown to the client before signing and the
 *   public accounts of the launch (pool, config, nonce account, creator wallet, quote, referral);
 * - health: the state of every scheduled job (status codes and times, never messages or keys).
 *
 * Change request filed to add these fields to the shared schemas.
 */
import { z } from 'zod';
import {
  OwnerTransactionSummary,
  SignerHealthResponse,
  SignerLaunchPrepareResponse,
} from '@forge/shared';
import { LaunchDetails } from './journal.js';

export const SignerLaunchPrepareResult = SignerLaunchPrepareResponse.extend({
  summary: OwnerTransactionSummary.optional(),
  details: LaunchDetails.optional(),
});
export type SignerLaunchPrepareResult = z.infer<typeof SignerLaunchPrepareResult>;

export const JobHealthState = z.object({
  /** `idle` between runs, `running` during one, `stopped` after shutdown. */
  state: z.enum(['starting', 'idle', 'running', 'stopped']),
  runs: z.number().int().nonnegative(),
  /** Outcome code of the last run (`ran`, `paused`, `busy`, `error`, ...). */
  lastStatus: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .nullable(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
});
export type JobHealthState = z.infer<typeof JobHealthState>;

export const SignerHealthReport = SignerHealthResponse.extend({
  cluster: z.enum(['devnet', 'mainnet-beta']).optional(),
  uptimeSeconds: z.number().int().nonnegative().optional(),
  jobs: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), JobHealthState).optional(),
});
export type SignerHealthReport = z.infer<typeof SignerHealthReport>;
