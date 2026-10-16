import {
  CoinImageUnavailableError,
  imageUnavailableMessage,
  type CoinImageRehoster,
  type ImageField,
} from '../coin-images';
import { RouteError } from '../jobs/http';
import type { RoutesLogger } from '../jobs/log';
import { UploadConfigError } from '../uploads/config';
import { StorageError } from '../uploads/storage';

/*
 * Images changed by a modification (POST /api/launchpads/:id/modifications).
 *
 * In a modification chat the owner may give a new logo (`theme.logoUrl`; the coin image is locked
 * after launch, but `launchpadCoin.imageUrl` is handled the same way). The change lives in the
 * conversation's draft (`conversations.spec`), while the builder only receives the request text.
 * Before the job is written, each image URL of the draft that differs from the launchpad's is
 * copied into FORGE's bucket exactly as at confirmation (coin-images/rehost.ts: same SSRF rules,
 * same content-addressed write-once `coin-images/<sha256>.<ext>` key). A URL that already is a
 * `coin-images/` object of the bucket is kept as is. The request is then rewritten: every
 * occurrence of the owner's URL becomes the bucket URL, and one line per changed image names the
 * bucket URL. The external URL therefore never reaches the builder brief, so never the site.
 *
 * An image that cannot be copied answers 422 IMAGE_UNAVAILABLE (the owner gives another URL in the
 * chat) and nothing is written.
 */

/** The builder refuses a longer request (MAX_REQUEST_CHARS, apps/builder/src/prompts). */
export const MAX_STORED_REQUEST_LENGTH = 8_000;

const IMAGE_FIELDS: readonly { field: ImageField; label: string }[] = [
  // The coin image first: its failure is reported first, as at confirmation.
  { field: 'launchpadCoin.imageUrl', label: 'New coin image URL' },
  { field: 'theme.logoUrl', label: 'New logo image URL' },
];

export interface StoredImage {
  field: ImageField;
  /** The URL of the conversation's draft. */
  source: string;
  /** The bucket URL that replaces it. */
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The non-empty string at `field` of a stored spec or draft (both unparsed jsonb). */
export function readImageUrl(spec: unknown, field: ImageField): string | undefined {
  const [group, key] = field.split('.') as [string, string];
  if (!isRecord(spec)) return undefined;
  const section = spec[group];
  if (!isRecord(section)) return undefined;
  const value = section[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface ModificationImageDeps {
  images: () => CoinImageRehoster;
  logger: RoutesLogger;
}

/**
 * Copies the images of `draft` that differ from the launchpad's `current` spec. An image whose
 * copy is the launchpad's current URL (a creation conversation still holding the owner's original
 * URL) is not a change and is left out. Throws RouteError (422 IMAGE_UNAVAILABLE, 503).
 */
export async function storeChangedImages(
  deps: ModificationImageDeps,
  current: unknown,
  draft: unknown,
): Promise<StoredImage[]> {
  const changed = IMAGE_FIELDS.flatMap(({ field }) => {
    const source = readImageUrl(draft, field);
    return source !== undefined && source !== readImageUrl(current, field)
      ? [{ field, source }]
      : [];
  });
  if (changed.length === 0) return [];
  const stored: StoredImage[] = [];
  try {
    const rehoster = deps.images();
    for (const { field, source } of changed) {
      const url = await rehoster.rehostImage(source, field);
      if (url !== readImageUrl(current, field)) stored.push({ field, source, url });
    }
  } catch (error) {
    if (error instanceof CoinImageUnavailableError) {
      throw new RouteError(422, 'IMAGE_UNAVAILABLE', imageUnavailableMessage(error));
    }
    if (error instanceof UploadConfigError || error instanceof StorageError) {
      // Both messages name variables or an operation and an HTTP status, never a value.
      deps.logger.log('error', 'modification.image_copy_unavailable', { detail: error.message });
      throw new RouteError(
        503,
        'SERVER_ERROR',
        'This service is temporarily unavailable. Please try again.',
      );
    }
    throw error;
  }
  return stored;
}

/**
 * The request as stored for the builder: each owner URL replaced by its bucket URL, then one line
 * per changed image. Throws RouteError 400 when the result is too long for the builder.
 */
export function requestWithStoredImages(request: string, images: readonly StoredImage[]): string {
  if (images.length === 0) return request;
  let text = request;
  for (const image of images) {
    if (image.source !== image.url) text = text.split(image.source).join(image.url);
  }
  const lines = images.map(
    (image) => `${IMAGE_FIELDS.find((f) => f.field === image.field)!.label}: ${image.url}`,
  );
  const result = `${text}\n\n${lines.join('\n')}`;
  if (result.length > MAX_STORED_REQUEST_LENGTH) {
    throw new RouteError(400, 'BAD_REQUEST', 'Describe the change in fewer characters.');
  }
  return result;
}
