/**
 * In-memory fake of the docker CLI for unit tests: no daemon, no process.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { SpawnFn } from './docker.js';

export interface DockerCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface FakeScenario {
  /** Exit code of the sandboxed command. */
  exitCode?: number;
  oomKilled?: boolean;
  stdout?: string | Buffer[];
  stderr?: string;
  /** The command never exits by itself (until `docker kill`). */
  hang?: boolean;
  /** `docker kill` does not make the attached CLI exit (stuck CLI). */
  stuckCli?: boolean;
  createCode?: number;
  createStderr?: string;
  egressNetworkExists?: boolean;
  egressIcc?: 'true' | 'false';
  egressInternal?: boolean;
  proxyLogs?: string;
  psOutput?: string;
  networkLsOutput?: string;
}

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: string | null = null;
  private done = false;

  kill(signal?: string): boolean {
    this.killedWith = signal ?? 'SIGTERM';
    this.finish(null);
    return true;
  }

  write(stdout?: string | Buffer[], stderr?: string): void {
    if (typeof stdout === 'string') this.stdout.write(stdout);
    else if (stdout) for (const chunk of stdout) this.stdout.write(chunk);
    if (stderr) this.stderr.write(stderr);
  }

  finish(code: number | null): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

function flag(args: string[], name: string): string | undefined {
  const f = args.find((a) => a.startsWith(`${name}=`));
  return f?.slice(name.length + 1);
}

export function fakeDocker(scenario: FakeScenario = {}) {
  const calls: DockerCall[] = [];
  const containers = new Map<string, { exitCode: number; oomKilled: boolean; running: boolean }>();
  const attached = new Map<string, FakeChild>();
  const networks = new Set<string>();
  let egressExists = scenario.egressNetworkExists ?? true;

  function handle(child: FakeChild, args: string[]): void {
    const [cmd, sub] = args;
    const last = args[args.length - 1]!;
    switch (cmd) {
      case 'create': {
        if (scenario.createCode && !args.some((a) => a.startsWith('--env=FORGE_EGRESS_CONFIG'))) {
          child.write(undefined, scenario.createStderr ?? 'create failed');
          child.finish(scenario.createCode);
          return;
        }
        const name = flag(args, '--name')!;
        containers.set(name, { exitCode: 0, oomKilled: false, running: false });
        child.write(`${'f'.repeat(64)}\n`);
        child.finish(0);
        return;
      }
      case 'start': {
        if (sub === '--attach') {
          const name = last;
          const c = containers.get(name);
          if (!c) {
            child.write(undefined, 'No such container');
            child.finish(1);
            return;
          }
          c.running = true;
          attached.set(name, child);
          child.write(scenario.stdout, scenario.stderr);
          if (!scenario.hang) {
            c.exitCode = scenario.exitCode ?? 0;
            c.oomKilled = scenario.oomKilled ?? false;
            c.running = false;
            child.finish(c.exitCode);
          }
          return;
        }
        child.finish(containers.has(last) ? 0 : 1);
        return;
      }
      case 'kill': {
        const c = containers.get(last);
        if (c) {
          c.exitCode = 137;
          c.running = false;
        }
        const a = attached.get(last);
        if (a && !scenario.stuckCli) a.finish(137);
        child.finish(c ? 0 : 1);
        return;
      }
      case 'inspect': {
        const c = containers.get(last);
        if (!c) {
          child.finish(1);
          return;
        }
        child.write(
          JSON.stringify({
            Status: c.running ? 'running' : 'exited',
            ExitCode: c.exitCode,
            OOMKilled: c.oomKilled,
          }),
        );
        child.finish(0);
        return;
      }
      case 'rm': {
        containers.delete(last);
        child.finish(0);
        return;
      }
      case 'logs': {
        child.write(
          scenario.proxyLogs ??
            '{"event":"ready","proxyPort":3128}\n{"event":"allow","host":"registry.npmjs.org","port":443}\n{"event":"deny","reason":"host_not_allowed","host":"example.com","port":443}\n',
        );
        child.finish(0);
        return;
      }
      case 'ps': {
        child.write(scenario.psOutput ?? '');
        child.finish(0);
        return;
      }
      case 'network': {
        if (sub === 'inspect') {
          if (!egressExists) {
            child.write(undefined, 'Error: No such network');
            child.finish(1);
            return;
          }
          child.write(
            JSON.stringify({
              Driver: 'bridge',
              Internal: scenario.egressInternal ?? false,
              Options: { 'com.docker.network.bridge.enable_icc': scenario.egressIcc ?? 'false' },
            }),
          );
          child.finish(0);
          return;
        }
        if (sub === 'create') {
          if (!args.includes('--internal')) egressExists = true;
          networks.add(last);
          child.finish(0);
          return;
        }
        if (sub === 'ls') {
          child.write(scenario.networkLsOutput ?? '');
          child.finish(0);
          return;
        }
        if (sub === 'rm') networks.delete(last);
        child.finish(0);
        return;
      }
      default:
        child.write(undefined, `unknown command ${cmd}`);
        child.finish(1);
    }
  }

  const spawn: SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], env: { ...(options.env ?? {}) } });
    setImmediate(() => handle(child, [...args]));
    return child as unknown as ChildProcess;
  };

  return {
    spawn,
    calls,
    containers,
    networks,
    attached,
    /** Calls whose argv starts with the given tokens. */
    find(...prefix: string[]): DockerCall[] {
      return calls.filter((c) => prefix.every((p, i) => c.args[i] === p));
    },
    sequence(): string[] {
      return calls.map((c) =>
        c.args[0] === 'network'
          ? `network ${c.args[1]}`
          : c.args[0] === 'start' && c.args[1] === '--attach'
            ? 'start --attach'
            : c.args[0]!,
      );
    },
  };
}
