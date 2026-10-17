// @vitest-environment node
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { buildPaymentTx } from '@forge/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TransactionCheckError,
  assertSignedByWallet,
  configuredCashbox,
  verifyLaunchTransaction,
  verifyPartnerClaimTransaction,
  verifyPaymentTransaction,
} from '../verify';
import {
  SIG_BYTES,
  TOKEN_PROGRAM,
  WSOL,
  ata,
  blockhash,
  claimPoolCreationFeeIx,
  closeAccountIx,
  compile,
  createAtaIdempotentIx,
  LAUNCH,
  launchFixture,
  launchTx,
  memoIx,
  owner,
  partnerClaimTx,
  paymentTx,
} from './helpers';

const wallet = owner.toBase58();
const other = () => Keypair.generate().publicKey;
const jobId = crypto.randomUUID();
const cashbox = Keypair.generate().publicKey;

afterEach(() => vi.unstubAllEnvs());

function expectRefused(fn: () => void, message: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TransactionCheckError);
    expect((err as Error).message).toMatch(message);
    expect((err as Error).message).toMatch(/Nothing was (signed|sent)\./);
    return;
  }
  throw new Error('the transaction was accepted');
}

describe('verifyPaymentTransaction', () => {
  const expected = (over: Partial<Parameters<typeof verifyPaymentTransaction>[1]> = {}) => ({
    wallet,
    lamports: 250_000_000n,
    jobId,
    cashbox: cashbox.toBase58(),
    ...over,
  });

  it('accepts the transaction @forge/core builds, with or without a compute budget', () => {
    verifyPaymentTransaction(paymentTx({ lamports: 250_000_000n, jobId, cashbox }), expected());
    verifyPaymentTransaction(
      paymentTx({ lamports: 250_000_000n, jobId, cashbox, computeBudget: true }),
      expected(),
    );
    // Without a configured cashbox the recipient is not pinned (but never the payer itself).
    verifyPaymentTransaction(
      paymentTx({ lamports: 250_000_000n, jobId }),
      expected({ cashbox: null }),
    );
  });

  it('refuses another fee payer or an extra signer', () => {
    const payer = other();
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ payer, lamports: 250_000_000n, jobId, cashbox }),
          expected(),
        ),
      /fee payer is not your wallet/,
    );
    const extraSigner = memoIx('hello', other());
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox, extra: [extraSigner] }),
          expected(),
        ),
      /signatures other than your wallet/,
    );
  });

  it('refuses another amount, recipient, memo or a second transfer', () => {
    expectRefused(
      () =>
        verifyPaymentTransaction(paymentTx({ lamports: 250_000_001n, jobId, cashbox }), expected()),
      /amount does not match/,
    );
    expectRefused(
      () => verifyPaymentTransaction(paymentTx({ lamports: 250_000_000n, jobId }), expected()),
      /not the FORGE cashbox/,
    );
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox: owner }),
          expected({ cashbox: null }),
        ),
      /your own wallet/,
    );
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({
            lamports: 250_000_000n,
            jobId,
            cashbox,
            memo: `forge:job:${crypto.randomUUID()}`,
          }),
          expected(),
        ),
      /memo does not match/,
    );
    const second = SystemProgram.transfer({ fromPubkey: owner, toPubkey: other(), lamports: 1 });
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox, extra: [second] }),
          expected(),
        ),
      /recipient is not the FORGE cashbox|exactly one transfer/,
    );
    const secondToCashbox = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: cashbox,
      lamports: 250_000_000,
    });
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox, extra: [secondToCashbox] }),
          expected(),
        ),
      /exactly one transfer/,
    );
  });

  it('refuses a missing or duplicated memo, other programs and System variants', () => {
    const noMemo = compile(owner, [
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: cashbox, lamports: 250_000_000 }),
    ]);
    expectRefused(() => verifyPaymentTransaction(noMemo, expected()), /exactly one memo/);
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({
            lamports: 250_000_000n,
            jobId,
            cashbox,
            extra: [memoIx(`forge:job:${jobId}`, owner)],
          }),
          expected(),
        ),
      /exactly one memo/,
    );
    const foreign = new TransactionInstruction({
      programId: other(),
      keys: [],
      data: Buffer.from([1]),
    });
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox, extra: [foreign] }),
          expected(),
        ),
      /unexpected program/,
    );
    const assign = SystemProgram.assign({ accountPubkey: owner, programId: other() });
    expectRefused(
      () =>
        verifyPaymentTransaction(
          paymentTx({ lamports: 250_000_000n, jobId, cashbox, extra: [assign] }),
          expected(),
        ),
      /unexpected System instruction/,
    );
  });

  it('bounds the priority fee', () => {
    const expensive = compile(owner, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 9_000_000 }),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: cashbox, lamports: 250_000_000 }),
      memoIx(`forge:job:${jobId}`, owner),
    ]);
    expectRefused(
      () => verifyPaymentTransaction(expensive, expected()),
      /priority fee is too high/,
    );
  });

  it('accepts the priced payment the server builds with @forge/core, and nothing more', async () => {
    const connection = {
      getMinimumBalanceForRentExemption: async () => 890_880,
      getBalance: async () => 5_000_000,
      getLatestBlockhash: async () => ({ blockhash: blockhash(), lastValidBlockHeight: 10 }),
      getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 9_000_000 }],
    } as unknown as Connection;
    const built = await buildPaymentTx(
      connection,
      { payer: owner, lamports: 250_000_000n, jobId },
      // The server's PAYMENT_PRIORITY_FEE: the core defaults.
      { env: { FORGE_CASHBOX_WALLET: cashbox.toBase58() }, priority: {} },
    );
    // Capped by the default policy: 1,000,000 micro-lamports per CU, 0.0005 SOL in all.
    expect(built.priorityFee).toMatchObject({ microLamports: 1_000_000 });
    const message = built.transaction.compileMessage();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: message.recentBlockhash,
        instructions: built.transaction.instructions,
      }).compileToV0Message(),
    );
    expect(() => verifyPaymentTransaction(tx, expected())).not.toThrow();

    // The same payment with a second price, or a second limit, is refused.
    for (const duplicate of [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
    ]) {
      const doubled = compile(owner, [duplicate, ...built.transaction.instructions]);
      expectRefused(
        () => verifyPaymentTransaction(doubled, expected()),
        /Unexpected compute budget/,
      );
    }
  });

  it('refuses address lookup tables', () => {
    const table = new AddressLookupTableAccount({
      key: other(),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [cashbox],
      },
    });
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash(),
      instructions: [
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: cashbox, lamports: 250_000_000 }),
        memoIx(`forge:job:${jobId}`, owner),
      ],
    }).compileToV0Message([table]);
    expectRefused(
      () => verifyPaymentTransaction(new VersionedTransaction(msg), expected()),
      /address lookup tables/,
    );
  });
});

