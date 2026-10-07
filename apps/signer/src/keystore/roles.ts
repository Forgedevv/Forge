/**
 * Key roles and key references.
 *
 * Roles: `payer`, `cashbox`, `buyback` (one each) and `creator:<launchpadId>` (one per
 * launchpad, launchpadId = lowercase UUID as stored in Supabase). The role decides the
 * key file name, so a role can only ever have one key file.
 *
 * Refs: opaque random identifiers (`ks_` + 32 hex chars = 128 bits of entropy). They are
 * what Supabase stores in `launchpads.creator_wallet_ref`. A ref carries no information
 * about the key: it is generated independently of the key material.
 */

import { randomBytes } from 'node:crypto';
import { KeystoreError } from './errors.js';

export const FIXED_ROLES = ['payer', 'cashbox', 'buyback'] as const;
export type FixedRole = (typeof FIXED_ROLES)[number];
export type CreatorRole = `creator:${string}`;
export type KeyRole = FixedRole | CreatorRole;

/** Lowercase UUID only: Postgres/Supabase emit lowercase, and one canonical form keeps idempotency simple. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREATOR_PREFIX = 'creator:';

export const REF_RE = /^ks_[0-9a-f]{32}$/;

const FILE_SUFFIX = '.json';
const CREATOR_FILE_PREFIX = 'creator-';

function isFixedRole(value: string): value is FixedRole {
  return (FIXED_ROLES as readonly string[]).includes(value);
}

/** Validates a role string. Throws INVALID_ROLE on anything unexpected. */
export function parseRole(input: string): KeyRole {
  if (typeof input !== 'string') throw new KeystoreError('INVALID_ROLE');
  if (isFixedRole(input)) return input;
  if (input.startsWith(CREATOR_PREFIX)) {
    const id = input.slice(CREATOR_PREFIX.length);
    if (UUID_RE.test(id)) return `${CREATOR_PREFIX}${id}`;
  }
  throw new KeystoreError('INVALID_ROLE', { role: safeRoleForDetails(input) });
}

/** Builds the creator role of a launchpad. */
export function creatorRole(launchpadId: string): CreatorRole {
  const role = parseRole(`${CREATOR_PREFIX}${launchpadId}`);
  return role as CreatorRole;
}

/** Validates a ref string. Throws INVALID_REF on anything unexpected (also blocks path tricks). */
export function parseRef(input: string): string {
  if (typeof input !== 'string' || !REF_RE.test(input)) {
    throw new KeystoreError('INVALID_REF');
  }
  return input;
}

export function newRef(): string {
  return `ks_${randomBytes(16).toString('hex')}`;
}

/** File name of a role's key file (relative to the keystore directory). */
export function roleFileName(role: KeyRole): string {
  const parsed = parseRole(role);
  if (parsed.startsWith(CREATOR_PREFIX)) {
    return `${CREATOR_FILE_PREFIX}${parsed.slice(CREATOR_PREFIX.length)}${FILE_SUFFIX}`;
  }
  return `${parsed}${FILE_SUFFIX}`;
}

/** Inverse of roleFileName. Returns undefined for any file that is not a key file. */
export function roleFromFileName(fileName: string): KeyRole | undefined {
  if (!fileName.endsWith(FILE_SUFFIX)) return undefined;
  const stem = fileName.slice(0, -FILE_SUFFIX.length);
  if (isFixedRole(stem)) return stem;
  if (stem.startsWith(CREATOR_FILE_PREFIX)) {
    const id = stem.slice(CREATOR_FILE_PREFIX.length);
    if (UUID_RE.test(id)) return `${CREATOR_PREFIX}${id}`;
  }
  return undefined;
}

/** Keeps error details short and printable; a role is never secret but may be garbage. */
function safeRoleForDetails(input: string): string {
  const printable = input.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 64 ? `${printable.slice(0, 64)}...` : printable;
}
