import { OPS } from '@forge/shared';
import { z } from 'zod';
import type { SandboxRunner, SandboxRunResult } from '../sandbox/index.js';
import { guard } from './context.js';
import { AgentFailedError } from './errors.js';

/**
 * Runs the site-coding agent (headless CLI) inside the sandbox, through the gateway.
 *
 * - network `allowlist` with the `gateway` preset only: the container reaches the gateway and
 *   nothing else (no registry, no GitHub);
 * - the only secret is a per-job gateway token with the job budget, revoked when the run ends;
 * - file tools only (read, list, search, edit, write): no shell, no web tools, no MCP server. The
 *   site is installed and built afterwards, in separate sandbox runs, once the scan has passed.
 */

/** Tools the agent may use. Everything else is refused by the CLI in print mode. */
export const AGENT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write'];
/** Explicitly refused, belt and braces. */
export const AGENT_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Task',
];

export interface AgentConfig {
  /** CLI binary inside the sandbox image. */
  bin: string;
  model: string;
  maxTurns: number;
  /** Default OPS.agentTimeoutMinutes. */
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  /** Default OPS.agentBudgetUsdPerJob. */
  budgetUsd: number;
}

export const AGENT_DEFAULTS = {
  bin: 'claude',
  maxTurns: 80,
  timeoutMs: OPS.agentTimeoutMinutes * 60_000,
  memoryMb: 2048,
  cpus: 2,
  budgetUsd: OPS.agentBudgetUsdPerJob,
} as const;

/** The gateway as seen by the pipeline (gateway/server.ts implements it). */
export interface AgentGateway {
  issueToken(jobId: string, options?: { budgetUsd?: number; ttlMinutes?: number }): Promise<string>;
  revokeToken(token: string): Promise<void>;
  /**
   * API cost already recorded for the job, all attempts and passes (the gateway's accounting).
   * Optional: without it the visual review budgets from the cost the CLI reported.
   */
  jobCostUsd?(jobId: string): Promise<number>;
}

/** argv of the agent run. The prompt is an argument (never a shell string). */
export function agentCommand(
  config: Pick<AgentConfig, 'bin' | 'model' | 'maxTurns'>,
  systemPrompt: string,
  taskPrompt: string,
): string[] {
  return [
    config.bin,
    '-p',
    taskPrompt,
    '--output-format',
    'json',
    '--model',
    config.model,
    '--max-turns',
    String(config.maxTurns),
    '--append-system-prompt',
    systemPrompt,
    '--allowedTools',
    AGENT_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    AGENT_DISALLOWED_TOOLS.join(','),
    '--strict-mcp-config',
  ];
}

const ResultSchema = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
});

export interface AgentOutcome {
  /** Summary written by the agent, if it could be read. */
  summary: string | undefined;
  turns: number | undefined;
  /** Cost reported by the CLI (the gateway's own accounting is authoritative). */
  reportedCostUsd: number | undefined;
  durationMs: number;
}

/** Reads the CLI's JSON result. Throws `AgentFailedError` when the run did not succeed. */
export function interpretAgentRun(run: SandboxRunResult): AgentOutcome {
  if (run.timedOut || run.killedReason === 'timeout') {
    throw new AgentFailedError('the agent did not finish within its time limit');
  }
  if (run.killedReason === 'aborted') throw new AgentFailedError('the agent run was aborted');
  if (run.killedReason === 'output_limit') {
    throw new AgentFailedError('the agent produced too much output');
  }
  if (run.oomKilled) throw new AgentFailedError('the agent ran out of memory');
  let parsed: z.infer<typeof ResultSchema> | undefined;
  try {
    const result = ResultSchema.safeParse(JSON.parse(run.stdout.trim()));
    if (result.success) parsed = result.data;
  } catch {
    parsed = undefined;
  }
  if (!run.ok) {
    const reason = parsed?.subtype ? ` (${parsed.subtype})` : '';
    throw new AgentFailedError(`the agent exited with code ${run.exitCode ?? 'unknown'}${reason}`);
  }
  if (parsed && (parsed.is_error === true || (parsed.subtype && parsed.subtype !== 'success'))) {
    throw new AgentFailedError(`the agent stopped with an error (${parsed.subtype ?? 'error'})`);
  }
  return {
    summary: parsed?.result?.slice(0, 2000),
    turns: parsed?.num_turns,
    reportedCostUsd: parsed?.total_cost_usd,
    durationMs: run.durationMs,
  };
}

export interface RunAgentInput {
  jobId: string;
  workdir: string;
  systemPrompt: string;
  taskPrompt: string;
  signal: AbortSignal;
}

/** Issues the job token, runs the agent, always revokes the token. */
export async function runAgent(
  deps: { runner: SandboxRunner; gateway: AgentGateway; config: AgentConfig },
  input: RunAgentInput,
): Promise<AgentOutcome> {
  const { config } = deps;
  guard(input.signal);
  const token = await deps.gateway.issueToken(input.jobId, {
    budgetUsd: config.budgetUsd,
    // The token outlives the run by a minute at most: the run is killed at its timeout.
    ttlMinutes: Math.ceil(config.timeoutMs / 60_000) + 1,
  });
  try {
    guard(input.signal);
    const run = await deps.runner.run({
      jobId: input.jobId,
      workdir: input.workdir,
      command: agentCommand(config, input.systemPrompt, input.taskPrompt),
      // Background calls of the CLI use the same model: only allow-listed models pass the gateway.
      env: { ANTHROPIC_SMALL_FAST_MODEL: config.model },
      secrets: { gatewayToken: token },
      network: 'allowlist',
      allow: ['gateway'],
      timeoutMs: config.timeoutMs,
      memoryMb: config.memoryMb,
      cpus: config.cpus,
      signal: input.signal,
    });
    guard(input.signal);
    return interpretAgentRun(run);
  } finally {
    await deps.gateway.revokeToken(token).catch(() => undefined);
  }
}