describe('configuredCashbox', () => {
  it('reads NEXT_PUBLIC_FORGE_CASHBOX_WALLET and refuses an invalid value', () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', '');
    expect(configuredCashbox()).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', cashbox.toBase58());
    expect(configuredCashbox()).toBe(cashbox.toBase58());
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', 'not-an-address');
    expect(() => configuredCashbox()).toThrow(/misconfigured/);
  });

  // Before: an unset pin silently disabled the recipient check, in production too.
  it('fails closed in a production build without a cashbox, keeps dev and test unpinned', () => {
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => configuredCashbox()).toThrow(TransactionCheckError);
    expect(() => configuredCashbox()).toThrow(/no cashbox address/);
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', '   ');
    expect(() => configuredCashbox()).toThrow(/no cashbox address/);
    vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', cashbox.toBase58());
    expect(configuredCashbox()).toBe(cashbox.toBase58());
    for (const mode of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', mode);
      vi.stubEnv('NEXT_PUBLIC_FORGE_CASHBOX_WALLET', '');
      expect(configuredCashbox()).toBeNull();
    }
  });
});

describe('verifyPartnerClaimTransaction', () => {
  const check = (tx: VersionedTransaction) => verifyPartnerClaimTransaction(tx, { wallet });

  it('accepts the partner claim @forge/core builds for the owner', () => {
    check(partnerClaimTx());
  });

  it('refuses another fee payer', () => {
    expectRefused(() => check(partnerClaimTx({ payer: other() })), /fee payer is not your wallet/);
  });

  it('refuses fees paid to accounts that are not the wallet', () => {
    const mint = other();
    expectRefused(
      () => check(partnerClaimTx({ claim: { mint, baseReceiver: ata(other(), mint) } })),
      /not paid to your own wallet/,
    );
    expectRefused(
      () => check(partnerClaimTx({ claim: { quoteReceiver: ata(other(), WSOL) } })),
      /not paid to your own wallet/,
    );
    expectRefused(
      () => check(compile(owner, [claimPoolCreationFeeIx(other())])),
      /not paid to your wallet/,
    );
    const thief = other();
    expectRefused(
      () => check(compile(owner, [claimPoolCreationFeeIx(owner, thief)])),
      /signatures other than your wallet|not made by your wallet/,
    );
  });

  it('refuses SOL, token moves and accounts outside the wallet', () => {
    expectRefused(
      () =>
        check(
          partnerClaimTx({
            extra: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: other(), lamports: 1 })],
          }),
        ),
      /sends SOL somewhere else/,
    );
    // The wallet's own WSOL account is fine (wrapping).
    check(
      partnerClaimTx({
        extra: [
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata(owner, WSOL), lamports: 1 }),
        ],
      }),
    );
    expectRefused(
      () => check(partnerClaimTx({ extra: [closeAccountIx(ata(owner, WSOL), other(), owner)] })),
      /somewhere else than your wallet/,
    );
    const transfer = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: ata(owner, WSOL), isSigner: false, isWritable: true },
        { pubkey: other(), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    });
    expectRefused(() => check(partnerClaimTx({ extra: [transfer] })), /unexpected token/);
    expectRefused(
      () => check(partnerClaimTx({ extra: [createAtaIdempotentIx(owner, other(), other())] })),
      /token account that is not yours/,
    );
    const foreign = new TransactionInstruction({
      programId: other(),
      keys: [],
      data: Buffer.from([]),
    });
    expectRefused(() => check(partnerClaimTx({ extra: [foreign] })), /unexpected program/);
  });

  it('refuses a transaction that claims nothing', () => {
    expectRefused(
      () => check(compile(owner, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })])),
      /does not claim any fees/,
    );
  });
});

