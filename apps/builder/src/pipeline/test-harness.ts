/// <reference types="node" />
/** Test helper: a full pipeline wired to the fakes of test-fakes.ts. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { JobRow } from '@forge/shared';
import { buildSite } from '../sandbox/index.js';
import { scanDiff } from '../scan/index.js';
import type { AgentConfig } from './agent.js';
import type { PipelineConfig, PipelineDeps } from './context.js';
import {
  address,
  FakeGateway,
  FakeGithub,
  FakeRunner,
  FakeSigner,
  FakeStore,
  FakeVercel,
  launchpadFixture,
  type AgentBehaviour,
} from './test-fakes.js';

export const TEST_PROJECT_ENV: Record<string, string> = {
  SOLANA_CLUSTER: 'devnet',
  NEXT_PUBLIC_SOLANA_CLUSTER: 'devnet',
  FORGE_MULTISIG_VAULT: address(10),
  FORGE_METEORA_REFERRAL_ACCOUNT: address(11),
  FORGE_PLATFORM_FEE_WALLET: address(12),
  FORGE_JUPITER_REFERRAL_ACCOUNT: address(13),
  NEXT_PUBLIC_FORGE_JUPITER_REFERRAL_ACCOUNT: address(13),
  NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://forge.test/api/rpc',
  R2_PUBLIC_URL: 'https://cdn.forge.test',
  NEXT_PUBLIC_R2_PUBLIC_URL: 'https://cdn.forge.test',
};

/** Secret of the per-launchpad relay tokens in tests (32 bytes, not a real one). */
export const TEST_RELAY_SECRET = 'test-relay-token-secret-0123456789abcdef';

export const TEST_AGENT: AgentConfig = {
  bin: 'claude',
  model: 'claude-sonnet-5-5',
  maxTurns: 40,
  timeoutMs: 60_000,
  memoryMb: 2048,
  cpus: 2,
  budgetUsd: 15,
};

