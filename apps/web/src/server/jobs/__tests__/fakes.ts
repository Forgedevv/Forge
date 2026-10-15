import type { FlagKey, JobStatus, LaunchpadSpec, LaunchpadStatus } from '@forge/shared';
import {
  Keypair,
  SystemProgram,
  Transaction,
  type Transaction as TransactionType,
} from '@solana/web3.js';
import { createSessionToken } from '@/server/auth/session';
import { MemoryRateLimiter } from '../../payments/rate-limit';
import {
  ClusterMismatchError,
  type ConfirmOutcome,
  type LaunchChain,
  type OwnerCostEstimate,
  type SendOutcome,
  type SignatureState,
} from '../chain';
import { MemoryLogger } from '../log';
import {
  StoreError,
  type ConversationRecord,
  type JobEventRecord,
  type JobPaymentRecord,
  type JobRecord,
  type LaunchpadRecord,
  type OwnedJob,
  type RefundRecord,
  type RoutesStore,
} from '../store';

/* In-memory doubles of the routes' store and chain, plus request helpers. No network. */

export const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
export const APP = 'https://forge.app';

export function setTestEnv(): void {
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.NEXT_PUBLIC_APP_URL = APP;
}

export function sessionCookie(wallet: string): string {
  return `__Host-forge_session=${createSessionToken(Buffer.from(SESSION_SECRET), wallet)}`;
}

export function request(
  method: 'GET' | 'POST',
  path: string,
  opts: {
    wallet?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { origin: APP, ...opts.headers };
  if (opts.wallet) headers.cookie = sessionCookie(opts.wallet);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${APP}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined
      ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
      : {}),
  });
}

export function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

let counter = 0;
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function spec(owner: string, overrides: Partial<LaunchpadSpec> = {}): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: owner,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'To the moon',
      designNotes: '',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: 'The MoonPad coin',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 0.5,
    },
    ...overrides,
  };
}

