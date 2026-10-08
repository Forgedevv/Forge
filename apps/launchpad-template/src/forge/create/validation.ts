import { parseSolToLamports } from './amounts';

/**
 * LOCKED ZONE. Client-side validation of the coin creation form. Pure functions: the same rules
 * are re-checked against the server summary before anything is signed (see `verify.ts`).
 */

export const NAME_MIN = 3;
export const NAME_MAX = 32;
export const SYMBOL_MIN = 2;
export const SYMBOL_MAX = 10;
export const DESCRIPTION_MAX = 500;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** Upper bound of a first buy, in SOL (same bound as LaunchpadSpec.launchpadCoin.firstBuySol). */
export const FIRST_BUY_MAX_SOL = 100;

export interface CreateCoinInput {
  name: string;
  symbol: string;
  description: string;
  /** Selected image (File in the browser; any object with name/type/size in tests). */
  image: { name: string; type: string; size: number } | null;
  /** Decimal SOL string typed by the user. Empty means "no first buy". */
  firstBuySol: string;
}

export type CreateCoinField = 'name' | 'symbol' | 'description' | 'image' | 'firstBuySol';
export type CreateCoinErrors = Partial<Record<CreateCoinField, string>>;

export interface ValidatedCoin {
  name: string;
  symbol: string;
  description: string;
  firstBuyLamports: bigint;
}

// Control characters and bidirectional overrides have no place in a coin name.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export type ValidationResult =
  { ok: true; value: ValidatedCoin } | { ok: false; errors: CreateCoinErrors };

export function validateCreateCoin(input: CreateCoinInput): ValidationResult {
  const errors: CreateCoinErrors = {};

  const name = input.name.trim();
  if (name.length < NAME_MIN) errors.name = `Name must be at least ${NAME_MIN} characters.`;
  else if (name.length > NAME_MAX) errors.name = `Name must be at most ${NAME_MAX} characters.`;
  else if (FORBIDDEN_CHARS.test(name)) errors.name = 'Name contains unsupported characters.';

  const symbol = normalizeSymbol(input.symbol);
  if (symbol.length < SYMBOL_MIN || symbol.length > SYMBOL_MAX) {
    errors.symbol = `Symbol must be ${SYMBOL_MIN} to ${SYMBOL_MAX} characters.`;
  } else if (!/^[A-Z0-9]+$/.test(symbol)) {
    errors.symbol = 'Symbol may only contain letters and digits.';
  }

  const description = input.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    errors.description = `Description must be at most ${DESCRIPTION_MAX} characters.`;
  } else if (FORBIDDEN_CHARS.test(description.replace(/[\n\r\t]/g, ' '))) {
    errors.description = 'Description contains unsupported characters.';
  }

  if (!input.image) {
    errors.image = 'A coin image is required.';
  } else if (!(IMAGE_TYPES as readonly string[]).includes(input.image.type)) {
    errors.image = 'Image must be a PNG, JPEG, WebP or GIF file.';
  } else if (input.image.size <= 0) {
    errors.image = 'The selected image is empty.';
  } else if (input.image.size > IMAGE_MAX_BYTES) {
    errors.image = 'Image must be 2 MB or smaller.';
  }

  let firstBuyLamports = BigInt(0);
  const rawBuy = input.firstBuySol.trim();
  if (rawBuy !== '') {
    const parsed = parseSolToLamports(rawBuy);
    if (parsed === null) {
      errors.firstBuySol = 'First buy must be a number of SOL with at most 9 decimals.';
    } else if (parsed > BigInt(FIRST_BUY_MAX_SOL) * BigInt(1000000000)) {
      errors.firstBuySol = `First buy cannot exceed ${FIRST_BUY_MAX_SOL} SOL.`;
    } else {
      firstBuyLamports = parsed;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, symbol, description, firstBuyLamports } };
}
