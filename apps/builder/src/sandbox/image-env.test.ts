import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GATEWAY_DEFAULTS } from '../gateway/config.js';

/**
 * The agent CLI asks for more output tokens per request than the gateway accepts unless the
 * sandbox image caps it (a devnet run failed with `Field "max_tokens" must be an integer between 1
 * and 64000`). The cap lives in the image because the run env refuses names containing TOKEN.
 */
describe('sandbox image environment', () => {
  const dockerfile = readFileSync(
    new URL('../../docker/sandbox.Dockerfile', import.meta.url),
    'utf8',
  );

  it('caps the agent output tokens within the gateway limit', () => {
    const match = /\bCLAUDE_CODE_MAX_OUTPUT_TOKENS=(\d+)\b/.exec(dockerfile);
    expect(match, 'CLAUDE_CODE_MAX_OUTPUT_TOKENS is set in sandbox.Dockerfile').not.toBeNull();
    const cap = Number(match![1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(GATEWAY_DEFAULTS.maxOutputTokens);
  });
});
