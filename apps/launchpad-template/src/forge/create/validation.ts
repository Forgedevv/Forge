import { MAX_FIRST_BUY_SOL, METADATA_LIMITS } from '@forge/core';
import { parseSolToLamports } from './amounts';

/**
 * LOCKED ZONE. Client-side validation of the coin creation form. Pure functions: the same rules
 * are re-checked by the server (`prepare-handler.ts`) and against the server summary before
 * anything is signed (see `verify.ts`).
 *
 * The on-chain limits come from `@forge/core` (single source of truth): the Metaplex name and
 * symbol limits are counted in UTF-8 BYTES, exactly like core's `assertLaunchMetadata`, so a name
 * with accents or emoji is refused here with a clear message instead of failing on the server.
 * The description is not written on-chain: it goes into the metadata JSON, whose limit (FORGE
 * upload contract, `upload-client.ts`) counts JavaScript string length.
 */

export const NAME_MIN = 3;
/** Metaplex name limit, in UTF-8 bytes (`METADATA_LIMITS.name` of `@forge/core`). */
export const NAME_MAX_BYTES: number = METADATA_LIMITS.name;
/** Kept for callers that read it as a length: same value as `NAME_MAX_BYTES`. */
export const NAME_MAX = NAME_MAX_BYTES;
export const SYMBOL_MIN = 2;
/** Metaplex symbol limit (`METADATA_LIMITS.symbol`); the symbol is ASCII, so bytes = characters. */
export const SYMBOL_MAX: number = METADATA_LIMITS.symbol;
export const DESCRIPTION_MAX = 500;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** Upper bound of a first buy, in SOL: `MAX_FIRST_BUY_SOL` of `@forge/core` (core refuses more). */
export const FIRST_BUY_MAX_SOL: number = MAX_FIRST_BUY_SOL;
const LAMPORTS_PER_SOL = BigInt(1000000000);

export interface CreateCoinInput {
  name: string;
  symbol: string;
  description: string;
  /** Selected image (File in the browser; any object with name/type/size in tests). */
  image: ImageLike | null;
  /** Decimal SOL string typed by the user. Empty means "no first buy". */
  firstBuySol: string;
}

export interface ImageLike {
  name: string;
  type: string;
  size: number;
}

export type CreateCoinField = 'name' | 'symbol' | 'description' | 'image' | 'firstBuySol';
export type CreateCoinErrors = Partial<Record<CreateCoinField, string>>;

/** Fields in the order the form shows them: the first invalid one is focused on submit. */
export const CREATE_COIN_FIELD_ORDER: readonly CreateCoinField[] = [
  'image',
  'name',
  'symbol',
  'description',
  'firstBuySol',
];

export interface ValidatedCoin {
  name: string;
  symbol: string;
  description: string;
  firstBuyLamports: bigint;
}

export const VALIDATION_TEXT = {
  nameShort: `Name must be at least ${NAME_MIN} characters.`,
  nameLong: `Name must be at most ${NAME_MAX_BYTES} characters.`,
  nameLongBytes: `Name is too long: it holds at most ${NAME_MAX_BYTES} bytes, and accents or emoji take 2 to 4 each. Shorten it.`,
  nameChars: 'Name contains unsupported characters.',
  symbolLength: `Symbol must be ${SYMBOL_MIN} to ${SYMBOL_MAX} characters.`,
  symbolChars: 'Symbol may only contain letters A to Z and digits.',
  descriptionLong: `Description must be at most ${DESCRIPTION_MAX} characters.`,
  descriptionChars: 'Description contains unsupported characters.',
  imageMissing: 'A coin image is required.',
  imageType: 'Image must be a PNG, JPEG, WebP or GIF file.',
  imageEmpty: 'The selected image is empty.',
  imageSize: 'Image must be 2 MB or smaller.',
  firstBuyFormat: 'First buy must be a number of SOL with at most 9 decimals.',
  firstBuyMax: `First buy cannot exceed ${FIRST_BUY_MAX_SOL} SOL.`,
} as const;

// Control characters and bidirectional overrides have no place in a coin name.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

/** UTF-8 size of a string, the unit of the Metaplex limits (same count as `@forge/core`). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Live counter of the name field: UTF-8 bytes of the trimmed name against the on-chain limit. */
export function nameUsage(name: string): { used: number; max: number; multibyte: boolean } {
  const trimmed = name.trim();
  const used = utf8ByteLength(trimmed);
  return { used, max: NAME_MAX_BYTES, multibyte: used !== trimmed.length };
}

/**
 * Checks a picked or dropped file before it is kept (type and size, like the server), so the
 * visitor learns at once that a file cannot be used. Returns the error text, or null.
 */
export function validateImageFile(file: ImageLike | null): string | null {
  if (!file) return VALIDATION_TEXT.imageMissing;
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return VALIDATION_TEXT.imageType;
  if (file.size <= 0) return VALIDATION_TEXT.imageEmpty;
  if (file.size > IMAGE_MAX_BYTES) return VALIDATION_TEXT.imageSize;
  return null;
}

export type ValidationResult =
  { ok: true; value: ValidatedCoin } | { ok: false; errors: CreateCoinErrors };

export function validateCreateCoin(input: CreateCoinInput): ValidationResult {
  const errors: CreateCoinErrors = {};

  const name = input.name.trim();
  const nameBytes = utf8ByteLength(name);
  if (name.length < NAME_MIN) errors.name = VALIDATION_TEXT.nameShort;
  else if (nameBytes > NAME_MAX_BYTES) {
    errors.name = nameBytes === name.length ? VALIDATION_TEXT.nameLong : VALIDATION_TEXT.nameLongBytes;
  } else if (FORBIDDEN_CHARS.test(name)) errors.name = VALIDATION_TEXT.nameChars;

  const symbol = normalizeSymbol(input.symbol);
  if (symbol.length < SYMBOL_MIN || symbol.length > SYMBOL_MAX) {
    errors.symbol = VALIDATION_TEXT.symbolLength;
  } else if (!/^[A-Z0-9]+$/.test(symbol)) {
    errors.symbol = VALIDATION_TEXT.symbolChars;
  }

  const description = input.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    errors.description = VALIDATION_TEXT.descriptionLong;
  } else if (FORBIDDEN_CHARS.test(description.replace(/[\n\r\t]/g, ' '))) {
    errors.description = VALIDATION_TEXT.descriptionChars;
  }

  const imageError = validateImageFile(input.image);
  if (imageError) errors.image = imageError;

  let firstBuyLamports = BigInt(0);
  const rawBuy = input.firstBuySol.trim();
  if (rawBuy !== '') {
    const parsed = parseSolToLamports(rawBuy);
    if (parsed === null) {
      errors.firstBuySol = VALIDATION_TEXT.firstBuyFormat;
    } else if (parsed > BigInt(FIRST_BUY_MAX_SOL) * LAMPORTS_PER_SOL) {
      errors.firstBuySol = VALIDATION_TEXT.firstBuyMax;
    } else {
      firstBuyLamports = parsed;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, symbol, description, firstBuyLamports } };
}

/** The invalid fields of `errors`, in form order. */
export function invalidFields(errors: CreateCoinErrors): CreateCoinField[] {
  return CREATE_COIN_FIELD_ORDER.filter((field) => Boolean(errors[field]));
}
