import type { ImageType } from './contract';

/*
 * Persistence of upload tickets (table `upload_tickets`, migration 0006, service role only).
 * The database guarantees single use: `(wallet, nonce)` and `mint` are unique, so two instances
 * racing on the same signed request or the same mint cannot both issue a ticket.
 */

export interface LaunchpadRef {
  id: string;
  slug: string;
  status: string;
  /** The launchpad's own coin mint, never usable for a client coin. */
  coinMint: string | null;
  /**
   * `launchpads.site_host` (migration 0011): the exact production host the builder recorded for
   * this launchpad's own site, accepted as `auth.host`. Null when none is recorded, or malformed.
   */
  siteHost: string | null;
}

/** `expired`: never completed within the complete window (set by the sweep). */
export type TicketStatus = 'issued' | 'completed' | 'rejected' | 'expired';

export interface TicketRecord {
  id: string;
  launchpadId: string;
  wallet: string;
  nonce: string;
  /** SHA-256 of the canonical request: an identical retry gets the same ticket back. */
  requestSha256: string;
  mint: string;
  host: string;
  contentType: ImageType;
  imageSize: number;
  imageSha256: string;
  /** Staging key of the presigned PUT (`pending/...`). */
  uploadKey: string;
  /** Public image key, written by FORGE after verification. */
  imageKey: string;
  metadataKey: string;
  coinName: string;
  coinSymbol: string;
  coinDescription: string;
  firstBuyLamports: string;
  status: TicketStatus;
  /** Why the stored image was refused (status `rejected`). */
  rejection: string | null;
  metadataSha256: string | null;
  /** Presign time, second precision (part of the URL signature). */
  issuedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  /** When the sweep deleted the objects this ticket no longer needs (null: not yet). */
  sweptAt: Date | null;
}

export interface SweepQuery {
  /** `issued` tickets issued before this are past the complete window (plus grace). */
  issuedBefore: Date;
  /** Finished tickets whose presigned URL expired before this (plus grace). */
  urlExpiredBefore: Date;
  limit: number;
}

export type InsertResult = { ok: true } | { ok: false; conflict: 'nonce' | 'mint' | 'other' };

export interface UploadStore {
  /** By uuid or by slug. */
  findLaunchpad(ref: { id: string } | { slug: string }): Promise<LaunchpadRef | null>;
  findTicketById(id: string): Promise<TicketRecord | null>;
  findTicketByNonce(wallet: string, nonce: string): Promise<TicketRecord | null>;
  /** True when a ticket, or a launchpad as its own coin, already uses this mint. */
  isMintTaken(mint: string): Promise<boolean>;
  /**
   * Issue times of the oldest `limit` tickets issued since `since` for the wallet or the
   * launchpad, ascending.
   */
  recentIssues(
    filter: { wallet: string } | { launchpadId: string },
    since: Date,
    limit: number,
  ): Promise<Date[]>;
  insertTicket(ticket: TicketRecord): Promise<InsertResult>;
  /** `issued` -> `completed`; returns the ticket as stored afterwards (null if missing). */
  markCompleted(id: string, metadataSha256: string, at: Date): Promise<TicketRecord | null>;
  /** `issued` -> `rejected`; returns the ticket as stored afterwards (null if missing). */
  markRejected(id: string, rejection: string): Promise<TicketRecord | null>;
  /** `issued` -> `expired`; returns the ticket as stored afterwards (null if missing). */
  markExpired(id: string): Promise<TicketRecord | null>;
  /**
   * Tickets not swept yet that the sweep must clean, oldest first: `issued` ones issued before
   * `issuedBefore`, and the others (completed, rejected, expired) whose presigned URL expired
   * before `urlExpiredBefore`.
   */
  listSweepable(query: SweepQuery): Promise<TicketRecord[]>;
  /** Records that the sweep cleaned the ticket's objects. */
  markSwept(id: string, at: Date): Promise<void>;
}