export class MemoryRoutesStore implements RoutesStore {
  launchpads = new Map<string, LaunchpadRecord & { lastTradeAt?: string }>();
  jobs = new Map<string, JobRecord>();
  events: JobEventRecord[] = [];
  conversations = new Map<string, ConversationRecord>();
  refunds: (RefundRecord & { payerWallet: string })[] = [];
  /** Payments of jobs, read by "start again". */
  payments: JobPaymentRecord[] = [];
  /** Payment anomalies (`resolved: false` = still held for a manual refund). */
  anomalies: { jobId: string; resolved: boolean }[] = [];
  flags = new Map<FlagKey, boolean>();
  failFlags = false;
  /** Called before a conditional job update applies (simulates a concurrent writer). */
  beforeTransition: ((jobId: string) => void) | null = null;
  /** Called right after a modification job is inserted (simulates a concurrent insert). */
  afterInsert: ((job: JobRecord) => void) | null = null;
  /** Called before a modification job is inserted; may throw (simulates a database refusal). */
  beforeInsert: ((launchpadId: string) => void) | null = null;
  /** Called before a creation job is inserted (simulates a concurrent "start again"). */
  beforeCreationInsert: ((launchpadId: string) => void) | null = null;
  private clock = 0;

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 10, 12, 0, this.clock)).toISOString();
  }

  addLaunchpad(owner: string, overrides: Partial<LaunchpadRecord> = {}): LaunchpadRecord {
    const record: LaunchpadRecord = {
      id: uuid(),
      ownerWallet: owner,
      slug: 'moonpad',
      spec: spec(owner),
      launchpadConfig: null,
      launchpadCoinConfig: null,
      launchpadCoinMint: null,
      includedModificationsLeft: 2,
      status: 'live',
      createdAt: this.stamp(),
      siteHost: null,
      ...overrides,
    };
    this.launchpads.set(record.id, record);
    return record;
  }

  addJob(launchpadId: string, overrides: Partial<JobRecord> = {}): JobRecord {
    const at = this.stamp();
    const record: JobRecord = {
      id: uuid(),
      launchpadId,
      type: 'create_launchpad',
      status: 'spec_ready',
      attempts: 0,
      failedStage: null,
      request: null,
      previewUrl: null,
      ownerTx: null,
      ownerTxDetails: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    this.jobs.set(record.id, record);
    return record;
  }

  addConversation(owner: string, launchpadId: string | null): ConversationRecord {
    const record = { id: uuid(), ownerWallet: owner, launchpadId };
    this.conversations.set(record.id, record);
    return record;
  }

  status(jobId: string): JobStatus | undefined {
    return this.jobs.get(jobId)?.status;
  }

  private owned(launchpadId: string, wallet: string): LaunchpadRecord | null {
    const l = this.launchpads.get(launchpadId);
    return l && l.ownerWallet === wallet ? { ...l } : null;
  }

  async getOwnedJob(jobId: string, wallet: string): Promise<OwnedJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const launchpad = this.owned(job.launchpadId, wallet);
    return launchpad ? { job: { ...job }, launchpad } : null;
  }

  async listJobEvents(jobId: string, wallet: string): Promise<JobEventRecord[]> {
    if (!(await this.getOwnedJob(jobId, wallet))) return [];
    return this.events.filter((e) => e.jobId === jobId);
  }

  async transitionJob(
    jobId: string,
    launchpadId: string,
    from: JobStatus,
    to: JobStatus,
  ): Promise<boolean> {
    this.beforeTransition?.(jobId);
    const job = this.jobs.get(jobId);
    if (!job || job.launchpadId !== launchpadId || job.status !== from) return false;
    this.jobs.set(jobId, { ...job, status: to, updatedAt: this.stamp() });
    return true;
  }

  async addJobEvent(jobId: string, message: string): Promise<void> {
    this.events.push({ id: this.events.length + 1, jobId, message, createdAt: this.stamp() });
  }

  async getFlag(key: FlagKey): Promise<boolean> {
    if (this.failFlags) throw new Error('flags unavailable');
    return this.flags.get(key) ?? false;
  }

  async getOwnedLaunchpad(launchpadId: string, wallet: string): Promise<LaunchpadRecord | null> {
    return this.owned(launchpadId, wallet);
  }

  async listOwnedLaunchpads(wallet: string): Promise<LaunchpadRecord[]> {
    return [...this.launchpads.values()]
      .filter((l) => l.ownerWallet === wallet)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((l) => ({ ...l }));
  }

  async listOwnedJobs(wallet: string, launchpadIds: readonly string[]): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => launchpadIds.includes(j.launchpadId) && this.owned(j.launchpadId, wallet))
      .map((j) => ({ ...j }));
  }

  async listRefunds(wallet: string, jobIds: readonly string[]): Promise<RefundRecord[]> {
    return this.refunds
      .filter((r) => r.payerWallet === wallet && jobIds.includes(r.jobId))
      .map(({ jobId, lamports, signature }) => ({ jobId, lamports, signature }));
  }

  async getOwnedConversation(id: string, wallet: string): Promise<ConversationRecord | null> {
    const c = this.conversations.get(id);
    return c && c.ownerWallet === wallet ? { ...c } : null;
  }

  async insertModificationJob(launchpadId: string, text: string): Promise<JobRecord> {
    this.beforeInsert?.(launchpadId);
    const job = this.addJob(launchpadId, { type: 'modify_launchpad', request: text });
    this.afterInsert?.(job);
    return { ...job };
  }

  async updatePendingModificationRequest(
    jobId: string,
    launchpadId: string,
    text: string,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.launchpadId !== launchpadId || job.status !== 'spec_ready') return false;
    if (job.type !== 'modify_launchpad') return false;
    this.jobs.set(jobId, { ...job, request: text });
    return true;
  }

  async deletePendingModificationJob(jobId: string, launchpadId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.launchpadId !== launchpadId || job.status !== 'spec_ready') return false;
    return this.jobs.delete(jobId);
  }

  async listJobPayments(wallet: string, jobIds: readonly string[]): Promise<JobPaymentRecord[]> {
    return this.payments
      .filter((p) => jobIds.includes(p.jobId))
      .filter((p) => {
        const job = this.jobs.get(p.jobId);
        return job !== undefined && this.owned(job.launchpadId, wallet) !== null;
      })
      .map((p) => ({ ...p }));
  }

  async countOpenPaymentAnomalies(wallet: string, jobIds: readonly string[]): Promise<number> {
    return this.anomalies.filter((a) => {
      const job = this.jobs.get(a.jobId);
      return (
        !a.resolved &&
        jobIds.includes(a.jobId) &&
        job !== undefined &&
        this.owned(job.launchpadId, wallet) !== null
      );
    }).length;
  }

  /** Enforces the index of migration 0010: one creation job that is not refunded per launchpad. */
  async insertCreationJob(launchpadId: string): Promise<JobRecord> {
    this.beforeCreationInsert?.(launchpadId);
    const open = [...this.jobs.values()].some(
      (j) =>
        j.launchpadId === launchpadId && j.type === 'create_launchpad' && j.status !== 'refunded',
    );
    if (open) throw new StoreError('insert creation job', '23505');
    return { ...this.addJob(launchpadId, { type: 'create_launchpad', status: 'spec_ready' }) };
  }

  async transitionLaunchpad(
    launchpadId: string,
    wallet: string,
    from: LaunchpadStatus,
    to: LaunchpadStatus,
    lastTradeAt?: string,
  ): Promise<boolean> {
    const l = this.launchpads.get(launchpadId);
    if (!l || l.ownerWallet !== wallet || l.status !== from) return false;
    this.launchpads.set(launchpadId, {
      ...l,
      status: to,
      ...(lastTradeAt ? { lastTradeAt } : {}),
    });
    return true;
  }
}

