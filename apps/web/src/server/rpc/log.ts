/*
 * Structured logs of the RPC relay, one JSON object per line.
 *
 * Only primitive fields are accepted and any field whose name contains KEY, SECRET, TOKEN, PRIVATE
 * or URL is dropped (PLANEXECUTE.md rule 3: RPC_URL embeds the provider key). Callers log tiers,
 * method names, origins, reasons and HTTP statuses; never a request or response body, an upstream
 * URL, an upstream error message, or a server token.
 */

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = 'info' | 'warn' | 'error';

export interface RelayLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

const FORBIDDEN_FIELD = /KEY|SECRET|TOKEN|PRIVATE|URL/i;

export function sanitizeFields(
  fields: LogFields = {},
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || FORBIDDEN_FIELD.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Name of an error, safe to log (never its message: fetch errors can carry the upstream URL). */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

export const consoleLogger: RelayLogger = {
  log(level, event, fields) {
    const line = JSON.stringify({ scope: 'rpc-relay', level, event, ...sanitizeFields(fields) });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  },
};

export class MemoryLogger implements RelayLogger {
  readonly entries: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = [];

  log(level: LogLevel, event: string, fields?: LogFields): void {
    this.entries.push({ level, event, fields: sanitizeFields(fields) });
  }

  events(): string[] {
    return this.entries.map((e) => e.event);
  }
}
