#!/usr/bin/env node
// @ts-check
/* global document, window, getComputedStyle -- layoutProbe and scrollThrough run in the page */
/**
 * FORGE visual review capture. Plain Node ESM with no dependency (Node 22: global fetch and
 * WebSocket). It runs in the review image (apps/builder/docker/review.Dockerfile) on the site built
 * by the first agent pass, and on a laptop through the site test tool (scripts/site-test).
 *
 * For each page and viewport it opens a fresh tab of a headless Chromium driven through the
 * DevTools protocol, with real device emulation (`Emulation.setDeviceMetricsOverride`, `mobile`
 * for the phone, scale factor 1: never a window size), waits for the network to go idle, measures
 * the layout (horizontal overflow) and saves a full-page screenshot, in parts.
 *
 * Network: every request leaving the site's origin is intercepted (`Fetch` domain). The Jupiter
 * data API gets an empty-list fixture, so the market shows its real day-one state (no coin yet);
 * every other external request fails, and host names do not resolve (loopback only).
 *
 * Output, only into --out: `<page>-<viewport>.png`, `<page>-<viewport>-2.png`, `report.json`. The
 * builder treats all of it as untrusted input (pipeline/review/capture-output.ts).
 *
 * The page, viewport and size constants mirror pipeline/review/contract.ts (a test compares them).
 *
 * Usage:
 *   node capture.mjs --out <dir> --site <dir> [--port 3000] [--browser <path>] [--no-browser-sandbox]
 *   node capture.mjs --out <dir> --url http://127.0.0.1:3100 [--browser <path>]
 *   Options: --deadline-ms <ms> (default 240000), --pages home,about, --viewports mobile
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAGES = [
  { id: 'home', path: '/' },
  { id: 'create-pool', path: '/create-pool' },
  { id: 'about', path: '/about' },
  { id: 'creator-fees', path: '/creator-fees' },
];

export const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, mobile: false },
  { id: 'mobile', width: 390, height: 844, mobile: true },
];

export const SHOT_MAX_HEIGHT = 4000;
export const SHOT_PART_HEIGHT = 2000;
export const MAX_OVERFLOWING = 20;
export const MAX_CONSOLE_MESSAGES = 5;
export const REPORT_FILE = 'report.json';
export const DATAPI_ORIGIN = 'https://datapi.jup.ag';

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** File name of part `part` (1-based) of a capture. */
export function shotFile(page, viewport, part = 1) {
  return part <= 1 ? `${page}-${viewport}.png` : `${page}-${viewport}-${part}.png`;
}

/**
 * What happens to a request of the page: `continue` (the site itself), `fixture` (Jupiter data
 * API, answered locally) or `block` (anything else).
 * @param {string} rawUrl
 * @param {string} siteOrigin
 * @returns {'continue' | 'fixture' | 'block'}
 */
export function routeRequest(rawUrl, siteOrigin) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'block';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return 'continue';
  if (url.origin === siteOrigin) return 'continue';
  if (url.origin === DATAPI_ORIGIN) return 'fixture';
  return 'block';
}

/**
 * Answer of the Jupiter data API on day one: no coin in any list. CORS headers included (the
 * coin list is a cross-origin JSON POST, so it is preflighted).
 * @param {string} rawUrl
 * @param {string} method
 * @param {Record<string, string>} [headers]
 */
export function datapiFixture(rawUrl, method, headers = {}) {
  const header = (name) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? undefined;
  const cors = [
    { name: 'access-control-allow-origin', value: header('origin') ?? '*' },
    {
      name: 'access-control-allow-headers',
      value: header('access-control-request-headers') ?? 'content-type',
    },
    { name: 'access-control-allow-methods', value: 'GET, POST, OPTIONS' },
    { name: 'access-control-max-age', value: '600' },
    { name: 'vary', value: 'Origin' },
  ];
  if (method.toUpperCase() === 'OPTIONS') return { status: 204, headers: cors, body: '' };
  let pathname = '/';
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    /* default */
  }
  const empty = { pools: [] };
  const body = pathname.startsWith('/v1/pools/gems')
    ? { recent: empty, aboutToGraduate: empty, graduated: empty }
    : empty;
  return {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }, ...cors],
    body: JSON.stringify(body),
  };
}