export class UploadStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly dbCode?: string,
  ) {
    super(`upload store ${operation} failed${dbCode ? ` (${dbCode})` : ''}`);
    this.name = 'UploadStoreError';
  }
}

/** In-memory UploadStore with the same uniqueness rules as the table (tests, local runs). */
export class MemoryUploadStore implements UploadStore {
  readonly launchpads = new Map<string, LaunchpadRef>();
  readonly tickets = new Map<string, TicketRecord>();

  addLaunchpad(launchpad: LaunchpadRef): void {
    this.launchpads.set(launchpad.id, launchpad);
  }

  async findLaunchpad(ref: { id: string } | { slug: string }): Promise<LaunchpadRef | null> {
    if ('id' in ref) return this.launchpads.get(ref.id) ?? null;
    for (const launchpad of this.launchpads.values()) {
      if (launchpad.slug === ref.slug) return launchpad;
    }
    return null;
  }

  async findTicketById(id: string): Promise<TicketRecord | null> {
    const ticket = this.tickets.get(id);
    return ticket ? { ...ticket } : null;
  }

  async findTicketByNonce(wallet: string, nonce: string): Promise<TicketRecord | null> {
    for (const ticket of this.tickets.values()) {
      if (ticket.wallet === wallet && ticket.nonce === nonce) return { ...ticket };
    }
    return null;
  }

  async isMintTaken(mint: string): Promise<boolean> {
    for (const ticket of this.tickets.values()) if (ticket.mint === mint) return true;
    for (const launchpad of this.launchpads.values()) if (launchpad.coinMint === mint) return true;
    return false;
  }

  async recentIssues(
    filter: { wallet: string } | { launchpadId: string },
    since: Date,
    limit: number,
  ): Promise<Date[]> {
    return [...this.tickets.values()]
      .filter((t) =>
        'wallet' in filter ? t.wallet === filter.wallet : t.launchpadId === filter.launchpadId,
      )
      .map((t) => t.issuedAt)
      .filter((at) => at.getTime() >= since.getTime())
      .sort((a, b) => a.getTime() - b.getTime())
      .slice(0, limit);
  }

  async insertTicket(ticket: TicketRecord): Promise<InsertResult> {
    for (const t of this.tickets.values()) {
      if (t.wallet === ticket.wallet && t.nonce === ticket.nonce) {
        return { ok: false, conflict: 'nonce' };
      }
      if (t.mint === ticket.mint) return { ok: false, conflict: 'mint' };
    }
    if (this.tickets.has(ticket.id)) return { ok: false, conflict: 'other' };
    this.tickets.set(ticket.id, { ...ticket });
    return { ok: true };
  }

  async markCompleted(id: string, metadataSha256: string, at: Date): Promise<TicketRecord | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    if (ticket.status === 'issued') {
      ticket.status = 'completed';
      ticket.metadataSha256 = metadataSha256;
      ticket.completedAt = at;
    }
    return { ...ticket };
  }

  async markRejected(id: string, rejection: string): Promise<TicketRecord | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    if (ticket.status === 'issued') {
      ticket.status = 'rejected';
      ticket.rejection = rejection;
    }
    return { ...ticket };
  }

  async markExpired(id: string): Promise<TicketRecord | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    if (ticket.status === 'issued') ticket.status = 'expired';
    return { ...ticket };
  }

  async listSweepable(query: SweepQuery): Promise<TicketRecord[]> {
    return [...this.tickets.values()]
      .filter(
        (t) =>
          t.sweptAt === null &&
          (t.status === 'issued'
            ? t.issuedAt.getTime() < query.issuedBefore.getTime()
            : t.expiresAt.getTime() < query.urlExpiredBefore.getTime()),
      )
      .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
      .slice(0, query.limit)
      .map((t) => ({ ...t }));
  }

  async markSwept(id: string, at: Date): Promise<void> {
    const ticket = this.tickets.get(id);
    if (ticket) ticket.sweptAt = at;
  }
}
