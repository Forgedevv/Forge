/// <reference types="node" />
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRow } from '@forge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRunOptions } from '../../sandbox/index.js';
import type { ChangedFile } from '../../scan/index.js';
import { jobBranch, StepAbortedError } from '../context.js';
import { createPipelineHandler } from '../index.js';
import {
  CREATE_JOB_ID,
  jobContext,
  jobFixture,
  makeJobsRoot,
  MODIFY_JOB_ID,
} from '../test-fakes.js';
import {
  designAgent,
  makeHarness,
  modifyAgent,
  withPreviewUrl,
  type Harness,
} from '../test-harness.js';
import { REVIEW_DEFAULTS, type VisualReviewConfig } from './config.js';
import { writeFakeCapture } from './test-helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const REPO = 'lp-moonpad';
const BRANCH = jobBranch(CREATE_JOB_ID);
const PASS1_HERO = '<h1>MoonPad</h1>';
const PASS2_HERO =
  'export function Hero() {\n  return (\n    <section className="hero hero-refined">\n      <h1>MoonPad, refined</h1>\n    </section>\n  );\n}\n';

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ root, cleanup } = await makeJobsRoot());
});
afterEach(async () => {
  await cleanup();
});

function harness(review: Partial<VisualReviewConfig> | null = {}): Harness {
  const h = makeHarness(root, review ? { review: { ...REVIEW_DEFAULTS, ...review } } : {});
  h.runner.agent = designAgent;
  return h;
}

