import { IMAGE_MAX_BYTES, IMAGE_TYPES } from './validation';

/**
 * LOCKED ZONE. Server-side checks of an uploaded coin image. The declared type is never trusted:
 * the bytes must start with the signature of a PNG, JPEG, WebP or GIF file, and that detected type
 * must be the declared one. Anything else (SVG, HTML, text, ...) is refused.
 */

export type ImageType = (typeof IMAGE_TYPES)[number];

export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class ImageError extends Error {
  constructor(
    message: string,
    /** HTTP status the API answers with. */
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/** Detects the image type from its first bytes (magic numbers). Null when not an allowed image. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

// Strict base64 (no whitespace, correct padding).
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/;

/** Largest base64 payload that can decode to at most IMAGE_MAX_BYTES bytes. */
const MAX_BASE64_LENGTH = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

export interface CheckedImage {
  contentType: ImageType;
  bytes: Uint8Array;
}

/**
 * Parses `data:<mime>;base64,<payload>` and checks it: allowed declared type, size between 1 byte
 * and 2 MB, and magic bytes matching the declared type.
 */
export function checkImageDataUrl(dataUrl: string): CheckedImage {
  const match = DATA_URL.exec(dataUrl);
  if (!match) throw new ImageError('The coin image is not a valid base64 data URL.', 400);
  const declared = match[1] as string;
  const payload = match[2] as string;
  if (!(IMAGE_TYPES as readonly string[]).includes(declared)) {
    throw new ImageError('Image must be a PNG, JPEG, WebP or GIF file.', 415);
  }
  if (payload.length > MAX_BASE64_LENGTH) {
    throw new ImageError('Image must be 2 MB or smaller.', 413);
  }
  if (payload.length === 0 || !BASE64.test(payload)) {
    throw new ImageError('The coin image is not valid base64.', 400);
  }
  const bytes = Uint8Array.from(Buffer.from(payload, 'base64'));
  if (bytes.length === 0) throw new ImageError('The selected image is empty.', 400);
  if (bytes.length > IMAGE_MAX_BYTES) throw new ImageError('Image must be 2 MB or smaller.', 413);
  const detected = sniffImageType(bytes);
  if (!detected) throw new ImageError('Image must be a PNG, JPEG, WebP or GIF file.', 415);
  if (detected !== declared) {
    throw new ImageError('The image content does not match its declared type.', 415);
  }
  return { contentType: detected, bytes };
}