/**
 * Locally installed Chrome, Chromium or Edge (first that exists).
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {(file: string) => boolean} exists
 * @returns {string | null}
 */
export function findBrowser(platform, env, exists = existsSync) {
  if (env.FORGE_REVIEW_BROWSER) return env.FORGE_REVIEW_BROWSER;
  const candidates = [];
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const root of roots) {
      candidates.push(path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
    );
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/**
 * Command-line flags of the headless browser.
 * @param {{ userDataDir: string, noSandbox: boolean }} options
 */
export function browserArgs({ userDataDir, noSandbox }) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-dev-shm-usage',
    // No name resolves but loopback: even a request the interception misses cannot leave.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    // In the container the browser's own sandbox cannot start (no user namespaces, no
    // privileges): the container is the sandbox.
    ...(noSandbox ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ out?: string, site?: string, url?: string, port: number, browser?: string, noSandbox: boolean, deadlineMs: number, pages: string[], viewports: string[] }} */
  const options = {
    port: 3000,
    noSandbox: false,
    deadlineMs: 240_000,
    pages: PAGES.map((p) => p.id),
    viewports: VIEWPORTS.map((v) => v.id),
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const list = (v, allowed, flag) => {
    const items = v.split(',').filter(Boolean);
    for (const item of items) {
      if (!allowed.includes(item)) throw new Error(`${flag}: unknown value ${item}`);
    }
    if (items.length === 0) throw new Error(`${flag} is empty`);
    return items;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = value(i++, arg);
    else if (arg === '--site') options.site = value(i++, arg);
    else if (arg === '--url') options.url = value(i++, arg);
    else if (arg === '--browser') options.browser = value(i++, arg);
    else if (arg === '--no-browser-sandbox') options.noSandbox = true;
    else if (arg === '--port') options.port = Number(value(i++, arg));
    else if (arg === '--deadline-ms') options.deadlineMs = Number(value(i++, arg));
    else if (arg === '--pages')
      options.pages = list(
        value(i++, arg),
        PAGES.map((p) => p.id),
        arg,
      );
    else if (arg === '--viewports')
      options.viewports = list(
        value(i++, arg),
        VIEWPORTS.map((v) => v.id),
        arg,
      );
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.out) throw new Error('--out <dir> is required');
  if (Boolean(options.site) === Boolean(options.url)) {
    throw new Error('give exactly one of --site <dir> and --url <origin>');
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error('--port must be between 1024 and 65535');
  }
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 10_000) {
    throw new Error('--deadline-ms must be at least 10000');
  }
  if (options.url) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('--url must be a loopback http origin');
    }
    options.url = url.origin;
  }
  return options;
}

/**
 * Runs in the page: measures the horizontal overflow. Lists visible elements whose right edge
 * passes the viewport, skipping those clipped by an ancestor that hides horizontal overflow and
 * fits in the viewport, and off-canvas fixed elements (closed drawers).
 * @param {number} max
 */
export function layoutProbe(max) {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const body = document.body;
  const out = [];
  let count = 0;
  const elements = body ? body.querySelectorAll('*') : [];
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= vw + 1) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
    if (st.position === 'fixed' && r.left >= vw) continue;
    let clipped = false;
    for (let p = el.parentElement; p && p !== doc; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX !== 'visible' && p.getBoundingClientRect().right <= vw + 1) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    count += 1;
    if (out.length < max) {
      const raw = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: raw.trim().split(/\s+/).filter(Boolean).slice(0, 6),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      });
    }
  }
  return {
    clientWidth: vw,
    scrollWidth: doc.scrollWidth,
    scrollHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
    overflowingCount: count,
    overflowing: out,
  };
}

