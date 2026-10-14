/// <reference types="node" />

/** Test helper: a scripted fetch stub that records every call. No network. */

export interface RecordedCall {
  method: string;
  /** Path plus query, without the origin. */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Parsed JSON body (string bodies only). */
  body: unknown;
  /** Bytes of a binary body (a file upload), copied. */
  raw: Uint8Array | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export interface Route {
  method: string;
  /** Matched against the path (without query). */
  path: string | RegExp;
  handler: Handler;
  /** Number of times the route may answer; unlimited when absent. */
  times?: number;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export interface FetchStub {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Calls matching method and path. */
  find(method: string, path: string | RegExp): RecordedCall[];
}

/** Routes are tried in order; the first with remaining `times` and a matching path wins. */
export function stubFetch(routes: Route[]): FetchStub {
  const remaining = routes.map((r) => r.times ?? Infinity);
  const calls: RecordedCall[] = [];
  const matches = (r: Route, method: string, path: string): boolean =>
    r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path));

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: RecordedCall = {
      method,
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      raw: init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined,
    };
    calls.push(call);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (r && (remaining[i] ?? 0) > 0 && matches(r, method, url.pathname)) {
        remaining[i] = (remaining[i] ?? 0) - 1;
        return r.handler(call);
      }
    }
    return json({ message: `unrouted ${method} ${url.pathname}` }, 599);
  };

  return {
    fetch: impl as typeof fetch,
    calls,
    find: (method, path) =>
      calls.filter(
        (c) =>
          c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)),
      ),
  };
}
