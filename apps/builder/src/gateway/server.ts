/**
 * AI gateway: an Anthropic Messages API reverse proxy that holds the real API key.
 *
 * The sandboxed agent (Claude Code headless) gets ANTHROPIC_BASE_URL = this gateway
 * and ANTHROPIC_AUTH_TOKEN = a per-job opaque token. The gateway checks the token,
 * the job budget and the request, swaps in the real key, forwards to Anthropic and
 * records the cost of each response. See docs/SECURITY.md §2 and §9.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino, type Logger } from 'pino';
import { OPS } from '@forge/shared';
import { GATEWAY_DEFAULTS } from './config.js';
import {
  assertValidPricing,
  computeCostUsd,
  parseUsage,
  type ModelPrice,
  type PricingTable,
  type Usage,
} from './pricing.js';
import { SseUsageReader } from './sse.js';
import type { GatewayStore, TokenRecord } from './store.js';

export interface GatewayAlert {
  kind: 'daily_budget_threshold';
  /** UTC day, YYYY-MM-DD. */
  day: string;
  totalUsd: number;
  dailyBudgetUsd: number;
  ratio: number;
}

export interface GatewayOptions {
  /** Anthropic API origin, e.g. https://api.anthropic.com. */
  upstreamUrl: string;
  /** Real Anthropic API key. Never logged nor returned. */
  apiKey: string;
  store: GatewayStore;
  pricing: PricingTable;
  dailyBudgetUsd: number;
  onAlert: (alert: GatewayAlert) => void | Promise<void>;
  /** Clock in epoch ms (tests). */
  now?: () => number;
  /** Allowed models. Defaults to the keys of `pricing`; each must be priced. */
  allowedModels?: readonly string[];
  /**
   * Allowed typed tools (server tools such as web search, or Anthropic-defined tools).
   * Default: none, only custom tools. Server tools would give the agent network
   * access through Anthropic and are billed outside the token pricing.
   */
  allowedToolTypes?: readonly string[];
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  upstreamTimeoutMs?: number;
  dailyAlertRatio?: number;
  logger?: Logger;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

export interface IssueTokenOptions {
  /** Default: OPS.agentBudgetUsdPerJob. */
  budgetUsd?: number;
  /** Default: OPS.agentTimeoutMinutes. */
  ttlMinutes?: number;
}

export interface Gateway {
  server: http.Server;
  /** Returns a new opaque token. Only its SHA-256 hash is stored. */
  issueToken(jobId: string, options?: IssueTokenOptions): Promise<string>;
  revokeToken(token: string): Promise<void>;
  revokeJobTokens(jobId: string): Promise<void>;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const TOKEN_PREFIX = 'forge_gw_';
const MAX_TOKEN_CHARS = 256;
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Request headers copied upstream. Everything else (auth, cookies, proxies) is dropped. */
const FORWARDED_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta', 'accept'] as const;
/** Upstream response headers copied to the client. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'request-id', 'retry-after', 'x-should-retry'];

/** Body fields that open side channels (remote MCP servers, server containers). */
const REJECTED_BODY_FIELDS = ['mcp_servers', 'container'] as const;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

function sendError(res: http.ServerResponse, err: HttpError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type: err.errorType, message: err.message } });
  res.writeHead(err.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, 'request_too_large', `Request body exceeds ${maxBytes} bytes.`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        reject(new HttpError(413, 'request_too_large', `Request body exceeds ${maxBytes} bytes.`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function extractToken(req: http.IncomingMessage): string | undefined {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  const fromApiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : undefined;
  let fromBearer: string | undefined;
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    if (!match) return undefined;
    fromBearer = match[1];
  }
  if (fromApiKey && fromBearer && fromApiKey !== fromBearer) return undefined;
  const token = fromBearer ?? fromApiKey;
  if (!token || token.length > MAX_TOKEN_CHARS) return undefined;
  return token;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`gateway: ${name} must be a positive number`);
  return value;
}

export function createGateway(options: GatewayOptions): Gateway {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const pricing = options.pricing;
  const allowedModels = new Set(options.allowedModels ?? Object.keys(pricing));
  assertValidPricing(pricing, [...allowedModels]);
  const allowedToolTypes = new Set(options.allowedToolTypes ?? []);
  const maxBodyBytes = positive(options.maxBodyBytes ?? GATEWAY_DEFAULTS.maxBodyBytes, 'maxBodyBytes');
  const maxResponseBytes = positive(
    options.maxResponseBytes ?? GATEWAY_DEFAULTS.maxResponseBytes,
    'maxResponseBytes',
  );
  const upstreamTimeoutMs = positive(
    options.upstreamTimeoutMs ?? GATEWAY_DEFAULTS.upstreamTimeoutMs,
    'upstreamTimeoutMs',
  );
  const dailyBudgetUsd = positive(options.dailyBudgetUsd, 'dailyBudgetUsd');
  const dailyAlertRatio = options.dailyAlertRatio ?? GATEWAY_DEFAULTS.dailyAlertRatio;
  if (typeof options.apiKey !== 'string' || options.apiKey === '') {
    throw new Error('gateway: apiKey is required');
  }
  const apiKey = options.apiKey;
  const upstream = new URL(options.upstreamUrl);
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error('gateway: upstreamUrl must be http(s)');
  }
  const upstreamBase = upstream.origin + upstream.pathname.replace(/\/+$/, '');
  const store = options.store;
  const log = (options.logger ?? pino({ name: 'gateway' })).child({ component: 'gateway' });

  /** Most expensive price of the table: used when the upstream reports an unpriced model. */
  const fallbackPrice: ModelPrice = Object.values(pricing).reduce((worst, price) =>
    price.inputPerMTok + price.outputPerMTok > worst.inputPerMTok + worst.outputPerMTok ? price : worst,
  );

  function priceFor(requestModel: string, responseModel: string | undefined): ModelPrice {
    if (responseModel !== undefined && responseModel !== requestModel) {
      return pricing[responseModel] ?? fallbackPrice;
    }
    return pricing[requestModel] ?? fallbackPrice;
  }

  function redact(text: string): string {
    return text.split(apiKey).join('[REDACTED]');
  }

  async function authenticate(req: http.IncomingMessage): Promise<TokenRecord> {
    const token = extractToken(req);
    if (!token) throw new HttpError(401, 'authentication_error', 'Missing or invalid gateway token.');
    const record = await store.getToken(hashToken(token));
    if (!record) throw new HttpError(401, 'authentication_error', 'Unknown gateway token.');
    if (record.revoked) throw new HttpError(401, 'authentication_error', 'Gateway token revoked.');
    if (now() >= record.expiresAt) throw new HttpError(401, 'authentication_error', 'Gateway token expired.');
    return record;
  }

  async function checkBudgets(record: TokenRecord): Promise<void> {
    const jobCost = await store.getJobCost(record.jobId);
    if (jobCost >= record.budgetUsd) {
      throw new HttpError(
        402,
        'budget_exceeded_error',
        `Job API budget exhausted (${record.budgetUsd} USD). No further requests are accepted for this job.`,
      );
    }
    const dailyCost = await store.getDailyCost(utcDay(now()));
    if (dailyCost >= dailyBudgetUsd) {
      throw new HttpError(402, 'daily_budget_exceeded_error', 'Daily API budget exhausted.');
    }
  }

  function validateBody(raw: Buffer): { body: Record<string, unknown>; model: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_request_error', 'Request body must be valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid_request_error', 'Request body must be a JSON object.');
    }
    const body = parsed as Record<string, unknown>;
    const model = body.model;
    if (typeof model !== 'string' || model === '') {
      throw new HttpError(400, 'invalid_request_error', 'Field "model" is required.');
    }
    if (!allowedModels.has(model)) {
      throw new HttpError(403, 'permission_error', `Model "${model.slice(0, 100)}" is not allowed by the gateway.`);
    }
    for (const field of REJECTED_BODY_FIELDS) {
      if (field in body) {
        throw new HttpError(403, 'permission_error', `Field "${field}" is not allowed by the gateway.`);
      }
    }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) {
        throw new HttpError(400, 'invalid_request_error', 'Field "tools" must be an array.');
      }
      for (const tool of body.tools as unknown[]) {
        const type = typeof tool === 'object' && tool !== null ? (tool as { type?: unknown }).type : undefined;
        if (type === undefined || type === null || type === 'custom') continue;
        if (typeof type !== 'string' || !allowedToolTypes.has(type)) {
          throw new HttpError(403, 'permission_error', `Tool type "${String(type).slice(0, 100)}" is not allowed by the gateway.`);
        }
      }
    }
    return { body, model };
  }

  function upstreamHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string' && value !== '') headers[name] = value;
      else if (Array.isArray(value) && value.length > 0) headers[name] = value.join(',');
    }
    headers['x-api-key'] = apiKey;
    return headers;
  }

  function copyResponseHeaders(upstreamRes: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstreamRes.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return headers;
  }

  async function record(jobId: string, model: string, usage: Usage, responseModel: string | undefined) {
    const costUsd = computeCostUsd(usage, priceFor(model, responseModel));
    if (costUsd <= 0) return { costUsd: 0, jobCostUsd: undefined as number | undefined };
    const day = utcDay(now());
    const jobCostUsd = await store.addJobCost(jobId, costUsd);
    const dailyTotal = await store.addDailyCost(day, costUsd);
    if (dailyTotal >= dailyAlertRatio * dailyBudgetUsd && (await store.markDailyAlert(day))) {
      log.warn({ day, dailyTotalUsd: dailyTotal, dailyBudgetUsd }, 'daily API budget threshold reached');
      try {
        await options.onAlert({
          kind: 'daily_budget_threshold',
          day,
          totalUsd: dailyTotal,
          dailyBudgetUsd,
          ratio: dailyAlertRatio,
        });
      } catch (error) {
        log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'onAlert failed');
      }
    }
    return { costUsd, jobCostUsd };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    const path = url.pathname;
    if (path !== MESSAGES_PATH && path !== COUNT_TOKENS_PATH) {
      throw new HttpError(404, 'not_found_error', 'Not found.');
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, 'invalid_request_error', 'Method not allowed.');
    }
    const token = await authenticate(req);
    await checkBudgets(token);
    const raw = await readBody(req, maxBodyBytes);
    const { body, model } = validateBody(raw);
    const isCountTokens = path === COUNT_TOKENS_PATH;

    // Only the `beta` flag (sent by Claude Code as ?beta=true) is forwarded.
    const target = new URL(upstreamBase + path);
    const beta = url.searchParams.get('beta');
    if (beta === 'true') target.searchParams.set('beta', 'true');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', onClose);

    let usage: Usage | undefined;
    let responseModel: string | undefined;
    let status = 0;
    let streamed = false;
    try {
      let upstreamRes: Response;
      try {
        upstreamRes = await doFetch(target, {
          method: 'POST',
          headers: upstreamHeaders(req),
          // Re-serialized: the upstream sees exactly the object that was validated.
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        throw controller.signal.aborted
          ? new HttpError(504, 'timeout_error', 'Upstream request timed out or was cancelled.')
          : new HttpError(502, 'api_error', 'Upstream request failed.');
      }
      status = upstreamRes.status;
      const headers = copyResponseHeaders(upstreamRes);
      const contentType = upstreamRes.headers.get('content-type') ?? '';

      if (upstreamRes.ok && contentType.includes('text/event-stream') && upstreamRes.body) {
        streamed = true;
        const reader = new SseUsageReader();
        res.writeHead(status, { ...headers, 'cache-control': 'no-cache' });
        try {
          for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
            reader.push(chunk);
            if (!res.write(chunk)) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
                };
                res.on('drain', done);
                res.on('close', done);
              });
            }
            if (res.destroyed) break;
          }
          reader.end();
          res.end();
        } catch {
          reader.end();
          res.destroy();
        } finally {
          usage = reader.usage;
          responseModel = reader.model;
        }
      } else {
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (upstreamRes.body) {
          try {
            for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
              size += chunk.length;
              if (size > maxResponseBytes) {
                controller.abort();
                throw new HttpError(502, 'api_error', 'Upstream response too large.');
              }
              chunks.push(chunk);
            }
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(504, 'timeout_error', 'Upstream response interrupted.');
          }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (upstreamRes.ok && !isCountTokens) {
          try {
            const json = JSON.parse(text) as { usage?: unknown; model?: unknown };
            usage = parseUsage(json.usage);
            if (typeof json.model === 'string') responseModel = json.model;
          } catch {
            usage = undefined;
          }
        }
        const out = redact(text);
        res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(out) });
        res.end(out);
      }
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      let costUsd = 0;
      let jobCostUsd: number | undefined;
      if (usage && !isCountTokens) {
        try {
          ({ costUsd, jobCostUsd } = await record(token.jobId, model, usage, responseModel));
        } catch (error) {
          log.error(
            { jobId: token.jobId, err: error instanceof Error ? redact(error.message) : 'unknown' },
            'failed to record API cost',
          );
        }
      }
      log.info(
        {
          jobId: token.jobId,
          path,
          model,
          status,
          stream: streamed,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          costUsd,
          jobCostUsd,
          durationMs: now() - started,
        },
        'gateway request',
      );
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (error.status >= 500) log.warn({ status: error.status, type: error.errorType }, 'gateway upstream error');
        sendError(res, error);
        return;
      }
      log.error({ err: error instanceof Error ? redact(error.message) : 'unknown' }, 'gateway internal error');
      sendError(res, new HttpError(500, 'api_error', 'Internal gateway error.'));
    });
  });
  server.requestTimeout = upstreamTimeoutMs + 60_000;

  return {
    server,
    async issueToken(jobId, opts = {}) {
      if (typeof jobId !== 'string' || jobId === '') throw new Error('gateway: jobId is required');
      const budgetUsd = positive(opts.budgetUsd ?? OPS.agentBudgetUsdPerJob, 'budgetUsd');
      const ttlMinutes = positive(opts.ttlMinutes ?? OPS.agentTimeoutMinutes, 'ttlMinutes');
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      await store.saveToken({
        tokenHash: hashToken(token),
        jobId,
        budgetUsd,
        expiresAt: now() + ttlMinutes * 60_000,
        revoked: false,
      });
      return token;
    },
    async revokeToken(token) {
      await store.revokeToken(hashToken(token));
    },
    async revokeJobTokens(jobId) {
      await store.revokeJobTokens(jobId);
    },
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
