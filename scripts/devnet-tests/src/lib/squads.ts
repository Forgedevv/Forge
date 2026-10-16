/**
 * Squads v4 helpers for the signer buyback proof (signer-buyback.ts): a throwaway multisig with
 * its vault 0 and a daily SOL spending limit for the throwaway bot wallet. Official SDK
 * (@sqds/multisig 2.1.4, pinned); the SDK builds the unsigned transactions, the throwaway wallets
 * sign them here, they are sent raw and confirmed by polling `getSignatureStatuses` (no websocket).
 */
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey, type Signer, type VersionedTransaction } from '@solana/web3.js';
import { COMMITMENT, confirmBySignature, getConnection, sleep } from './solana.js';

export const SQUADS_PROGRAM_ID = new PublicKey(multisig.PROGRAM_ID.toBase58());

/** Builds with a fresh blockhash, signs, sends and confirms; retries transient failures. */
export async function sendVersioned(
  build: (blockhash: string) => VersionedTransaction,
  signers: Signer[],
  label: string,
): Promise<string> {
  const conn = getConnection();
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
    const tx = build(blockhash);
    tx.sign(signers);
    try {
      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await confirmBySignature(signature, lastValidBlockHeight);
      console.log(`    tx ${label} ${signature}`);
      return signature;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /block height exceeded|Blockhash not found|fetch failed|ECONNRESET|ETIMEDOUT|429|503|timed out/i.test(
          msg,
        );
      if (!transient || attempt === attempts) {
        const logs = (err as { logs?: string[] }).logs;
        if (logs) console.error(logs.join('\n'));
        throw err;
      }
      console.warn(`    retry ${attempt}/${attempts}: ${msg.slice(0, 120)}`);
      await sleep(1_500 * attempt);
    }
  }
}

/** The program config of the cluster: treasury and multisig creation fee. */
export async function readProgramConfig(): Promise<{ treasury: PublicKey; creationFee: bigint }> {
  const [pda] = multisig.getProgramConfigPda({});
  const cfg = await multisig.accounts.ProgramConfig.fromAccountAddress(getConnection(), pda, COMMITMENT);
  return {
    treasury: new PublicKey(cfg.treasury.toBase58()),
    creationFee: BigInt(cfg.multisigCreationFee.toString()),
  };
}

export interface CreateMultisigArgs {
  /** Only voter (all permissions), threshold 1. */
  creator: Keypair;
  createKey: Keypair;
  /** Member WITHOUT any permission: it can only use its spending limit. */
  bot: PublicKey;
}

export async function createMultisigOnChain(
  a: CreateMultisigArgs,
): Promise<{ multisigPda: string; vault: string; signature: string }> {
  const { treasury } = await readProgramConfig();
  const [multisigPda] = multisig.getMultisigPda({ createKey: a.createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const signature = await sendVersioned(
    (blockhash) =>
      multisig.transactions.multisigCreateV2({
        blockhash,
        treasury,
        createKey: a.createKey.publicKey,
        creator: a.creator.publicKey,
        multisigPda,
        configAuthority: null,
        threshold: 1,
        members: [
          { key: a.creator.publicKey, permissions: multisig.types.Permissions.all() },
          { key: a.bot, permissions: multisig.types.Permissions.fromPermissions([]) },
        ],
        timeLock: 0,
        rentCollector: null,
        memo: 'forge devnet buyback proof',
      }),
    [a.creator, a.createKey],
    'multisigCreateV2',
  );
  return { multisigPda: multisigPda.toBase58(), vault: vault.toBase58(), signature };
}

export interface AddSpendingLimitArgs {
  creator: Keypair;
  multisigPda: PublicKey;
  /** Create key of the spending limit (any fresh public key). */
  createKey: PublicKey;
  bot: PublicKey;
  amountLamports: bigint;
}

/**
 * Config transaction `AddSpendingLimit` (vault 0, SOL, period Day, members = [bot],
 * destinations = [bot]): create, propose, approve, execute, all by the creator.
 */
export async function addDailySolSpendingLimit(
  a: AddSpendingLimitArgs,
): Promise<{ spendingLimit: string; transactionIndex: string; signatures: Record<string, string> }> {
  const account = await multisig.accounts.Multisig.fromAccountAddress(
    getConnection(),
    a.multisigPda,
    COMMITMENT,
  );
  const transactionIndex = BigInt(account.transactionIndex.toString()) + 1n;
  const [spendingLimit] = multisig.getSpendingLimitPda({
    multisigPda: a.multisigPda,
    createKey: a.createKey,
  });
  const common = { multisigPda: a.multisigPda, transactionIndex, feePayer: a.creator.publicKey };
  const signatures: Record<string, string> = {};
  signatures.configTransactionCreate = await sendVersioned(
    (blockhash) =>
      multisig.transactions.configTransactionCreate({
        ...common,
        blockhash,
        creator: a.creator.publicKey,
        actions: [
          {
            __kind: 'AddSpendingLimit',
            createKey: a.createKey,
            vaultIndex: 0,
            mint: PublicKey.default,
            amount: Number(a.amountLamports),
            period: multisig.types.Period.Day,
            members: [a.bot],
            destinations: [a.bot],
          },
        ],
      }),
    [a.creator],
    'configTransactionCreate (AddSpendingLimit)',
  );
  signatures.proposalCreate = await sendVersioned(
    (blockhash) =>
      multisig.transactions.proposalCreate({ ...common, blockhash, creator: a.creator.publicKey }),
    [a.creator],
    'proposalCreate',
  );
  signatures.proposalApprove = await sendVersioned(
    (blockhash) =>
      multisig.transactions.proposalApprove({ ...common, blockhash, member: a.creator.publicKey }),
    [a.creator],
    'proposalApprove',
  );
  signatures.configTransactionExecute = await sendVersioned(
    (blockhash) =>
      multisig.transactions.configTransactionExecute({
        ...common,
        blockhash,
        member: a.creator.publicKey,
        rentPayer: a.creator.publicKey,
        spendingLimits: [spendingLimit],
      }),
    [a.creator],
    'configTransactionExecute',
  );
  return {
    spendingLimit: spendingLimit.toBase58(),
    transactionIndex: transactionIndex.toString(),
    signatures,
  };
}
