/// <reference types="node" />
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { REVIEW_PAGES } from '../../src/pipeline/review/contract.js';
import { REPO_ROOT, TEMPLATE_DIR, ToolError, updateState, type Layout } from './layout.js';

/**
 * Serves site/ on a laptop: the template's installed dependencies are linked into it (Windows
 * junctions, symlinks elsewhere), `.env.local` points the RPC relay to a tiny local JSON-RPC proxy
 * to the public devnet endpoint, and `next dev` runs on 127.0.0.1.
 */

export const DEFAULT_SITE_PORT = 3100;
export const DEFAULT_RPC_PORT = 3101;
export const DEVNET_RPC = 'https://api.devnet.solana.com';

/** Credential-looking variables never reach the dev server. */
const SENSITIVE_ENV_RE =
  /KEY|SECRET|TOKEN|PRIVATE|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION|MNEMONIC|SEED/i;

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Links every installed dependency of the template (and `typescript`) into site/node_modules. */
export function linkDependencies(layout: Layout): number {
  const source = path.join(TEMPLATE_DIR, 'node_modules');
  if (!existsSync(source)) {
    throw new ToolError('apps/launchpad-template/node_modules is missing: run pnpm install first');
  }
  const nodeModules = path.join(layout.site, 'node_modules');
  if (existsSync(nodeModules) && lstatSync(nodeModules).isSymbolicLink()) {
    throw new ToolError('site/node_modules is a link: remove it first');
  }
  mkdirSync(nodeModules, { recursive: true });
  let linked = 0;
  const entries = readdirSync(source, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith('.'),
  );
  for (const entry of entries) {
    const link = path.join(nodeModules, entry.name);
    if (existsSync(link)) continue;
    linkDir(realpathSync(path.join(source, entry.name)), link);
    linked += 1;
  }
  const typescript = path.join(nodeModules, 'typescript');
  if (!existsSync(typescript)) {
    linkDir(realpathSync(path.join(REPO_ROOT, 'node_modules', 'typescript')), typescript);
    linked += 1;
  }
  updateState(layout, (s) => {
    s.linkedNodeModules = true;
  });
  return linked;
}

/** `.env.local` of the local site: devnet, the local RPC proxy, no secret. */
export function writeEnvLocal(layout: Layout, rpcPort: number): void {
  writeFileSync(
    path.join(layout.site, '.env.local'),
    [
      '# Written by the FORGE site test tool. Public values only.',
      'SOLANA_CLUSTER=devnet',
      'NEXT_PUBLIC_SOLANA_CLUSTER=devnet',
      `NEXT_PUBLIC_FORGE_RPC_RELAY_URL=http://127.0.0.1:${rpcPort}`,
      'NEXT_TELEMETRY_DISABLED=1',
      '',
    ].join('\n'),
  );
  updateState(layout, (s) => {
    s.envLocal = true;
  });
}

/** Local stand-in for the FORGE RPC relay: JSON-RPC POSTs forwarded to the devnet endpoint. */
export function startRpcProxy(port: number, upstream: string = DEVNET_RPC): Promise<http.Server> {
  if (!new URL(upstream).hostname.includes('devnet')) {
    throw new ToolError('the RPC proxy only forwards to a devnet endpoint');
  }
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(30_000),
      })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            '{"jsonrpc":"2.0","error":{"code":-32603,"message":"devnet unreachable"},"id":null}',
          );
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Stops a process and everything it started (next dev forks its server). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function answers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await r.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** True when something already answers on the port (the tool never starts a second server). */
export function portAnswers(port: number): Promise<boolean> {
  return answers(`http://127.0.0.1:${port}/`, 3_000);
}

export interface RunningSite {
  url: string;
  stop(): Promise<void>;
}

/**
 * Links the dependencies, writes `.env.local`, starts the RPC proxy and `next dev`, waits until
 * the site answers, then loads every reviewed page once (next dev compiles a page on its first
 * request, slower than the capture waits).
 */
export async function startSite(
  layout: Layout,
  sitePort: number,
  rpcPort: number,
): Promise<RunningSite> {
  if (await portAnswers(sitePort)) throw new ToolError(`port ${sitePort} is already in use`);
  const linked = linkDependencies(layout);
  if (linked > 0) console.log(`linked ${linked} dependencies into site/node_modules`);
  writeEnvLocal(layout, rpcPort);
  const proxy = await startRpcProxy(rpcPort);
  console.log(`RPC proxy on http://127.0.0.1:${rpcPort} -> ${DEVNET_RPC}`);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SENSITIVE_ENV_RE.test(k)) env[k] = v;
  env.NEXT_TELEMETRY_DISABLED = '1';
  updateState(layout, (s) => {
    s.nextDev = true;
  });
  const next = spawn(
    process.execPath,
    [
      path.join(layout.site, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '-H',
      '127.0.0.1',
      '-p',
      String(sitePort),
    ],
    {
      cwd: layout.site,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  let log = '';
  const keep = (c: Buffer) => {
    log = (log + c.toString('utf8')).slice(-4000);
  };
  next.stdout?.on('data', keep);
  next.stderr?.on('data', keep);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    killTree(next);
    await new Promise<void>((r) => proxy.close(() => r()));
  };
  const url = `http://127.0.0.1:${sitePort}`;
  try {
    const deadline = Date.now() + 180_000;
    while (!(await answers(`${url}/`, 120_000))) {
      if (next.exitCode !== null) throw new ToolError(`next dev exited:\n${log.slice(-1500)}`);
      if (Date.now() > deadline)
        throw new ToolError(`next dev did not answer:\n${log.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    for (const page of REVIEW_PAGES) {
      const t = Date.now();
      await answers(`${url}${page.path}`, 240_000);
      console.log(`  compiled ${page.path} in ${Math.round((Date.now() - t) / 1000)} s`);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  console.log(`site on ${url}`);
  return { url, stop };
}
