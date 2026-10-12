// Applies supabase/migrations/*.sql in order to SUPABASE_DB_URL. Idempotent: applied files are
// recorded in schema_migrations. Never prints connection details.
//
// TLS: set SUPABASE_DB_CA_FILE to the path of the project's CA certificate (PEM, downloadable from
// the Supabase dashboard, Database settings, SSL configuration) to verify the server certificate
// and host name. Without it the connection is encrypted but not verified, and a one-line warning
// is printed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Connection string parameters that would override the `ssl` option given to pg. */
const SSL_URL_PARAMS = [
  'ssl',
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslnegotiation',
  'uselibpqcompat',
];

export const UNVERIFIED_TLS_WARNING =
  'warning: SUPABASE_DB_CA_FILE is not set, the database TLS certificate is not verified';

/**
 * pg client configuration for `url`. With SUPABASE_DB_CA_FILE: the server certificate must chain
 * to that CA and match the host (ssl parameters of the URL are dropped so that they cannot
 * override this). Without it: unchanged behaviour (encrypted, not verified) and `warn` is called
 * once with a fixed message. Errors name variables only, never values.
 */
export function connectionConfig(url, env = process.env, warn = console.warn) {
  const caFile = env.SUPABASE_DB_CA_FILE?.trim();
  if (!caFile) {
    warn(UNVERIFIED_TLS_WARNING);
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }
  let ca;
  try {
    ca = readFileSync(caFile, 'utf8');
  } catch {
    throw new Error('SUPABASE_DB_CA_FILE cannot be read');
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('SUPABASE_DB_CA_FILE is not a PEM certificate');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a valid URL');
  }
  for (const name of SSL_URL_PARAMS) parsed.searchParams.delete(name);
  return { connectionString: parsed.toString(), ssl: { ca, rejectUnauthorized: true } };
}

export function loadEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadEnv();
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is not set');
  const client = new pg.Client(connectionConfig(url));
  await client.connect();
  try {
    await client.query(
      'create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query('select name from public.schema_migrations')).rows.map((r) => r.name),
    );
    const dir = join(root, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      if (done.has(f)) {
        console.log(`skip   ${f}`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('insert into public.schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        console.log(`apply  ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        });
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