/** Scrolls through the page (reveal-on-scroll sections), then back to the top. */
async function scrollThrough() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Math.max(200, window.innerHeight);
  const end = Math.min(document.documentElement.scrollHeight, 4000);
  for (let y = 0; y < end; y += step) {
    window.scrollTo(0, y);
    await sleep(150);
  }
  window.scrollTo(0, 0);
  await sleep(400);
  // Development overlay of `next dev` (local tool only): not part of the site.
  const style = document.createElement('style');
  style.textContent = 'nextjs-portal { display: none !important; }';
  document.head.appendChild(style);
  return true;
}

// -------------------------------------------------------------------------------------------
// DevTools protocol client (WebSocket, flat sessions)
// -------------------------------------------------------------------------------------------

class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, method: string }>} */
    this.pending = new Map();
    /** @type {Set<(method: string, params: any, sessionId: string | undefined) => void>} */
    this.listeners = new Set();
    ws.addEventListener('message', (event) => this.onMessage(event.data));
    ws.addEventListener('close', () => this.failAll(new Error('DevTools connection closed')));
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${String(message.error.message)}`));
      } else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of [...this.listeners]) {
        listener(message.method, message.params ?? {}, message.sessionId);
      }
    }
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** @param {(method: string, params: any, sessionId: string | undefined) => void} listener */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops what this process started (browser, site server); also run on SIGTERM / SIGINT. */
const activeCleanups = new Set();

/** Waits for a child process to exit, at most `ms`. */
function exited(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return Promise.race([new Promise((r) => proc.once('exit', r)), sleep(ms)]);
}

/** Keeps the last `max` characters of a stream (diagnostics only). */
function tail(stream, max = 8192) {
  let text = '';
  stream?.on('data', (chunk) => {
    text = (text + String(chunk)).slice(-max);
  });
  return () => text;
}

/** Starts the headless browser and connects to it. */
async function launchBrowser(executable, noSandbox) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'forge-capture-'));
  const proc = spawn(executable, browserArgs({ userDataDir, noSandbox }), {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const stderr = tail(proc.stderr);
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the browser did not start in 30 s')), 30_000);
    proc.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser exited early (code ${code}): ${stderr().slice(-500)}`));
    });
    proc.stderr?.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  proc.removeAllListeners('exit');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cannot connect to the browser')), {
      once: true,
    });
  });
  const cdp = new Cdp(ws);
  const close = async () => {
    await cdp.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
    ws.close();
    await exited(proc, 5_000);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    for (let i = 0; i < 5; i += 1) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
  };
  return { cdp, close };
}

/** Starts `next start` of the built site on loopback and waits until it answers. */
async function startSite(siteDir, port) {
  const nextBin = path.join(siteDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) throw new Error('next is not installed in the site folder');
  const origin = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: siteDir,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = tail(proc.stdout);
  const err = tail(proc.stderr);
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    await exited(proc, 3_000);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      return { origin, stop };
    } catch {
      await sleep(500);
    }
  }
  await stop();
  throw new Error(`the site did not start: ${`${out()}\n${err()}`.trim().slice(-800)}`);
}

