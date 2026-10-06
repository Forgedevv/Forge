import { z } from 'zod';
import { CLIENT_BOUNDS } from './constants.js';

/** Base58 Solana public key (32 to 44 characters). */
export const SolanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
  error: 'Invalid Solana address',
});
export type SolanaAddress = z.infer<typeof SolanaAddress>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, {
  error: 'Color must be a 6-digit hex value like #7C3AED',
});

/** Only http(s) URLs are accepted for images and logos rendered on client sites. */
const HttpUrl = z.url({ protocol: /^https?$/, error: 'Must be an http(s) URL' });

/** Launchpad slug: becomes `<slug>.<clients-domain>`. */
export const Slug = z.string().regex(/^[a-z0-9-]{3,32}$/, {
  error: 'Slug must be 3 to 32 characters: lowercase letters, digits and dashes',
});

const { tradingFeeBps, coinCreatorSharePct, poolCreationFeeSol } = CLIENT_BOUNDS;

/** Pure check of the pool creation fee bound: 0 (when allowed) or within [min, max] SOL. */
export function isValidPoolCreationFeeSol(value: number): boolean {
  if (value === 0) return poolCreationFeeSol.allowZero;
  return value >= poolCreationFeeSol.min && value <= poolCreationFeeSol.max;
}

/**
 * Launchpad specification produced by the design chat, consumed by the builder and the signer
 * (docs/INTERFACES.md §2). Bounds come from CLIENT_BOUNDS.
 */
export const LaunchpadSpec = z.object({
  version: z.literal(1),
  /** Client wallet = session wallet = payer = feeClaimer of both configs. */
  ownerWallet: SolanaAddress,
  name: z.string().min(2).max(32),
  slug: Slug,
  quote: z.literal('SOL'),
  tradingFeeBps: z.number().int().min(tradingFeeBps.min).max(tradingFeeBps.max),
  coinCreatorSharePct: z
    .number()
    .int()
    .min(coinCreatorSharePct.min)
    .max(coinCreatorSharePct.max)
    .default(coinCreatorSharePct.default),
  poolCreationFeeSol: z.number().refine(isValidPoolCreationFeeSol, {
    error: `poolCreationFeeSol must be 0 or between ${poolCreationFeeSol.min} and ${poolCreationFeeSol.max} SOL`,
  }),
  antiSniper: z.boolean().default(true),
  theme: z.object({
    primaryColor: HexColor,
    accentColor: HexColor,
    darkMode: z.boolean(),
    tagline: z.string().max(120),
    logoUrl: HttpUrl.optional(),
    /** Free-form instructions for the builder agent. */
    designNotes: z.string().max(2000),
  }),
  launchpadCoin: z.object({
    name: z.string().min(1).max(32),
    symbol: z.string().regex(/^[A-Z0-9]{2,10}$/, {
      error: 'Symbol must be 2 to 10 uppercase letters or digits',
    }),
    description: z.string().max(500),
    imageUrl: HttpUrl,
    /** Paid by the client. */
    firstBuySol: z.number().min(0).max(100),
  }),
});
/** Parsed spec (defaults applied). */
export type LaunchpadSpec = z.infer<typeof LaunchpadSpec>;
/** Spec before parsing (fields with defaults are optional). */
export type LaunchpadSpecInput = z.input<typeof LaunchpadSpec>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Partial spec while the chat fills it (docs/frontend/CONTRACT.md). Complete = LaunchpadSpec. */
export type LaunchpadSpecDraft = DeepPartial<Omit<LaunchpadSpecInput, 'version' | 'quote'>> & {
  version?: 1;
  quote?: 'SOL';
};

/** Draft validation result. `errors` keys are dotted field paths, e.g. "launchpadCoin.symbol". */
export interface SpecValidation {
  complete: boolean;
  errors: Record<string, string>;
}

/**
 * Validates a draft against LaunchpadSpec. `version` and `quote` are fixed by the contract and
 * filled in when missing. Keeps the first error message per field path.
 */
export function validateSpecDraft(draft: LaunchpadSpecDraft): SpecValidation {
  const result = LaunchpadSpec.safeParse({ ...draft, version: 1, quote: 'SOL' });
  if (result.success) return { complete: true, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join('.');
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { complete: false, errors };
}