describe('verifyLaunchTransaction / assertSignedByWallet', () => {
  const summary = {
    firstBuyLamports: LAUNCH.firstBuyLamports.toString(),
    coinName: LAUNCH.name,
    coinSymbol: LAUNCH.symbol,
  };
  /** Verifies a launch against the summary and the launch accounts sent with it. */
  const verify = (
    fixture: ReturnType<typeof launchFixture>,
    over: Partial<Parameters<typeof verifyLaunchTransaction>[1]> = {},
  ) => verifyLaunchTransaction(fixture.tx, { wallet, summary, launch: fixture.launch, ...over });

  it('accepts the launch @forge/core builds, paid by the wallet with only its signature missing', () => {
    verify(launchFixture());
    verify(launchFixture({ firstBuyLamports: 0n }), {
      summary: { ...summary, firstBuyLamports: '0' },
    });
  });

  it('refuses another fee payer, a missing FORGE signature or a wallet already signed', () => {
    expectRefused(() => verify(launchFixture({ payer: other() })), /fee payer is not your wallet/);
    expectRefused(() => verify(launchFixture({ presign: false })), /missing a FORGE signature/);
    expectRefused(() => verify(launchFixture({ presign: 'creator' })), /missing a FORGE signature/);
    const signed = launchFixture();
    signed.tx.signatures[0] = SIG_BYTES;
    expectRefused(() => verify(signed), /already signed/);
  });

  // Before: only the fee payer and the signature slots were checked, so a server could get the
  // wallet to sign any program call as long as FORGE's slots were filled.
  it('refuses a launch that does not do what the summary says', () => {
    expectRefused(
      () => verify(launchFixture({ firstBuyLamports: 2n })),
      /does not match the launch you are approving: the first buy amount/,
    );
    expectRefused(
      () => verify(launchFixture({ name: 'Other' })),
      /the coin name is not the expected one/,
    );
    expectRefused(
      () => verify(launchFixture({ symbol: 'OTHER' })),
      /the coin symbol is not the expected one/,
    );
    expectRefused(
      () => verify(launchFixture(), { summary: { ...summary, firstBuyLamports: 'x' } }),
      /launch summary is invalid/,
    );
  });

  // Before: the config, mint, creator wallet and nonce account were only checked to be consistent
  // within the transaction, so a launch on another config, mint, creator or nonce was accepted.
  it.each<[string, (fixture: ReturnType<typeof launchFixture>) => object, RegExp]>([
    ['another config', (f) => ({ ...f.launch, config: other().toBase58() }), /the config is not/],
    ['another mint', (f) => ({ ...f.launch, mint: other().toBase58() }), /the coin mint is not/],
    [
      'another creator wallet',
      (f) => ({ ...f.launch, creator: other().toBase58() }),
      /the creator wallet is not/,
    ],
    [
      'another durable nonce account',
      (f) => ({ ...f.launch, nonceAccount: other().toBase58() }),
      /the durable nonce account is not/,
    ],
    [
      'another metadata URI',
      (f) => ({ ...f.launch, metadataUri: 'https://example.com/other.json' }),
      /the metadata URI is not/,
    ],
  ])('refuses a launch on %s than the server response pins', (_label, launch, message) => {
    const fixture = launchFixture();
    expectRefused(
      () => verify(fixture, { launch: launch(fixture) as typeof fixture.launch }),
      message,
    );
  });

  it('refuses a launch when the server sent no launch accounts, in every environment', () => {
    const fixture = launchFixture();
    for (const env of ['production', 'development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      expectRefused(() => verify(fixture, { launch: undefined }), /launch details are missing/);
      expectRefused(() => verify(fixture, { launch: null }), /launch details are missing/);
    }
  });

  it('refuses malformed launch accounts', () => {
    const fixture = launchFixture();
    const bad = (over: object) => ({ ...fixture.launch, ...over }) as typeof fixture.launch;
    expectRefused(
      () => verify(fixture, { launch: bad({ creator: 'not-an-address' }) }),
      /launch details from the server are invalid/,
    );
    expectRefused(
      () => verify(fixture, { launch: bad({ metadataUri: 'http://example.com/acme.json' }) }),
      /launch details from the server are invalid/,
    );
    // Passes the base58 shape but is not a canonical public key.
    expectRefused(
      () => verify(fixture, { launch: bad({ config: '1'.repeat(44) }) }),
      /launch details from the server are invalid/,
    );
  });

  it('refuses SOL or tokens sent elsewhere and any other program', () => {
    const thief = other();
    expectRefused(
      () =>
        verify(
          launchFixture({
            extra: ({ payer }) => [
              SystemProgram.transfer({ fromPubkey: payer, toPubkey: thief, lamports: 1 }),
            ],
          }),
        ),
      /SOL is sent elsewhere/,
    );
    expectRefused(
      () =>
        verify(
          launchFixture({
            extra: ({ payer }) => [closeAccountIx(ata(payer, WSOL), thief, payer)],
          }),
        ),
      /wrapped SOL is returned elsewhere/,
    );
    expectRefused(
      () => verify(launchFixture({ extra: ({ payer }) => [memoIx('hello', payer)] })),
      /calls an unexpected program/,
    );
    expectRefused(
      () =>
        verify(
          launchFixture({
            extra: ({ payer, mint }) => [
              new TransactionInstruction({
                programId: TOKEN_PROGRAM,
                keys: [
                  { pubkey: ata(payer, mint), isSigner: false, isWritable: true },
                  { pubkey: thief, isSigner: false, isWritable: false },
                  { pubkey: payer, isSigner: true, isWritable: false },
                ],
                // Approve(amount = 1)
                data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]),
              }),
            ],
          }),
        ),
      /unexpected token call/,
    );
  });

  it('refuses a FORGE signature that does not verify', () => {
    const fixture = launchFixture();
    // Slot 1: the first FORGE signer (the mint), filled with bytes that are no signature.
    fixture.tx.signatures[1] = new Uint8Array(64).fill(9);
    expectRefused(() => verify(fixture), /does not verify/);
  });

  it('detects a wallet that changed the message or did not sign', () => {
    const tx = launchTx();
    const copy = VersionedTransaction.deserialize(tx.serialize());
    copy.signatures[0] = SIG_BYTES;
    assertSignedByWallet(tx, copy, wallet);
    expectRefused(() => assertSignedByWallet(tx, launchTx(), wallet), /changed the transaction/);
    const unsigned = VersionedTransaction.deserialize(tx.serialize());
    expectRefused(() => assertSignedByWallet(tx, unsigned, wallet), /did not sign/);
  });
});