/** Text of a console call, short. */
function consoleText(args) {
  return (Array.isArray(args) ? args : [])
    .map((a) => (a && (a.value ?? a.description)) ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** Report entry of one page at one viewport, before anything is known. */
function emptyEntry(page, viewport) {
  return {
    page: page.id,
    path: page.path,
    viewport: viewport.id,
    width: viewport.width,
    height: viewport.height,
    ok: false,
    error: /** @type {string | null} */ (null),
    status: /** @type {number | null} */ (null),
    files: /** @type {Array<{ file: string, y: number, height: number }>} */ ([]),
    pageHeight: 0,
    truncated: false,
    layout: /** @type {any} */ (null),
    consoleErrors: 0,
    consoleMessages: /** @type {string[]} */ ([]),
    requests: { fixture: 0, blocked: 0 },
  };
}

/**
 * Captures one page at one viewport, in a fresh tab. Never throws: errors are in the entry.
 * @param {Cdp} cdp
 */
async function capturePage(cdp, origin, page, viewport, outDir) {
  const entry = emptyEntry(page, viewport);
  let targetId;
  let off = () => false;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
    const url = `${origin}${page.path}`;
    const inflight = new Set();
    let lastActivity = Date.now();
    let loaded = false;
    const recordConsole = (text) => {
      entry.consoleErrors += 1;
      if (entry.consoleMessages.length < MAX_CONSOLE_MESSAGES) entry.consoleMessages.push(text);
    };
    off = cdp.on((method, params, sid) => {
      if (sid !== sessionId) return;
      if (method === 'Fetch.requestPaused') {
        const { requestId, request } = params;
        const route = routeRequest(request.url, origin);
        let action;
        if (route === 'continue') {
          action = send('Fetch.continueRequest', { requestId });
        } else if (route === 'fixture') {
          entry.requests.fixture += 1;
          const f = datapiFixture(request.url, request.method, request.headers);
          action = send('Fetch.fulfillRequest', {
            requestId,
            responseCode: f.status,
            responseHeaders: f.headers,
            body: Buffer.from(f.body, 'utf8').toString('base64'),
          });
        } else {
          entry.requests.blocked += 1;
          action = send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        }
        action.catch(() => undefined);
      } else if (method === 'Network.requestWillBeSent') {
        inflight.add(params.requestId);
        lastActivity = Date.now();
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight.delete(params.requestId);
        lastActivity = Date.now();
      } else if (method === 'Network.responseReceived') {
        if (params.type === 'Document' && entry.status === null) {
          entry.status = params.response?.status ?? null;
        }
      } else if (method === 'Runtime.consoleAPICalled') {
        if (params.type === 'error' || params.type === 'assert')
          recordConsole(consoleText(params.args));
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails ?? {};
        recordConsole(
          String(d.exception?.description ?? d.text ?? 'uncaught exception').slice(0, 200),
        );
      } else if (method === 'Page.loadEventFired') {
        loaded = true;
      }
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    if (viewport.mobile) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_USER_AGENT });
    }
    const nav = await send('Page.navigate', { url }, 30_000);
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    // Load event, then network idle (800 ms without activity), each capped.
    const loadDeadline = Date.now() + 30_000;
    while (!loaded && Date.now() < loadDeadline) await sleep(100);
    const idleDeadline = Date.now() + 15_000;
    while (Date.now() < idleDeadline) {
      if (inflight.size === 0 && Date.now() - lastActivity >= 800) break;
      await sleep(100);
    }
    await send(
      'Runtime.evaluate',
      {
        expression: 'document.fonts ? document.fonts.ready.then(() => true) : true',
        awaitPromise: true,
        returnByValue: true,
      },
      10_000,
    ).catch(() => undefined);
    await send(
      'Runtime.evaluate',
      { expression: `(${scrollThrough.toString()})()`, awaitPromise: true, returnByValue: true },
      20_000,
    ).catch(() => undefined);
    await sleep(1_000);
    const probe = await send('Runtime.evaluate', {
      expression: `(${layoutProbe.toString()})(${MAX_OVERFLOWING})`,
      returnByValue: true,
    });
    if (probe.exceptionDetails) throw new Error('the layout probe failed');
    const layout = probe.result?.value;
    entry.layout = {
      clientWidth: layout.clientWidth,
      scrollWidth: layout.scrollWidth,
      horizontalOverflow: layout.scrollWidth > layout.clientWidth,
      overflowingCount: layout.overflowingCount,
      overflowing: layout.overflowing,
    };
    entry.pageHeight = layout.scrollHeight;
    const total = Math.min(Math.max(layout.scrollHeight, viewport.height), SHOT_MAX_HEIGHT);
    entry.truncated = layout.scrollHeight > SHOT_MAX_HEIGHT;
    for (let part = 1, y = 0; y < total; part += 1, y += SHOT_PART_HEIGHT) {
      const height = Math.min(SHOT_PART_HEIGHT, total - y);
      const shot = await send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y, width: viewport.width, height, scale: 1 },
        },
        60_000,
      );
      const file = shotFile(page.id, viewport.id, part);
      writeFileSync(path.join(outDir, file), Buffer.from(shot.data, 'base64'));
      entry.files.push({ file, y, height });
    }
    entry.ok = true;
  } catch (error) {
    entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  } finally {
    off();
    if (targetId)
      await cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => undefined);
  }
  return entry;
}

