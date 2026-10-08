/*
 * Structured logs of the payment routes, one JSON object per line.
 *
 * Only primitive fields are accepted, and any field whose name contains KEY, SECRET, TOKEN or
 * PRIVATE is dropped (PLANEXECUTE.md rule 3). Callers log ids, statuses, reasons, amounts and
 * public transaction signatures; never a request body, an RPC URL or a raw error message (RPC
 * and HTTP errors may echo the endpoint, which embeds an API key).
 */

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = 'info' | 'warn' | 'error';

export interface PaymentsLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

const FORBIDDEN_FIELD = /KEY|SECRET|TOKEN|PRIVATE/i;

/** Drops forbidden or undefined fields. Exported for tests. */
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

/** Name of an error, safe to log (never its message). */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

export const consoleLogger: PaymentsLogger = {
  log(level, event, fields) {
    const line = JSON.stringify({ scope: 'payments', level, event, ...sanitizeFields(fields) });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  },
};

/** Logger that keeps entries in memory (tests, smoke script). */
export class MemoryLogger implements PaymentsLogger {
  readonly entries: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = [];

  log(level: LogLevel, event: string, fields?: LogFields): void {
    this.entries.push({ level, event, fields: sanitizeFields(fields) });
  }

  events(): string[] {
    return this.entries.map((e) => e.event);
  }
}
