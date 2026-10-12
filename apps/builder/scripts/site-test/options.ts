/// <reference types="node" />
import { LOCAL_AGENT_DEFAULTS, type LocalAgentOptions } from './agent.js';
import { checkPort, resolveUserPath, ToolError } from './layout.js';
import { DEFAULT_RPC_PORT, DEFAULT_SITE_PORT } from './serve.js';

/** Command line of the site test tool (cli.ts). */

export const COMMANDS = ['prepare', 'agent', 'scan', 'serve', 'capture', 'review', 'all'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Options {
  command: Command;
  out: string;
  brief?: string;
  capture?: string;
  browser?: string;
  sitePort: number;
  rpcPort: number;
  agent: LocalAgentOptions;
}

export function parseCli(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) {
    throw new ToolError(`usage: site-test <${COMMANDS.join('|')}> --out <dir> [options]`);
  }
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ToolError(`${flag} needs a value`);
    }
    values.set(flag.slice(2), value);
  }
  const known = new Set([
    'out',
    'brief',
    'capture',
    'browser',
    'port',
    'rpc-port',
    'model',
    'agent-bin',
    'max-turns',
  ]);
  for (const key of values.keys())
    if (!known.has(key)) throw new ToolError(`unknown option --${key}`);
  const out = values.get('out');
  if (!out) throw new ToolError('--out <dir> is required (a folder outside the repository)');
  if ((command === 'prepare' || command === 'all') && !values.get('brief')) {
    throw new ToolError('--brief <file> is required');
  }
  const sitePort = checkPort(Number(values.get('port') ?? DEFAULT_SITE_PORT), '--port');
  const rpcPort = checkPort(Number(values.get('rpc-port') ?? DEFAULT_RPC_PORT), '--rpc-port');
  if (sitePort === rpcPort) throw new ToolError('--port and --rpc-port must differ');
  const maxTurns = Number(values.get('max-turns') ?? LOCAL_AGENT_DEFAULTS.maxTurns);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) {
    throw new ToolError('--max-turns must be between 1 and 500');
  }
  const opt = (k: string) => (values.get(k) ? resolveUserPath(values.get(k)!) : undefined);
  return {
    command: command as Command,
    out: resolveUserPath(out),
    ...(opt('brief') ? { brief: opt('brief')! } : {}),
    ...(opt('capture') ? { capture: opt('capture')! } : {}),
    ...(values.get('browser') ? { browser: values.get('browser')! } : {}),
    sitePort,
    rpcPort,
    agent: {
      ...LOCAL_AGENT_DEFAULTS,
      ...(values.get('model') ? { model: values.get('model')! } : {}),
      ...(values.get('agent-bin') ? { bin: values.get('agent-bin')! } : {}),
      maxTurns,
    },
  };
}
