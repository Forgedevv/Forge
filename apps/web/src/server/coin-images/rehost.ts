import { createHash } from 'node:crypto';
import type { LaunchpadSpec } from '@forge/shared';
import type { RoutesLogger } from '../jobs/log';
import { IMAGE_EXTENSIONS, type ImageType } from '../uploads/contract';
import type { ObjectStorage } from '../uploads/storage';
import {
  fetchPublicImage,
  ImageFetchError,
  MAX_BYTES,
  type FetchedImage,
  type ImageFetchFailure,
} from './fetch-image';

/*
 * Copy of a confirmed spec's images into FORGE's R2 bucket (POST /api/spec/confirm).
 *
 * The owner gives the coin image (and optionally the logo) as a public URL in the chat. Coin
 * metadata (GET /api/coin-meta/:slug) and the client site would otherwise hotlink it: the third
 * party could delete it or swap it for another image after launch. At confirmation the image is
 * downloaded once (fetch-image.ts, SSRF rules there), stored under a content-addressed key
 * `coin-images/<sha256>.<ext>` with an immutable Cache-Control, and the spec keeps that public
 * URL instead. Objects under `coin-images/` are write-once and must never be covered by an R2
 * lifecycle rule.
 *
 * A URL that already is a `coin-images/` object of the bucket is kept as is, so confirming the
 * same spec again is idempotent. Any other URL, including another key of the bucket (staging
 * uploads under `pending/` are deleted by a lifecycle rule), is copied.
 */

export const COIN_IMAGE_PREFIX = 'coin-images/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const COIN_IMAGE_KEY = /^coin-images\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/;

export type ImageField = 'launchpadCoin.imageUrl' | 'theme.logoUrl';

/** The image of `field` cannot be copied: the owner must give another URL. */
export class CoinImageUnavailableError extends Error {
  constructor(
    readonly field: ImageField,
    readonly reason: ImageFetchFailure,
  ) {
    super(`${field} could not be copied (${reason})`);
    this.name = 'CoinImageUnavailableError';
  }
}

export interface CoinImageRehoster {
  /** `spec` with its image URLs pointing at the bucket. Throws CoinImageUnavailableError. */
  rehost(spec: LaunchpadSpec): Promise<LaunchpadSpec>;
}

export interface CoinImageRehosterDeps {
  storage: ObjectStorage;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  logger?: RoutesLogger;
}

export function coinImageKey(sha256Hex: string, contentType: ImageType): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error('invalid sha256 for a coin image key');
  return `${COIN_IMAGE_PREFIX}${sha256Hex}.${IMAGE_EXTENSIONS[contentType]}`;
}

/** True when `url` is exactly the public URL of a `coin-images/` object of the bucket. */
export function isStoredCoinImageUrl(url: string, storage: ObjectStorage): boolean {
  const base = storage.publicUrl('');
  if (!url.startsWith(base)) return false;
  const key = url.slice(base.length);
  return COIN_IMAGE_KEY.test(key) && storage.publicUrl(key) === url;
}

/** Host of a URL for the logs (never its path or query, which may carry access tokens). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function createCoinImageRehoster(deps: CoinImageRehosterDeps): CoinImageRehoster {
  const { storage } = deps;
  const fetchImage = deps.fetchImage ?? ((url: string) => fetchPublicImage(url));

  /** The URL to keep as is, or the downloaded image. */
  async function download(url: string, field: ImageField): Promise<string | FetchedImage> {
    if (isStoredCoinImageUrl(url, storage)) return url;
    try {
      return await fetchImage(url);
    } catch (error) {
      if (!(error instanceof ImageFetchError)) throw error;
      deps.logger?.log('warn', 'coin_image_refused', {
        field,
        reason: error.reason,
        status: error.status,
        host: hostOf(url),
      });
      throw new CoinImageUnavailableError(field, error.reason);
    }
  }

  /** Writes the image once under its content hash; returns its public URL. */
  async function store(image: FetchedImage, field: ImageField): Promise<string> {
    const digest = createHash('sha256').update(image.bytes).digest();
    const key = coinImageKey(digest.toString('hex'), image.contentType);
    const written = await storage.putIfAbsent(
      key,
      image.bytes,
      image.contentType,
      digest.toString('base64'),
      { cacheControl: IMMUTABLE_CACHE_CONTROL },
    );
    deps.logger?.log('info', 'coin_image_copied', {
      field,
      key,
      bytes: image.bytes.byteLength,
      created: written === 'created',
    });
    return storage.publicUrl(key);
  }

  return {
    async rehost(spec) {
      const imageSource = spec.launchpadCoin.imageUrl;
      const logoSource = spec.theme.logoUrl;
      // A logo identical to the coin image is downloaded once (null: reuse the image's URL).
      const ownLogo = logoSource !== undefined && logoSource !== imageSource;
      // Downloads run together; nothing is written unless both succeeded, and the coin image's
      // failure is reported first.
      const [imageResult, logoResult] = await Promise.allSettled([
        download(imageSource, 'launchpadCoin.imageUrl'),
        ownLogo ? download(logoSource, 'theme.logoUrl') : Promise.resolve(null),
      ]);
      if (imageResult.status === 'rejected') throw imageResult.reason;
      if (logoResult.status === 'rejected') throw logoResult.reason;
      const keep = (value: string | FetchedImage, field: ImageField) =>
        typeof value === 'string' ? Promise.resolve(value) : store(value, field);
      const imageUrl = await keep(imageResult.value, 'launchpadCoin.imageUrl');
      const logoUrl =
        logoSource === undefined
          ? undefined
          : logoResult.value === null
            ? imageUrl
            : await keep(logoResult.value, 'theme.logoUrl');
      return {
        ...spec,
        theme: logoUrl === undefined ? spec.theme : { ...spec.theme, logoUrl },
        launchpadCoin: { ...spec.launchpadCoin, imageUrl },
      };
    },
  };
}

/** Message of the 4xx answered for CoinImageUnavailableError; safe to show to the owner. */
export function imageUnavailableMessage(error: CoinImageUnavailableError): string {
  const what = error.field === 'theme.logoUrl' ? 'logo' : 'coin image';
  const mb = MAX_BYTES / (1024 * 1024);
  const why =
    error.reason === 'too_large'
      ? `is larger than ${mb} MB`
      : error.reason === 'not_an_image' || error.reason === 'unsupported_type'
        ? 'is not a PNG, JPEG, WebP or GIF image'
        : 'could not be downloaded from its URL';
  return (
    `The ${what} ${why}. Please give another image URL in the chat: ` +
    `a public https link to a PNG, JPEG, WebP or GIF of at most ${mb} MB.`
  );
}
