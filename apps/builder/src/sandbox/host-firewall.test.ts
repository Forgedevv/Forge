/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * docker/host-firewall.sh repeats, for the kernel, the IPv4 ranges the egress proxy refuses.
 * Both lists must stay identical: a range missing from the firewall is reachable by a compromised
 * proxy.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(here, '../../docker/host-firewall.sh'), 'utf8');
const proxy = readFileSync(path.join(here, 'egress-proxy.ts'), 'utf8');

function firewallV4(): string[] {
  const block = /^DENY_V4=\(([^)]*)\)/m.exec(script)?.[1];
  if (!block) throw new Error('DENY_V4 not found in host-firewall.sh');
  return block.split(/\s+/).filter(Boolean).sort();
}

function proxyV4(): string[] {
  const block = /const V4_DENY[^=]*=\s*\[([\s\S]*?)\n\];/.exec(proxy)?.[1];
  if (!block) throw new Error('V4_DENY not found in egress-proxy.ts');
  return [...block.matchAll(/\['([0-9.]+)',\s*(\d+)\]/g)].map((m) => `${m[1]}/${m[2]}`).sort();
}

describe('host-firewall.sh', () => {
  it('drops exactly the IPv4 ranges the egress proxy refuses', () => {
    expect(proxyV4().length).toBeGreaterThan(10);
    expect(firewallV4()).toEqual(proxyV4());
  });

  it('includes the AS112 and AMT ranges', () => {
    for (const cidr of ['192.31.196.0/24', '192.52.193.0/24', '192.175.48.0/24']) {
      expect(firewallV4()).toContain(cidr);
    }
  });

  it('runs the startup self-check by default and fails closed', () => {
    expect(script).toContain('SELF_CHECK="${FORGE_FIREWALL_SELF_CHECK:-1}"');
    expect(script).toMatch(/--internal/);
    // The check network uses the sandbox bridge prefix, so the sandbox rules apply to it.
    expect(script).toContain('CHECK_IF="${SANDBOX_PREFIX}chk');
    expect(script).toMatch(/SELF-CHECK FAILED[\s\S]*exit 1/);
    // The probe sits in a single-quoted shell string: it must not contain a single quote.
    const probe = /^PROBE='([\s\S]*?)^'$/m.exec(script)?.[1];
    expect(probe).toBeDefined();
    expect(probe).not.toContain("'");
    for (const leak of ['resolves external names', 'public DNS server', 'direct TCP']) {
      expect(probe).toContain(leak);
    }
  });
});
