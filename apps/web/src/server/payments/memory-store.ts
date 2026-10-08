import { randomUUID } from 'node:crypto';
import type { FlagKey, JobStatus, JobType, LaunchpadStatus } from '@forge/shared';
import type {
  ConfirmWriteResult,
  JobContext,
  NewPayment,
  PaymentRecord,
  PaymentsStore,
} from './store';

/*
 * In-memory PaymentsStore for unit tests and the devnet smoke script. It mirrors the database
 * semantics the routes rely on: each method is one atomic statement (it yields once before
 * running, so concurrent callers interleave between statements exactly like separate SQL
 * statements would), `tx_signature` is unique, and updates are conditional.
 */

export interface MemoryJob {
  id: string;
  launchpadId: string;
  type: JobType;
  status: JobStatus;
}

export interface MemoryLaunchpad {
  id: string;
  ownerWallet: string;
  specOwnerWallet: string | null;
  includedModificationsLeft: number;
  status: LaunchpadStatus;
}

export class MemoryPaymentsStore implements PaymentsStore {
  readonly jobs = new Map<string, MemoryJob>();
  readonly launchpads = new Map<string, MemoryLaunchpad>();
  readonly payments = new Map<string, PaymentRecord>();
  readonly flags = new Map<FlagKey, boolean>();
  readonly events: { jobId: string; message: string }[] = [];
  /** Number of job transitions actually applied (to assert exactly-once). */
  transitions: { jobId: string; from: JobStatus; to: JobStatus }[] = [];
  /** Hook run before each statement (tests use it to inject failures or delays). */
  beforeStatement: ((name: string) => void | Promise<void>) | null = null;

  private async statement(name: string): Promise<void> {
    await Promise.resolve();
    if (this.beforeStatement) await this.beforeStatement(name);
  }

  addLaunchpad(launchpad: Partial<MemoryLaunchpad> & { ownerWallet: string }): MemoryLaunchpad {
    const row: MemoryLaunchpad = {
      id: randomUUID(),
      specOwnerWallet: launchpad.ownerWallet,
      includedModificationsLeft: 2,
      status: 'draft',
      ...launchpad,
    };
    this.launchpads.set(row.id, row);
    return row;
  }

  addJob(job: Partial<MemoryJob> & { launchpadId: string }): MemoryJob {
    const row: MemoryJob = {
      id: randomUUID(),
      type: 'create_launchpad',
      status: 'spec_ready',
      ...job,
    };
    this.jobs.set(row.id, row);
    return row;
  }

  async getJobContext(jobId: string): Promise<JobContext | null> {
    await this.statement('getJobContext');
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const launchpad = this.launchpads.get(job.launchpadId);
    if (!launchpad) return null;
    return { job: { ...job }, launchpad: { ...launchpad } };
  }

  async getIncludedModificationsLeft(launchpadId: string): Promise<number | null> {
    await this.statement('getIncludedModificationsLeft');
    return this.launchpads.get(launchpadId)?.includedModificationsLeft ?? null;
  }

  async getPayment(paymentId: string): Promise<PaymentRecord | null> {
    await this.statement('getPayment');
    const row = this.payments.get(paymentId);
    return row ? { ...row } : null;
  }

  async findPaymentBySignature(signature: string): Promise<PaymentRecord | null> {
    await this.statement('findPaymentBySignature');
    for (const row of this.payments.values()) {
      if (row.txSignature === signature) return { ...row };
    }
    return null;
  }

  async findConfirmedPaymentForJob(jobId: string): Promise<PaymentRecord | null> {
    await this.statement('findConfirmedPaymentForJob');
    for (const row of this.payments.values()) {
      if (row.jobId === jobId && row.status === 'confirmed') return { ...row };
    }
    return null;
  }

  async insertQuote(payment: NewPayment): Promise<PaymentRecord> {
    await this.statement('insertQuote');
    const row: PaymentRecord = {
      id: randomUUID(),
      jobId: payment.jobId,
      payerWallet: payment.payerWallet,
      kind: payment.kind,
      usdAmount: payment.usdAmount,
      lamports: payment.lamports,
      quoteExpiresAt: payment.quoteExpiresAt.getTime(),
      txSignature: null,
      status: 'quoted',
    };
    this.payments.set(row.id, row);
    return { ...row };
  }

  async confirmPayment(paymentId: string, signature: string): Promise<ConfirmWriteResult> {
    await this.statement('confirmPayment');
    const row = this.payments.get(paymentId);
    if (!row || row.txSignature !== null || (row.status !== 'quoted' && row.status !== 'expired')) {
      return 'not_updated';
    }
    for (const other of this.payments.values()) {
      if (other.txSignature === signature) return 'signature_taken';
    }
    row.txSignature = signature;
    row.status = 'confirmed';
    return 'confirmed';
  }

  async confirmIncludedPayment(paymentId: string): Promise<boolean> {
    await this.statement('confirmIncludedPayment');
    const row = this.payments.get(paymentId);
    if (!row || row.status !== 'quoted' || row.lamports !== 0n || row.txSignature !== null) {
      return false;
    }
    row.status = 'confirmed';
    return true;
  }

  async markPaymentExpired(paymentId: string): Promise<boolean> {
    await this.statement('markPaymentExpired');
    const row = this.payments.get(paymentId);
    if (!row || row.status !== 'quoted' || row.txSignature !== null) return false;
    row.status = 'expired';
    return true;
  }

  async transitionJob(jobId: string, from: JobStatus, to: JobStatus): Promise<boolean> {
    await this.statement('transitionJob');
    const job = this.jobs.get(jobId);
    if (!job || job.status !== from) return false;
    job.status = to;
    this.transitions.push({ jobId, from, to });
    return true;
  }

  async setIncludedModificationsLeft(
    launchpadId: string,
    expected: number,
    next: number,
  ): Promise<boolean> {
    await this.statement('setIncludedModificationsLeft');
    const launchpad = this.launchpads.get(launchpadId);
    if (!launchpad || next < 0 || launchpad.includedModificationsLeft !== expected) return false;
    launchpad.includedModificationsLeft = next;
    return true;
  }

  async getFlag(key: FlagKey): Promise<boolean> {
    await this.statement('getFlag');
    return this.flags.get(key) ?? false;
  }

  async addJobEvent(jobId: string, message: string): Promise<void> {
    await this.statement('addJobEvent');
    this.events.push({ jobId, message });
  }
}