async function write(workdir: string, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(workdir, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** The review agent: refines the hero, and records what it found in its folder. */
function refiningAgent(seen: { files?: string[]; report?: unknown } = {}) {
  return async (workdir: string) => {
    seen.files = (await readdir(path.join(workdir, '.forge-review'))).sort();
    seen.report = JSON.parse(
      await readFile(path.join(workdir, '.forge-review/report.json'), 'utf8'),
    );
    await write(workdir, 'src/components/Hero.tsx', PASS2_HERO);
  };
}

async function runStep(
  h: Harness,
  job: JobRow = jobFixture({ status: 'building' }),
  signal?: AbortSignal,
) {
  const { ctx, events } = jobContext(signal);
  const outcome = await createPipelineHandler(h.deps).handle(job, ctx);
  return { outcome, events };
}

const hero = (h: Harness) => h.github.text(REPO, BRANCH, 'src/components/Hero.tsx') ?? '';
const committedPaths = (h: Harness) => [...h.github.filesAt(REPO, BRANCH).keys()];
const runsOf = (h: Harness, step: string) => h.runner.runs.filter((r) => r.step === step);

describe('visual review: flag off', () => {
  it('runs exactly one agent pass, as before', async () => {
    const h = harness(null);
    const { events } = await runStep(h);
    expect(h.runner.stepsRun()).toEqual(['agent', 'install', 'build']);
    expect(h.gateway.issued).toHaveLength(1);
    expect(events).not.toContain('Reviewing the design on desktop and mobile');
    expect(hero(h)).toContain(PASS1_HERO);
  });
});

describe('visual review: flag on', () => {
  it('captures the built site, runs a second pass on it and commits the second pass', async () => {
    const h = harness();
    const seen: { files?: string[]; report?: unknown } = {};
    h.runner.reviewAgent = refiningAgent(seen);
    h.runner.capture = (dir) =>
      writeFakeCapture(dir, { pageHeight: 2600, mobileOverflow: ['home'] });
    const scanned: ChangedFile[][] = [];
    const scan = h.deps.scan;
    h.deps.scan = (files, options) => {
      scanned.push(files);
      return scan(files, options);
    };
    const { outcome, events } = await runStep(h);

    expect(h.runner.stepsRun()).toEqual([
      'agent',
      'install',
      'build',
      'capture',
      'agent',
      'install',
      'build',
    ]);
    // The second pass is what is committed and deployed.
    expect(hero(h)).toBe(PASS2_HERO);
    expect(outcome.patch?.preview_url).toMatch(/^https:\/\//);
    expect(events).toEqual([
      'Creating your repo',
      'Coding the design',
      'Checking the changes',
      'Building your site',
      'Reviewing the design on desktop and mobile',
      'Refining the design',
      'Building the refined site',
      'Publishing your preview',
    ]);

    // Capture: review image, no network, no secret, pass 1 folder read-only, separate output.
    const [captureRun] = runsOf(h, 'capture');
    const pass1Workdir = h.runner.runs[0]!.options.workdir;
    const o = captureRun!.options;
    expect(o).toMatchObject({
      image: 'review',
      network: 'none',
      workspaceReadOnly: true,
      workdir: pass1Workdir,
    });
    expect(o.secrets).toBeUndefined();
    expect(o.allow).toBeUndefined();
    expect(Object.keys(o.env ?? {}).some((k) => /KEY|TOKEN|SECRET|AUTH/.test(k))).toBe(false);
    expect(o.outputDir).toBeDefined();
    expect(o.outputDir).not.toBe(pass1Workdir);
    expect(path.dirname(o.outputDir!)).toBe(path.dirname(pass1Workdir));
    expect(o.command.slice(0, 2)).toEqual(['node', '/opt/forge/review/capture.mjs']);
    expect(o.timeoutMs).toBeLessThanOrEqual(REVIEW_DEFAULTS.captureTimeoutMs);

    // Pass 2: a fresh folder with the validated screenshots and report, the same rules.
    const agentRuns = runsOf(h, 'agent');
    const pass2 = agentRuns[1]!.options;
    expect(pass2.workdir).not.toBe(pass1Workdir);
    expect(pass2).toMatchObject({ network: 'allowlist', allow: ['gateway'] });
    expect(pass2.secrets).toEqual({ gatewayToken: h.gateway.issued[1]!.token });
    expect(seen.files).toContain('home-mobile.png');
    expect(seen.files).toContain('home-mobile-2.png');
    expect(seen.files).toContain('report.json');
    expect(JSON.stringify(seen.report)).toContain('"horizontalOverflow": true'.replace(': ', ':'));
    const argv = pass2.command;
    const task = argv[argv.indexOf('-p') + 1]!;
    expect(task).toMatch(/Read every screenshot with the Read tool/);
    expect(task).toContain('HORIZONTAL OVERFLOW');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('Test system prompt.');

    // Gateway: two tokens, the second capped by what is left (spent + review cap), both revoked.
    expect(h.gateway.issued).toHaveLength(2);
    expect(h.gateway.issued[1]!.budgetUsd).toBeCloseTo(0.42 + REVIEW_DEFAULTS.maxBudgetUsd, 6);
    expect(h.gateway.issued[1]!.ttlMinutes).toBeLessThanOrEqual(
      Math.ceil(REVIEW_DEFAULTS.agentTimeoutMs / 60_000) + 1,
    );
    expect(h.gateway.revoked).toEqual(h.gateway.issued.map((i) => i.token));
    expect(pass2.timeoutMs).toBeLessThanOrEqual(REVIEW_DEFAULTS.agentTimeoutMs);

    // The review input never reaches the scan or the repository.
    expect(scanned).toHaveLength(2);
    for (const files of scanned) {
      expect(files.some((f) => f.path.startsWith('.forge-review'))).toBe(false);
    }
    expect(committedPaths(h).some((p) => p.startsWith('.forge-review'))).toBe(false);
    // Build of pass 2: no network, in the pass 2 folder.
    const builds = runsOf(h, 'build');
    expect(builds[1]!.options).toMatchObject({ network: 'none', workdir: pass2.workdir });
    // Every folder (pass 1, capture output, pass 2) is gone.
    expect(await readdir(root)).toEqual([]);
  });

  it('caps the second pass at the job budget', async () => {
    const h = harness();
    h.runner.reviewAgent = refiningAgent();
    h.gateway.spentUsd = 12;
    await runStep(h);
    expect(h.gateway.issued[1]!.budgetUsd).toBe(15);
    expect(hero(h)).toBe(PASS2_HERO);
  });

  it('does not review modification jobs', async () => {
    const h = harness();
    h.runner.reviewAgent = refiningAgent();
    const create = (status: JobRow['status']) => jobFixture({ id: CREATE_JOB_ID, status });
    await runStep(h, create('building'));
    await runStep(h, create('onchain_setup'));
    await runStep(h, withPreviewUrl(h, create('deploying')));
    const before = h.runner.runs.length;
    h.runner.reviewAgent = modifyAgent;
    const { events } = await runStep(
      h,
      jobFixture({
        id: MODIFY_JOB_ID,
        type: 'modify_launchpad',
        status: 'building',
        request: 'A greener accent please',
      }),
    );
    expect(h.runner.runs.slice(before).map((r) => r.step)).toEqual(['agent', 'install', 'build']);
    expect(events).not.toContain('Reviewing the design on desktop and mobile');
  });
});

describe('visual review: any failure keeps the first pass', () => {
  type Setup = (h: Harness) => void;
  const cases: Array<[string, Setup, string[]]> = [
    [
      'the capture fails',
      (h) => {
        h.runner.captureExitCode = 1;
      },
      ['agent', 'install', 'build', 'capture'],
    ],
    [
      'the capture writes an invalid report',
      (h) => {
        h.runner.capture = async (dir) => {
          await writeFakeCapture(dir);
          await writeFile(path.join(dir, 'report.json'), '{"version": 1, "shots": [ oops');
        };
      },
      ['agent', 'install', 'build', 'capture'],
    ],
    [
      'the capture has no usable screenshot',
      (h) => {
        h.runner.capture = async (dir) => {
          await writeFakeCapture(dir);
          for (const f of await readdir(dir)) {
            if (f.endsWith('.png')) await writeFile(path.join(dir, f), 'not a png');
          }
        };
      },
      ['agent', 'install', 'build', 'capture'],
    ],
    [
      'the review agent fails',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.runner.reviewAgentExitCode = 1;
      },
      ['agent', 'install', 'build', 'capture', 'agent'],
    ],
    [
      'the review agent times out',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.runner.reviewAgentTimedOut = true;
      },
      ['agent', 'install', 'build', 'capture', 'agent'],
    ],
    [
      'the review agent reports an error result',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.runner.reviewAgentStdout = JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
        });
      },
      ['agent', 'install', 'build', 'capture', 'agent'],
    ],
    [
      'the second install fails',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.runner.installExitCodes = [0, 1];
      },
      ['agent', 'install', 'build', 'capture', 'agent', 'install'],
    ],
    [
      'the second build fails',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.runner.buildExitCodes = [0, 1];
      },
      ['agent', 'install', 'build', 'capture', 'agent', 'install', 'build'],
    ],
    [
      'too little of the job budget is left',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.gateway.spentUsd = 14.5;
      },
      ['agent', 'install', 'build', 'capture'],
    ],
    [
      'the gateway cannot issue the second token',
      (h) => {
        h.runner.reviewAgent = refiningAgent();
        h.gateway.onCall = (op) => {
          if (op === 'issueToken' && h.gateway.issued.length === 1) h.gateway.fail('issueToken');
        };
      },
      ['agent', 'install', 'build', 'capture'],
    ],
  ];

  for (const [label, setup, steps] of cases) {
    it(`when ${label}`, async () => {
      const h = harness();
      setup(h);
      const { outcome, events } = await runStep(h);
      expect(outcome.patch?.preview_url).toMatch(/^https:\/\//);
      expect(h.runner.stepsRun()).toEqual(steps);
      expect(hero(h)).toContain(PASS1_HERO);
      expect(hero(h)).not.toContain('refined');
      expect(committedPaths(h).some((p) => p.startsWith('.forge-review'))).toBe(false);
      expect(events.at(-1)).toBe('Publishing your preview');
      expect(events).not.toContain('The changes did not pass our safety checks');
      expect(h.gateway.revoked).toEqual(h.gateway.issued.map((i) => i.token));
      expect(await readdir(root)).toEqual([]);
    });
  }

  it('when the second pass breaks a scan rule (and an alert is sent)', async () => {
    const h = harness();
    h.runner.reviewAgent = async (workdir) => {
      await write(workdir, 'src/components/Hero.tsx', PASS2_HERO);
      await write(workdir, 'src/forge/BuyButton.tsx', 'export const BuyButton = () => null;\n');
    };
    const { events } = await runStep(h);
    expect(h.runner.stepsRun()).toEqual(['agent', 'install', 'build', 'capture', 'agent']);
    expect(hero(h)).toContain(PASS1_HERO);
    expect(h.alerts.map((a) => a.code)).toEqual([`review_scan_blocked:${CREATE_JOB_ID}`]);
    expect(events).not.toContain('The changes did not pass our safety checks');
  });

  it('when the review deadline passes during the second pass', async () => {
    const h = harness({ minTimeLeftMs: 0, minAgentMs: 0, buildReserveMs: 0 });
    let clock = 1_000_000;
    h.deps.now = () => clock;
    h.runner.reviewAgent = async (workdir) => {
      await refiningAgent()(workdir);
      clock += REVIEW_DEFAULTS.jobTimeoutMs; // far past the deadline
    };
    await runStep(h);
    expect(h.runner.stepsRun()).toEqual(['agent', 'install', 'build', 'capture', 'agent']);
    expect(hero(h)).toContain(PASS1_HERO);
  });

  it('when too little time is left after the first pass (no capture at all)', async () => {
    const h = harness();
    let clock = 1_000_000;
    h.deps.now = () => clock;
    h.runner.agent = async (workdir, options) => {
      await designAgent(workdir, options);
      clock += REVIEW_DEFAULTS.jobTimeoutMs - 10 * 60_000;
    };
    await runStep(h);
    expect(h.runner.stepsRun()).toEqual(['agent', 'install', 'build']);
    expect(hero(h)).toContain(PASS1_HERO);
  });

  it('but an abort of the job itself propagates', async () => {
    const h = harness();
    const controller = new AbortController();
    h.runner.reviewAgent = async (workdir) => {
      await refiningAgent()(workdir);
      controller.abort('timeout');
    };
    await expect(runStep(h, undefined, controller.signal)).rejects.toBeInstanceOf(StepAbortedError);
    expect(h.github.count('commitFiles')).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('visual review: the review folder never reaches the scan or the repository', () => {
  it('whatever the agent writes into it', async () => {
    const h = harness();
    h.runner.reviewAgent = async (workdir) => {
      await write(workdir, 'src/components/Hero.tsx', PASS2_HERO);
      await write(workdir, '.forge-review/extra.tsx', 'export const x = eval("1");\n');
      await write(workdir, '.forge-review/report.json', '{"tampered": true}');
      await mkdir(path.join(workdir, '.forge-review/nested/deeper'), { recursive: true });
    };
    const scanned: ChangedFile[][] = [];
    const scan = h.deps.scan;
    h.deps.scan = (files, options) => {
      scanned.push(files);
      return scan(files, options);
    };
    await runStep(h);
    expect(hero(h)).toBe(PASS2_HERO);
    expect(scanned.flat().some((f) => f.path.includes('forge-review'))).toBe(false);
    expect(committedPaths(h).some((p) => p.includes('forge-review'))).toBe(false);
  });

  it('even when the agent replaces it with a link', async () => {
    const h = harness();
    const outside = path.join(root, '..', `outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    let linked = true;
    h.runner.reviewAgent = async (workdir) => {
      await write(workdir, 'src/components/Hero.tsx', PASS2_HERO);
      await rm(path.join(workdir, '.forge-review'), { recursive: true, force: true });
      try {
        await symlink(outside, path.join(workdir, '.forge-review'), 'junction');
      } catch {
        linked = false;
      }
    };
    try {
      await runStep(h);
      expect(hero(h)).toBe(PASS2_HERO);
      expect(committedPaths(h).some((p) => p.includes('forge-review'))).toBe(false);
      // The link was removed, never followed.
      expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
      if (!linked) return;
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a first pass that creates it is scanned (and refused) like any hidden folder', async () => {
    const h = harness();
    h.runner.agent = async (workdir, options: SandboxRunOptions) => {
      await designAgent(workdir, options);
      await write(workdir, '.forge-review/notes.md', 'hello');
    };
    await expect(runStep(h)).rejects.toThrow(/scan blocked/);
    expect(h.runner.stepsRun()).toEqual(['agent']);
  });
});
