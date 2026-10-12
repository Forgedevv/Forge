/// <reference types="node" />
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_DEFAULTS, agentCommand, interpretAgentRun } from '../../src/pipeline/agent.js';
import type { SandboxRunResult } from '../../src/sandbox/index.js';
import { ToolError, type Layout } from './layout.js';

export interface LocalAgentOptions {
  /** CLI binary (default `claude` on the PATH). */
  bin: string;
  /** Default claude-sonnet-5-5, as in production. */
  model: string;
  maxTurns: number;
  timeoutMs: number;
}

export const LOCAL_AGENT_DEFAULTS: LocalAgentOptions = {
  bin: AGENT_DEFAULTS.bin,
  model: 'claude-sonnet-5-5',
  maxTurns: AGENT_DEFAULTS.maxTurns,
  timeoutMs: AGENT_DEFAULTS.timeoutMs,
};

/**
 * Runs the locally installed agent CLI in the site folder with exactly the production argv
 * (`agentCommand`: file tools only, no shell, no web tools, no MCP server). It uses the local CLI
 * login. There is no container here: only run briefs you trust.
 */
export async function runLocalAgent(
  layout: Layout,
  label: string,
  systemPrompt: string,
  taskPrompt: string,
  options: LocalAgentOptions,
): Promise<void> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.bin)) {
    throw new ToolError(
      'a .cmd/.bat agent CLI cannot receive multi-line prompts without a shell: use the native binary',
    );
  }
  const [bin, ...args] = agentCommand(options, systemPrompt, taskPrompt);
  const started = Date.now();
  console.log(
    `agent ${label}: ${options.model}, at most ${options.maxTurns} turns, in ${layout.site}`,
  );
  const run = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(bin!, args, {
      cwd: layout.site,
      // Background calls of the CLI use the same model, as in production.
      env: { ...process.env, ANTHROPIC_SMALL_FAST_MODEL: options.model },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const tick = setInterval(
      () => console.log(`  ... ${Math.round((Date.now() - started) / 1000)} s`),
      30_000,
    );
    child.once('error', (err) => {
      clearTimeout(timer);
      clearInterval(tick);
      reject(new ToolError(`cannot start the agent CLI "${bin}": ${err.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearInterval(tick);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
  writeFileSync(path.join(layout.out, `agent-${label}.json`), run.stdout);
  writeFileSync(path.join(layout.out, `agent-${label}.stderr.txt`), run.stderr);
  const result: SandboxRunResult = {
    runId: `local-${label}`,
    ok: run.code === 0 && !run.timedOut,
    exitCode: run.code,
    timedOut: run.timedOut,
    oomKilled: false,
    killedReason: run.timedOut ? 'timeout' : null,
    durationMs: Date.now() - started,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: { stdout: false, stderr: false },
    outputBytes: { stdout: run.stdout.length, stderr: run.stderr.length },
    egress: null,
  };
  // Same reading of the CLI result as the pipeline (throws on a failed run).
  const outcome = interpretAgentRun(result);
  console.log(
    `agent ${label}: ${outcome.turns ?? '?'} turns, $${outcome.reportedCostUsd?.toFixed(2) ?? '?'}, ${Math.round(outcome.durationMs / 1000)} s`,
  );
  if (outcome.summary) console.log(`summary: ${outcome.summary}`);
}
