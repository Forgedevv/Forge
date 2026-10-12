/*
 * Typed access to scripts/migrate.mjs from the tests. The script is plain JavaScript outside the
 * TypeScript project, so it is loaded by URL.
 */

export interface PgConfig {
  connectionString: string;
  ssl: { ca?: string; rejectUnauthorized: boolean };
}

export interface MigrateModule {
  UNVERIFIED_TLS_WARNING: string;
  /** pg client configuration with the TLS policy of the script (SUPABASE_DB_CA_FILE). */
  connectionConfig(
    url: string,
    env?: Record<string, string | undefined>,
    warn?: (line: string) => void,
  ): PgConfig;
}

export async function loadMigrate(): Promise<MigrateModule> {
  return (await import(new URL('../scripts/migrate.mjs', import.meta.url).href)) as MigrateModule;
}