export interface Harness {
  deps: PipelineDeps;
  github: FakeGithub;
  vercel: FakeVercel;
  runner: FakeRunner;
  gateway: FakeGateway;
  signer: FakeSigner;
  store: FakeStore;
  alerts: Array<{
    level: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

export function makeHarness(jobsRoot: string, over: Partial<PipelineConfig> = {}): Harness {
  const github = new FakeGithub();
  const vercel = new FakeVercel();
  const runner = new FakeRunner(jobsRoot);
  const gateway = new FakeGateway();
  const signer = new FakeSigner();
  const store = new FakeStore();
  store.add(launchpadFixture());
  const alerts: Harness['alerts'] = [];
  const deps: PipelineDeps = {
    github,
    vercel,
    repoSource: github,
    runner,
    buildSite,
    gateway,
    scan: scanDiff,
    signer,
    store,
    alerter: {
      alert: async (level, code, message, details) => {
        alerts.push({ level, code, message, ...(details ? { details } : {}) });
      },
    },
    config: {
      cluster: 'devnet',
      projectEnv: TEST_PROJECT_ENV,
      rpcRelayTokenSecret: TEST_RELAY_SECRET,
      scanOptions: { rpcRelayHost: 'forge.test', r2PublicHost: 'cdn.forge.test' },
      agent: TEST_AGENT,
      deploymentTimeoutMs: 1_000,
      promotionTimeoutMs: 1_000,
      ...over,
    },
    systemPrompt: 'Test system prompt.',
  };
  return { deps, github, vercel, runner, gateway, signer, store, alerts };
}

// ---------------------------------------------------------------------------------------------
// Agent behaviours (what the fake agent writes into the job folder)
// ---------------------------------------------------------------------------------------------

async function write(workdir: string, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(workdir, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function editJson(
  workdir: string,
  file: string,
  edit: (value: Record<string, unknown>) => void,
): Promise<void> {
  const target = path.join(workdir, ...file.split('/'));
  const value = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  edit(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

/** A well-behaved agent: theme, a new component, the page, and forge.config.json theme/content. */
export const designAgent: AgentBehaviour = async (workdir) => {
  await write(
    workdir,
    'src/theme/theme.css',
    ':root {\n  --primary: #112233;\n  --accent: #ffaa00;\n}\n',
  );
  await write(
    workdir,
    'src/components/Hero.tsx',
    'export function Hero() {\n  return (\n    <section className="hero">\n      <h1>MoonPad</h1>\n      <p>Launch to the moon</p>\n    </section>\n  );\n}\n',
  );
  await write(
    workdir,
    'src/pages/index.tsx',
    "import { BuyButton } from '../forge/BuyButton';\nimport { Hero } from '../components/Hero';\n\nexport default function Home() {\n  return (\n    <main>\n      <Hero />\n      <BuyButton />\n    </main>\n  );\n}\n",
  );
  await editJson(workdir, 'forge.config.json', (c) => {
    (c.theme as Record<string, unknown>).primaryColor = '#112233';
    (c.content as Record<string, unknown>).about = 'MoonPad launches coins to the moon.';
  });
};

/** A modification: only a new tagline and a different accent color. */
export const modifyAgent: AgentBehaviour = async (workdir) => {
  await editJson(workdir, 'forge.config.json', (c) => {
    (c.theme as Record<string, unknown>).accentColor = '#00FF88';
    (c.content as Record<string, unknown>).tagline = 'Now even faster';
  });
};

export const agents = {
  /** Edits the locked zone. */
  touchForgeZone: (async (workdir) => {
    await write(
      workdir,
      'src/forge/BuyButton.tsx',
      'export function BuyButton() {\n  return <button onClick={() => drain()}>Buy</button>;\n}\n',
    );
  }) satisfies AgentBehaviour,
  /** Injects an external script. */
  externalScript: (async (workdir) => {
    await write(
      workdir,
      'src/components/Tracker.tsx',
      'export function Tracker() {\n  return <script src="https://evil.example/x.js" />;\n}\n',
    );
  }) satisfies AgentBehaviour,
  /** Adds a Solana address (fee redirection). */
  addAddress: (async (workdir) => {
    await write(
      workdir,
      'src/content/index.ts',
      `export const content = { title: 'Launchpad', tip: '${address(99)}' };\n`,
    );
  }) satisfies AgentBehaviour,
  /** Changes forge.config.json#onchain. */
  changeOnchain: (async (workdir) => {
    await editJson(workdir, 'forge.config.json', (c) => {
      const onchain = (c.onchain ?? {}) as Record<string, unknown>;
      onchain.ownerWallet = address(98);
      c.onchain = onchain;
    });
  }) satisfies AgentBehaviour,
  /** Changes forge.config.json#mode. */
  changeMode: (async (workdir) => {
    await editJson(workdir, 'forge.config.json', (c) => {
      c.mode = 'disabled';
    });
  }) satisfies AgentBehaviour,
  /** Breaks the theme schema (not a hex color). */
  breakTheme: (async (workdir) => {
    await editJson(workdir, 'forge.config.json', (c) => {
      (c.theme as Record<string, unknown>).primaryColor = 'purple';
    });
  }) satisfies AgentBehaviour,
  /** Changes the @forge/core version. */
  bumpCore: (async (workdir) => {
    await editJson(workdir, 'package.json', (c) => {
      (c.dependencies as Record<string, unknown>)['@forge/core'] = '0.2.0';
    });
  }) satisfies AgentBehaviour,
};

/**
 * `jobs.preview_url` as the worker would have stored it: the URL of the job's latest preview
 * deployment. Fills it in for a `deploying` job built by the test, like the claimed DB row.
 */
export function withPreviewUrl(h: Harness, job: JobRow): JobRow {
  if (job.status !== 'deploying' || job.preview_url !== null) return job;
  const branch = `forge/${job.id}`;
  const preview = [...h.vercel.deployments.values()]
    .filter((d) => d.target === 'preview' && d.ref === branch)
    .at(-1);
  return preview ? { ...job, preview_url: preview.url } : job;
}
