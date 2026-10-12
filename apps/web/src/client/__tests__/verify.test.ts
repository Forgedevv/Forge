// @vitest-environment node
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
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
  const expected = { wallet, summary };

  it('accepts the launch @forge/core builds, paid by the wallet with only its signature missing', () => {
    verifyLaunchTransaction(launchTx(), expected);
    verifyLaunchTransaction(launchTx({ firstBuyLamports: 0n }), {
      wallet,
      summary: { ...summary, firstBuyLamports: '0' },
    });
  });

  it('refuses another fee payer, a missing FORGE signature or a wallet already signed', () => {
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ payer: other() }), expected),
      /fee payer is not your wallet/,
    );
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ presign: false }), expected),
      /missing a FORGE signature/,
    );
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ presign: 'creator' }), expected),
      /missing a FORGE signature/,
    );
    const signed = launchTx();
    signed.signatures[0] = SIG_BYTES;
    expectRefused(() => verifyLaunchTransaction(signed, expected), /already signed/);
  });

  // Before: only the fee payer and the signature slots were checked, so a server could get the
  // wallet to sign any program call as long as FORGE's slots were filled.
  it('refuses a launch that does not do what the summary says', () => {
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ firstBuyLamports: 2n }), expected),
      /does not match the launch you are approving: the first buy amount/,
    );
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ name: 'Other' }), expected),
      /the coin name is not the expected one/,
    );
    expectRefused(
      () => verifyLaunchTransaction(launchTx({ symbol: 'OTHER' }), expected),
      /the coin symbol is not the expected one/,
    );
    expectRefused(
      () =>
        verifyLaunchTransaction(launchTx(), {
          wallet,
          summary: { ...summary, firstBuyLamports: 'x' },
        }),
      /launch summary is invalid/,
    );
  });

  it('refuses SOL or tokens sent elsewhere and any other program', () => {
    const thief = other();
    expectRefused(
      () =>
        verifyLaunchTransaction(
          launchTx({
            extra: ({ payer }) => [
              SystemProgram.transfer({ fromPubkey: payer, toPubkey: thief, lamports: 1 }),
            ],
          }),
          expected,
        ),
      /SOL is sent elsewhere/,
    );
    expectRefused(
      () =>
        verifyLaunchTransaction(
          launchTx({ extra: ({ payer }) => [closeAccountIx(ata(payer, WSOL), thief, payer)] }),
          expected,
        ),
      /wrapped SOL is returned elsewhere/,
    );
    expectRefused(
      () =>
        verifyLaunchTransaction(
          launchTx({ extra: ({ payer }) => [memoIx('hello', payer)] }),
          expected,
        ),
      /calls an unexpected program/,
    );
    expectRefused(
      () =>
        verifyLaunchTransaction(
          launchTx({
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
          expected,
        ),
      /unexpected token call/,
    );
  });

  it('refuses a FORGE signature that does not verify', () => {
    const tx = launchTx();
    // Slot 1: the first FORGE signer (the mint), filled with bytes that are no signature.
    tx.signatures[1] = new Uint8Array(64).fill(9);
    expectRefused(() => verifyLaunchTransaction(tx, expected), /does not verify/);
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