export class FakeLaunchChain implements LaunchChain {
  calls: string[] = [];
  sent: TransactionType[] = [];
  clusterOk = true;
  estimate: OwnerCostEstimate = {
    networkFeeLamports: 15_000n,
    ownerDebitLamports: 520_000_000n,
    simulationFailed: false,
  };
  /** Token account rent reported by the cluster, or the error its read throws. */
  tokenAccountRent: bigint | Error = 2_039_280n;
  /** State reported by getSignatureState (per call, last value repeats). */
  states: SignatureState[] = ['unknown'];
  sendOutcome: SendOutcome = { status: 'sent' };
  confirmOutcome: ConfirmOutcome = 'confirmed';
  sendError: Error | null = null;

  async assertCluster(): Promise<void> {
    this.calls.push('assertCluster');
    if (!this.clusterOk) throw new ClusterMismatchError();
  }

  async estimateOwnerCosts(): Promise<OwnerCostEstimate> {
    this.calls.push('estimate');
    return this.estimate;
  }

  async getTokenAccountRentLamports(): Promise<bigint> {
    this.calls.push('rent');
    if (this.tokenAccountRent instanceof Error) throw this.tokenAccountRent;
    return this.tokenAccountRent;
  }

  async getSignatureState(): Promise<SignatureState> {
    this.calls.push('status');
    return (this.states.length > 1 ? this.states.shift() : this.states[0]) ?? 'unknown';
  }

  async send(tx: TransactionType): Promise<SendOutcome> {
    this.calls.push('send');
    if (this.sendError) throw this.sendError;
    this.sent.push(tx);
    return this.sendOutcome;
  }

  async confirm(): Promise<ConfirmOutcome> {
    this.calls.push('confirm');
    return this.confirmOutcome;
  }
}

/** A launch-like transaction: the owner pays and signs last, creator and mint sign first. */
export function launchTransaction(owner: Keypair, extra?: { lamports?: number }) {
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const tx = new Transaction({
    feePayer: owner.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: mint.publicKey,
      lamports: extra?.lamports ?? 500_000_000,
    }),
    SystemProgram.transfer({
      fromPubkey: creator.publicKey,
      toPubkey: mint.publicKey,
      lamports: 1,
    }),
    SystemProgram.transfer({
      fromPubkey: mint.publicKey,
      toPubkey: creator.publicKey,
      lamports: 1,
    }),
  );
  tx.partialSign(creator, mint);
  const base64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  return { tx, base64, creator, mint };
}

/** The owner's signed copy of a stored base64 transaction. */
export function ownerSign(base64: string, owner: Keypair): string {
  const tx = Transaction.from(Buffer.from(base64, 'base64'));
  tx.partialSign(owner);
  return tx.serialize().toString('base64');
}

export function harness() {
  setTestEnv();
  return {
    store: new MemoryRoutesStore(),
    chain: new FakeLaunchChain(),
    logger: new MemoryLogger(),
    rateLimiter: new MemoryRateLimiter(),
  };
}
