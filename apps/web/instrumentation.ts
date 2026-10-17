/*
 * Runs once when a server instance starts (Next.js instrumentation, before it serves requests).
 * On the Node.js runtime it reads the whole server configuration (src/server/readiness.ts) and
 * logs the result: `server_ready`, or `server_not_ready` with every problem named by variable,
 * so a misconfigured deployment shows in the logs at startup rather than at the first request of
 * each route. It never throws: a failing `register` fails every request of the instance (on
 * Vercel, public pages and the health route included). GET /api/health answers 503 instead, and
 * every route keeps refusing to run without its own configuration.
 */
export async function register(): Promise<void> {
  // The documented guard: the import is left out of an edge build of this file.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logStartupReadiness } = await import('./src/server/readiness');
    logStartupReadiness();
  }
}
