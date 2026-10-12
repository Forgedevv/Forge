import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadMigrate, type PgConfig } from './migrate-module.js';

/*
 * TLS configuration of the migration script (scripts/migrate.mjs). No database needed.
 */

const migrate = await loadMigrate();

const PASSWORD = 'p@ss:w/rd;=x';
const URL_BASE = `postgresql://postgres.ref:${encodeURIComponent(PASSWORD)}@db.example.supabase.co:5432/postgres`;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

const dir = mkdtempSync(join(tmpdir(), 'forge-migrate-'));
const caFile = join(dir, 'ca.pem');
writeFileSync(caFile, PEM);
const notPem = join(dir, 'not.pem');
writeFileSync(notPem, 'hello');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The TLS options pg will actually use (connection string parameters override `ssl`). */
function effectiveSsl(config: PgConfig): unknown {
  const client = new pg.Client(config) as unknown as { connectionParameters: { ssl: unknown } };
  return client.connectionParameters.ssl;
}

describe('connectionConfig', () => {
  it('keeps the unverified connection without a CA and warns once, without details', () => {
    const warn = vi.fn();
    const config = migrate.connectionConfig(URL_BASE, {}, warn);
    expect(config).toEqual({ connectionString: URL_BASE, ssl: { rejectUnauthorized: false } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(migrate.UNVERIFIED_TLS_WARNING);
    expect(migrate.UNVERIFIED_TLS_WARNING).not.toMatch(/supabase\.co|postgres|5432/);
    expect(effectiveSsl(config)).toEqual({ rejectUnauthorized: false });
  });

  it('verifies against SUPABASE_DB_CA_FILE, even when the URL asks for another mode', () => {
    const warn = vi.fn();
    const config = migrate.connectionConfig(
      `${URL_BASE}?sslmode=require&application_name=forge-migrate`,
      { SUPABASE_DB_CA_FILE: ` ${caFile} ` },
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(config.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    const url = new URL(config.connectionString);
    expect(url.searchParams.has('sslmode')).toBe(false);
    expect(url.searchParams.get('application_name')).toBe('forge-migrate');
    expect(decodeURIComponent(url.password)).toBe(PASSWORD);
    expect(effectiveSsl(config)).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('refuses an unreadable or non-PEM CA file, naming the variable only', () => {
    const missing = join(dir, 'missing.pem');
    expect(() =>
      migrate.connectionConfig(URL_BASE, { SUPABASE_DB_CA_FILE: missing }, vi.fn()),
    ).toThrow(/^SUPABASE_DB_CA_FILE cannot be read$/);
    expect(() =>
      migrate.connectionConfig(URL_BASE, { SUPABASE_DB_CA_FILE: notPem }, vi.fn()),
    ).toThrow(/^SUPABASE_DB_CA_FILE is not a PEM certificate$/);
    let message = '';
    try {
      migrate.connectionConfig(`not a url ${PASSWORD}`, { SUPABASE_DB_CA_FILE: caFile }, vi.fn());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('SUPABASE_DB_URL is not a valid URL');
  });
});