/** Captures every page and viewport; writes the PNGs and `report.json` into `options.out`. */
export async function capture(options) {
  const started = Date.now();
  const deadline = started + options.deadlineMs;
  const browser = options.browser ?? findBrowser(process.platform, process.env);
  if (!browser) throw new Error('no Chrome, Chromium or Edge found: pass --browser <path>');
  const outDir = path.resolve(options.out);
  if (!existsSync(outDir)) throw new Error('the output folder does not exist');
  const cleanups = [];
  const shots = [];
  try {
    let origin = options.url;
    if (options.site) {
      const site = await startSite(path.resolve(options.site), options.port);
      cleanups.push(site.stop);
      activeCleanups.add(site.stop);
      origin = site.origin;
    }
    const { cdp, close } = await launchBrowser(browser, options.noSandbox);
    cleanups.push(close);
    activeCleanups.add(close);
    for (const viewport of VIEWPORTS.filter((v) => options.viewports.includes(v.id))) {
      for (const page of PAGES.filter((p) => options.pages.includes(p.id))) {
        if (Date.now() > deadline - 20_000) {
          shots.push({ ...emptyEntry(page, viewport), error: 'skipped: capture deadline reached' });
          continue;
        }
        // A page that hangs only costs its own entry: the report is always written in time.
        const budget = Math.min(120_000, deadline - 10_000 - Date.now());
        let timer;
        const timedOut = new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ ...emptyEntry(page, viewport), error: 'timed out' }),
            budget,
          );
        });
        shots.push(
          await Promise.race([capturePage(cdp, origin, page, viewport, outDir), timedOut]),
        );
        clearTimeout(timer);
      }
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      activeCleanups.delete(cleanup);
      await cleanup().catch(() => undefined);
    }
  }
  const report = {
    version: 1,
    generator: 'forge-review-capture',
    shotMaxHeight: SHOT_MAX_HEIGHT,
    shotPartHeight: SHOT_PART_HEIGHT,
    durationMs: Date.now() - started,
    shots,
  };
  // Written last and renamed, so a killed run never leaves a half-written report.
  const tmp = path.join(outDir, `${REPORT_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, path.join(outDir, REPORT_FILE));
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const hardStop = setTimeout(() => {
    process.stderr.write('capture: deadline exceeded\n');
    process.exit(3);
  }, options.deadlineMs + 15_000);
  hardStop.unref();
  try {
    const report = await capture(options);
    const ok = report.shots.filter((s) => s.ok).length;
    process.stdout.write(
      `capture: ${ok}/${report.shots.length} screenshots in ${report.durationMs} ms\n`,
    );
    for (const s of report.shots.filter((x) => !x.ok)) {
      process.stdout.write(`capture: ${s.page} ${s.viewport} failed: ${s.error}\n`);
    }
    process.exit(ok > 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      const pending = [...activeCleanups].map((c) => c().catch(() => undefined));
      void Promise.race([Promise.all(pending), sleep(5_000)]).then(() => process.exit(143));
    });
  }
  void main();
}
