/**
 * Throwaway devnet wallets. Keypairs are generated on first use and stored as JSON secret-key
 * arrays in `.state/wallets/<name>.json` (gitignored). Only public keys are ever printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { STATE_DIR } from './env.js';

export const WALLET_NAMES = [
  'funder', // receives faucet SOL by hand, distributes to the others
  'referral', // owner of the WSOL referral token account (stand-in for the FORGE multisig)
  'partner', // feeClaimer / leftoverReceiver of the configs (stand-in for the client wallet)
  'forgeCreator', // poolCreator (stand-in for a FORGE creator wallet)
  'trader', // does buys and sells
  'client', // test 3: pays and signs the first buy
  'multisigStandIn', // test 2: receiver of the creator claim
  'platformFee', // test 4: receives the 30 bps platform fee
] as const;

export type WalletName = (typeof WALLET_NAMES)[number];

const WALLETS_DIR = resolve(STATE_DIR, 'wallets');

export function walletPath(name: WalletName): string {
  return resolve(WALLETS_DIR, `${name}.json`);
}

export function loadOrCreateWallet(name: WalletName): Keypair {
  if (!existsSync(WALLETS_DIR)) mkdirSync(WALLETS_DIR, { recursive: true });
  const path = walletPath(name);
  if (existsSync(path)) {
    const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)) + '\n', { encoding: 'utf8', mode: 0o600 });
  return kp;
}

export type Wallets = Record<WalletName, Keypair>;

export function loadWallets(): Wallets {
  const out = {} as Wallets;
  for (const name of WALLET_NAMES) out[name] = loadOrCreateWallet(name);
  return out;
}

/** A keypair stored outside the wallet set (e.g. a mint or a config keypair), by arbitrary name. */
export function loadOrCreateKeypair(fileName: string): Keypair {
  if (!existsSync(WALLETS_DIR)) mkdirSync(WALLETS_DIR, { recursive: true });
  const path = resolve(WALLETS_DIR, `${fileName}.json`);
  if (existsSync(path)) {
    const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)) + '\n', { encoding: 'utf8', mode: 0o600 });
  return kp;
}
