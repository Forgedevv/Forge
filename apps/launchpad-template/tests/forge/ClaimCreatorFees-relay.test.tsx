// @vitest-environment jsdom
import '../helpers/dom-setup';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockClaimsCore } from '@/forge/claims/mock-core';
import { FIXTURE_LAUNCHPAD_CONFIG } from '@/forge/create/test-fixtures';

const h = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('@jup-ag/wallet-adapter', () => ({
  useWallet: () => ({ publicKey: null, signTransaction: undefined }),
  useUnifiedWalletContext: () => ({ setShowModal: () => {} }),
}));

vi.mock('@/forge/create/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/forge/create/chain')>();
  return {
    ...actual,
    createRpcChainClient: (options: { url: string }) => {
      h.urls.push(options.url);
      return actual.createRpcChainClient(options);
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  h.urls = [];
});

describe('ClaimCreatorFees: JSON-RPC through the normalised relay endpoint', () => {
  it('sends to /api/rpc when the relay variable is a bare origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', 'https://forge.example');
    vi.resetModules();
    const { ClaimCreatorFees } = await import('@/forge/ClaimCreatorFees');
    render(
      <ClaimCreatorFees
        mode="live"
        core={createMockClaimsCore([])}
        launchpadConfigs={[FIXTURE_LAUNCHPAD_CONFIG.toBase58()]}
      />,
    );
    expect(h.urls).toEqual(['https://forge.example/api/rpc']);
  });

  it('builds no chain client when the relay variable is not an http(s) URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_RPC_RELAY_URL', 'ftp://forge.example');
    vi.resetModules();
    const { ClaimCreatorFees } = await import('@/forge/ClaimCreatorFees');
    render(<ClaimCreatorFees mode="live" core={createMockClaimsCore([])} />);
    expect(h.urls).toEqual([]);
  });
});
